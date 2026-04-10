#!/bin/bash
set -euo pipefail

BUILD_DIR="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")" || BUILD_DIR="$1"
INSTALL_DIR="$(cd "$(dirname "$2")" 2>/dev/null && pwd)/$(basename "$2")" || INSTALL_DIR="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SQLITE_SRC="$ROOT_DIR/deps/sqlite-src"
export EM_CACHE="${EM_CACHE:-$ROOT_DIR/build/emscripten-cache}"
OPT_FLAGS="${CEREUSDB_C_OPT_FLAGS:-${SEDONA_WASM_C_OPT_FLAGS:--Oz -DNDEBUG}}"

NJOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

echo "  SQLite source: $SQLITE_SRC"
echo "  Build dir:     $BUILD_DIR"
echo "  Install dir:   $INSTALL_DIR"

[ -x "$SQLITE_SRC/configure" ] || { echo "Missing SQLite configure script"; exit 1; }

mkdir -p "$BUILD_DIR" "$INSTALL_DIR" "$EM_CACHE"
cd "$BUILD_DIR"

if [ ! -f "$BUILD_DIR/Makefile" ]; then
    export CCACHE_DISABLE=1
    export CC=emcc
    export AR=emar
    export RANLIB=emranlib
    export CFLAGS="$OPT_FLAGS -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_THREADSAFE=0"

    emconfigure "$SQLITE_SRC/configure" \
        --prefix="$INSTALL_DIR" \
        --disable-shared \
        --enable-static \
        --disable-tcl \
        --disable-load-extension \
        --disable-math \
        --disable-readline \
        --disable-threadsafe
fi

emmake make -j"$NJOBS" lib
emmake make install-lib install-headers install-pc

ls -lh "$INSTALL_DIR/lib/libsqlite3.a"
