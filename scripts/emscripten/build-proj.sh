#!/bin/bash
set -euo pipefail

BUILD_DIR="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")" || BUILD_DIR="$1"
INSTALL_DIR="$(cd "$(dirname "$2")" 2>/dev/null && pwd)/$(basename "$2")" || INSTALL_DIR="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJ_SRC="$ROOT_DIR/deps/proj"
export EM_CACHE="${EM_CACHE:-$ROOT_DIR/build/emscripten-cache}"
OPT_FLAGS="${CEREUSDB_C_OPT_FLAGS:-${SEDONA_WASM_C_OPT_FLAGS:--Oz -DNDEBUG -fwasm-exceptions}}"

NJOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

echo "  PROJ source:   $PROJ_SRC"
echo "  Build dir:     $BUILD_DIR"
echo "  Install dir:   $INSTALL_DIR"

mkdir -p "$BUILD_DIR/sqlite" "$BUILD_DIR/proj" "$INSTALL_DIR/lib" "$INSTALL_DIR/include" "$EM_CACHE"

# ---- Step 1: Build SQLite ----
bash "$SCRIPT_DIR/build-sqlite.sh" "$BUILD_DIR/sqlite" "$INSTALL_DIR"

# ---- Step 2: Build PROJ ----
echo "  Building PROJ..."
cd "$BUILD_DIR/proj"

emcmake cmake "$PROJ_SRC" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_APPS=OFF \
    -DENABLE_CURL=OFF \
    -DENABLE_TIFF=OFF \
    -DBUILD_PROJSYNC=OFF \
    -DEMBED_PROJ_DATA_PATH=OFF \
    -DSQLITE3_INCLUDE_DIR="$INSTALL_DIR/include" \
    -DSQLITE3_LIBRARY="$INSTALL_DIR/lib/libsqlite3.a" \
    -DCMAKE_C_FLAGS="$OPT_FLAGS" \
    -DCMAKE_CXX_FLAGS="$OPT_FLAGS"

emmake make -j"$NJOBS"
emmake make install

echo "  PROJ build complete"
ls -lh "$INSTALL_DIR/lib/"libproj*.a 2>/dev/null || echo "  WARNING: no .a files found"
