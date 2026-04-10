# Optimizer And Planner Scope Note

This note records the current planner/optimizer status for `cereusdb`.

Date: April 7, 2026

## Summary

`cereusdb` now includes a browser-safe MVP of SedonaDB's spatial join planner
path in all public packages (`geos`, `geos-proj`, `full`).

What is supported now:

- optimized regular spatial joins planned as `SpatialJoinExec`
- distance joins planned as `SpatialJoinExec`
- `ST_KNN` join support
- the current Sedona planner semantics around KNN predicate precedence and
  post-filter behavior, as covered by the package Vitest suite

What is still not claimed:

- full native optimizer parity
- spill-to-disk or out-of-core spatial join execution
- multi-partition browser spatial joins
- native-style broadcast index join orchestration
- raster-join-specific optimizer work

## Evidence In The Current Codebase

### WASM path

The WASM session builder in [context.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/rust/cereusdb/src/context.rs)
now uses `SessionStateBuilder`, installs `SedonaOptions`, calls
`sedona_spatial_join::register_planner(...)`, and builds the `SessionContext`
from that configured state.

It also sets browser-specific spatial join options:

- `num_spatial_partitions = 1`
- `concurrent_build_side_collection = false`
- `repartition_probe_side = false`
- `parallel_refinement_chunk_size = 0`
- `execution_mode = PrepareNone`
- `force_spill = false`

### Native Sedona path

The native Sedona context in [context.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/deps/sedona-db/rust/sedona/src/context.rs)
still goes further: it supports the broader native execution model, native file
formats, URL-table access, and the memory/spill assumptions that are normal in
hosted execution environments.

### `ST_KNN`

`ST_KNN` remains a stub UDF in
[st_knn.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/deps/sedona-db/rust/sedona-functions/src/st_knn.rs).
Direct scalar execution still errors with `Can't execute ST_KNN() outside a
spatial join`, which is correct. The actual behavior comes from planner rewrite
plus `SpatialJoinExec`.

### Spatial join runtime assumptions

The upstream `sedona-spatial-join` crate still contains native-style async and
spill-oriented code paths, including `tokio::sync::Notify`,
`SpawnedTask::spawn_blocking(...)`, repartitioning, and spill-file readers.

The current browser MVP works by staying off those paths through constrained
session options and in-memory execution, not by claiming those paths are fully
browser-safe.

## Decision Matrix

| Item | Current WASM status | Decision |
|---|---|---|
| Spatial join planner registration | Enabled | Supported in browser MVP |
| Regular spatial join planning (`ST_Contains`, `ST_Intersects`, etc.) | Enabled | Supported in browser MVP |
| Distance join planning (`ST_DWithin`, `ST_Distance(...) < literal`) | Enabled | Supported in browser MVP |
| `ST_KNN` join support | Enabled | Supported in browser MVP |
| KNN predicate precedence / post-filter semantics | Covered by browser tests | Supported in browser MVP |
| Verified relation predicates | `ST_Intersects`, `ST_Contains`, `ST_Within`, `ST_Covers`, `ST_CoveredBy`, `ST_Touches`, `ST_Crosses`, `ST_Overlaps`, `ST_Equals` | Supported in browser MVP |
| Broader planner coverage beyond the current verified relation/distance matrix | Not yet claimed broadly | Revisit if product scope expands |
| Spill-to-disk spatial join execution | Not supported | Out of scope for current browser MVP |
| Multi-partition out-of-core spatial join execution | Not supported | Out of scope for current browser MVP |
| Broadcast index join orchestration | Not supported as a browser target | Out of scope for now |
| Raster join optimization | Not supported as a browser target | Out of scope for now |
| Datasource/file pushdown in the native Sedona sense | Not part of current browser ingestion model | Out of scope until datasource integration changes |

## Important Nuance

This note is about optimizer parity, not about whether spatial SQL joins work in
the browser.

Today, the browser build does support:

- planner-driven spatial joins
- planner-driven distance joins
- `SpatialJoinExec` in physical plans
- `ST_KNN` joins

What it does not support is the full native execution envelope that depends on
spill files, larger repartitioned workflows, or native runtime assumptions.

## Current Browser MVP Limits

The current spatial join / KNN support should be understood as:

- single spatial partition
- in-memory only
- sequential refinement
- no spill files
- no out-of-core multi-partition execution

The current browser KNN contract is also narrower than the generic SQL
signature might suggest:

- supported:
  - `ST_KNN(q.geom, o.geom)`
  - `ST_KNN(q.geom, o.geom, k)`
  - `ST_KNN(q.geom, o.geom, k, literal_use_spheroid)`
- not supported:
  - non-literal `k`
  - non-literal `use_spheroid`
  - geography inputs
  - `OR`-composed predicates that would require planner extraction through `OR`

These limits are intentional and documented in [README.md](/Users/tmueller/Development/gh/tobilg/cereusdb/README.md).

## Reconsideration Triggers

Revisit this scope if at least one of the following becomes true:

1. Browser product requirements clearly need larger-scale spatial joins beyond
   the current in-memory MVP.
2. We decide to port multi-partition and spill-capable execution to browser
   storage/runtime primitives.
3. We want explicit parity claims for broader optimizer areas such as broadcast
   index joins or raster join planning.
4. We add package tests that verify broader optimizer behavior beyond the
   current regular-spatial-join and `ST_KNN` coverage.

## Recommended Future Path If Reopened

If broader optimizer parity is reopened later, the recommended order is:

1. Keep the current single-partition browser MVP as the stable baseline.
2. Audit every remaining native-style runtime assumption in
   `sedona-spatial-join`.
3. Decide whether to:
   - adapt the upstream runtime for browser constraints, or
   - implement a smaller WASM-specific extension path for multi-partition work.
4. Only then widen the public browser claims beyond the current MVP.

## Resulting Roadmap Consequence

Phase 2 is now complete with supported browser join planning:

- `ST_KNN` is supported
- optimized spatial joins are supported
- distance joins are supported
- broader native optimizer parity remains explicitly out of scope
