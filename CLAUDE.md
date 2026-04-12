# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is CereusDB

CereusDB compiles Apache SedonaDB (a spatial SQL engine built on DataFusion/Arrow) to WebAssembly for browser use. Cross-compiled C++ dependencies (GEOS, PROJ, GDAL, S2) are built via Emscripten as static archives and linked into a single WASM module targeting `wasm32-unknown-unknown`.

## Build Commands

Prerequisites: Rust stable with `wasm32-unknown-unknown` target, Emscripten SDK, wasm-pack, binaryen (wasm-opt), Node.js.

```
make deps                # Initialize git submodules
make prepare-sources     # Apply patches from patches/ onto deps/ into build/patched-sources/
make check               # cargo check -p cereusdb (prepares sources first)

make build-minimal       # GEOS only → dist/minimal
make build-standard      # GEOS + PROJ → dist/standard
make build-global        # GEOS + PROJ + S2 → dist/global
make build-full          # GEOS + PROJ + S2 + GDAL → dist/full

make test-js-minimal     # Build minimal + run Vitest
make test-js-standard    # Build standard + run Vitest
make test-js-global      # Build global + run Vitest
make test-js-full        # Build full + run Vitest (alias: make test-js)

make package-minimal     # Assemble @cereusdb/minimal npm package
make package-all         # Assemble all four npm packages
make sync-versions       # Sync packages/*/package.json versions from Cargo.toml
make serve               # Start Vite playground on http://127.0.0.1:8080
make size-report         # Build all variants and report WASM sizes
make surface-report      # Regenerate plans/runtime-surface-report.md
```

Run the narrowest package target that covers your change: `minimal` for GEOS-only, `standard` for PROJ, `global` for S2, `full` for raster/GDAL.

## Architecture

### Rust Workspace

- **`rust/cereusdb/`** — Main WASM crate (`cdylib`). `lib.rs` exports the `CereusDB` struct via `wasm_bindgen` and provides C ABI shims (`malloc`/`free`) for Emscripten-compiled C++ code. Feature flags (`geos`, `proj`, `s2`, `gdal`, `spatial-join`) control which SedonaDB spatial functions are compiled in.
- **`rust/cereusdb-object-store/`** — WASM-compatible in-memory object store adapter for DataFusion. Remote files are fetched entirely into memory (no streaming range requests).
- **`context.rs`** — Creates the DataFusion `SessionContext`, registers ST_*/RS_* functions by feature flag, constrains spatial joins to 1 partition / in-memory / no spill.
- **`io.rs`** — Browser I/O: fetch via `web_sys`, Parquet/GeoJSON/GeoTIFF loading. GeoJSON is stored as WKT strings (requires `ST_GeomFromWKT()` in queries).

### Dependency Pipeline

Submodules in `deps/` are never modified directly. `scripts/prepare-patched-sources.sh` exports them via `git archive` and applies patch series from `patches/` into `build/patched-sources/`. The root `Cargo.toml` uses `[patch.crates-io]` to redirect `geos-sys`, `proj-sys`, `gdal-sys` to these patched copies.

Emscripten C/C++ libraries are built by scripts in `scripts/emscripten/` into `build/sysroot/lib/`. `scripts/build.sh` conditionally builds them if not already present, then links them via `RUSTFLAGS` `-l static=...` flags.

### JavaScript Layer

- **`js/src/index.ts`** — TypeScript wrapper around wasm-bindgen output. Provides the public API: `CereusDB.create()`, `db.sql()` (returns Arrow IPC), `db.sqlJSON()`, file registration methods.
- **`js/tests/`** — Vitest tests split by capability (core, proj, raster, s2, geography, etc.). Tests load WASM bytes from disk via `wasmSource` option, bypassing browser fetch.
- **`pkg/`** — Symlink to whichever `dist/<variant>` was last built. The JS wrapper imports from `../../pkg/cereusdb.js`.

### npm Packages

Four graduated variants published as `@cereusdb/{minimal,standard,global,full}` under `packages/`. These are shells assembled by `scripts/build-npm-package.mjs` which rewrites the import path and copies WASM files. `packages/playground` is a React/Vite browser playground. `packages/documentation` is a Typedoc site.

## Coding Conventions

- Rust: `rustfmt` defaults, 4-space indent. TypeScript: 2-space indent, ES modules.
- SQL function names follow upstream SedonaDB: `ST_*` for spatial, `RS_*` for raster.
- Dependency changes go in `patches/` as `.patch` files, never edit submodules directly.
- New tests go in `js/tests/` as `*.test.ts`.
- Commits: short imperative subjects. PRs should state which package variants are affected and note WASM size changes.
