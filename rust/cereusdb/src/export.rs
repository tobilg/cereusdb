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

//! GeoParquet export of query results.
//!
//! Written directly with the `parquet` crate's `ArrowWriter`: DataFusion's
//! `COPY TO` (and SedonaDB's `write_geoparquet`, which builds on it) spawns
//! Tokio tasks that are not available in the browser.

use std::collections::BTreeMap;
use std::sync::Arc;

use arrow_array::{Array, BinaryArray, BinaryViewArray, LargeBinaryArray, RecordBatch};
use arrow_schema::{DataType, SchemaRef};
use datafusion::logical_expr::LogicalPlan;
use datafusion::prelude::SessionContext;
use parquet::arrow::ArrowWriter;
use parquet::basic::{BrotliLevel, Compression, GzipLevel, ZstdLevel};
use parquet::file::metadata::KeyValue;
use parquet::file::properties::WriterProperties;
use sedona_common::option::SedonaOptions;
use sedona_geometry::bounds::wkb_bounds_xy;
use sedona_geometry::interval::IntervalTrait;
use sedona_schema::crs::lnglat;
use sedona_schema::datatypes::{Edges, SedonaType};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use datafusion::sql::parser::{CopyToSource, Statement as DFStatement};
use datafusion::sql::sqlparser::ast::Value as SqlValue;

use crate::statements::starts_with_keyword;
use crate::storage::manifest::align_batch;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeoParquetOptions {
    /// `zstd` (default), `snappy`, `lz4`, `gzip`, `brotli` or `uncompressed`.
    pub compression: Option<String>,
    /// Maximum number of rows per row group.
    pub row_group_size: Option<usize>,
}

fn compression(name: Option<&str>) -> Result<Compression, String> {
    Ok(match name.map(str::to_ascii_lowercase).as_deref() {
        None | Some("zstd") => Compression::ZSTD(ZstdLevel::default()),
        Some("snappy") => Compression::SNAPPY,
        Some("lz4") => Compression::LZ4_RAW,
        Some("gzip") => Compression::GZIP(GzipLevel::default()),
        Some("brotli") => Compression::BROTLI(BrotliLevel::default()),
        Some("uncompressed") | Some("none") => Compression::UNCOMPRESSED,
        Some(other) => {
            return Err(format!(
                "Unsupported compression '{other}'; use zstd, snappy, lz4, gzip, brotli or uncompressed"
            ))
        }
    })
}

/// Run `sql` and encode the result as a GeoParquet file. Geometry and
/// geography columns are described in the `geo` file metadata; the first
/// one (preferring a column named `geometry` or `geom`) is the primary column.
/// Returns the file and the number of exported rows.
pub async fn export_geoparquet(
    ctx: &SessionContext,
    sql: &str,
    options: GeoParquetOptions,
) -> Result<(Vec<u8>, usize), String> {
    let state = ctx.state();
    let plan = state
        .create_logical_plan(sql)
        .await
        .map_err(|e| e.to_string())?;
    if matches!(
        plan,
        LogicalPlan::Ddl(_)
            | LogicalPlan::Dml(_)
            | LogicalPlan::Statement(_)
            | LogicalPlan::Copy(_)
    ) {
        return Err("GeoParquet export requires a query (for example SELECT * FROM t)".to_string());
    }
    let df = ctx
        .execute_logical_plan(plan)
        .await
        .map_err(|e| e.to_string())?;
    let schema: SchemaRef = Arc::new(df.schema().as_arrow().clone());
    let batches = df.collect().await.map_err(|e| e.to_string())?;
    let batches = batches
        .iter()
        .map(|batch| align_batch(&schema, batch))
        .collect::<Result<Vec<_>, _>>()?;

    let mut properties =
        WriterProperties::builder().set_compression(compression(options.compression.as_deref())?);
    if let Some(row_group_size) = options.row_group_size {
        if row_group_size == 0 {
            return Err("rowGroupSize must be greater than 0".to_string());
        }
        properties = properties.set_max_row_group_size(row_group_size);
    }
    if let Some(geo) = geo_metadata(ctx, &schema, &batches)? {
        properties = properties.set_key_value_metadata(Some(vec![KeyValue::new(
            "geo".to_string(),
            geo.to_string(),
        )]));
    }

    let mut writer =
        ArrowWriter::try_new(Vec::new(), Arc::clone(&schema), Some(properties.build()))
            .map_err(|e| format!("Failed to create Parquet writer: {e}"))?;
    for batch in &batches {
        writer
            .write(batch)
            .map_err(|e| format!("Failed to write Parquet: {e}"))?;
    }
    let bytes = writer
        .into_inner()
        .map_err(|e| format!("Failed to finish Parquet file: {e}"))?;
    let rows = batches.iter().map(RecordBatch::num_rows).sum();
    Ok((bytes, rows))
}

/// MIME type passed to the export handler for GeoParquet files.
pub const PARQUET_MIME_TYPE: &str = "application/vnd.apache.parquet";

/// A parsed `COPY ... TO '<file>'` statement.
#[derive(Debug)]
pub struct CopyRequest {
    /// Query producing the rows to export.
    pub query: String,
    /// File name passed to the export handler.
    pub filename: String,
    pub options: GeoParquetOptions,
}

/// Parse `COPY { table | (query) } TO '<file>' [STORED AS GEOPARQUET|PARQUET]
/// [OPTIONS (compression '...', row_group_size n)]`. Returns `Ok(None)` for
/// other statements.
pub fn parse_copy(ctx: &SessionContext, sql: &str) -> Result<Option<CopyRequest>, String> {
    if !starts_with_keyword(sql, "COPY") {
        return Ok(None);
    }
    let state = ctx.state();
    let statement = state
        .sql_to_statement(sql, &state.config().options().sql_parser.dialect)
        .map_err(|e| e.to_string())?;
    let DFStatement::CopyTo(copy) = statement else {
        return Ok(None);
    };

    if !copy.partitioned_by.is_empty() {
        return Err("COPY ... PARTITIONED BY is not supported".to_string());
    }
    let filename = copy.target.trim().to_string();
    if filename.is_empty() || filename.contains(":/") {
        return Err(format!(
            "COPY writes a file through the export handler (a browser download by default); \
             use a file name such as 'export.parquet' instead of '{filename}'"
        ));
    }
    let format = match copy.stored_as.as_deref() {
        Some(format) => format.to_ascii_uppercase(),
        None => match filename
            .rsplit_once('.')
            .map(|(_, ext)| ext.to_ascii_lowercase())
        {
            Some(ext) if ext == "parquet" || ext == "geoparquet" => "GEOPARQUET".to_string(),
            _ => {
                return Err(format!(
                    "Cannot infer the format of '{filename}'; add STORED AS GEOPARQUET or use a \
                     .parquet file name"
                ))
            }
        },
    };
    if format != "GEOPARQUET" && format != "PARQUET" {
        return Err(format!(
            "Unsupported COPY format {format}; supported: GEOPARQUET (or PARQUET)"
        ));
    }

    let mut options = GeoParquetOptions::default();
    for (key, value) in copy.options {
        let value = match value {
            SqlValue::SingleQuotedString(value) | SqlValue::DoubleQuotedString(value) => value,
            SqlValue::Number(value, _) => value,
            other => other.to_string(),
        };
        let key = key.to_ascii_lowercase();
        match key.strip_prefix("format.").unwrap_or(&key) {
            "compression" => options.compression = Some(value),
            "row_group_size" | "max_row_group_size" => {
                options.row_group_size = Some(value.parse().map_err(|_| {
                    format!("row_group_size must be a positive integer, got '{value}'")
                })?)
            }
            other => {
                return Err(format!(
                    "Unsupported COPY option '{other}'; supported: compression, row_group_size"
                ))
            }
        }
    }

    let query = match copy.source {
        CopyToSource::Relation(name) => format!("SELECT * FROM {name}"),
        CopyToSource::Query(query) => query.to_string(),
    };
    Ok(Some(CopyRequest {
        query,
        filename,
        options,
    }))
}

/// Build the GeoParquet 1.1 `geo` metadata, or `None` without geometry columns.
fn geo_metadata(
    ctx: &SessionContext,
    schema: &SchemaRef,
    batches: &[RecordBatch],
) -> Result<Option<Value>, String> {
    let mut columns = Map::new();
    let mut names = Vec::new();
    for (index, field) in schema.fields().iter().enumerate() {
        let (edges, crs) = match SedonaType::from_storage_field(field) {
            Ok(SedonaType::Wkb(edges, crs)) | Ok(SedonaType::WkbView(edges, crs)) => (edges, crs),
            _ => continue,
        };

        let mut column = Map::new();
        column.insert("encoding".into(), json!("WKB"));
        column.insert("geometry_types".into(), json!([]));
        if let Some(crs) = crs_value(ctx, field.name(), &crs)? {
            column.insert("crs".into(), crs);
        }
        if edges != Edges::Planar {
            column.insert("edges".into(), json!(edges.to_string()));
        } else if let Some(bbox) = column_bbox(batches, index) {
            column.insert("bbox".into(), json!(bbox));
        }
        columns.insert(field.name().clone(), Value::Object(column));
        names.push(field.name().clone());
    }
    if names.is_empty() {
        return Ok(None);
    }

    let primary = names
        .iter()
        .find(|name| name.as_str() == "geometry" || name.as_str() == "geom")
        .unwrap_or(&names[0])
        .clone();
    let mut metadata = BTreeMap::new();
    metadata.insert("version", json!("1.1.0"));
    metadata.insert("primary_column", json!(primary));
    metadata.insert("columns", Value::Object(columns));
    Ok(Some(json!(metadata)))
}

/// GeoParquet `crs`: `None` (omitted, meaning OGC:CRS84) for longitude/latitude,
/// PROJJSON when it is known or can be derived by PROJ, and `null` when the
/// column has no CRS.
fn crs_value(
    ctx: &SessionContext,
    column: &str,
    crs: &sedona_schema::crs::Crs,
) -> Result<Option<Value>, String> {
    let Some(value) = crs else {
        return Ok(Some(Value::Null));
    };
    if crs == &lnglat() {
        return Ok(None);
    }
    let parsed: Value = value
        .to_json()
        .parse()
        .map_err(|e| format!("Invalid CRS for column '{column}': {e}"))?;
    let Value::String(name) = parsed else {
        return Ok(Some(parsed));
    };
    let engine = ctx
        .state()
        .config()
        .options()
        .extensions
        .get::<SedonaOptions>()
        .map(|options| Arc::clone(options.runtime.crs_engine()))
        .ok_or_else(|| format!("Cannot convert CRS '{name}' of column '{column}' to PROJJSON"))?;
    let projjson = engine.to_projjson(&name).map_err(|e| {
        format!(
            "Cannot convert CRS '{name}' of column '{column}' to PROJJSON ({e}); \
             exporting this CRS requires a package with PROJ (standard or larger)"
        )
    })?;
    projjson
        .parse()
        .map(Some)
        .map_err(|e| format!("Invalid PROJJSON for column '{column}': {e}"))
}

fn column_bbox(batches: &[RecordBatch], index: usize) -> Option<[f64; 4]> {
    let mut bbox: Option<[f64; 4]> = None;
    for batch in batches {
        let column = batch.column(index);
        let values: Box<dyn Iterator<Item = Option<&[u8]>>> = match column.data_type() {
            DataType::Binary => Box::new(column.as_any().downcast_ref::<BinaryArray>()?.iter()),
            DataType::LargeBinary => {
                Box::new(column.as_any().downcast_ref::<LargeBinaryArray>()?.iter())
            }
            DataType::BinaryView => {
                Box::new(column.as_any().downcast_ref::<BinaryViewArray>()?.iter())
            }
            _ => return None,
        };
        for wkb in values.flatten() {
            let bounds = wkb_bounds_xy(wkb).ok()?;
            let (x, y) = (bounds.x(), bounds.y());
            if x.is_empty() || y.is_empty() {
                continue;
            }
            if x.is_wraparound() {
                return None;
            }
            let next = [x.lo(), y.lo(), x.hi(), y.hi()];
            bbox = Some(match bbox {
                None => next,
                Some(current) => [
                    current[0].min(next[0]),
                    current[1].min(next[1]),
                    current[2].max(next[2]),
                    current[3].max(next[3]),
                ],
            });
        }
    }
    bbox
}
