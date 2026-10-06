# Persistent Databases

By default every CereusDB table lives in memory and disappears when the page
reloads. Persistent databases keep their tables in the browser's
[Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
(OPFS). Each one is attached as its own catalog, so its schemas, tables and
views appear in `information_schema`, `SHOW TABLES` and `db.catalog()` next to
the default in-memory `datafusion` catalog.

## Try it

Run these statements in the
[playground](https://cereusdb-playground.gh.tobilg.com) (or any page using
CereusDB):

```sql
CREATE DATABASE 'opfs://test';
CREATE TABLE test.public.pts AS SELECT 1 AS id, ST_Point(1, 2) AS geom;
```

Reload the page, then:

```sql
ATTACH 'opfs://test';
SELECT id, ST_AsText(geom) FROM test.public.pts;  -- 1, POINT(1 2)
COPY test.public.pts TO 'pts.parquet';            -- downloads pts.parquet
```

While the database is attached, open the page in a second tab and run
`ATTACH 'opfs://test'` there: it fails with "open in another tab or worker"
until the first tab runs `DETACH test` or is closed. `DROP DATABASE test`
removes the database and its files again.

## Creating and opening databases

```ts
const db = await CereusDB.create();

await db.sqlJSON(`CREATE DATABASE 'opfs://mydb'`);
// same as: await db.createDatabase('opfs://mydb');

await db.sqlJSON(`
  CREATE TABLE mydb.public.cities AS
  SELECT 1 AS id, 'Berlin' AS name, ST_Point(13.4, 52.5) AS geom
`);
```

After a reload, attach the database again:

```ts
await db.sqlJSON(`ATTACH 'opfs://mydb'`); // or: await db.attachDatabase('opfs://mydb');
```

Or open it (creating it if needed) while creating the instance:

```ts
const db = await CereusDB.create({ attach: ['opfs://mydb'] });
```

| SQL | Programmatic API |
|---|---|
| `CREATE DATABASE [IF NOT EXISTS] 'opfs://mydb'` | `db.createDatabase('opfs://mydb', { ifNotExists })` |
| `CREATE DATABASE name LOCATION 'opfs://mydb'` | `db.createDatabase('opfs://mydb', { name })` |
| `ATTACH [IF NOT EXISTS] 'opfs://mydb' [AS name]` | `db.attachDatabase('opfs://mydb', { name, ifNotExists })` |
| `DETACH [IF EXISTS] name` | `db.detachDatabase(name, { ifExists })` |
| `DROP DATABASE [IF EXISTS] name` or `'opfs://mydb'` | `db.dropDatabase(nameOrLocation, { ifExists })` |
| `USE name` / `USE name.schema` | `db.useDatabase(name, schema)` |
| `SELECT * FROM cereusdb_databases()` | `db.listDatabases()` (also lists stored databases that are not attached) |

Locations must be quoted and have the form `opfs://<name>`, where the name
consists of letters, digits, `_` and `-`. The database is named after the
location (lowercased) unless you pass a name. A plain `CREATE DATABASE name`
without a location creates an in-memory database instead (see below).

## Working with tables

Inside a persistent database you can use the usual statements. Each statement
that changes the database writes the change before its promise resolves.

```sql
CREATE SCHEMA mydb.staging;
CREATE TABLE mydb.staging.events (id INT, kind VARCHAR);
INSERT INTO mydb.staging.events VALUES (1, 'click');
UPDATE mydb.staging.events SET kind = 'view' WHERE id = 1;
DELETE FROM mydb.staging.events WHERE id = 1;
CREATE VIEW mydb.public.berlin AS SELECT * FROM mydb.public.cities WHERE name = 'Berlin';
ALTER TABLE mydb.public.cities ADD COLUMN country VARCHAR DEFAULT 'DE';
ALTER TABLE mydb.public.cities RENAME COLUMN name TO city;
ALTER TABLE mydb.public.cities DROP COLUMN country;
ALTER TABLE mydb.public.cities RENAME TO places;
DROP TABLE mydb.staging.events;
```

`USE mydb` makes `mydb.public` the default, so unqualified names such as
`places` resolve to `mydb.public.places`.

The programmatic helpers `createTable()`, `alterTable()`, `dropTable()` and
`insertArrow()` (which inserts Arrow IPC data, for example from apache-arrow's
`tableToIPC()`) work on persistent and in-memory tables alike. Tables
registered with `registerFile()` or `registerGeoJSON()` under a qualified name
such as `mydb.public.uploads` are stored as well; call `db.flush()` after the
synchronous `registerGeoJSON()` to wait for the write.

## Persistent and in-memory databases

A database is a catalog with schemas and tables (`database.schema.table`).
Every CereusDB instance has the in-memory `datafusion` database with a `public`
schema. It is the default database, so unqualified table names (in SQL and in
methods such as `registerFile()`) refer to `datafusion.public` until `USE`
selects another database. Persistent and in-memory databases appear side by
side and behave the same in these respects:

- Name resolution: `a.b.c` is database, schema, table; `b.c` is a schema in the
  default database; `c` uses the default database and schema. `USE` changes the
  defaults.
- Both start with a `public` schema, so `USE name` and `name.public.t` work
  right after `CREATE DATABASE`.
- Both appear in `information_schema`, `SHOW TABLES`, `cereusdb_databases()`
  and `db.catalog()`; the `storage` (`memory` or `opfs`) and `location` fields
  tell them apart.
- The same DDL and DML statements work in both, and a query can combine
  tables of several databases.
- `db.tables()` lists table names of all databases; use
  `db.tables({ qualified: true })` for `database.schema.table` names, since the
  same table name can exist in several databases.

They differ here:

| | In-memory database | Persistent database |
|---|---|---|
| Lifetime | Until the page reloads | Until `DROP DATABASE`; reopen with `ATTACH` |
| Can hold | Any table: in-memory, remote (`registerParquetTable()`), raster, views | In-memory tables and views; copy other tables with `CREATE TABLE ... AS SELECT` |
| Data in memory | Always | From the first use of each table |
| Writes | No I/O | Written to OPFS before each statement's promise resolves |
| Views | Kept as planned queries | Stored as SQL and planned again on attach |
| Removing | `DROP DATABASE` (not the current default database) | `DETACH` closes it, `DROP DATABASE` also deletes its files |
| Multiple tabs | Each tab has its own | Open in one tab or worker at a time |

`ALTER TABLE ... RENAME TO <database>.<schema>.<table>` moves a table between
databases: into a persistent database its data is written to storage, and out
of one it becomes an in-memory table.

## How data is stored

Each database is a directory in OPFS (`cereusdb/<name>/`) with a
`manifest.json` and one or more LZ4-compressed Arrow IPC files per table:

- `INSERT` adds a file with the new rows.
- `UPDATE`, `DELETE`, `ALTER TABLE` and `INSERT OVERWRITE` rewrite the table
  into a single file.
- Tables with many files are compacted automatically; `db.compactDatabase(name)`
  compacts all tables.

The manifest is written last, so an interrupted write leaves the previous
state intact. It also records each table's schema, column defaults and
constraints, so attaching a database reads only the manifest. A table's data is
loaded into memory the first time the table is used (scanned or changed) and
stays in memory while the database is attached.

## Limitations

- A database can be open in only one tab or worker at a time (it is locked
  with the Web Locks API). Opening it elsewhere fails until it is detached or
  the tab is closed.
- Only tables and views can be stored. External tables (for example
  `registerParquetTable()`) must be copied with `CREATE TABLE ... AS SELECT`.
- Views are stored as SQL. A view that references tables outside its database
  cannot be planned when the database is attached if those tables are missing.
  It stays listed (with its columns), can be dropped or replaced, and queries
  on it explain the problem; it works again once the tables exist and the
  database is attached again.
- Tables that are used are held in memory completely, so the data you work
  with has to fit into the browser's WebAssembly memory.
- Data stored in OPFS can be evicted under storage pressure unless the page
  calls `navigator.storage.persist()`.

## Other storage backends

Persistent databases use a `StorageBackend` per URL scheme. In browsers with
OPFS, `opfs://` uses `OPFSStorageBackend` automatically. Elsewhere (for
example in Node.js or tests) pass a backend explicitly:

```ts
import { CereusDB, MemoryStorageBackend } from '@cereusdb/standard';

const db = await CereusDB.create({ storage: { opfs: new MemoryStorageBackend() } });
```

## Exporting data

Use `db.exportGeoParquet()`, `db.downloadGeoParquet()` or `COPY ... TO` to
export tables of persistent databases as GeoParquet; see
[GeoParquet Export](./geoparquet-export.md).
