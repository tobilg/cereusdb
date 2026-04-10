# S2 Feasibility Spike

Date: April 9, 2026

## Goal

Test whether upstream `sedona-s2geography` can be built for the current browser
WASM toolchain with Emscripten, before any runtime integration work begins.

## Commands Run

Toolchain check:

```bash
command -v emcc
emcc --version
command -v emcmake
```

Dependency discovery check:

```bash
find /opt/homebrew -path '*absl*Config.cmake' -o -path '*OpenSSLConfig.cmake'
```

Emscripten configure attempt:

```bash
emcmake cmake \
  -S deps/sedona-db/c/sedona-s2geography \
  -B /tmp/s2-spike \
  -DCMAKE_BUILD_TYPE=Release
```

Second configure attempt with the host OpenSSL root forced:

```bash
emcmake cmake \
  -S deps/sedona-db/c/sedona-s2geography \
  -B /tmp/s2-spike \
  -DCMAKE_BUILD_TYPE=Release \
  -DOPENSSL_ROOT_DIR=/opt/homebrew/Cellar/openssl@3/3.6.0
```

## Result

The original host-toolchain spike is blocked at configure time, but the isolated
vcpkg-backed spike succeeds.

Initial blocker with plain `emcmake cmake`:

- `sedona-s2geography` requires `find_package(OpenSSL REQUIRED)` in
  `deps/sedona-db/c/sedona-s2geography/CMakeLists.txt`
- the Emscripten configure step could not find a browser-targeted OpenSSL
  package
- `sedona-s2geography` also requires `find_package(absl REQUIRED)` in the same
  CMake file, and no Abseil CMake package was found in the local browser
  toolchain

That first failure was:

```text
Could NOT find OpenSSL (missing: OPENSSL_CRYPTO_LIBRARY OPENSSL_INCLUDE_DIR)
```

Follow-up vcpkg-backed spike:

```bash
make s2-spike-vcpkg VCPKG_ROOT=/Users/tmueller/vcpkg \
  S2_SPIKE_BUILD_DIR=build/s2-vcpkg-spike-v2
```

Outcome:

- `abseil:wasm32-emscripten` built successfully through vcpkg
- `openssl:wasm32-emscripten` built successfully through vcpkg
- `sedona-s2geography` configured successfully against those target libraries
- the full native spike target `geography_glue` built successfully under
  `wasm32-emscripten`

## Interpretation

S2 is no longer blocked on fundamental browser toolchain feasibility.

The real result is:

- host package-manager lookup is not sufficient for browser builds
- vcpkg with the `wasm32-emscripten` community triplet is sufficient to supply
  `OpenSSL` and `absl`
- `sedona-s2geography` itself can build under Emscripten once those deps are
  provided correctly

So the next question is product cost, not feasibility:

- whether we want to carry vcpkg as an optional S2-only dependency path
- whether the eventual size increase is acceptable once linked into
  `cereusdb`
- whether we want an opt-in S2 package variant rather than folding S2 into the
  default browser builds

## Focused Runtime Debug

After wiring an opt-in `geos-s2` browser build, the remaining blocker turned out
to be a wasm constructor problem, not an S2 toolchain problem.

Confirmed working:

- the module instantiates successfully
- `sedona_s2geography::register::scalar_kernels()` returns all `18` S2 kernels
- the current `sd_order` lng/lat override works in the S2 package variants
- a no-opt S2 build can execute primitive-return exports like `Date::now()`

Confirmed failing in the unpatched S2-linked artifact:

- `js_sys::Object::new()` hangs, even as the first exported wasm call
- any second wasm-bindgen export call hangs, even for a trivial primitive-return
  export
- `CereusDB.create()` hangs when full S2 scalar registration is enabled

What is actually happening:

- wasm-bindgen export shims call `__wasm_call_ctors` on every exported function
  call
- in the S2-linked build, `__wasm_call_ctors` includes S2-related C++ global
  constructors such as `_GLOBAL__sub_I_mutable_s2shape_index.cc`,
  `_GLOBAL__sub_I_s2cell_union.cc`, `_GLOBAL__sub_I_s2loop.cc`, and
  `_GLOBAL__sub_I_s2polygon.cc`
- the `js_sys::Object::new()` path goes through an externref shim that calls
  `__externref_table_alloc.command_export`
- that command export calls `__wasm_call_ctors` again, recursively, inside the
  same top-level wasm export

So the first-call object-return failure and the later second-export failure have
the same root cause: repeated or recursive `__wasm_call_ctors` in the S2-linked
artifact.

Temporary proof-of-fix:

1. build a no-opt full-S2 artifact
2. patch the generated wasm so `__wasm_call_ctors` becomes a no-op
3. instantiate that patched wasm with the existing JS wrapper

With that temporary patch:

- repeated exported calls work
- `js_sys::Object::new()` works
- `CereusDB.create()` succeeds with full S2 scalar registration enabled
- a geography query such as `ST_Distance(ST_GeogFromWKT(...), ST_GeogFromWKT(...))`
  executes and returns a sensible spherical result

Conclusion:

- full S2 geography support is browser-viable
- the remaining engineering task is to make constructor execution effectively
  one-shot in the S2-linked wasm build, or otherwise prevent internal
  wasm-bindgen shims from re-entering `__wasm_call_ctors`

## Productized Fix

The constructor issue can be fixed without wasm post-processing.

Implemented fix:

- export `__wasm_call_ctors` from the final Rust/WASM link when native C/C++
  features are enabled
- call `wasm.__wasm_call_ctors()` exactly once during JS wrapper initialization,
  before `__wbindgen_start()`

This avoids repeated or recursive constructor entry from wasm-bindgen command
exports in the S2-linked artifact.

Validated outcomes:

- `geos-proj-s2` builds and passes its JS package tests
- `full = geos+proj+gdal+s2` builds and passes its JS package tests
- full S2 geography queries execute in the browser-targeted artifact, including
  geography distance and the existing `sd_order` override

## Current Recommendation

Treat S2 as part of the high-end browser package path, not as a default patch to
the small builds.

Current package state:

- `geos`: no PROJ, no S2
- `geos-proj`: PROJ, no S2
- `geos-proj-s2`: full S2 geography plus PROJ
- `full`: GEOS + PROJ + GDAL + S2

Remaining decision:

- whether this four-package matrix is the long-term public contract, or
- whether another naming cleanup is worth doing later

## Size Note

Final `cereusdb` package sizes are available for the S2-bearing public
packages:

- `geos-proj-s2`: about `43M` raw, `12.0 MB` gzip
- `full`: about `50M` raw, `14.5 MB` gzip

These are the real browser artifact numbers for the current S2-enabled public
packages.

However, the native spike produced these static libraries:

- `build/s2-vcpkg-spike-v2/libs2.a`: about `2.6M`
- `build/s2-vcpkg-spike-v2/s2geography/libs2geography.a`: about `869K`
- `build/s2-vcpkg-spike-v2/libgeography_glue.a`: about `7.8K`

The vcpkg install root for the S2 stack is about `61M`, with the most relevant
target libraries including:

- `libcrypto.a`: about `5.3M`
- `libssl.a`: about `1.2M`

These numbers are not equivalent to final wasm delta, but they confirm that S2
will not be free in size terms.
