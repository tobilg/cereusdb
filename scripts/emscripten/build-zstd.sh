#!/bin/bash
set -euo pipefail

BUILD_DIR="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")" || BUILD_DIR="$1"
INSTALL_DIR="$(cd "$(dirname "$2")" 2>/dev/null && pwd)/$(basename "$2")" || INSTALL_DIR="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ZSTD_SRC="$ROOT_DIR/deps/zstd"
export EM_CACHE="${EM_CACHE:-$ROOT_DIR/build/emscripten-cache}"
OPT_FLAGS="${CEREUSDB_C_OPT_FLAGS:-${SEDONA_WASM_C_OPT_FLAGS:--Oz -DNDEBUG}}"

echo "  zstd source: $ZSTD_SRC"
echo "  Build dir:   $BUILD_DIR"
echo "  Install dir: $INSTALL_DIR"

mkdir -p "$BUILD_DIR" "$INSTALL_DIR" "$EM_CACHE"
cd "$BUILD_DIR"

# One static libzstd shared by GDAL (GeoTIFF ZSTD/LERC_ZSTD) and the Rust
# zstd-sys crate (Parquet), which links it through pkg-config (libzstd.pc).
# CMAKE_C_FLAGS_RELEASE is overridden because the default -O3 would win over -Oz.
emcmake cmake "$ZSTD_SRC/build/cmake" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DZSTD_BUILD_STATIC=ON \
    -DZSTD_BUILD_SHARED=OFF \
    -DZSTD_BUILD_PROGRAMS=OFF \
    -DZSTD_BUILD_TESTS=OFF \
    -DZSTD_BUILD_CONTRIB=OFF \
    -DZSTD_MULTITHREAD_SUPPORT=OFF \
    -DZSTD_LEGACY_SUPPORT=OFF \
    -DCMAKE_C_FLAGS="$OPT_FLAGS" \
    -DCMAKE_C_FLAGS_RELEASE="$OPT_FLAGS"

NJOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
emmake make -j"$NJOBS"
emmake make install

echo "  zstd build complete"
ls -lh "$INSTALL_DIR/lib/libzstd.a" "$INSTALL_DIR/lib/pkgconfig/libzstd.pc"
