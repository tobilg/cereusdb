# Browser-Safe Follow-On Feature Plan

Date: April 8, 2026

Status: completed on April 8, 2026.

This plan covers features that still make sense under the current browser WASM
execution model:

- single-process
- in-memory
- single-partition for optimized spatial joins
- no spill/out-of-core execution

These are not active SedonaDB parity gaps. They are follow-on features that can
improve browser capability, correctness, and usability without pretending the
WASM runtime supports native-scale execution.

## Goals

1. Expand the validated spatial join surface beyond the current `ST_Contains`
   and `ST_KNN` coverage.
2. Harden KNN semantics and document the exact browser-safe contract.
3. Add browser-safe SQL/runtime features whose value is not tied to spill,
   repartitioning, or large-scale execution.

## Non-Goals

- multi-partition spatial joins
- spill-to-disk or out-of-core execution
- broadcast/shuffle join orchestration
- raster-join-specific optimizer work

## Phase A: Distance Join MVP

Objective: validate and, if needed, fix planner-driven distance joins in the
same constrained join path already used for regular relation joins and
`ST_KNN`.

Scope:

- `ST_DWithin(left.geom, right.geom, distance)`
- `ST_Distance(left.geom, right.geom) < distance`
- literal distance first
- optional side-specific distance expressions only after literal coverage is
  stable

Files likely involved:

- [deps/sedona-db/rust/sedona-spatial-join/src/planner/spatial_expr_utils.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/deps/sedona-db/rust/sedona-spatial-join/src/planner/spatial_expr_utils.rs)
- [deps/sedona-db/rust/sedona-spatial-join/src/spatial_predicate.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/deps/sedona-db/rust/sedona-spatial-join/src/spatial_predicate.rs)
- [rust/cereusdb/src/context.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/rust/cereusdb/src/context.rs)
- new [js/tests/distance-join.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/distance-join.test.ts)

Work items:

1. Add `EXPLAIN` and correctness tests for both `ST_DWithin` and
   `ST_Distance(...) < literal`.
2. Confirm they plan as `SpatialJoinExec`, not as a plain nested-loop join.
3. If a case falls back incorrectly, patch predicate extraction or planner
   matching in `sedona-spatial-join`.
4. Document the supported distance-join syntax in [README.md](/Users/tmueller/Development/gh/tobilg/cereusdb/README.md).

Exit criteria:

- Distance joins are verified in `geos`, `geos-proj`, and `full`.
- The optimizer note explicitly lists distance joins as supported in the WASM
  MVP.

Implementation notes:

- The current upstream `sedona-spatial-join` planner already handled the target
  distance predicates correctly for the browser MVP.
- The phase closed by adding package tests for `ST_DWithin` and
  `ST_Distance(...) < literal`, then verifying they plan as `SpatialJoinExec`
  and execute correctly in all public browser packages.

## Phase B: Relation Join Coverage Matrix

Objective: widen verified planner coverage across the relation predicates that
`sedona-spatial-join` already models.

Target predicates:

- `ST_Intersects`
- `ST_Contains`
- `ST_Within`
- `ST_Covers`
- `ST_CoveredBy`
- `ST_Touches`
- `ST_Crosses`
- `ST_Overlaps`
- `ST_Equals`

Files likely involved:

- [deps/sedona-db/rust/sedona-spatial-join/src/spatial_predicate.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/deps/sedona-db/rust/sedona-spatial-join/src/spatial_predicate.rs)
- [deps/sedona-db/rust/sedona-spatial-join/src/planner/spatial_expr_utils.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/deps/sedona-db/rust/sedona-spatial-join/src/planner/spatial_expr_utils.rs)
- [js/tests/core.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/core.test.ts)
- new [js/tests/relation-join.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/relation-join.test.ts)

Work items:

1. Build a small predicate matrix with geometries chosen to avoid ambiguous
   topology.
2. Add `EXPLAIN` and result tests for every relation type.
3. Verify inverse handling for `contains/within` and `covers/coveredby`.
4. Patch planner inversion or predicate extraction only if the matrix exposes a
   real issue.

Exit criteria:

- Every supported relation predicate has at least one planner test and one
  correctness test.
- README and optimizer note stop speaking only in terms of “regular spatial
  joins” and list the verified relations explicitly.

Implementation notes:

- The verified relation matrix now covers:
  `ST_Intersects`, `ST_Contains`, `ST_Within`, `ST_Covers`,
  `ST_CoveredBy`, `ST_Touches`, `ST_Crosses`, `ST_Overlaps`, and
  `ST_Equals`.
- The suite also verifies the planner inversion path for
  `contains/within` and `covers/coveredby` when geometry arguments are
  reversed relative to join inputs.

## Phase C: KNN Hardening

Objective: keep the current KNN MVP but make its supported semantics explicit
and well-tested.

Files likely involved:

- [js/tests/knn.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/knn.test.ts)
- [deps/sedona-db/docs/reference/sql-joins.md](/Users/tmueller/Development/gh/tobilg/cereusdb/deps/sedona-db/docs/reference/sql-joins.md)
- [plans/optimizer-parity-note.md](/Users/tmueller/Development/gh/tobilg/cereusdb/plans/optimizer-parity-note.md)
- [README.md](/Users/tmueller/Development/gh/tobilg/cereusdb/README.md)

Work items:

1. Add tests for default-argument forms:
   - `ST_KNN(q.geom, o.geom)`
   - `ST_KNN(q.geom, o.geom, k)`
2. Add failure tests for unsupported expression shapes:
   - non-literal `k`
   - non-literal `use_spheroid`
   - geography inputs
   - `OR` compositions that should not be rewritten as KNN joins
3. Verify pushdown/post-filter behavior for query-side versus object-side
   predicates.
4. Decide whether `use_spheroid=true` should be accepted, rejected, or
   documented as parser-level but not materially different in the browser MVP.

Exit criteria:

- The browser KNN contract is explicit and test-backed.
- Unsupported forms fail clearly instead of degrading silently.

Implementation notes:

- The browser KNN suite now covers default-argument forms,
  query-side/object-side filter behavior, literal `use_spheroid=true`,
  and unsupported shapes such as non-literal `k`, non-literal
  `use_spheroid`, geography inputs, and `OR`-composed predicates.

## Phase D: Browser-Safe Surface Additions

Objective: add useful SQL/runtime features whose value is correctness or
convenience, not large-scale execution.

Priority order:

1. `ST_AsEWKT`
2. `ST_DumpPoints`
3. broader raster input formats only after the current `GDALOpenEx` browser
   blocker is isolated

Files likely involved:

- [patches/sedona-db](/Users/tmueller/Development/gh/tobilg/cereusdb/patches/sedona-db)
- [js/tests/geography.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/geography.test.ts)
- [js/tests/raster.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/raster.test.ts)
- [plans/website-parity-scope-note.md](/Users/tmueller/Development/gh/tobilg/cereusdb/plans/website-parity-scope-note.md)

Work items:

1. Implement `ST_AsEWKT` as a local extension if geography serialization is
   needed.
2. Reopen `ST_DumpPoints` only if there is a concrete downstream use case.
3. Treat non-GeoTIFF raster formats as a separate GDAL/WASM debugging task, not
   as planner work.

Exit criteria:

- Every added surface extension has a concrete browser use case and package
  tests.

Implementation notes:

- `ST_AsEWKT` was added as a local extension through
  [0009-browser-safe-follow-on.patch](/Users/tmueller/Development/gh/tobilg/cereusdb/patches/sedona-db/0009-browser-safe-follow-on.patch)
  and is now covered by the geography tests and the runtime function-catalog
  suite.
- `ST_DumpPoints` remains intentionally unimplemented because there is still no
  concrete browser-side use case for it.
- Broader non-GeoTIFF raster ingestion remains a separate GDAL/WASM debugging
  problem, not part of the completed follow-on phases.

## Recommended Execution Order

1. Phase A: distance joins
2. Phase B: relation join matrix
3. Phase C: KNN hardening
4. Phase D: browser-safe surface additions

## Verification Gates

After each completed phase:

1. `cargo check -p cereusdb`
2. `make test-js-geos`
3. `make test-js-geos-proj`
4. `make test-js-full`

## Stop Conditions

Stop and re-evaluate if:

- a feature depends on multi-partition or spill behavior to be useful
- planner support exists upstream but the browser MVP would need hidden runtime
  fallbacks to pass
- a proposed surface addition requires a new heavyweight native dependency or a
  browser-hostile parser/runtime path
