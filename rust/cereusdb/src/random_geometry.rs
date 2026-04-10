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

use std::{any::Any, fmt::Debug, sync::Arc};

use arrow_schema::{DataType, SchemaRef};
use async_trait::async_trait;
use datafusion::catalog::TableFunctionImpl;
use datafusion::execution::context::TaskContext;
use datafusion::physical_plan::execution_plan::{Boundedness, EmissionType};
use datafusion::physical_plan::expressions::Column;
use datafusion::physical_plan::projection::ProjectionExec;
use datafusion::physical_plan::stream::RecordBatchStreamAdapter;
use datafusion::physical_plan::{Partitioning, PhysicalExpr, SendableRecordBatchStream};
use datafusion::{
    catalog::{Session, TableProvider},
    common::Result,
    datasource::TableType,
    physical_expr::EquivalenceProperties,
    physical_plan::{DisplayAs, DisplayFormatType, ExecutionPlan, PlanProperties},
    prelude::Expr,
};
use datafusion_common::{plan_err, DataFusionError, ScalarValue};
use geo_types::Rect;
use sedona_common::sedona_internal_err;
use sedona_geometry::types::GeometryTypeId;
use sedona_testing::datagen::RandomPartitionedDataBuilder;
use serde::{Deserialize, Serialize};

#[derive(Debug, Default)]
pub struct RandomGeometryFunction;

impl TableFunctionImpl for RandomGeometryFunction {
    fn call(&self, exprs: &[Expr]) -> Result<Arc<dyn TableProvider>> {
        if exprs.len() != 1 {
            return plan_err!(
                "sd_random_geometry() expected 1 argument but got {}",
                exprs.len()
            );
        }

        if let Expr::Literal(scalar, _) = &exprs[0] {
            if let ScalarValue::Utf8(Some(options_str)) = scalar.cast_to(&DataType::Utf8)? {
                let builder = RandomPartitionedDataBuilder::new();
                return Ok(Arc::new(RandomGeometryProvider::try_new(
                    builder,
                    Some(options_str),
                )?));
            }
        }

        plan_err!(
            "Expected literal in sd_random_geometry() but got {}",
            &exprs[0]
        )
    }
}

#[derive(Debug)]
struct RandomGeometryProvider {
    builder: RandomPartitionedDataBuilder,
    num_partitions: usize,
    rows_per_batch: usize,
    num_rows: usize,
}

impl RandomGeometryProvider {
    fn try_new(mut builder: RandomPartitionedDataBuilder, options: Option<String>) -> Result<Self> {
        let options = if let Some(options_str) = options {
            match serde_json::from_str::<RandomGeometryFunctionOptions>(&options_str) {
                Ok(options) => Some(options),
                Err(e) => {
                    return plan_err!("Failed to parse options: {e}\nOptions were: {options_str}")
                }
            }
        } else {
            None
        };

        let mut num_partitions = 1;
        let mut rows_per_batch = 1024;
        let mut num_rows = 1024;

        if let Some(options) = options {
            if let Some(opt_num_partitions) = options.num_partitions {
                num_partitions = opt_num_partitions;
            }

            if let Some(opt_rows_per_batch) = options.rows_per_batch {
                rows_per_batch = opt_rows_per_batch;
            }

            if let Some(opt_num_rows) = options.num_rows {
                num_rows = opt_num_rows;
            }

            if let Some(seed) = options.seed {
                builder = builder.seed(seed);
            } else {
                builder = builder.seed(
                    (std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis()
                        % u32::MAX as u128) as u64,
                );
            }
            if let Some(null_rate) = options.null_rate {
                builder = builder.null_rate(null_rate);
            }
            if let Some(geom_type) = options.geom_type {
                builder = builder.geometry_type(geom_type);
            }
            if let Some(bounds) = options.bounds {
                let bounds = Rect::new((bounds.0, bounds.1), (bounds.2, bounds.3));
                builder = builder.bounds(bounds);
            }
            if let Some(size_range) = options.size {
                builder = builder.size_range(size_range);
            }
            if let Some(vertices_range) = options.num_vertices {
                builder = builder.vertices_per_linestring_range(vertices_range);
            }
            if let Some(empty_rate) = options.empty_rate {
                builder = builder.empty_rate(empty_rate);
            }
            if let Some(hole_rate) = options.hole_rate {
                builder = builder.polygon_hole_rate(hole_rate);
            }
            if let Some(parts_range) = options.num_parts {
                builder = builder.num_parts_range(parts_range);
            }
        }

        builder.validate()?;

        Ok(Self {
            builder,
            num_partitions,
            rows_per_batch,
            num_rows,
        })
    }
}

#[async_trait]
impl TableProvider for RandomGeometryProvider {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn schema(&self) -> SchemaRef {
        self.builder.schema()
    }

    fn table_type(&self) -> TableType {
        TableType::View
    }

    async fn scan(
        &self,
        _state: &dyn Session,
        projection: Option<&Vec<usize>>,
        _filters: &[Expr],
        _limit: Option<usize>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        let (builder, last_partition_rows) = builder_with_partition_sizes(
            self.builder.clone(),
            self.rows_per_batch,
            self.num_partitions,
            self.num_rows,
        );

        let exec = Arc::new(RandomGeometryExec::new(builder, last_partition_rows));

        if let Some(projection) = projection {
            let schema = self.schema();
            let exprs: Vec<_> = projection
                .iter()
                .map(|index| -> (Arc<dyn PhysicalExpr>, String) {
                    let name = schema.field(*index).name();
                    (Arc::new(Column::new(name, *index)), name.clone())
                })
                .collect();
            Ok(Arc::new(ProjectionExec::try_new(exprs, exec)?))
        } else {
            Ok(exec)
        }
    }
}

#[derive(Debug)]
struct RandomGeometryExec {
    builder: RandomPartitionedDataBuilder,
    last_partition_rows: usize,
    properties: PlanProperties,
}

impl RandomGeometryExec {
    fn new(builder: RandomPartitionedDataBuilder, last_partition_rows: usize) -> Self {
        let properties = PlanProperties::new(
            EquivalenceProperties::new(builder.schema().clone()),
            Partitioning::UnknownPartitioning(1),
            EmissionType::Incremental,
            Boundedness::Bounded,
        );

        Self {
            builder,
            last_partition_rows,
            properties,
        }
    }
}

impl DisplayAs for RandomGeometryExec {
    fn fmt_as(&self, _t: DisplayFormatType, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(
            f,
            "RandomGeometryExec: builder={:?}, last_partition_rows={}",
            self.builder, self.last_partition_rows
        )
    }
}

impl ExecutionPlan for RandomGeometryExec {
    fn name(&self) -> &str {
        "RandomGeometryExec"
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn schema(&self) -> SchemaRef {
        self.builder.schema()
    }

    fn properties(&self) -> &PlanProperties {
        &self.properties
    }

    fn children(&self) -> Vec<&Arc<dyn ExecutionPlan>> {
        Vec::new()
    }

    fn with_new_children(
        self: Arc<Self>,
        _: Vec<Arc<dyn ExecutionPlan>>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        Ok(self)
    }

    fn execute(
        &self,
        partition: usize,
        _context: Arc<TaskContext>,
    ) -> Result<SendableRecordBatchStream> {
        if partition != 0 {
            return sedona_internal_err!(
                "Can't read partition {partition} from RandomGeometryExec"
            );
        }

        let iter = SequentialPartitionIterator::new(self.builder.clone(), self.last_partition_rows);
        let stream = Box::pin(futures::stream::iter(iter));
        let record_batch_stream = RecordBatchStreamAdapter::new(self.schema(), stream);
        Ok(Box::pin(record_batch_stream))
    }
}

struct RowLimitedIterator {
    reader: Option<Box<dyn arrow_array::RecordBatchReader + Send>>,
    limit: usize,
    rows_consumed: usize,
}

impl RowLimitedIterator {
    fn new(reader: Box<dyn arrow_array::RecordBatchReader + Send>, limit: usize) -> Self {
        Self {
            reader: Some(reader),
            limit,
            rows_consumed: 0,
        }
    }
}

impl Iterator for RowLimitedIterator {
    type Item = Result<arrow_array::RecordBatch>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.rows_consumed >= self.limit {
            self.reader = None;
            return None;
        }

        let reader = self.reader.as_mut()?;
        match reader.next() {
            Some(Ok(batch)) => {
                let batch_rows = batch.num_rows();

                if self.rows_consumed + batch_rows <= self.limit {
                    self.rows_consumed += batch_rows;
                    Some(Ok(batch))
                } else {
                    let rows_to_take = self.limit - self.rows_consumed;
                    self.rows_consumed = self.limit;
                    self.reader = None;
                    Some(Ok(batch.slice(0, rows_to_take)))
                }
            }
            Some(Err(e)) => {
                self.reader = None;
                Some(Err(DataFusionError::from(e)))
            }
            None => {
                self.reader = None;
                None
            }
        }
    }
}

struct SequentialPartitionIterator {
    builder: RandomPartitionedDataBuilder,
    current_partition: usize,
    current_reader: Option<Box<dyn Iterator<Item = Result<arrow_array::RecordBatch>> + Send>>,
    last_partition_rows: usize,
}

impl SequentialPartitionIterator {
    fn new(builder: RandomPartitionedDataBuilder, last_partition_rows: usize) -> Self {
        Self {
            builder,
            current_partition: 0,
            current_reader: None,
            last_partition_rows,
        }
    }

    fn next_reader(
        &mut self,
    ) -> Option<Box<dyn Iterator<Item = Result<arrow_array::RecordBatch>> + Send>> {
        if self.current_partition >= self.builder.num_partitions {
            return None;
        }

        let partition = self.current_partition;
        self.current_partition += 1;

        let rng = RandomPartitionedDataBuilder::default_rng(self.builder.seed + partition as u64);
        let reader = self.builder.partition_reader(rng, partition);

        if partition == (self.builder.num_partitions - 1) {
            Some(Box::new(RowLimitedIterator::new(
                reader,
                self.last_partition_rows,
            )))
        } else {
            Some(Box::new(reader.map(|item| match item {
                Ok(batch) => Ok(batch),
                Err(error) => Err(DataFusionError::from(error)),
            })))
        }
    }
}

impl Iterator for SequentialPartitionIterator {
    type Item = Result<arrow_array::RecordBatch>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.current_reader.is_none() {
                self.current_reader = self.next_reader();
            }

            let reader = self.current_reader.as_mut()?;
            match reader.next() {
                Some(Ok(batch)) => return Some(Ok(batch)),
                Some(Err(error)) => {
                    self.current_reader = None;
                    return Some(Err(error));
                }
                None => {
                    self.current_reader = None;
                }
            }
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct RandomGeometryFunctionOptions {
    num_partitions: Option<usize>,
    rows_per_batch: Option<usize>,
    num_rows: Option<usize>,
    seed: Option<u64>,
    null_rate: Option<f64>,
    geom_type: Option<GeometryTypeId>,
    bounds: Option<(f64, f64, f64, f64)>,
    #[serde(default, deserialize_with = "deserialize_scalar_or_range")]
    size: Option<(f64, f64)>,
    #[serde(default, deserialize_with = "deserialize_scalar_or_range")]
    num_vertices: Option<(usize, usize)>,
    empty_rate: Option<f64>,
    hole_rate: Option<f64>,
    #[serde(default, deserialize_with = "deserialize_scalar_or_range")]
    num_parts: Option<(usize, usize)>,
}

fn builder_with_partition_sizes(
    builder: RandomPartitionedDataBuilder,
    batch_size: usize,
    partitions: usize,
    num_rows: usize,
) -> (RandomPartitionedDataBuilder, usize) {
    let rows_for_one_batch_per_partition = batch_size * partitions;
    let batches_per_partition = if num_rows.is_multiple_of(rows_for_one_batch_per_partition) {
        num_rows / rows_for_one_batch_per_partition
    } else {
        num_rows / rows_for_one_batch_per_partition + 1
    };

    let builder_out = builder
        .rows_per_batch(batch_size)
        .num_partitions(partitions)
        .batches_per_partition(batches_per_partition);
    let normal_partition_rows = batches_per_partition * batch_size;
    let remainder = (normal_partition_rows * partitions) - num_rows;
    let last_partition_rows = if remainder == 0 {
        normal_partition_rows
    } else {
        normal_partition_rows - remainder
    };
    (builder_out, last_partition_rows)
}

fn deserialize_scalar_or_range<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<(T, T)>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de> + Copy,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum ScalarOrRange<T> {
        Scalar(T),
        Range((T, T)),
    }

    match Option::<ScalarOrRange<T>>::deserialize(deserializer)? {
        None => Ok(None),
        Some(ScalarOrRange::Scalar(val)) => Ok(Some((val, val))),
        Some(ScalarOrRange::Range(range)) => Ok(Some(range)),
    }
}

pub fn register_random_geometry_function(ctx: &datafusion::prelude::SessionContext) {
    ctx.register_udtf("sd_random_geometry", Arc::new(RandomGeometryFunction));
}
