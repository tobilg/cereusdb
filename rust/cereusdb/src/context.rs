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

//! CereusDB session context setup for WASM.
//!
//! Creates a DataFusion SessionContext with:
//! - All pure-Rust spatial functions (ST_Point, ST_Distance, ST_AsText, etc.)
//! - Geo-based spatial functions (ST_Area, ST_Buffer, ST_Centroid, etc.)
//! - Information schema enabled

use datafusion::error::Result;
use datafusion::execution::session_state::SessionStateBuilder;
use datafusion::logical_expr::ScalarUDFImpl;
use datafusion::prelude::{SessionConfig, SessionContext};
#[cfg(feature = "spatial-join")]
use sedona_common::{
    option::{
        add_sedona_option_extension, ExecutionMode, NumSpatialPartitionsConfig, SedonaOptions,
        SpatialJoinDebugOptions, SpatialJoinOptions, SpatialLibrary,
    },
    sedona_internal_err,
};
use sedona_expr::function_set::FunctionSet;
use wasm_bindgen::JsValue;

#[cfg(feature = "random-geometry")]
use crate::random_geometry::register_random_geometry_function;
#[cfg(feature = "s2")]
use crate::s2_order::S2OrderLngLat;

#[cfg(feature = "spatial-join")]
const UNSUPPORTED_WASM_SCALAR_UDFS: &[&str] = &[];
#[cfg(not(feature = "spatial-join"))]
const UNSUPPORTED_WASM_SCALAR_UDFS: &[&str] = &["st_knn"];

fn console_log(msg: &str) {
    web_sys::console::log_1(&JsValue::from_str(msg));
}

/// Create a DataFusion SessionContext configured for WASM with spatial functions.
pub fn create_sedona_session_context() -> Result<SessionContext> {
    #[cfg(feature = "spatial-join")]
    let session_config = {
        let mut session_config = add_sedona_option_extension(
            SessionConfig::new()
                .with_information_schema(true)
                .with_target_partitions(1),
        );
        configure_wasm_spatial_join_options(&mut session_config)?;
        session_config
    };

    #[cfg(not(feature = "spatial-join"))]
    let session_config = SessionConfig::new().with_information_schema(true);

    #[cfg(feature = "spatial-join")]
    let state_builder = sedona_spatial_join::register_planner(
        SessionStateBuilder::new()
            .with_default_features()
            .with_config(session_config),
    )?;

    #[cfg(not(feature = "spatial-join"))]
    let state_builder = SessionStateBuilder::new()
        .with_default_features()
        .with_config(session_config);

    let ctx = SessionContext::new_with_state(state_builder.build());

    #[cfg(feature = "proj")]
    configure_proj_engine()?;

    #[cfg(feature = "gdal")]
    configure_gdal_engine()?;

    #[cfg(feature = "random-geometry")]
    register_random_geometry_function(&ctx);

    register_spatial_functions(&ctx)?;

    Ok(ctx)
}

#[cfg(feature = "spatial-join")]
fn configure_wasm_spatial_join_options(session_config: &mut SessionConfig) -> Result<()> {
    let Some(options) = session_config
        .options_mut()
        .extensions
        .get_mut::<SedonaOptions>()
    else {
        return sedona_internal_err!("SedonaOptions extension missing from SessionConfig");
    };

    options.spatial_join = SpatialJoinOptions {
        spatial_library: SpatialLibrary::Geos,
        execution_mode: ExecutionMode::PrepareNone,
        concurrent_build_side_collection: false,
        repartition_probe_side: false,
        parallel_refinement_chunk_size: 0,
        debug: SpatialJoinDebugOptions {
            num_spatial_partitions: NumSpatialPartitionsConfig::Fixed(1),
            memory_for_intermittent_usage: None,
            force_spill: false,
            random_seed: Some(0),
        },
        ..Default::default()
    };

    Ok(())
}

/// Register spatial functions from sedona-functions and sedona-geo crates.
fn register_spatial_functions(ctx: &SessionContext) -> Result<()> {
    // Register the default function set from sedona-functions.
    // Includes: ST_Point, ST_AsText, ST_AsBinary, ST_GeomFromWKT,
    // ST_GeomFromWKB, ST_Envelope, ST_FlipCoordinates, ST_SRID,
    // ST_SetSRID, ST_Dimension, ST_GeometryType, ST_NumGeometries,
    // ST_NPoints, ST_X, ST_Y, ST_Z, ST_XMin/Max, ST_YMin/Max, etc.
    console_log("[context] registering sedona-functions...");
    let function_set = sedona_functions::register::default_function_set();
    register_function_set(ctx, function_set);

    console_log("[context] registering sedona-geo scalars...");
    let geo_kernels = sedona_geo::register::scalar_kernels();
    let mut fs = FunctionSet::new();
    for (name, kernel_refs) in geo_kernels {
        let udf = fs.add_scalar_udf_impl(name, kernel_refs)?;
        ctx.register_udf(udf.clone().into());
    }

    console_log("[context] registering sedona-geo aggregates...");
    let geo_agg_kernels = sedona_geo::register::aggregate_kernels();
    for (name, acc_refs) in geo_agg_kernels {
        let udf = fs.add_aggregate_udf_kernel(name, acc_refs)?;
        ctx.register_udaf(udf.clone().into());
    }

    #[cfg(feature = "geos")]
    {
        console_log("[context] registering GEOS scalars...");
        let geos_kernels = sedona_geos::register::scalar_kernels();
        for (name, kernel_refs) in geos_kernels {
            let udf = fs.add_scalar_udf_impl(name, kernel_refs)?;
            ctx.register_udf(udf.clone().into());
        }

        console_log("[context] registering GEOS aggregates...");
        let geos_agg_kernels = sedona_geos::register::aggregate_kernels();
        for (name, acc_refs) in geos_agg_kernels {
            let udf = fs.add_aggregate_udf_kernel(name, acc_refs)?;
            ctx.register_udaf(udf.clone().into());
        }
    }

    #[cfg(feature = "proj")]
    {
        console_log("[context] registering PROJ functions...");
        let proj_kernels = sedona_proj::register::scalar_kernels();
        for (name, kernel_refs) in proj_kernels {
            let udf = fs.add_scalar_udf_impl(name, kernel_refs)?;
            ctx.register_udf(udf.clone().into());
        }
    }

    #[cfg(feature = "s2")]
    {
        let s2_kernels = sedona_s2geography::register::scalar_kernels()?;
        for (name, kernel_refs) in s2_kernels {
            let udf = fs.add_scalar_udf_impl(name, kernel_refs)?;
            ctx.register_udf(udf.clone().into());
        }

        console_log("[context] registering S2 sd_order override...");
        #[cfg(feature = "proj")]
        let sd_order_kernel = sedona_proj::sd_order_lnglat::OrderLngLat::new(
            sedona_s2geography::s2geography::s2_cell_id_from_lnglat,
        );
        #[cfg(not(feature = "proj"))]
        let sd_order_kernel =
            S2OrderLngLat::new(sedona_s2geography::s2geography::s2_cell_id_from_lnglat);
        let udf = fs.add_scalar_udf_impl("sd_order", sd_order_kernel)?;
        ctx.register_udf(udf.clone().into());
    }

    #[cfg(feature = "gdal")]
    {
        console_log("[context] registering raster functions...");
        let raster_function_set = sedona_raster_functions::register::default_function_set();
        register_function_set(ctx, raster_function_set);
    }

    console_log("[context] all functions registered");
    Ok(())
}

#[cfg(feature = "proj")]
fn configure_proj_engine() -> Result<()> {
    console_log("[context] configuring PROJ engine...");
    sedona_proj::register::configure_global_proj_engine(
        sedona_proj::register::ProjCrsEngineBuilder::default(),
    )
}

#[cfg(feature = "gdal")]
fn configure_gdal_engine() -> Result<()> {
    console_log("[context] configuring GDAL engine...");
    sedona_gdal::global::configure_global_gdal_api(sedona_gdal::global::GdalApiBuilder::default())
        .map_err(|error| datafusion::error::DataFusionError::Execution(format!(
            "Failed to configure GDAL engine: {error}"
        )))
}

/// Register a FunctionSet on a SessionContext.
fn register_function_set(ctx: &SessionContext, function_set: FunctionSet) {
    for udf in function_set.scalar_udfs() {
        if UNSUPPORTED_WASM_SCALAR_UDFS
            .iter()
            .any(|unsupported| udf.name().eq_ignore_ascii_case(unsupported))
        {
            console_log(&format!(
                "[context] skipping unsupported WASM scalar: {}",
                udf.name()
            ));
            continue;
        }
        ctx.register_udf(udf.clone().into());
    }
    for udf in function_set.aggregate_udfs() {
        ctx.register_udaf(udf.clone().into());
    }
}
