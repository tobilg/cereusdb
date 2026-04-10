#!/bin/bash
# Build zlib and expat for Emscripten (GDAL dependencies)
set -euo pipefail

BUILD_DIR="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")" || BUILD_DIR="$1"
INSTALL_DIR="$(cd "$(dirname "$2")" 2>/dev/null && pwd)/$(basename "$2")" || INSTALL_DIR="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
export EM_CACHE="${EM_CACHE:-$ROOT_DIR/build/emscripten-cache}"
ZLIB_SOURCE_DIR="$ROOT_DIR/deps/zlib"
OPT_FLAGS="${CEREUSDB_C_OPT_FLAGS:-${SEDONA_WASM_C_OPT_FLAGS:--Oz -DNDEBUG -fwasm-exceptions}}"

NJOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

mkdir -p "$BUILD_DIR" "$INSTALL_DIR" "$EM_CACHE"

restore_zlib_header() {
    if [ ! -f "$ZLIB_SOURCE_DIR/zconf.h" ] && [ -f "$ZLIB_SOURCE_DIR/zconf.h.included" ]; then
        mv "$ZLIB_SOURCE_DIR/zconf.h.included" "$ZLIB_SOURCE_DIR/zconf.h"
    fi
}

restore_zlib_header
trap restore_zlib_header EXIT

# ---- zlib ----
if [ ! -f "$INSTALL_DIR/lib/libz.a" ]; then
    echo "  Building zlib..."
    if [ -f "$BUILD_DIR/zlib/CMakeCache.txt" ] && ! grep -Fq "CMAKE_INSTALL_PREFIX:PATH=$INSTALL_DIR" "$BUILD_DIR/zlib/CMakeCache.txt"; then
        rm -rf "$BUILD_DIR/zlib"
    fi
    mkdir -p "$BUILD_DIR/zlib"
    cd "$BUILD_DIR/zlib"
    emcmake cmake "$ZLIB_SOURCE_DIR" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
        -DBUILD_SHARED_LIBS=OFF \
        -DZLIB_BUILD_EXAMPLES=OFF \
        -DINSTALL_BIN_DIR="$INSTALL_DIR/bin" \
        -DINSTALL_LIB_DIR="$INSTALL_DIR/lib" \
        -DINSTALL_INC_DIR="$INSTALL_DIR/include" \
        -DINSTALL_MAN_DIR="$INSTALL_DIR/share/man" \
        -DINSTALL_PKGCONFIG_DIR="$INSTALL_DIR/share/pkgconfig" \
        -DCMAKE_C_FLAGS="$OPT_FLAGS -DZ_HAVE_UNISTD_H"
    emmake make -j"$NJOBS" zlibstatic
    mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include" "$INSTALL_DIR/share/pkgconfig"
    cp libz.a "$INSTALL_DIR/lib/libz.a"
    cp zconf.h "$ZLIB_SOURCE_DIR/zlib.h" "$INSTALL_DIR/include/"
    cp zlib.pc "$INSTALL_DIR/share/pkgconfig/" 2>/dev/null || true
    restore_zlib_header
    echo "  zlib done"
fi

# ---- expat ----
if [ ! -f "$INSTALL_DIR/lib/libexpat.a" ]; then
    echo "  Building expat..."
    if [ -f "$BUILD_DIR/expat/CMakeCache.txt" ] && ! grep -Fq "CMAKE_INSTALL_PREFIX:PATH=$INSTALL_DIR" "$BUILD_DIR/expat/CMakeCache.txt"; then
        rm -rf "$BUILD_DIR/expat"
    fi
    mkdir -p "$BUILD_DIR/expat"
    cd "$BUILD_DIR/expat"
    emcmake cmake "$ROOT_DIR/deps/expat/expat" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
        -DBUILD_SHARED_LIBS=OFF \
        -DEXPAT_BUILD_TOOLS=OFF \
        -DEXPAT_BUILD_EXAMPLES=OFF \
        -DEXPAT_BUILD_TESTS=OFF \
        -DEXPAT_BUILD_DOCS=OFF \
        -DCMAKE_C_FLAGS="$OPT_FLAGS"
    emmake make -j"$NJOBS"
    emmake make install
    echo "  expat done"
fi

ls -lh "$INSTALL_DIR/lib/libz.a" "$INSTALL_DIR/lib/libexpat.a"
