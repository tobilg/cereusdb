# S2 Geography And Random Geometry Plan

Date: April 9, 2026

Current status:

- Phase 1 completed on April 8, 2026: `sd_random_geometry` is now implemented in `cereusdb`
- Phase 2 completed on April 8, 2026: the plain host-toolchain path is blocked, but the isolated vcpkg-backed spike successfully builds `geography_glue` under `wasm32-emscripten`
- The S2 spike path now exists via `make s2-vcpkg-bootstrap`, `make s2-vcpkg-install`, and `make s2-spike-vcpkg`
- Phase 3 completed on April 9, 2026: `geos-proj-s2` now exposes the full native S2 geography kernel family in browser WASM
- Phase 4 completed on April 9, 2026: the public package matrix is now `geos`, `geos-proj`, `geos-proj-s2`, and `full = geos+proj+gdal+s2`
- Remaining decision: whether this four-package matrix should be treated as final, or renamed later for product clarity

## Goal

Add two native SedonaDB capabilities that are still absent from `cereusdb`:

- `sd_random_geometry` table function
- S2 geography scalar kernel family

These should be treated as separate tracks with different complexity:

- `sd_random_geometry`: low-to-medium complexity, mostly Rust/DataFusion wiring
- S2 geography: high complexity, because it introduces a new C++/CMake toolchain and likely a large browser size increase

## Baseline

Relevant upstream integration points:

- native context registers `sd_random_geometry` in `deps/sedona-db/rust/sedona/src/context.rs`
- native context registers S2 in `deps/sedona-db/rust/sedona/src/context.rs`
- S2 kernels live in `deps/sedona-db/c/sedona-s2geography`
- `sd_random_geometry` implementation lives in `deps/sedona-db/rust/sedona/src/random_geometry_provider.rs`

Current WASM gaps:

- `rust/cereusdb/src/context.rs` does not register `sd_random_geometry`
- `rust/cereusdb/Cargo.toml` has no `sedona-s2geography` dependency or feature
- the current Emscripten build chain has no S2/Abseil/OpenSSL build path

## Phase 1: Ship `sd_random_geometry`

Reason: this is the easier native feature and gives immediate value for browser demos, tests, and benchmarks.

Work:

- add a local WASM-side table function registration in `rust/cereusdb/src/context.rs`
- decide whether to:
  - depend directly on `sedona-testing`, or
  - copy the minimal `RandomGeometryProvider` implementation into `cereusdb`
- prefer a dedicated optional feature such as `random-geometry` if we want to avoid shipping test-oriented code in all packages
- expose and document the SQL form:
  - `SELECT * FROM sd_random_geometry('{...json options...}')`

Verification:

- add JS/Vitest coverage for deterministic seeded output
- test row counts, partition-independent behavior, and invalid argument errors

Exit criteria:

- `sd_random_geometry` is present in `information_schema.routines`
- query results are deterministic with a fixed seed

## Phase 2: S2 feasibility spike

Reason: S2 is the risky part. Do not begin by wiring SQL names before the native toolchain works.

Work:

- inspect `deps/sedona-db/c/sedona-s2geography/build.rs` and `CMakeLists.txt` requirements
- identify required third-party pieces for browser builds:
  - S2
  - Abseil
  - OpenSSL or any crypto/TLS pieces transitively required by the upstream build
- prove whether `sedona-s2geography` can be built under Emscripten at all
- measure binary-size impact from a minimal build

Likely repo touch points:

- `scripts/emscripten/*`
- `Makefile`
- `patches/sedona-db/*` only if WASM-specific patches are required

Exit criteria:

- one successful `cargo check -p cereusdb` with `sedona-s2geography` linked under Emscripten
- a rough raw/gzip size delta for the artifact

Stop condition:

- if the C++ dependency chain is not browser-viable without major upstream surgery, stop here and record S2 as non-goal

## Phase 3: Minimal S2 runtime integration

Reason: once the library builds, integrate the smallest useful supported slice first.

Work:

- add `sedona-s2geography` as an optional dependency in `rust/cereusdb/Cargo.toml`
- add an `s2geography` feature and package policy:
  - do not include in the default `geos` build
  - likely include only in a new opt-in build variant, or in `full` if size is acceptable
- mirror native registration in `rust/cereusdb/src/context.rs`
- register the `sd_order` override that native SedonaDB installs for S2 geography

Implemented:

- `sedona-s2geography` is an opt-in wasm dependency
- `geos-proj-s2` and `full` carry the S2-enabled browser path
- the browser runtime now exposes the native S2 scalar kernel family plus the
  S2-backed `sd_order` override
- the constructor issue in the S2-linked artifact is fixed by exporting
  `__wasm_call_ctors` and calling it exactly once during JS init

Verification:

- package catalog assertions
- focused S2 tests
- `npm run test:geos-proj-s2`
- `npm run test:full`

## Phase 4: Contract hardening and package decisions

Reason: S2 will likely be expensive in size and should not silently bloat the main browser package.

Work:

- decide final package strategy:
  - separate S2-enabled build, recommended
  - or fold into `full` only if size remains acceptable
- document semantic differences between planar geometry and spherical geography
- add README guidance on when to use S2 vs existing geography helpers
- add size-reporting targets and compare raw/gzip/Brotli deltas

Implemented:

- package policy is explicit: S2 is present only in the upper two public packages
- size impact is documented for `geos-proj-s2`
- size impact is documented for `full`
- browser test coverage exists for the supported S2 surface

Current measured sizes:

- `geos-proj-s2`: `43M` raw, `12.0 MB` gzip
- `full`: `50M` raw, `14.5 MB` gzip

Open product decision:

- keep the current four-package matrix, or
- rename the high-end packages later for semantic clarity

## Recommended order

1. Implement `sd_random_geometry`
2. Run the S2 feasibility spike
3. Integrate the opt-in S2 runtime slice
4. Decide whether `full` should adopt S2 after reviewing the measured artifact cost

## Complexity summary

- `sd_random_geometry`: low-to-medium
  - mostly Rust/DataFusion work
  - main decision is whether depending on `sedona-testing` in production is acceptable

- S2 geography: high
  - new C++ browser build path
  - likely patching around Emscripten constraints
  - possible large binary impact
  - requires package-level product decisions, not just code wiring
