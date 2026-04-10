#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
S2_SRC="$ROOT_DIR/deps/sedona-db/c/sedona-s2geography"
VCPKG_ROOT="${VCPKG_ROOT:-$ROOT_DIR/deps/vcpkg}"
VCPKG_TARGET_TRIPLET="${VCPKG_TARGET_TRIPLET:-wasm32-emscripten}"
VCPKG_INSTALLED_DIR="${VCPKG_INSTALLED_DIR:-$ROOT_DIR/build/vcpkg/s2-installed}"

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

if ! command -v emcc >/dev/null 2>&1; then
    echo "emcc is required for the wasm32-emscripten vcpkg triplet" >&2
    exit 1
fi

bash "$SCRIPT_DIR/bootstrap-vcpkg.sh"

EMSCRIPTEN_ROOT="$(resolve_emscripten_root || true)"
if [ -z "$EMSCRIPTEN_ROOT" ]; then
    echo "Could not resolve EMSCRIPTEN_ROOT for the vcpkg wasm32-emscripten triplet" >&2
    exit 1
fi
export EMSCRIPTEN_ROOT

mkdir -p "$VCPKG_INSTALLED_DIR"

echo "  S2 source:      $S2_SRC"
echo "  vcpkg root:     $VCPKG_ROOT"
echo "  vcpkg triplet:  $VCPKG_TARGET_TRIPLET"
echo "  install root:   $VCPKG_INSTALLED_DIR"
echo "  emscripten:     $EMSCRIPTEN_ROOT"

"$VCPKG_ROOT/vcpkg" install \
    --triplet "$VCPKG_TARGET_TRIPLET" \
    --x-manifest-root "$S2_SRC" \
    --x-install-root "$VCPKG_INSTALLED_DIR"

OPENSSL_WRAPPER="$VCPKG_INSTALLED_DIR/$VCPKG_TARGET_TRIPLET/share/openssl/vcpkg-cmake-wrapper.cmake"
if [ "$VCPKG_TARGET_TRIPLET" = "wasm32-emscripten" ] && [ -f "$OPENSSL_WRAPPER" ]; then
    if rg -q 'find_package\(Threads' "$OPENSSL_WRAPPER"; then
        perl -0pi -e 's@if\("REQUIRED" IN_LIST ARGS\)\n\s+find_package\(Threads REQUIRED\)\n\s+else\(\)\n\s+find_package\(Threads\)\n\s+endif\(\)\n\s+list\(APPEND OPENSSL_LIBRARIES \$\{CMAKE_THREAD_LIBS_INIT\}\)\n\s+if\(TARGET OpenSSL::Crypto\)\n\s+set_property\(TARGET OpenSSL::Crypto APPEND PROPERTY INTERFACE_LINK_LIBRARIES "Threads::Threads"\)\n\s+endif\(\)\n\s+if\(TARGET OpenSSL::SSL\)\n\s+set_property\(TARGET OpenSSL::SSL APPEND PROPERTY INTERFACE_LINK_LIBRARIES "Threads::Threads"\)\n\s+endif\(\)@set(CMAKE_THREAD_LIBS_INIT "")@s' "$OPENSSL_WRAPPER"
    fi
    perl -0pi -e 's@\n\s*find_library\(OPENSSL_DL_LIBRARY NAMES dl\)\n\s*if\(OPENSSL_DL_LIBRARY\)\n\s*list\(APPEND OPENSSL_LIBRARIES "dl"\)\n\s*if\(TARGET OpenSSL::Crypto\)\n\s*set_property\(TARGET OpenSSL::Crypto APPEND PROPERTY INTERFACE_LINK_LIBRARIES "dl"\)\n\s*endif\(\)\n\s*endif\(\)@@s' "$OPENSSL_WRAPPER"
fi

ABSL_CONFIG="$VCPKG_INSTALLED_DIR/$VCPKG_TARGET_TRIPLET/share/absl/abslConfig.cmake"
if [ "$VCPKG_TARGET_TRIPLET" = "wasm32-emscripten" ] && [ -f "$ABSL_CONFIG" ]; then
    perl -0pi -e 's/^find_dependency\(Threads\)\n//m' "$ABSL_CONFIG"
fi
