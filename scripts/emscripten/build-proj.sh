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
    -DEMBED_RESOURCE_FILES=ON \
    -DUSE_ONLY_EMBEDDED_RESOURCE_FILES=ON \
    -DSQLITE3_INCLUDE_DIR="$INSTALL_DIR/include" \
    -DSQLITE3_LIBRARY="$INSTALL_DIR/lib/libsqlite3.a" \
    -DCMAKE_C_FLAGS="$OPT_FLAGS" \
    -DCMAKE_CXX_FLAGS="$OPT_FLAGS"

emmake make -j"$NJOBS"
emmake make install

# ---- Step 3: Embed proj.db zstd-compressed ----
# PROJ serves proj.db from its own embedded copy. Replace PROJ's embedded
# resources object with one that inflates a zstd-compressed proj.db on first use.
# Its ZSTD_* symbols resolve at link time from the libzstd that zstd-sys links
# into every package for Parquet.
echo "  Embedding zstd-compressed proj.db..."
command -v zstd >/dev/null 2>&1 || { echo "Error: the zstd CLI is required to compress proj.db"; exit 1; }
[ -f "$INSTALL_DIR/include/zstd.h" ] || { echo "Error: build zstd first (scripts/emscripten/build-zstd.sh)"; exit 1; }

PROJ_DB_ZST="$BUILD_DIR/proj/proj.db.zst"
zstd -q -f -19 "$BUILD_DIR/proj/data/proj.db" -o "$PROJ_DB_ZST"

RESOURCES_OBJ="$BUILD_DIR/proj/embedded_resources.c.o"
emcc $OPT_FLAGS -c "$SCRIPT_DIR/proj-embedded-resources.c" -o "$RESOURCES_OBJ" \
    -std=c23 \
    -DCEREUSDB_PROJ_DB_ZST="\"$PROJ_DB_ZST\"" \
    -I "$PROJ_SRC/src" \
    -I "$BUILD_DIR/proj/src" \
    -I "$INSTALL_DIR/include"

# The archive member keeps PROJ's object name, so `emar r` replaces it.
emar t "$INSTALL_DIR/lib/libproj.a" | grep -qx "embedded_resources.c.o" \
    || { echo "Error: libproj.a has no embedded_resources.c.o to replace"; exit 1; }
emar r "$INSTALL_DIR/lib/libproj.a" "$RESOURCES_OBJ"
ls -lh "$BUILD_DIR/proj/data/proj.db" "$PROJ_DB_ZST"

echo "  PROJ build complete"
ls -lh "$INSTALL_DIR/lib/"libproj*.a 2>/dev/null || echo "  WARNING: no .a files found"
