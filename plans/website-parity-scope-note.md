# Broader Apache Sedona Parity Scope Note

Date: April 7, 2026

## Decision

The active baseline for `cereusdb` is SedonaDB:

1. the pinned `deps/sedona-db` engine surface
2. the local SedonaDB docs/runtime snapshot in this repo
3. the public SedonaDB docs as a secondary check

The public SedonaDB docs can lag the pinned runtime surface in this repo, so
they are not the only source of truth for parity decisions.

The broader Apache Sedona website is not the default parity baseline for this
repo. Items that exist only on the broader Apache Sedona site should not be
treated as active `cereusdb` feature gaps unless product scope explicitly
expands beyond SedonaDB parity.

Broader Apache Sedona website-only items are split into four buckets:

## 1. Implemented Local Extensions

These broader Apache Sedona website-only helpers are now intentionally shipped
as local extensions in `cereusdb`, even though they are outside the active
SedonaDB baseline.

- `ST_GeomFromGeoJSON`
- `ST_MakeEnvelope`
- `ST_ExteriorRing`
- `ST_Expand`
- `ST_AsEWKT`

Why:

- they are narrow, browser-safe helpers
- they fit cleanly into the current Rust/WASM runtime architecture
- they do not imply planner work or new heavyweight native dependencies

## 2. Remaining Local Patch Candidates

These are narrow, browser-safe helpers that could reasonably be implemented in
the local SedonaDB patch series if we ever explicitly choose to pursue broader
Apache Sedona cross-product parity.

- `ST_DumpPoints`

Why:

- they do not imply planner work
- they do not imply new heavyweight native dependencies
- they look like ordinary geometry/geography helpers or serializers

## 3. Upstream-First Candidates

These should be treated as SedonaDB/Rust engine-surface additions first, not as
WASM-specific wiring work, if broader Apache Sedona cross-product parity ever
becomes a goal.

- `ST_GeomFromGML`
- `ST_GeomFromKML`
- `ST_GeomFromGeoHash`
- `ST_GeogFromGeoHash`

Why:

- they add new parser/format/kernel surface at the engine layer
- they are not unique to browser WASM
- carrying them only as local WASM patches would create avoidable divergence

Reopen rule:

- prefer upstream SedonaDB/Rust work first
- only do a temporary local patch if there is a concrete product requirement and
  upstream timing is not acceptable

## 4. Current Browser Non-Goals

These are intentionally outside the current browser roadmap unless product scope
changes materially.

- spatial indexing functions (`Bing`, `H3`, `S2`, `GeoHash`)
- clustering functions (`DBSCAN`, `LOF`)
- spatial statistics functions
- address parsing / `libpostal` functions
- broader raster website-only categories such as tiles, map algebra, and output
  functions that are not part of the current local SedonaDB/Rust raster surface

Why:

- they materially widen the analytical/product scope
- several imply substantial upstream engine work
- some imply new dependency/runtime stories that are not browser-friendly today

## Guidance

- Do not describe these website-only items as “missing WASM wiring” unless they
  already exist in the local SedonaDB engine surface used by this repo.
- Use [gap-checklist.csv](/Users/tmueller/Development/gh/tobilg/cereusdb/plans/gap-checklist.csv)
  as the planning source of truth.
- Reopen any broader Apache Sedona website-only item only with an explicit
  user/product requirement to go beyond SedonaDB parity.
