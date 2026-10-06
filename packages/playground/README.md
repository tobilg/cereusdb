# @cereusdb/playground

Private Vite app used as the browser playground for `@cereusdb/minimal`. It
imports the locally assembled package from `packages/minimal/dist` (see the
`@cereusdb/minimal` alias in `vite.config.ts`), so it always runs the current
source, not a published release.

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
make package-minimal
make serve
```

Re-run `make package-minimal` after changing Rust or wrapper code; the dev
server serves `packages/minimal/dist` as it was last assembled.

For a production build without starting the dev server:

```bash
make package-minimal
cd packages/playground
npm run build:release
```

`make build-playground` does the same in one command.

## Trying persistent databases

The playground runs CereusDB on the page's main thread with the default
options, so `opfs://` databases and `COPY ... TO` downloads work out of the box
(`127.0.0.1` counts as a secure context, which OPFS requires):

```sql
CREATE DATABASE 'opfs://test';
CREATE TABLE test.public.pts AS SELECT 1 AS id, ST_Point(1, 2) AS geom;
-- reload the page, then:
ATTACH 'opfs://test';
SELECT id, ST_AsText(geom) FROM test.public.pts;
COPY test.public.pts TO 'pts.parquet';   -- downloads pts.parquet
```

Running `ATTACH 'opfs://test'` in a second tab fails with "open in another tab
or worker" until the first tab detaches the database or closes. See the
[persistent databases guide](../documentation/guides/persistent-databases.md)
for details.
