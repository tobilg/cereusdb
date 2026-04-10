#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
S2_SRC="$ROOT_DIR/deps/sedona-db/c/sedona-s2geography"
BUILD_DIR="${S2_SPIKE_BUILD_DIR:-$ROOT_DIR/build/s2-vcpkg-spike}"
VCPKG_ROOT="${VCPKG_ROOT:-$ROOT_DIR/deps/vcpkg}"
VCPKG_TARGET_TRIPLET="${VCPKG_TARGET_TRIPLET:-wasm32-emscripten}"
VCPKG_INSTALLED_DIR="${VCPKG_INSTALLED_DIR:-$ROOT_DIR/build/vcpkg/s2-installed}"
NJOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

resolve_emscripten_root() {
    local emcc_path real_emcc candidate

    if [ -n "${EMSCRIPTEN_ROOT:-}" ] && [ -f "${EMSCRIPTEN_ROOT}/cmake/Modules/Platform/Emscripten.cmake" ]; then
        printf '%s\n' "$EMSCRIPTEN_ROOT"
        return 0
    fi

    if [ -n "${EMSDK:-}" ] && [ -f "${EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" ]; then
        printf '%s\n' "${EMSDK}/upstream/emscripten"
        return 0
    fi

    emcc_path="$(command -v emcc 2>/dev/null || true)"
    if [ -z "$emcc_path" ]; then
        return 1
    fi

    real_emcc="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$emcc_path")"
    for candidate in \
        "$(dirname "$real_emcc")" \
        "$(dirname "$(dirname "$real_emcc")")" \
        "/opt/homebrew/opt/emscripten/libexec"
    do
        if [ -f "$candidate/cmake/Modules/Platform/Emscripten.cmake" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    return 1
}

EMSCRIPTEN_ROOT="$(resolve_emscripten_root || true)"
if [ -z "$EMSCRIPTEN_ROOT" ]; then
    echo "Could not resolve EMSCRIPTEN_ROOT for the vcpkg wasm32-emscripten triplet" >&2
    exit 1
fi
export EMSCRIPTEN_ROOT

bash "$SCRIPT_DIR/install-s2-vcpkg-deps.sh"

echo "  S2 source:      $S2_SRC"
echo "  build dir:      $BUILD_DIR"
echo "  vcpkg root:     $VCPKG_ROOT"
echo "  vcpkg triplet:  $VCPKG_TARGET_TRIPLET"
echo "  installed dir:  $VCPKG_INSTALLED_DIR"
echo "  emscripten:     $EMSCRIPTEN_ROOT"

mkdir -p "$BUILD_DIR"

cmake \
    -S "$S2_SRC" \
    -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
    -DVCPKG_TARGET_TRIPLET="$VCPKG_TARGET_TRIPLET" \
    -DVCPKG_INSTALLED_DIR="$VCPKG_INSTALLED_DIR" \
    -DVCPKG_CHAINLOAD_TOOLCHAIN_FILE="$EMSCRIPTEN_ROOT/cmake/Modules/Platform/Emscripten.cmake"

if [ "${CEREUSDB_S2_SPIKE_CONFIGURE_ONLY:-${SEDONA_WASM_S2_SPIKE_CONFIGURE_ONLY:-0}}" = "1" ]; then
    echo "  S2 vcpkg spike configure completed"
    exit 0
fi

cmake --build "$BUILD_DIR" --target geography_glue -j"$NJOBS"
echo "  S2 vcpkg spike build completed"
