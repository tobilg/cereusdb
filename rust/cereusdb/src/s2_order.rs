use std::{fmt::Debug, sync::Arc};

use arrow_array::builder::UInt64Builder;
use arrow_schema::DataType;
use datafusion_common::{exec_err, DataFusionError, Result};
use datafusion_expr::ColumnarValue;
use sedona_expr::scalar_udf::SedonaScalarKernel;
use sedona_functions::executor::WkbBytesExecutor;
use sedona_geometry::wkb_header::WkbHeader;
use sedona_schema::{crs::lnglat, datatypes::SedonaType, matchers::ArgMatcher};

/// Minimal `sd_order` implementation for S2-only browser packages.
///
/// Without PROJ, this kernel only supports geometry/geography inputs that are
/// already expressed in lon/lat. `geos-proj-s2` keeps using the PROJ-backed
/// implementation from `sedona-proj`.
pub struct S2OrderLngLat<F> {
    order_fn: F,
}

impl<F: Fn((f64, f64)) -> u64> S2OrderLngLat<F> {
    pub fn new(order_fn: F) -> Self {
        Self { order_fn }
    }
}

impl<F: Fn((f64, f64)) -> u64> Debug for S2OrderLngLat<F> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S2OrderLngLat").finish()
    }
}

impl<F: Fn((f64, f64)) -> u64 + Send + Sync> SedonaScalarKernel for S2OrderLngLat<F> {
    fn return_type(&self, args: &[SedonaType]) -> Result<Option<SedonaType>> {
        let matcher = ArgMatcher::new(
            vec![ArgMatcher::is_geometry_or_geography()],
            SedonaType::Arrow(DataType::UInt64),
        );
        matcher.match_args(args)
    }

    fn invoke_batch(
        &self,
        arg_types: &[SedonaType],
        args: &[ColumnarValue],
    ) -> Result<ColumnarValue> {
        match &arg_types[0] {
            SedonaType::Wkb(_, maybe_crs) | SedonaType::WkbView(_, maybe_crs)
                if maybe_crs.is_some() && maybe_crs != &lnglat() =>
            {
                return exec_err!(
                    "sd_order requires lon/lat geometries in the S2-only browser build; use the PROJ-enabled package for projected inputs"
                );
            }
            _ => {}
        }

        let executor = WkbBytesExecutor::new(arg_types, args);
        let mut builder = UInt64Builder::with_capacity(executor.num_iterations());

        executor.execute_wkb_void(|maybe_wkb| {
            match maybe_wkb {
                Some(wkb_bytes) => {
                    let header = WkbHeader::try_new(wkb_bytes)
                        .map_err(|error| DataFusionError::Execution(format!("{error}")))?;
                    let order = (self.order_fn)(header.first_xy());
                    builder.append_value(order);
                }
                None => builder.append_null(),
            }

            Ok(())
        })?;

        executor.finish(Arc::new(builder.finish()))
    }
}
