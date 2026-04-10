# @cereusdb/playground

Private Vite app used as the browser playground for `@cereusdb/standard`.

It combines the old static browser examples into one Pages-deployable app:

- ad hoc SQL query execution
- preset spatial example queries
- remote Parquet loading
- local Parquet and GeoJSON file registration
- result table rendering and raw JSON inspection

## Local development

From the repo root:

```bash
make install-playground-deps
make package-standard
make serve
```

For a production build without starting the dev server:

```bash
make package-standard
cd packages/playground
npm run build:release
```
