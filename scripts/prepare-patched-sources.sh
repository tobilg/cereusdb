#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${1:-$ROOT_DIR/build/patched-sources}"

prepare_repo() {
    local name="$1"
    local src="$2"
    local dest="$OUT_DIR/$name"

    [ -d "$src" ] || { echo "Missing source repo: $src"; exit 1; }

    if [ -d "$dest" ]; then
        chmod -R u+w "$dest" 2>/dev/null || true
    fi
    rm -rf "$dest"
    mkdir -p "$dest"
    git -C "$src" archive --format=tar HEAD | tar -xf - -C "$dest"

    if [ "$name" = "sedona-db" ]; then
        copy_tree_if_present "$src" "$dest" "c/sedona-s2geography/s2geometry"
        copy_tree_if_present "$src" "$dest" "c/sedona-s2geography/s2geography"
    fi

    if [ -d "$ROOT_DIR/patches/$name" ]; then
        local patches=("$ROOT_DIR/patches/$name"/*.patch)
        if [ -e "${patches[0]}" ]; then
            git -C "$dest" init -q
            for patch in "${patches[@]}"; do
                git -C "$dest" apply --whitespace=nowarn "$patch"
            done
            rm -rf "$dest/.git"
        fi
    fi
}

prepare_crate() {
    local name="$1"
    local version="$2"
    local dest="$OUT_DIR/$name"
    local cargo_home="${CARGO_HOME:-$HOME/.cargo}"
    local src
    local tmp_dir=""

    src="$(find "$cargo_home/registry/src" -mindepth 2 -maxdepth 2 -type d -name "$name-$version" -print -quit 2>/dev/null || true)"
    if [ -z "$src" ]; then
        tmp_dir="$(mktemp -d)"
        local archive="$tmp_dir/$name-$version.crate"
        echo "Downloading cached source fallback: $name-$version"
        curl -L --fail --silent --show-error \
            "https://crates.io/api/v1/crates/$name/$version/download" \
            -o "$archive"
        tar -xzf "$archive" -C "$tmp_dir"
        src="$tmp_dir/$name-$version"
    fi

    if [ -d "$dest" ]; then
        chmod -R u+w "$dest" 2>/dev/null || true
    fi
    rm -rf "$dest"
    mkdir -p "$(dirname "$dest")"
    cp -R "$src" "$dest"
    if [ -n "$tmp_dir" ]; then
        rm -rf "$tmp_dir"
    fi

    if [ -d "$ROOT_DIR/patches/$name" ]; then
        local patches=("$ROOT_DIR/patches/$name"/*.patch)
        if [ -e "${patches[0]}" ]; then
            git -C "$dest" init -q
            for patch in "${patches[@]}"; do
                git -C "$dest" apply --whitespace=nowarn "$patch"
            done
            rm -rf "$dest/.git"
        fi
    fi
}

copy_tree_if_present() {
    local src_root="$1"
    local dest_root="$2"
    local rel_path="$3"

    if [ ! -d "$src_root/$rel_path" ]; then
        return
    fi

    rm -rf "$dest_root/$rel_path"
    mkdir -p "$(dirname "$dest_root/$rel_path")"
    cp -R "$src_root/$rel_path" "$dest_root/$rel_path"
}

mkdir -p "$OUT_DIR"

prepare_repo "sedona-db" "$ROOT_DIR/deps/sedona-db"
prepare_repo "object-store" "$ROOT_DIR/deps/object-store"
prepare_crate "datafusion-common" "52.5.0"
prepare_repo "georust-geos" "$ROOT_DIR/deps/georust-geos"
prepare_repo "georust-proj" "$ROOT_DIR/deps/georust-proj"
prepare_repo "georust-gdal" "$ROOT_DIR/deps/georust-gdal"

printf '%s\n' \
    "Prepared patched sources in $OUT_DIR" \
    "  - sedona-db" \
    "  - object-store" \
    "  - datafusion-common" \
    "  - georust-geos" \
    "  - georust-proj" \
    "  - georust-gdal"
