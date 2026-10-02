#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
export VCPKG_ROOT="${CEREUSDB_VCPKG_ROOT:-$ROOT_DIR/deps/vcpkg}"

if [ ! -f "$VCPKG_ROOT/bootstrap-vcpkg.sh" ]; then
    {
        echo "vcpkg checkout not found at: $VCPKG_ROOT"
        echo
        echo "Run 'make deps' to check out the pinned deps/vcpkg submodule, or set"
        echo "CEREUSDB_VCPKG_ROOT to another vcpkg checkout."
    } >&2
    exit 1
fi

# The vcpkg tool must match the ports checkout, so bootstrap again whenever the
# checked-out vcpkg commit differs from the one the binary was bootstrapped for.
STAMP_FILE="$ROOT_DIR/build/vcpkg/bootstrap.stamp"
VCPKG_COMMIT="$(git -C "$VCPKG_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"

if [ -x "$VCPKG_ROOT/vcpkg" ] && [ "$(cat "$STAMP_FILE" 2>/dev/null)" = "$VCPKG_COMMIT" ]; then
    echo "  vcpkg ready:   $VCPKG_ROOT/vcpkg"
    exit 0
fi

echo "  Bootstrapping vcpkg at $VCPKG_ROOT ($VCPKG_COMMIT)"
"$VCPKG_ROOT/bootstrap-vcpkg.sh" -disableMetrics
mkdir -p "$(dirname "$STAMP_FILE")"
echo "$VCPKG_COMMIT" > "$STAMP_FILE"
echo "  vcpkg ready:   $VCPKG_ROOT/vcpkg"
