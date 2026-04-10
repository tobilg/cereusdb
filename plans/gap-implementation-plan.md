# Gap Implementation Plan

This plan operationalizes [gap-checklist.csv](/Users/tmueller/Development/gh/tobilg/cereusdb/plans/gap-checklist.csv) into phased execution work for `cereusdb`.

The plan uses three principles:

1. Use the pinned `deps/sedona-db` engine surface and local SedonaDB docs/runtime as the primary parity baseline.
2. Treat planner/runtime gaps separately from normal function-registration gaps.
3. Treat broader Apache Sedona website parity as optional cross-product scope, not as the default `cereusdb` gap list.

## Success Criteria

- Every implemented gap is reflected in:
  - runtime registration in [context.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/rust/cereusdb/src/context.rs)
  - browser API behavior where relevant in [index.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/src/index.ts)
  - package-specific Vitest coverage in [js/tests](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests)
  - updated status in [gap-checklist.csv](/Users/tmueller/Development/gh/tobilg/cereusdb/plans/gap-checklist.csv)
- Each shippable phase ends with:
  - `cargo check -p cereusdb`
  - `make test-js-geos`
  - `make test-js-geos-proj`
  - `make test-js-full`

## Phase 1

Objective: close the exact non-planner local SedonaDB parity gaps that look like normal runtime registration work.

Status: completed on April 6, 2026.

Scope:
- `ST_ClosestPoint`
- `ST_LineLocatePoint`
- `ST_MaxDistance`
- `RS_Contains`
- `RS_Intersects`
- `RS_Within`

Work items:
- Audit patched SedonaDB crates under `build/patched-sources/` and `deps/sedona-db` to confirm whether the missing functions already exist but are not registered, or whether they are absent earlier in the Rust engine.
- If they already exist upstream:
  - wire them into [context.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/rust/cereusdb/src/context.rs)
  - extend [geo-function-cases.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/support/geo-function-cases.ts) for `ST_*`
  - extend [raster.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/raster.test.ts) for `RS_*`
- If they do not exist upstream:
  - patch the relevant SedonaDB crates in `patches/sedona-db/`
  - keep write scope limited to the exact kernel/registration code

Files likely involved:
- [context.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/rust/cereusdb/src/context.rs)
- [patches/sedona-db](/Users/tmueller/Development/gh/tobilg/cereusdb/patches/sedona-db)
- [function-catalog.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/function-catalog.test.ts)
- [raster.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/raster.test.ts)

Exit criteria:
- All six functions appear in the correct package catalogs.
- `gap-checklist.csv` rows move from `missing_runtime` to `supported`.

Implementation notes:
- `ST_ClosestPoint`, `ST_LineLocatePoint`, and `ST_MaxDistance` were added through a SedonaDB GEOS patch and covered in the shared geo-function Vitest catalog.
- `RS_Contains`, `RS_Intersects`, and `RS_Within` now ship in the `full` package after enabling `sedona-raster-functions` spatial predicates, patching `sedona-tg` to build with `emcc` for `wasm32`, and storing raster CRS as PROJJSON during GDAL ingestion.
- The package matrix was revalidated with `make test-js-geos`, `make test-js-geos-proj`, and `make test-js-full`.

## Phase 2

Objective: bring planner-driven spatial joins and `ST_KNN` into the browser as a constrained WASM MVP, then document what remains outside native optimizer parity.

Status: completed on April 7, 2026.

Scope:
- Sedona spatial join planner registration in the WASM session builder
- optimized regular spatial joins in all public browser packages
- `ST_KNN` support in the browser under an explicitly constrained execution profile
- documentation of what broader optimizer parity is still out of scope

Support decision implemented:
- `ST_KNN` is now supported in `geos`, `geos-proj`, and `full`.
- The browser runtime uses a constrained join profile:
  - single spatial partition
  - in-memory only
  - sequential refinement
  - no spill/out-of-core execution

Why this remained a separate phase:
- Planner/runtime work is materially different from normal function-registration work.
- The browser MVP had to be validated as a planner-enabled execution mode, not just as a catalog change.

Work items:
- Wire `sedona_spatial_join::register_planner(...)` into the WASM `SessionStateBuilder` path.
- Add WASM-specific `SedonaOptions` so the join engine stays on a browser-safe execution profile.
- Re-enable `st_knn` registration once planner support is live.
- Add package tests for:
  - regular spatial joins planned as `SpatialJoinExec`
  - regular spatial join correctness
  - `ST_KNN` catalog presence
  - `ST_KNN` planning as `SpatialJoinExec`
  - `ST_KNN` correctness and predicate-precedence behavior
- Record the remaining optimizer limitations in the scope note.

Deliverable completed:
- [optimizer-parity-note.md](/Users/tmueller/Development/gh/tobilg/cereusdb/plans/optimizer-parity-note.md)

Exit criteria:
- `ST_KNN` is supported in the browser packages and covered by the dedicated Vitest suite.
- The optimizer note clearly distinguishes the supported browser MVP from still-missing native-style optimizer parity.

Implementation notes:
- The decisive runtime change is in [context.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/rust/cereusdb/src/context.rs): the WASM build now uses `SessionStateBuilder`, installs `SedonaOptions`, registers the spatial join planner, and enables `st_knn`.
- The browser MVP did not require a persistent SedonaDB source fork: the successful `prepare-sources` + package rebuild flow showed that constrained session options were sufficient for the current upstream `sedona-spatial-join` runtime.
- The package-aware Vitest suite now verifies `SpatialJoinExec` planning and `ST_KNN` behavior in [core.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/core.test.ts) and [knn.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/knn.test.ts).

## Phase 3

Objective: expand geography parity where the missing surface is likely to be tractable within SedonaDB/Rust.

Status: completed on April 7, 2026.

Scope:
- missing geography constructors/conversions visible in the local SedonaDB engine/runtime surface, with the public SedonaDB docs used as a secondary check where useful

Work items:
- Inventory actual upstream geography kernels available in the Rust engine.
- Compare that list to the current WASM runtime catalog.
- Add missing geography functions incrementally, starting with pure conversion helpers rather than more complex geodesic operations.

Suggested order:
1. constructors and aliases
2. geometry/geography conversion functions
3. remaining geography-specific helpers

Files likely involved:
- [context.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/rust/cereusdb/src/context.rs)
- SedonaDB patched source crates under `build/patched-sources/sedona-db/`
- [function-catalog.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/function-catalog.test.ts)
- [geography.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/geography.test.ts)

Exit criteria:
- Geography parity is described against actual SedonaDB/Rust kernels/runtime, not against the broader Apache Sedona site.

Implementation notes:
- The primary baseline for geography is the pinned SedonaDB engine/runtime surface. The public SedonaDB docs currently lag some runtime names, so Phase 3 followed the actual engine/runtime where needed instead of mirroring the broader Apache Sedona geography page.
- `ST_GeogFromEWKB`, `ST_GeogFromEWKT`, `ST_GeogToGeometry`, and `ST_GeomToGeography` were added through [0006-phase3-geography.patch](/Users/tmueller/Development/gh/tobilg/cereusdb/patches/sedona-db/0006-phase3-geography.patch).
- The package-aware Vitest suite now includes dedicated geography coverage in [geography.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/geography.test.ts) in addition to the runtime function-catalog coverage.
- Remaining geography gaps are now narrowed to website-level items that are still absent from the local SedonaDB/Rust surface, notably `ST_GeogFromGeoHash` and `ST_AsEWKT`.

## Phase 4

Objective: align raster API and documentation with the actual browser-safe raster surface.

Scope:
- current local SedonaDB/Rust `RS_*` catalog in the `full` package
- host-driven GeoTIFF/TIFF ingestion through the JS/WASM API
- explicit non-goals for now:
  - SQL-side raster loader functions
  - non-GeoTIFF browser raster ingestion

Work items:
- Verify the runtime `RS_*` catalog against `information_schema.routines`.
- Add a catalog-driven full-package test harness so every registered `RS_*` routine has a live case.
- Keep the browser raster story host-driven through `registerGeoTIFF()` / `registerRaster()` instead of inventing SQL loader semantics for browser memory.
- Keep the non-GeoTIFF GDAL blocker separate:
  - current experiments stalled in `GDALOpenEx` for non-GeoTIFF formats
  - do not advertise broader format support until a real fix exists
- Push any broader Apache Sedona raster-page deltas out of the active SedonaDB baseline and into the cross-product parity note.

Files likely involved:
- [io.rs](/Users/tmueller/Development/gh/tobilg/cereusdb/rust/cereusdb/src/io.rs)
- [index.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/src/index.ts)
- [raster.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/raster.test.ts)
- [raster-function-cases.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/support/raster-function-cases.ts)

Exit criteria:
- Raster API and SQL surface are aligned and honestly documented.

Implementation notes:
- The `full` package now exposes all `33` raster functions from the current local SedonaDB/Rust docs set.
- The package-aware Vitest suite validates the runtime raster catalog and now covers every registered `RS_*` routine in [raster.test.ts](/Users/tmueller/Development/gh/tobilg/cereusdb/js/tests/raster.test.ts).
- Browser raster ingestion remains host-driven through `registerGeoTIFF()` / `registerRaster()`; SQL-side raster loader functions are intentionally not part of the browser API.
- Non-GeoTIFF ingestion remains blocked and is explicitly treated as a separate GDAL/WASM debugging task rather than Phase 4 work.

## Phase 5

Objective: record broader Apache Sedona cross-product deltas that are outside the active SedonaDB baseline.

Status: completed on April 7, 2026.

Scope:
- Apache Sedona website-only geometry items such as:
  - `ST_GeomFromGML`
  - `ST_GeomFromKML`
  - `ST_GeomFromGeoHash`
  - `ST_DumpPoints`
- Apache Sedona website-only category areas:
  - spatial indexing
  - clustering
  - spatial statistics
  - address parsing
- Apache Sedona website-only geography/raster items such as:
  - `ST_GeogFromGeoHash`
  - `ST_AsEWKT`
  - raster tiles / map algebra / output categories that are not part of the current local SedonaDB/Rust raster surface

Work items:
- Mark these items as outside the active SedonaDB baseline.
- Distinguish between:
  - optional local patch candidates if broader cross-product parity is ever desired
  - optional upstream-first candidates if broader cross-product parity is ever desired
  - broader categories that remain outside current product scope
- Do not mix these items back into the active SedonaDB parity gap list unless product scope changes.

Exit criteria:
- A conscious scope decision exists for each broader Apache Sedona website-only area, and those items are no longer presented as active SedonaDB parity gaps.

Implementation notes:
- Phase 5 is a scope-decision phase, not a runtime implementation phase.
- The decisions are recorded in [website-parity-scope-note.md](/Users/tmueller/Development/gh/tobilg/cereusdb/plans/website-parity-scope-note.md).
- The key correction is that these items are outside the active SedonaDB baseline for this repo.
- Four narrow website-only helpers are now intentionally shipped as local extensions:
  - `ST_GeomFromGeoJSON`
  - `ST_MakeEnvelope`
  - `ST_ExteriorRing`
  - `ST_Expand`
- Remaining optional local patch candidates, if broader Apache Sedona cross-product parity is ever desired, are:
  - `ST_DumpPoints`
  - `ST_AsEWKT`
- Optional upstream-first candidates, if broader Apache Sedona cross-product parity is ever desired, are:
  - `ST_GeomFromGML`
  - `ST_GeomFromKML`
  - `ST_GeomFromGeoHash`
  - `ST_GeogFromGeoHash`
- Broader categories that remain outside current product scope include:
  - spatial indexing categories (`Bing`, `H3`, `S2`, `GeoHash`)
  - clustering
  - spatial statistics
  - address parsing / `libpostal`
  - broader website-only raster categories beyond the current local SedonaDB/Rust raster surface

## Phase 6

Objective: reduce surface confusion after the functional work lands.

Status: completed on April 7, 2026.

Scope:
- alias drift between runtime and docs
- README/API reporting
- generated surface snapshots

Work items:
- Document runtime aliases that are exposed but not individually represented in the local docs tree.
- Consider adding a generated catalog report under `plans/` or `docs/` that records package-specific function surfaces.
- Keep the checklist updated as the source of truth for planning status.

Exit criteria:
- Runtime/catalog/docs discrepancies are intentional and documented.

Implementation notes:
- Phase 6 was closed by adding a generated package-surface snapshot at [runtime-surface-report.md](/Users/tmueller/Development/gh/tobilg/cereusdb/plans/runtime-surface-report.md).
- The snapshot is regenerated by `make surface-report`, which rebuilds the `geos`, `geos-proj`, and `full` packages and records their runtime `ST_*` / `RS_*` catalogs.
- The report explicitly separates:
  - runtime-only names not represented as standalone local qmd pages
  - intentional package omissions such as `ST_Transform` in `geos` and raster functions outside `full`
- [README.md](/Users/tmueller/Development/gh/tobilg/cereusdb/README.md) now links to the generated report and documents the main runtime-only aliases and patch-added names so catalog drift is no longer implicit.

## Recommended Execution Order

1. Phase 1
2. Phase 2 scope note
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6

## Stop Conditions

Stop and re-evaluate if any of the following happens:

- a supposedly “missing runtime” function turns out to require broader upstream engine work
- raster predicate support depends on `sedona-tg` capabilities that are not browser-safe
- any planner/runtime work requires Tokio-like assumptions or spill/file behavior incompatible with browser WASM

## Checklist Maintenance Rule

After each completed work item:

1. Update the corresponding row in [gap-checklist.csv](/Users/tmueller/Development/gh/tobilg/cereusdb/plans/gap-checklist.csv)
2. Update package-specific tests
3. Re-run the package matrix
4. Update README/examples only for features that are actually verified

## Follow-On Work

Baseline SedonaDB parity work is complete. Browser-safe follow-on features that
still make sense under the current in-memory WASM model are tracked separately
in [browser-safe-follow-on-plan.md](/Users/tmueller/Development/gh/tobilg/cereusdb/plans/browser-safe-follow-on-plan.md).
