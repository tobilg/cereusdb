# Repository Guidelines

## Project Structure & Module Organization
`rust/cereusdb` contains the main WASM runtime and SQL/session wiring. `rust/cereusdb-object-store` holds the browser object-store bridge. `js/` is the internal TypeScript wrapper/test harness. Publishable npm package shells live in `packages/minimal`, `packages/standard`, `packages/global`, and `packages/full`; Typedoc source and deployment config live in `packages/documentation`; the browser playground lives in `packages/playground`. `scripts/` contains the build, patching, packaging, and size-report entry points. Third-party code lives in `deps/` as submodules. Local changes to upstream dependencies belong in `patches/`; `build/patched-sources/` is generated and should not be edited directly. Public build outputs are written to `dist/minimal`, `dist/standard`, `dist/global`, and `dist/full`.

## Build, Test, and Development Commands
- `make deps`: initialize all dependency submodules.
- `make prepare-sources`: generate patched source trees under `build/`.
- `make check`: run `cargo check -p cereusdb`.
- `make build-minimal`, `make build-standard`, `make build-global`, `make build-full`: build the public browser packages.
- `make package-minimal`, `make package-standard`, `make package-global`, `make package-full`: assemble the publishable `@cereusdb/*` npm packages under `packages/`.
- `make package-all`: assemble all four publishable npm packages.
- `make sync-versions`: sync `packages/*/package.json` versions from `Cargo.toml`.
- `make install-playground-deps`: install `packages/playground` dependencies.
- `make build-playground`: build the Vite playground against the assembled `@cereusdb/standard` package.
- `make test-js-minimal`, `make test-js-standard`, `make test-js-global`, `make test-js-full`: build the selected package and run Vitest.
- `make size-minimal`, `make size-standard`, `make size-global`, `make size-full`: rebuild a package and report its WASM size.
- `make size-report`: rebuild all browser packages and print raw/compressed WASM sizes.
- `make surface-report`: regenerate `plans/runtime-surface-report.md`.
- `make serve`: start the Vite playground on `http://127.0.0.1:8080`.
Technical build flags stay explicit in `scripts/build.sh`, for example `--with-geos`, `--with-proj`, `--with-s2`, and `--with-gdal`.

## Coding Style & Naming Conventions
Follow existing language conventions: Rust uses `rustfmt` defaults and 4-space indentation; TypeScript tests and wrapper code use 2-space indentation and ES module syntax. Prefer descriptive `snake_case` in Rust and `camelCase` in TypeScript. Keep new SQL function names aligned with upstream SedonaDB naming (`ST_*`, `RS_*`). When touching vendored behavior, add or update a patch in `patches/` instead of editing a submodule as the source of truth.

## Testing Guidelines
Vitest is the JS/WASM test framework; tests live in `js/tests/` and are split by package capability (`core`, `proj`, `raster`, `function-catalog`, `geography`). Name new tests `*.test.ts`. Run the narrowest package target that covers your change, then rerun the broader package if shared code changed: `minimal` for GEOS-only work, `standard` for PROJ work, `global` for S2 geography work, `full` for raster/GDAL work. For Rust-only changes, run `make check`; for dependency patches, also verify the relevant browser package target.

## Commit & Pull Request Guidelines
Recent history uses short imperative subjects (`Fix`, `Optimizations`, `Working build`). Keep commits concise, imperative, and specific; prefer `Add ST_GeomFromGeoJSON tests` over `Updates`. PRs should state which public package variants are affected (`minimal`, `standard`, `global`, `full`), list the commands run, and call out size changes when WASM artifacts or `packages/*` publish payloads move materially. Include screenshots only for example-page or browser-UI changes.
