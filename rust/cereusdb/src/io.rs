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

//! I/O helpers for WASM: file upload, remote fetch, format conversion.

use std::sync::Arc;

use arrow_array::{ArrayRef, RecordBatch, StringArray};
#[cfg(feature = "gdal")]
use arrow_array::StructArray;
use arrow_schema::{DataType, Field, Schema};
use datafusion::datasource::MemTable;
use datafusion::error::DataFusionError;
use datafusion::error::Result as DFResult;
use datafusion::prelude::SessionContext;

/// Fetch bytes from a URL using browser fetch() API.
#[cfg(target_arch = "wasm32")]
pub async fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    use wasm_bindgen::JsCast;
    use wasm_bindgen_futures::JsFuture;
    use web_sys::{Request, RequestInit, RequestMode, Response};

    let opts = RequestInit::new();
    opts.set_method("GET");
    opts.set_mode(RequestMode::Cors);

    let request = Request::new_with_str_and_init(url, &opts)
        .map_err(|e| format!("Failed to create request: {e:?}"))?;

    // Try window first (main thread), fall back to WorkerGlobalScope (web worker)
    let promise = if let Some(window) = web_sys::window() {
        window.fetch_with_request(&request)
    } else {
        let global: web_sys::WorkerGlobalScope = js_sys::global().unchecked_into();
        global.fetch_with_request(&request)
    };

    let resp_value = JsFuture::from(promise)
        .await
        .map_err(|e| format!("Fetch failed: {e:?}"))?;

    let resp: Response = resp_value
        .dyn_into()
        .map_err(|e| format!("Response cast failed: {e:?}"))?;

    if !resp.ok() {
        return Err(format!("HTTP {} for {}", resp.status(), url));
    }

    let array_buffer = JsFuture::from(
        resp.array_buffer()
            .map_err(|e| format!("Failed to get array buffer: {e:?}"))?,
    )
    .await
    .map_err(|e| format!("Failed to read array buffer: {e:?}"))?;

    let uint8_array = js_sys::Uint8Array::new(&array_buffer);
    let mut vec = vec![0u8; uint8_array.length() as usize];
    uint8_array.copy_to(&mut vec);

    Ok(vec)
}

/// Stub for non-WASM targets (enables cargo check on host).
#[cfg(not(target_arch = "wasm32"))]
pub async fn fetch_bytes(_url: &str) -> Result<Vec<u8>, String> {
    Err("fetch_bytes only available on WASM".into())
}

#[cfg(feature = "gdal")]
static VSI_FILE_COUNTER: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// Load raster bytes into a single-column raster MemTable and register it on the SessionContext.
#[cfg(feature = "gdal")]
pub fn load_raster_buffer_to_memtable(
    ctx: &SessionContext,
    table_name: &str,
    format: &str,
    data: &[u8],
) -> DFResult<()> {
    use sedona_schema::datatypes::RASTER;

    let extension = raster_file_extension(format)?;
    let vsi_path = next_vsi_mem_file_path(table_name, extension);

    let raster_array = sedona_gdal::global::with_global_gdal_api(
        |api| -> std::result::Result<StructArray, String> {
            sedona_gdal::vsi::create_mem_file(api, &vsi_path, data)
                .map_err(|error| format!("Failed to create GDAL memory file: {error}"))?;

            let load_result = unsafe {
                let dataset = open_gdal_dataset(&vsi_path, format)?;
                let result = dataset_to_raster_struct(api, dataset, format);
                gdal_sys::GDALClose(dataset);
                result
            };

            let unlink_result = sedona_gdal::vsi::unlink_mem_file(api, &vsi_path)
                .map_err(|error| format!("Failed to unlink GDAL memory file: {error}"));

            match (load_result, unlink_result) {
                (Ok(raster), Ok(())) => Ok(raster),
                (Err(load_error), Ok(())) => Err(load_error),
                (Ok(_), Err(unlink_error)) => Err(unlink_error),
                (Err(load_error), Err(unlink_error)) => {
                    Err(format!("{load_error}; {unlink_error}"))
                }
            }
        },
    )
    .map_err(|error| {
        DataFusionError::Execution(format!("Failed to initialize GDAL runtime: {error}"))
    })?
    .map_err(DataFusionError::Execution)?;

    let schema = Arc::new(Schema::new(vec![RASTER.to_storage_field("raster", true)?]));

    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![Arc::new(raster_array) as ArrayRef],
    )?;
    let table = MemTable::try_new(schema, vec![vec![batch]])?;
    ctx.register_table(table_name, Arc::new(table))?;

    Ok(())
}

#[cfg(feature = "gdal")]
pub fn load_geotiff_buffer_to_memtable(
    ctx: &SessionContext,
    table_name: &str,
    data: &[u8],
) -> DFResult<()> {
    load_raster_buffer_to_memtable(ctx, table_name, "geotiff", data)
}

/// Stub for builds without GDAL support.
#[cfg(not(feature = "gdal"))]
pub fn load_raster_buffer_to_memtable(
    _ctx: &SessionContext,
    _table_name: &str,
    _format: &str,
    _data: &[u8],
) -> DFResult<()> {
    Err(DataFusionError::Execution(
        "Raster registration requires the full GDAL-enabled build".to_string(),
    ))
}

#[cfg(not(feature = "gdal"))]
pub fn load_geotiff_buffer_to_memtable(
    ctx: &SessionContext,
    table_name: &str,
    data: &[u8],
) -> DFResult<()> {
    load_raster_buffer_to_memtable(ctx, table_name, "geotiff", data)
}

#[cfg(feature = "gdal")]
fn raster_file_extension(format: &str) -> DFResult<&'static str> {
    match format.trim().to_ascii_lowercase().as_str() {
        "geotiff" | "gtiff" | "tiff" | "tif" => Ok("tiff"),
        _ => Err(DataFusionError::Execution(format!(
            "Unsupported raster format: {format}"
        ))),
    }
}

#[cfg(feature = "gdal")]
fn raster_driver_name(format: &str) -> DFResult<&'static str> {
    match format.trim().to_ascii_lowercase().as_str() {
        "geotiff" | "gtiff" | "tiff" | "tif" => Ok("GTiff"),
        _ => Err(DataFusionError::Execution(format!(
            "Unsupported raster format: {format}"
        ))),
    }
}

#[cfg(feature = "gdal")]
fn next_vsi_mem_file_path(table_name: &str, extension: &str) -> String {
    let suffix = VSI_FILE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let sanitized_name: String = table_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    format!("/vsimem/cereusdb-{sanitized_name}-{suffix}.{extension}")
}

#[cfg(feature = "gdal")]
unsafe fn open_gdal_dataset(
    path: &str,
    format: &str,
) -> std::result::Result<gdal_sys::GDALDatasetH, String> {
    let c_path = std::ffi::CString::new(path).map_err(|_| "Invalid VSI path".to_string())?;
    let driver_name = raster_driver_name(format).map_err(|error| error.to_string())?;
    let c_driver_name =
        std::ffi::CString::new(driver_name).map_err(|_| "Invalid GDAL driver".to_string())?;
    let allowed_drivers = [c_driver_name.as_ptr(), std::ptr::null()];
    gdal_sys::CPLErrorReset();

    let dataset = gdal_sys::GDALOpenEx(
        c_path.as_ptr(),
        sedona_gdal::gdal_dyn_bindgen::GDAL_OF_READONLY
            | sedona_gdal::gdal_dyn_bindgen::GDAL_OF_RASTER
            | sedona_gdal::gdal_dyn_bindgen::GDAL_OF_VERBOSE_ERROR,
        allowed_drivers.as_ptr(),
        std::ptr::null(),
        std::ptr::null(),
    );

    if dataset.is_null() {
        return Err(last_gdal_error("Failed to open raster dataset"));
    }

    Ok(dataset)
}

#[cfg(feature = "gdal")]
unsafe fn dataset_to_raster_struct(
    api: &'static sedona_gdal::gdal_api::GdalApi,
    dataset: gdal_sys::GDALDatasetH,
    format: &str,
) -> std::result::Result<StructArray, String> {
    use sedona_raster::builder::RasterBuilder;
    use sedona_raster::traits::{BandMetadata, RasterMetadata};
    use sedona_schema::raster::StorageType;

    let width = gdal_sys::GDALGetRasterXSize(dataset);
    let height = gdal_sys::GDALGetRasterYSize(dataset);
    let band_count = gdal_sys::GDALGetRasterCount(dataset);

    if width <= 0 || height <= 0 {
        return Err("Raster dataset has invalid raster dimensions".to_string());
    }
    if band_count <= 0 {
        return Err("Raster dataset contains no raster bands".to_string());
    }

    let mut geo_transform = [0.0_f64, 1.0_f64, 0.0_f64, 0.0_f64, 0.0_f64, -1.0_f64];
    if matches!(
        format.trim().to_ascii_lowercase().as_str(),
        "geotiff" | "gtiff" | "tiff" | "tif"
    ) {
        gdal_sys::CPLErrorReset();
        let _geo_transform_status =
            gdal_sys::GDALGetGeoTransform(dataset, geo_transform.as_mut_ptr());
    }

    let crs = dataset_crs_as_projjson(api, dataset)?;

    let raster_metadata = RasterMetadata {
        width: width as u64,
        height: height as u64,
        upperleft_x: geo_transform[0],
        upperleft_y: geo_transform[3],
        scale_x: geo_transform[1],
        scale_y: geo_transform[5],
        skew_x: geo_transform[2],
        skew_y: geo_transform[4],
    };

    let mut builder = RasterBuilder::new(1);
    builder
        .start_raster(&raster_metadata, crs.as_deref())
        .map_err(|error| format!("Failed to start raster builder: {error}"))?;

    for band_index in 1..=band_count {
        let band = gdal_sys::GDALGetRasterBand(dataset, band_index);
        if band.is_null() {
            return Err(last_gdal_error(&format!(
                "Failed to access raster band {band_index}"
            )));
        }

        let band_width = gdal_sys::GDALGetRasterBandXSize(band);
        let band_height = gdal_sys::GDALGetRasterBandYSize(band);
        if band_width != width || band_height != height {
            return Err(format!(
                "Raster band {band_index} dimensions ({band_width}x{band_height}) do not match dataset dimensions ({width}x{height})"
            ));
        }

        let gdal_data_type = gdal_sys::GDALGetRasterDataType(band);
        let band_data_type = map_gdal_band_data_type(gdal_data_type)?;
        let nodata_value = read_band_nodata_value(band, band_data_type);

        let pixel_count = usize::try_from(width)
            .ok()
            .and_then(|w| usize::try_from(height).ok().and_then(|h| w.checked_mul(h)))
            .ok_or_else(|| "Raster dimensions overflow host memory size".to_string())?;
        let buffer_len = pixel_count
            .checked_mul(band_data_type.byte_size())
            .ok_or_else(|| "Raster band byte size overflow".to_string())?;
        let mut band_bytes = vec![0_u8; buffer_len];

        builder
            .start_band(BandMetadata {
                nodata_value,
                storage_type: StorageType::InDb,
                datatype: band_data_type,
                outdb_url: None,
                outdb_band_id: None,
            })
            .map_err(|error| format!("Failed to start raster band: {error}"))?;

        gdal_sys::CPLErrorReset();
        let read_status = gdal_sys::GDALRasterIO(
            band,
            gdal_sys::GDALRWFlag::GF_Read,
            0,
            0,
            width,
            height,
            band_bytes.as_mut_ptr().cast(),
            width,
            height,
            gdal_data_type,
            0,
            0,
        );

        if read_status != gdal_sys::CPLErr::CE_None {
            return Err(last_gdal_error(&format!(
                "Failed to read raster band {band_index}"
            )));
        }

        builder.band_data_writer().append_value(&band_bytes);
        builder
            .finish_band()
            .map_err(|error| format!("Failed to finish raster band: {error}"))?;
    }

    builder
        .finish_raster()
        .map_err(|error| format!("Failed to finish raster row: {error}"))?;
    builder
        .finish()
        .map_err(|error| format!("Failed to build raster array: {error}"))
}

#[cfg(feature = "gdal")]
unsafe fn dataset_crs_as_projjson(
    api: &'static sedona_gdal::gdal_api::GdalApi,
    dataset: gdal_sys::GDALDatasetH,
) -> std::result::Result<Option<String>, String> {
    let spatial_ref_handle = gdal_sys::GDALGetSpatialRef(dataset);
    if spatial_ref_handle.is_null() {
        return Ok(None);
    }

    let spatial_ref = sedona_gdal::spatial_ref::SpatialRef::from_c_srs_clone(api, spatial_ref_handle)
        .map_err(|error| format!("Failed to clone raster spatial reference: {error}"))?;
    let projjson = spatial_ref
        .to_projjson()
        .map_err(|error| format!("Failed to export raster spatial reference as PROJJSON: {error}"))?;
    let projjson = projjson.trim();

    if projjson.is_empty() {
        Ok(None)
    } else {
        Ok(Some(projjson.to_string()))
    }
}

#[cfg(feature = "gdal")]
fn map_gdal_band_data_type(
    gdal_data_type: gdal_sys::GDALDataType::Type,
) -> std::result::Result<sedona_schema::raster::BandDataType, String> {
    use sedona_schema::raster::BandDataType;

    match gdal_data_type {
        gdal_sys::GDALDataType::GDT_Byte => Ok(BandDataType::UInt8),
        gdal_sys::GDALDataType::GDT_Int8 => Ok(BandDataType::Int8),
        gdal_sys::GDALDataType::GDT_UInt16 => Ok(BandDataType::UInt16),
        gdal_sys::GDALDataType::GDT_Int16 => Ok(BandDataType::Int16),
        gdal_sys::GDALDataType::GDT_UInt32 => Ok(BandDataType::UInt32),
        gdal_sys::GDALDataType::GDT_Int32 => Ok(BandDataType::Int32),
        gdal_sys::GDALDataType::GDT_UInt64 => Ok(BandDataType::UInt64),
        gdal_sys::GDALDataType::GDT_Int64 => Ok(BandDataType::Int64),
        gdal_sys::GDALDataType::GDT_Float32 => Ok(BandDataType::Float32),
        gdal_sys::GDALDataType::GDT_Float64 => Ok(BandDataType::Float64),
        _ => Err(format!(
            "Unsupported GDAL raster data type: {gdal_data_type}"
        )),
    }
}

#[cfg(feature = "gdal")]
fn read_band_nodata_value(
    band: gdal_sys::GDALRasterBandH,
    band_data_type: sedona_schema::raster::BandDataType,
) -> Option<Vec<u8>> {
    use sedona_schema::raster::BandDataType;

    let mut has_nodata = 0;
    let bytes = unsafe {
        match band_data_type {
            BandDataType::UInt8 => {
                (gdal_sys::GDALGetRasterNoDataValue(band, &mut has_nodata)
                    .round()
                    .clamp(u8::MIN as f64, u8::MAX as f64) as u8)
                    .to_le_bytes()
                    .to_vec()
            }
            BandDataType::Int8 => {
                (gdal_sys::GDALGetRasterNoDataValue(band, &mut has_nodata)
                    .round()
                    .clamp(i8::MIN as f64, i8::MAX as f64) as i8)
                    .to_le_bytes()
                    .to_vec()
            }
            BandDataType::UInt16 => {
                (gdal_sys::GDALGetRasterNoDataValue(band, &mut has_nodata)
                    .round()
                    .clamp(u16::MIN as f64, u16::MAX as f64) as u16)
                    .to_le_bytes()
                    .to_vec()
            }
            BandDataType::Int16 => {
                (gdal_sys::GDALGetRasterNoDataValue(band, &mut has_nodata)
                    .round()
                    .clamp(i16::MIN as f64, i16::MAX as f64) as i16)
                    .to_le_bytes()
                    .to_vec()
            }
            BandDataType::UInt32 => {
                (gdal_sys::GDALGetRasterNoDataValue(band, &mut has_nodata)
                    .round()
                    .clamp(u32::MIN as f64, u32::MAX as f64) as u32)
                    .to_le_bytes()
                    .to_vec()
            }
            BandDataType::Int32 => {
                (gdal_sys::GDALGetRasterNoDataValue(band, &mut has_nodata)
                    .round()
                    .clamp(i32::MIN as f64, i32::MAX as f64) as i32)
                    .to_le_bytes()
                    .to_vec()
            }
            BandDataType::UInt64 => gdal_sys::GDALGetRasterNoDataValueAsUInt64(
                band,
                &mut has_nodata,
            )
            .to_le_bytes()
            .to_vec(),
            BandDataType::Int64 => gdal_sys::GDALGetRasterNoDataValueAsInt64(
                band,
                &mut has_nodata,
            )
            .to_le_bytes()
            .to_vec(),
            BandDataType::Float32 => {
                (gdal_sys::GDALGetRasterNoDataValue(band, &mut has_nodata) as f32)
                    .to_le_bytes()
                    .to_vec()
            }
            BandDataType::Float64 => gdal_sys::GDALGetRasterNoDataValue(band, &mut has_nodata)
                .to_le_bytes()
                .to_vec(),
        }
    };

    if has_nodata == 0 {
        None
    } else {
        Some(bytes)
    }
}

#[cfg(feature = "gdal")]
fn last_gdal_error(default_message: &str) -> String {
    unsafe {
        let ptr = gdal_sys::CPLGetLastErrorMsg();
        if ptr.is_null() {
            return default_message.to_string();
        }

        let message = std::ffi::CStr::from_ptr(ptr)
            .to_string_lossy()
            .trim()
            .to_string();
        if message.is_empty() {
            default_message.to_string()
        } else {
            message
        }
    }
}

/// Load Parquet bytes into a MemTable and register on the SessionContext.
///
/// Uses the `parquet` crate to read the bytes synchronously into RecordBatches,
/// then wraps them in a MemTable that DataFusion can query.
pub async fn load_parquet_buffer_to_memtable(
    ctx: &SessionContext,
    table_name: &str,
    data: &[u8],
) -> DFResult<()> {
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

    let bytes = bytes::Bytes::copy_from_slice(data);
    let builder = ParquetRecordBatchReaderBuilder::try_new(bytes)
        .map_err(|e| datafusion::error::DataFusionError::External(Box::new(e)))?;
    let schema = builder.schema().clone();
    let reader = builder
        .build()
        .map_err(|e| datafusion::error::DataFusionError::External(Box::new(e)))?;

    let batches: Vec<RecordBatch> = reader.collect::<Result<Vec<_>, _>>()?;

    let table = MemTable::try_new(schema, vec![batches])?;
    ctx.register_table(table_name, Arc::new(table))?;

    Ok(())
}

/// Parse a GeoJSON string and register as a named table.
///
/// Creates a table with columns for each property in the GeoJSON features,
/// plus a `geometry` column containing WKB-encoded geometries.
pub fn load_geojson_to_memtable(
    ctx: &SessionContext,
    table_name: &str,
    geojson_str: &str,
) -> DFResult<()> {
    let geojson: geojson::GeoJson = geojson_str
        .parse()
        .map_err(|e| datafusion::error::DataFusionError::External(Box::new(
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("Invalid GeoJSON: {e}"))
        )))?;

    let features = match geojson {
        geojson::GeoJson::FeatureCollection(fc) => fc.features,
        geojson::GeoJson::Feature(f) => vec![f],
        geojson::GeoJson::Geometry(g) => {
            vec![geojson::Feature {
                bbox: None,
                geometry: Some(g),
                id: None,
                properties: None,
                foreign_members: None,
            }]
        }
    };

    if features.is_empty() {
        // Register empty table with just geometry column
        let schema = Arc::new(Schema::new(vec![Field::new(
            "geometry",
            DataType::Binary,
            true,
        )]));
        let table = MemTable::try_new(schema, vec![vec![]])?;
        ctx.register_table(table_name, Arc::new(table))?;
        return Ok(());
    }

    // For simplicity in Phase 1: store geometry as WKT text and all properties as JSON strings.
    // This allows full SQL access. Users can use ST_GeomFromWKT(geometry) in queries.
    let mut wkt_values: Vec<Option<String>> = Vec::with_capacity(features.len());
    let mut props_json: Vec<Option<String>> = Vec::with_capacity(features.len());

    for feature in &features {
        // Convert geometry to WKT
        let wkt_str = feature
            .geometry
            .as_ref()
            .map(|g| geojson_geometry_to_wkt(g));
        wkt_values.push(wkt_str);

        // Store properties as JSON string
        let props = feature
            .properties
            .as_ref()
            .map(|p| serde_json::to_string(p).unwrap_or_default());
        props_json.push(props);
    }

    let schema = Arc::new(Schema::new(vec![
        Field::new("geometry", DataType::Utf8, true),
        Field::new("properties", DataType::Utf8, true),
    ]));

    let geometry_array: ArrayRef = Arc::new(StringArray::from(wkt_values));
    let properties_array: ArrayRef = Arc::new(StringArray::from(props_json));

    let batch = RecordBatch::try_new(schema.clone(), vec![geometry_array, properties_array])?;

    let table = MemTable::try_new(schema, vec![vec![batch]])?;
    ctx.register_table(table_name, Arc::new(table))?;

    Ok(())
}

/// Convert a GeoJSON geometry to WKT string.
fn geojson_geometry_to_wkt(geom: &geojson::Geometry) -> String {
    use geojson::Value;
    match &geom.value {
        Value::Point(coords) => {
            format!("POINT({} {})", coords[0], coords[1])
        }
        Value::MultiPoint(points) => {
            let pts: Vec<String> = points
                .iter()
                .map(|c| format!("{} {}", c[0], c[1]))
                .collect();
            format!("MULTIPOINT({})", pts.join(", "))
        }
        Value::LineString(coords) => {
            let pts: Vec<String> = coords
                .iter()
                .map(|c| format!("{} {}", c[0], c[1]))
                .collect();
            format!("LINESTRING({})", pts.join(", "))
        }
        Value::MultiLineString(lines) => {
            let line_strs: Vec<String> = lines
                .iter()
                .map(|line| {
                    let pts: Vec<String> =
                        line.iter().map(|c| format!("{} {}", c[0], c[1])).collect();
                    format!("({})", pts.join(", "))
                })
                .collect();
            format!("MULTILINESTRING({})", line_strs.join(", "))
        }
        Value::Polygon(rings) => {
            let ring_strs: Vec<String> = rings
                .iter()
                .map(|ring| {
                    let pts: Vec<String> =
                        ring.iter().map(|c| format!("{} {}", c[0], c[1])).collect();
                    format!("({})", pts.join(", "))
                })
                .collect();
            format!("POLYGON({})", ring_strs.join(", "))
        }
        Value::MultiPolygon(polys) => {
            let poly_strs: Vec<String> = polys
                .iter()
                .map(|poly| {
                    let ring_strs: Vec<String> = poly
                        .iter()
                        .map(|ring| {
                            let pts: Vec<String> =
                                ring.iter().map(|c| format!("{} {}", c[0], c[1])).collect();
                            format!("({})", pts.join(", "))
                        })
                        .collect();
                    format!("({})", ring_strs.join(", "))
                })
                .collect();
            format!("MULTIPOLYGON({})", poly_strs.join(", "))
        }
        Value::GeometryCollection(geoms) => {
            let geom_strs: Vec<String> = geoms.iter().map(geojson_geometry_to_wkt).collect();
            format!("GEOMETRYCOLLECTION({})", geom_strs.join(", "))
        }
    }
}
