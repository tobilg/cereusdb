#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

FEATURES=""
BUILD_GEOS=false
BUILD_PROJ=false
BUILD_GDAL=false
BUILD_S2=false
OUT_DIR=""
LINK_PKG=true

append_feature() {
    local feature="$1"
    case ",$FEATURES," in
        *,"$feature",*) ;;
        *) FEATURES="${FEATURES:+$FEATURES,}$feature" ;;
    esac
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --with-geos) BUILD_GEOS=true; append_feature geos ;;
        --with-proj) BUILD_PROJ=true; append_feature proj ;;
        --with-gdal) BUILD_GDAL=true; append_feature gdal ;;
        --with-s2) BUILD_S2=true; append_feature s2 ;;
        --full) BUILD_GEOS=true; BUILD_PROJ=true; BUILD_GDAL=true; BUILD_S2=true; FEATURES="geos,proj,gdal,s2" ;;
        --out-dir) OUT_DIR="$2"; shift ;;
        --no-link-pkg) LINK_PKG=false ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
    shift
done

if [ "$BUILD_GDAL" = true ]; then
    BUILD_GEOS=true
    BUILD_PROJ=true
    BUILD_S2=true
    append_feature geos
    append_feature proj
    append_feature s2
fi

if [ "$BUILD_S2" = true ]; then
    BUILD_GEOS=true
    BUILD_PROJ=true
    append_feature geos
    append_feature proj
fi

if [ "$BUILD_PROJ" = true ] && [ "$BUILD_GEOS" != true ]; then
    BUILD_GEOS=true
    append_feature geos
fi

if [ "$BUILD_GEOS" != true ] && [ "$BUILD_PROJ" != true ] && [ "$BUILD_GDAL" != true ] && [ "$BUILD_S2" != true ]; then
    BUILD_GEOS=true
    append_feature geos
fi

if [ -n "$OUT_DIR" ]; then
    mkdir -p "$(dirname "$OUT_DIR")"
    OUT_DIR="$(cd "$(dirname "$OUT_DIR")" 2>/dev/null && pwd)/$(basename "$OUT_DIR")" || exit 1
fi

VARIANT="geos"
if [ "$BUILD_GEOS" = true ] && [ "$BUILD_PROJ" = true ] && [ "$BUILD_GDAL" = true ] && [ "$BUILD_S2" = true ]; then
    VARIANT="full"
elif [ "$BUILD_GEOS" = true ] && [ "$BUILD_PROJ" = true ] && [ "$BUILD_S2" = true ]; then
    VARIANT="geos-proj-s2"
elif [ "$BUILD_GEOS" = true ] && [ "$BUILD_PROJ" = true ]; then
    VARIANT="geos-proj"
fi

OUT_DIR="${OUT_DIR:-$ROOT_DIR/dist/$VARIANT}"

echo "=== CereusDB Build ==="
echo "Package:  $VARIANT"
echo "Features: ${FEATURES:-geos}"
echo "Out dir:  $OUT_DIR"

bash "$SCRIPT_DIR/prepare-patched-sources.sh"

# Build C/C++ deps if requested and not already built
if [ "$BUILD_GEOS" = true ] && [ ! -f "$ROOT_DIR/build/sysroot/lib/libgeos_c.a" ]; then
    command -v emcc >/dev/null 2>&1 || { echo "Error: emcc not found"; exit 1; }
    echo "--- Building GEOS ---"
    mkdir -p "$ROOT_DIR/build"
    bash "$SCRIPT_DIR/emscripten/build-geos.sh" "$ROOT_DIR/build/geos" "$ROOT_DIR/build/sysroot"
fi

if [ "$BUILD_PROJ" = true ] && [ ! -f "$ROOT_DIR/build/sysroot/lib/libproj.a" ]; then
    command -v emcc >/dev/null 2>&1 || { echo "Error: emcc not found"; exit 1; }
    echo "--- Building PROJ ---"
    mkdir -p "$ROOT_DIR/build"
    bash "$SCRIPT_DIR/emscripten/build-proj.sh" "$ROOT_DIR/build/proj" "$ROOT_DIR/build/sysroot"
fi

if [ "$BUILD_GDAL" = true ] && [ ! -f "$ROOT_DIR/build/sysroot/lib/libgdal.a" ]; then
    command -v emcc >/dev/null 2>&1 || { echo "Error: emcc not found"; exit 1; }
    echo "--- Building GDAL ---"
    mkdir -p "$ROOT_DIR/build"
    bash "$SCRIPT_DIR/emscripten/build-gdal.sh" "$ROOT_DIR/build/gdal" "$ROOT_DIR/build/sysroot"
fi

if [ "$BUILD_S2" = true ]; then
    command -v emcc >/dev/null 2>&1 || { echo "Error: emcc not found"; exit 1; }
    echo "--- Preparing S2 vcpkg dependencies ---"
    mkdir -p "$ROOT_DIR/build"
    export VCPKG_ROOT="${VCPKG_ROOT:-$ROOT_DIR/deps/vcpkg}"
    export VCPKG_TARGET_TRIPLET="${VCPKG_TARGET_TRIPLET:-wasm32-emscripten}"
    export VCPKG_INSTALLED_DIR="${VCPKG_INSTALLED_DIR:-$ROOT_DIR/build/vcpkg/s2-installed}"
    export EMSCRIPTEN_ROOT="${EMSCRIPTEN_ROOT:-$(em-config EMSCRIPTEN_ROOT)}"
    bash "$SCRIPT_DIR/emscripten/install-s2-vcpkg-deps.sh"
fi

# Set env vars for C deps
[ "$BUILD_GEOS" = true ] && export GEOS_LIB_DIR="$ROOT_DIR/build/sysroot/lib" GEOS_VERSION="3.13.1"
[ "$BUILD_PROJ" = true ] && export PROJ_LIB_DIR="$ROOT_DIR/build/sysroot/lib" SQLITE3_INCLUDE_DIR="$ROOT_DIR/build/sysroot/include" CEREUSDB_PROJ_DB_PATH="$ROOT_DIR/build/sysroot/share/proj/proj.db" SEDONA_WASM_PROJ_DB_PATH="$ROOT_DIR/build/sysroot/share/proj/proj.db"
[ "$BUILD_GDAL" = true ] && export GDAL_LIB_DIR="$ROOT_DIR/build/sysroot/lib" GDAL_VERSION="3.10.0"

# Set Emscripten C/C++ runtime link flags when using C deps
if [ "$BUILD_GEOS" = true ] || [ "$BUILD_PROJ" = true ] || [ "$BUILD_GDAL" = true ]; then
    EM_CACHE="$(em-config CACHE)"
    EM_SYSROOT_ROOT="$EM_CACHE/sysroot"
    EM_SYSROOT="$EM_SYSROOT_ROOT/lib/wasm32-emscripten"
    [ -d "$EM_SYSROOT" ] || EM_SYSROOT="$(dirname "$(which emcc)")/../libexec/cache/sysroot/lib/wasm32-emscripten"
    export CFLAGS_wasm32_unknown_unknown="${CFLAGS_wasm32_unknown_unknown:-} --sysroot=$EM_SYSROOT_ROOT"
    export RUSTFLAGS="${RUSTFLAGS:-} -L native=$EM_SYSROOT -l static=c -l static=c++-noexcept -l static=c++abi-noexcept -l static=compiler_rt"
fi

if [ "$BUILD_GDAL" = true ]; then
    export RUSTFLAGS="${RUSTFLAGS:-} -L native=$ROOT_DIR/build/sysroot/lib -l static=z -l static=expat"
fi

# If the linked artifact contains C/C++ global constructors, export the linker-
# generated ctor entrypoint so the JS wrapper can call it exactly once during
# initialization. This avoids command-style linkage wrappers calling it on every
# exported wasm function.
if [ "$BUILD_GEOS" = true ] || [ "$BUILD_PROJ" = true ] || [ "$BUILD_GDAL" = true ] || [ "$BUILD_S2" = true ]; then
    export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=--export-if-defined=__wasm_call_ctors"
fi

# Build Rust WASM
echo "--- Building Rust WASM ---"
cd "$ROOT_DIR"
rm -rf "$OUT_DIR"

WASM_FEATURES=""
[ -n "$FEATURES" ] && WASM_FEATURES="--features $FEATURES"
WASM_PACK_NO_OPT=""
[ "${SKIP_WASM_OPT:-0}" = "1" ] && WASM_PACK_NO_OPT="--no-opt"

wasm-pack build rust/cereusdb --target web --out-dir "$OUT_DIR" --release $WASM_PACK_NO_OPT $WASM_FEATURES

# Patch JS if C deps are linked (provides env/wasi import stubs)
if [ "$BUILD_GEOS" = true ] || [ "$BUILD_PROJ" = true ] || [ "$BUILD_GDAL" = true ]; then
    echo "--- Patching JS for Emscripten imports ---"
    bash "$SCRIPT_DIR/patch-wasm-js.sh" "$OUT_DIR"
fi

# Optimize
if [ "${SKIP_WASM_OPT:-0}" != "1" ] && command -v wasm-opt >/dev/null 2>&1; then
    echo "--- Optimizing WASM ---"
    wasm-opt "${WASM_OPT_LEVEL:--Oz}" "$OUT_DIR/cereusdb_bg.wasm" -o "$OUT_DIR/cereusdb_bg.wasm"
fi

if [ "$LINK_PKG" = true ]; then
    rm -rf "$ROOT_DIR/pkg"
    ln -s "$OUT_DIR" "$ROOT_DIR/pkg"
fi

echo "--- Build complete ---"
ls -lh "$OUT_DIR/cereusdb_bg.wasm"
echo "Gzipped:"
gzip -c "$OUT_DIR/cereusdb_bg.wasm" | wc -c | awk '{printf "%.1f MB\n", $1/1048576}'
