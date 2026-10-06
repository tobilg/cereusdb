// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

//! On-storage layout of a persistent database.
//!
//! ```text
//! <root>/manifest.json          commit point: schemas, tables, views, segments
//! <root>/segments/<id>.arrow    immutable Arrow IPC files (LZ4 compressed)
//! ```
//!
//! A table is the concatenation of its segments. INSERT adds a segment,
//! UPDATE/DELETE/ALTER rewrite the table into a single new segment. Segment
//! files are never modified; the manifest is written last, so a crash leaves
//! the previous manifest (and its segments) intact.

use std::collections::BTreeMap;
use std::io::Cursor;
use std::sync::Arc;

use arrow::compute::cast;
use arrow_array::RecordBatch;
use arrow_ipc::reader::{FileReader, StreamReader};
use arrow_ipc::writer::{FileWriter, IpcWriteOptions, StreamWriter};
use arrow_ipc::CompressionType;
use arrow_schema::SchemaRef;
use serde::{Deserialize, Serialize};

pub const MANIFEST_FORMAT: &str = "cereusdb";
pub const MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    pub next_segment_id: u64,
    #[serde(default)]
    pub schemas: BTreeMap<String, SchemaManifest>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SchemaManifest {
    #[serde(default)]
    pub tables: BTreeMap<String, TableManifest>,
    #[serde(default)]
    pub views: BTreeMap<String, ViewManifest>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TableManifest {
    pub segments: Vec<SegmentManifest>,
    /// Hex-encoded Arrow IPC schema, so the table can be described without
    /// reading its segments. Missing in manifests written before lazy loading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    /// Column defaults as SQL expressions.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub column_defaults: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraints: Vec<ConstraintManifest>,
}

/// A table constraint, by column names (so it survives column changes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConstraintManifest {
    PrimaryKey { columns: Vec<String> },
    Unique { columns: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SegmentManifest {
    pub id: u64,
    pub rows: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewManifest {
    pub sql: String,
    /// Hex-encoded Arrow IPC schema of the view's columns, so a view that
    /// cannot be planned on attach still shows its columns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
}

impl Manifest {
    pub fn new_database() -> Self {
        let mut schemas = BTreeMap::new();
        schemas.insert("public".to_string(), SchemaManifest::default());
        Self {
            format: MANIFEST_FORMAT.to_string(),
            version: MANIFEST_VERSION,
            next_segment_id: 1,
            schemas,
        }
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let manifest: Manifest =
            serde_json::from_slice(bytes).map_err(|e| format!("invalid manifest: {e}"))?;
        if manifest.format != MANIFEST_FORMAT {
            return Err(format!(
                "invalid manifest: unexpected format '{}'",
                manifest.format
            ));
        }
        if manifest.version > MANIFEST_VERSION {
            return Err(format!(
                "manifest version {} is newer than supported version {MANIFEST_VERSION}",
                manifest.version
            ));
        }
        Ok(manifest)
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec_pretty(self).map_err(|e| format!("failed to encode manifest: {e}"))
    }

    pub fn segment_ids(&self) -> impl Iterator<Item = u64> + '_ {
        self.schemas
            .values()
            .flat_map(|schema| schema.tables.values())
            .flat_map(|table| table.segments.iter().map(|segment| segment.id))
    }
}

pub fn manifest_path(root: &str) -> String {
    format!("{root}/manifest.json")
}

pub fn segments_dir(root: &str) -> String {
    format!("{root}/segments")
}

pub fn segment_path(root: &str, id: u64) -> String {
    format!("{root}/segments/{}", segment_file_name(id))
}

pub fn segment_file_name(id: u64) -> String {
    format!("{id}.arrow")
}

pub fn segment_id_from_file_name(name: &str) -> Option<u64> {
    name.strip_suffix(".arrow")?.parse().ok()
}

/// Serialize batches as an LZ4-compressed Arrow IPC file using `schema`.
///
/// Batches whose schema differs from the table schema (for example in field
/// metadata or view types produced by the inserting query) are aligned first.
///
/// Compression relies on the patched arrow-ipc (`patches/arrow-ipc`): before
/// arrow 60, compressed buffers got a 4-byte length prefix on wasm32 instead
/// of 8 bytes and could not be read back. Older uncompressed segments remain
/// readable because every buffer records whether it is compressed.
pub fn encode_segment(schema: &SchemaRef, batches: &[RecordBatch]) -> Result<Vec<u8>, String> {
    let options = IpcWriteOptions::default()
        .try_with_compression(Some(CompressionType::LZ4_FRAME))
        .map_err(|e| format!("failed to configure IPC writer: {e}"))?;
    let mut writer = FileWriter::try_new_with_options(Vec::new(), schema, options)
        .map_err(|e| format!("failed to create IPC writer: {e}"))?;
    for batch in batches {
        let batch = align_batch(schema, batch)?;
        writer
            .write(&batch)
            .map_err(|e| format!("failed to write IPC batch: {e}"))?;
    }
    writer
        .finish()
        .map_err(|e| format!("failed to finish IPC file: {e}"))?;
    writer
        .into_inner()
        .map_err(|e| format!("failed to finish IPC file: {e}"))
}

/// Encode a schema as a hex string (an Arrow IPC stream without batches).
pub fn encode_schema(schema: &SchemaRef) -> Result<String, String> {
    let mut writer = StreamWriter::try_new(Vec::new(), schema)
        .map_err(|e| format!("failed to encode schema: {e}"))?;
    writer
        .finish()
        .map_err(|e| format!("failed to encode schema: {e}"))?;
    let bytes = writer
        .into_inner()
        .map_err(|e| format!("failed to encode schema: {e}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn decode_schema(hex: &str) -> Result<SchemaRef, String> {
    if hex.len() % 2 != 0 {
        return Err("invalid schema encoding".to_string());
    }
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "invalid schema encoding".to_string())?;
    let reader = StreamReader::try_new(Cursor::new(bytes), None)
        .map_err(|e| format!("invalid schema: {e}"))?;
    Ok(reader.schema())
}

pub fn decode_segment(bytes: Vec<u8>) -> Result<(SchemaRef, Vec<RecordBatch>), String> {
    let reader = FileReader::try_new(Cursor::new(bytes), None)
        .map_err(|e| format!("invalid segment: {e}"))?;
    let schema = reader.schema();
    let batches = reader
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("invalid segment: {e}"))?;
    Ok((schema, batches))
}

pub fn align_batch(schema: &SchemaRef, batch: &RecordBatch) -> Result<RecordBatch, String> {
    if batch.schema_ref() == schema {
        return Ok(batch.clone());
    }
    if batch.num_columns() != schema.fields().len() {
        return Err(format!(
            "batch has {} columns but table has {}",
            batch.num_columns(),
            schema.fields().len()
        ));
    }
    let columns = batch
        .columns()
        .iter()
        .zip(schema.fields())
        .map(|(column, field)| {
            if column.data_type() == field.data_type() {
                Ok(Arc::clone(column))
            } else {
                cast(column, field.data_type())
                    .map_err(|e| format!("failed to cast column '{}': {e}", field.name()))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    RecordBatch::try_new(Arc::clone(schema), columns)
        .map_err(|e| format!("failed to align batch with table schema: {e}"))
}

/// A parsed database location such as `opfs://mydb`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseLocation {
    pub scheme: String,
    pub root: String,
}

impl DatabaseLocation {
    pub fn parse(location: &str) -> Result<Self, String> {
        let trimmed = location.trim();
        let Some((scheme, rest)) = trimmed.split_once("://") else {
            if let Some((scheme, rest)) = trimmed.split_once(":/") {
                return Err(format!(
                    "Invalid database location '{trimmed}': use '{scheme}://{}'",
                    rest.trim_start_matches('/')
                ));
            }
            return Err(format!(
                "Invalid database location '{trimmed}': expected a URL like 'opfs://mydb'"
            ));
        };
        let scheme = scheme.to_ascii_lowercase();
        if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(format!("Invalid database location '{trimmed}'"));
        }
        let root = rest.trim_end_matches('/');
        if root.is_empty()
            || !root
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!(
                "Invalid database location '{trimmed}': the database name may only contain \
                 letters, digits, '_' and '-' (for example 'opfs://mydb')"
            ));
        }
        Ok(Self {
            scheme,
            root: root.to_string(),
        })
    }

    pub fn url(&self) -> String {
        format!("{}://{}", self.scheme, self.root)
    }

    /// Default catalog name for this location: the database name, lowercased
    /// so it can be referenced unquoted in SQL.
    pub fn default_name(&self) -> String {
        self.root.to_ascii_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_locations() {
        let location = DatabaseLocation::parse("opfs://MyDb").unwrap();
        assert_eq!(location.scheme, "opfs");
        assert_eq!(location.root, "MyDb");
        assert_eq!(location.url(), "opfs://MyDb");
        assert_eq!(location.default_name(), "mydb");

        let err = DatabaseLocation::parse("opfs:/mydb").unwrap_err();
        assert!(err.contains("use 'opfs://mydb'"), "{err}");
        assert!(DatabaseLocation::parse("opfs://a/b").is_err());
        assert!(DatabaseLocation::parse("opfs://").is_err());
        assert!(DatabaseLocation::parse("mydb").is_err());
    }

    #[test]
    fn schema_round_trip() {
        use arrow_schema::{DataType, Field, Schema};
        let schema: SchemaRef = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int32, false),
            Field::new("name", DataType::Utf8View, true),
        ]));
        let decoded = decode_schema(&encode_schema(&schema).unwrap()).unwrap();
        assert_eq!(decoded, schema);
        assert!(decode_schema("zz").is_err());
    }

    #[test]
    fn manifest_round_trip() {
        let manifest = Manifest::new_database();
        let parsed = Manifest::parse(&manifest.to_bytes().unwrap()).unwrap();
        assert!(parsed.schemas.contains_key("public"));
        assert_eq!(parsed.next_segment_id, 1);
    }
}
