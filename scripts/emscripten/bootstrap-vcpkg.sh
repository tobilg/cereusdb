#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
VCPKG_ROOT="${VCPKG_ROOT:-$ROOT_DIR/deps/vcpkg}"

if [ -x "$VCPKG_ROOT/vcpkg" ]; then
    echo "  vcpkg ready:   $VCPKG_ROOT/vcpkg"
    exit 0
fi

if [ ! -f "$VCPKG_ROOT/bootstrap-vcpkg.sh" ]; then
    cat <<EOF >&2
vcpkg checkout not found at: $VCPKG_ROOT

Set VCPKG_ROOT to an existing checkout or add one at deps/vcpkg.
Example:
  VCPKG_ROOT=/Users/tmueller/vcpkg make s2-vcpkg-bootstrap
EOF
    exit 1
fi

echo "  Bootstrapping vcpkg at $VCPKG_ROOT"
"$VCPKG_ROOT/bootstrap-vcpkg.sh" -disableMetrics
echo "  vcpkg ready:   $VCPKG_ROOT/vcpkg"
