#!/bin/bash
set -euo pipefail

PKG_DIR="${1:?Usage: patch-wasm-js.sh <pkg-dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JS="$PKG_DIR/cereusdb.js"
CACHE_TAG="${CACHE_TAG:-ehfix-20260406-1}"

[ -f "$JS" ] || { echo "Error: $JS not found"; exit 1; }

cp "$SCRIPT_DIR/env_shim.js" "$PKG_DIR/"

# 1. Add shim import at top
sed -i '' "1s|^|import { createEnvImports, createWasiImports, setMemory } from \"./env_shim.js?v=${CACHE_TAG}\";\nconst __env = createEnvImports();\nconst __wasi = createWasiImports();\n|" "$JS"

# 2. Replace env/wasi imports
sed -i '' 's|^import \* as \(import[0-9]*\) from "env"$|const \1 = __env;|' "$JS"
sed -i '' 's|^import \* as \(import[0-9]*\) from "wasi_snapshot_preview1"$|const \1 = __wasi;|' "$JS"

# 3. Inject setMemory BEFORE __wbg_finalize_init
# Find lines with "__wbg_load(await" (async init) and inject setMemory after
# The pattern is: const { instance, module } = await __wbg_load(...)
# followed by: return __wbg_finalize_init(instance, module)
python3 -c "
import re, sys
with open('$JS', 'r') as f:
    content = f.read()

# Before every __wbg_finalize_init call, inject setMemory
content = content.replace(
    'return __wbg_finalize_init(instance, module)',
    'if (instance.exports && instance.exports.memory) setMemory(instance.exports.memory);\n    return __wbg_finalize_init(instance, module)'
)

# If the wasm exports the linker-generated ctor entrypoint, run it exactly once
# at initialization time before wasm-bindgen start hooks execute.
content = content.replace(
    '    cachedUint8ArrayMemory0 = null;\n    wasm.__wbindgen_start();',
    '    cachedUint8ArrayMemory0 = null;\n    if (typeof wasm.__wasm_call_ctors === \"function\") wasm.__wasm_call_ctors();\n    wasm.__wbindgen_start();'
)

# Also handle: __wbg_finalize_init(instance, module) without return (sync path)
# Already covered by the above since both have 'return'

with open('$JS', 'w') as f:
    f.write(content)
"

remaining=$(grep -c 'from "env"\|from "wasi_snapshot_preview1"' "$JS" || true)
echo "Patched $JS (remaining bare imports: $remaining)"
