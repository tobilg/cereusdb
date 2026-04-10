#!/bin/bash
set -euo pipefail

BUILD_DIR="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")" || BUILD_DIR="$1"
INSTALL_DIR="$(cd "$(dirname "$2")" 2>/dev/null && pwd)/$(basename "$2")" || INSTALL_DIR="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
GEOS_SRC="$ROOT_DIR/deps/geos"
export EM_CACHE="${EM_CACHE:-$ROOT_DIR/build/emscripten-cache}"
OPT_FLAGS="${CEREUSDB_C_OPT_FLAGS:-${SEDONA_WASM_C_OPT_FLAGS:--Oz -DNDEBUG -fwasm-exceptions}}"

echo "  GEOS source: $GEOS_SRC"
echo "  Build dir:   $BUILD_DIR"
echo "  Install dir: $INSTALL_DIR"

mkdir -p "$BUILD_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/include" "$EM_CACHE"
cd "$BUILD_DIR"

emcmake cmake "$GEOS_SRC" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_BENCHMARKS=OFF \
    -DBUILD_DOCUMENTATION=OFF \
    -DGEOS_BUILD_DEVELOPER=OFF \
    -DCMAKE_C_FLAGS="$OPT_FLAGS" \
    -DCMAKE_CXX_FLAGS="$OPT_FLAGS"

NJOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
emmake make -j"$NJOBS" geos geos_c

# Install libs and headers manually (make install fails linking geosop)
cp lib/libgeos_c.a lib/libgeos.a "$INSTALL_DIR/lib/"
cp -r "$GEOS_SRC/include/geos" "$INSTALL_DIR/include/" 2>/dev/null || true
cp include/geos/export.h "$INSTALL_DIR/include/geos/" 2>/dev/null || true
cp capi/geos_c.h "$INSTALL_DIR/include/" 2>/dev/null || true

echo "  GEOS build complete"
ls -lh "$INSTALL_DIR/lib/"libgeos*.a
