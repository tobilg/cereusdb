#!/bin/bash
set -euo pipefail

WASM_PATH="${1:?usage: report-wasm-size.sh <wasm-path> [label]}"
LABEL="${2:-$(basename "$(dirname "$WASM_PATH")")}"

[ -f "$WASM_PATH" ] || { echo "Missing WASM artifact: $WASM_PATH" >&2; exit 1; }

raw_bytes="$(wc -c < "$WASM_PATH" | tr -d ' ')"
gzip_bytes="$(gzip -c "$WASM_PATH" | wc -c | tr -d ' ')"

if command -v brotli >/dev/null 2>&1; then
    brotli_bytes="$(brotli -c "$WASM_PATH" | wc -c | tr -d ' ')"
else
    brotli_bytes="n/a"
fi

printf '%s\n' \
    "=== $LABEL ===" \
    "Artifact: $WASM_PATH" \
    "Raw bytes: $raw_bytes" \
    "Gzip bytes: $gzip_bytes" \
    "Brotli bytes: $brotli_bytes"

if command -v wasm-objdump >/dev/null 2>&1; then
    echo "Sections:"
    wasm-objdump -h "$WASM_PATH" | awk '
        BEGIN { printed = 0 }
        /Code/ || /Data/ {
            printed = 1
            print "  " $0
        }
        END {
            if (!printed) {
                print "  (Code/Data section summary unavailable)"
            }
        }
    '
else
    echo "Sections: wasm-objdump not available"
fi
