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

//! Arrow IPC and JSON serialization for query results.

use std::sync::Arc;

use arrow_array::{RecordBatch, UInt64Array};
use arrow_ipc::writer::StreamWriter;
use arrow_json::ArrayWriter;
use arrow_schema::{DataType, Field, Schema};
use datafusion::error::Result;

/// Serialize RecordBatches to Arrow IPC stream format bytes.
///
/// The resulting bytes can be decoded by the apache-arrow JavaScript library
/// using `tableFromIPC()`.
pub fn batches_to_ipc_bytes(batches: &[RecordBatch]) -> Result<Vec<u8>> {
    if batches.is_empty() {
        return Ok(Vec::new());
    }

    let schema = batches[0].schema();
    let mut buf = Vec::new();
    {
        let mut writer = StreamWriter::try_new(&mut buf, &schema)?;
        for batch in batches {
            writer.write(batch)?;
        }
        writer.finish()?;
    }
    Ok(buf)
}

/// Serialize RecordBatches to a JSON array string.
///
/// Each row becomes a JSON object with column names as keys.
pub fn batches_to_json(batches: &[RecordBatch]) -> Result<String> {
    if batches.is_empty() {
        return Ok("[]".to_string());
    }

    let mut buf = Vec::new();
    let mut writer = ArrayWriter::new(&mut buf);
    for batch in batches {
        writer.write(batch)?;
    }
    writer.finish()?;

    String::from_utf8(buf).map_err(|e| {
        datafusion::error::DataFusionError::External(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("JSON UTF-8 error: {e}"),
        )))
    })
}

/// A single-row `count` result, as returned by DML and COPY statements.
pub fn count_batch(count: u64) -> RecordBatch {
    let schema = Arc::new(Schema::new(vec![Field::new(
        "count",
        DataType::UInt64,
        false,
    )]));
    RecordBatch::try_new(schema, vec![Arc::new(UInt64Array::from(vec![count]))])
        .expect("count batch matches its schema")
}
