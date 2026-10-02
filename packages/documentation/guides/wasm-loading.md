# Loading the WASM Module

Every `@cereusdb/*` package ships its WebAssembly binary as a separate file, `dist/wasm/cereusdb_bg.wasm`. The JavaScript files never contain the wasm payload. There are two entry points that differ only in how they find that file.

| Entry point | Default wasm location | Use when |
| --- | --- | --- |
| `@cereusdb/<package>` | `new URL('cereusdb_bg.wasm', import.meta.url)` | You want zero configuration and let your bundler copy the wasm |
| `@cereusdb/<package>/external` | None, `wasmUrl` or `wasmSource` is required | You host the wasm yourself (CDN, static folder) or load it in Node |

Both entry points export the same `CereusDB` API.

## Default entry

```ts
import { CereusDB } from '@cereusdb/standard';

const db = await CereusDB.create();
```

The generated loader references the wasm through `new URL('cereusdb_bg.wasm', import.meta.url)`. Bundlers such as Vite, Rolldown, and webpack detect this pattern and emit the wasm as a separate asset next to your bundle.

Because the reference is static, bundlers always process the wasm for this entry, even if you pass your own `wasmUrl` at runtime. If your bundler is configured to inline assets, the wasm ends up base64-encoded inside your JavaScript, which makes chunks roughly a third larger than the wasm itself. Common causes in Vite are:

- a large `build.assetsInlineLimit`
- library mode (`build.lib`), which inlines all assets
- importing the worker with `?worker&inline`

If you see `data:application/wasm;base64,...` in your output, check these settings first or switch to the external entry.

## External entry

```ts
import { CereusDB } from '@cereusdb/standard/external';

const db = await CereusDB.create({
  wasmUrl: 'https://cdn.example.com/cereusdb/0.2.0/cereusdb_bg.wasm',
});
```

The external entry uses a loader with no built-in wasm reference, so bundlers never emit or inline the binary. Calling `CereusDB.create()` without `wasmUrl` or `wasmSource` throws an error.

Copy `node_modules/@cereusdb/<package>/dist/wasm/cereusdb_bg.wasm` to your static hosting (for example Vite's `public/` folder) and pass its URL. The wasm must come from the same package and version as the JavaScript.

### With a Vite `?url` import

You can still let Vite manage the file by importing its URL explicitly:

```ts
import { CereusDB } from '@cereusdb/standard/external';
import wasmUrl from '@cereusdb/standard/wasm?url';

const db = await CereusDB.create({ wasmUrl });
```

`?url` imports follow `build.assetsInlineLimit` too. Keep the limit below the wasm size (the default is 4 KiB) so Vite emits a file instead of a data URL.

### In Node or tests

```ts
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { CereusDB } from '@cereusdb/minimal/external';

const require = createRequire(import.meta.url);
const wasmSource = await readFile(require.resolve('@cereusdb/minimal/wasm'));
const db = await CereusDB.create({ wasmSource });
```

## Web workers

Both entry points work inside module workers. Large datasets and query results live in the wasm memory of whichever thread calls `CereusDB.create()`, so create the database inside the worker if you want to keep that memory off the main thread.
