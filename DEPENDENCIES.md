# Dependencies

This repository keeps build inputs in git submodules and keeps local source
changes as patch files under `patches/`.

## Submodules

| Path | Upstream | Purpose |
|---|---|---|
| `deps/sedona-db` | `apache/sedona-db` | Upstream SedonaDB workspace |
| `deps/geos` | `libgeos/geos` | GEOS C/C++ source |
| `deps/proj` | `OSGeo/PROJ` | PROJ C/C++ source |
| `deps/gdal` | `OSGeo/gdal` | GDAL C/C++ source |
| `deps/expat` | `libexpat/libexpat` | GDAL XML dependency |
| `deps/zlib` | `madler/zlib` | GDAL compression dependency |
| `deps/sqlite-src` | `sqlite/sqlite` | SQLite source used by PROJ/GDAL builds |
| `deps/georust-geos` | `georust/geos` | Rust `geos` / `geos-sys` sources |
| `deps/georust-proj` | `georust/proj` | Rust `proj-sys` source |
| `deps/georust-gdal` | `georust/gdal` | Rust `gdal-sys` source |

## Patch Layout

Patch files are grouped by upstream repository:

| Patch dir | Applied to |
|---|---|
| `patches/sedona-db` | `deps/sedona-db` |
| `patches/georust-geos` | `deps/georust-geos` |
| `patches/georust-proj` | `deps/georust-proj` |
| `patches/georust-gdal` | `deps/georust-gdal` |

## Generated Sources

`make prepare-sources` exports clean copies of the patched source trees to
`build/patched-sources/` and applies the patch series there.

Cargo path overrides in the root workspace point at `build/patched-sources/`
instead of copied source trees checked into git.

## Makefile Entry Points

The build and bootstrap flow is intentionally surfaced in `Makefile`:

- `make deps`
- `make prepare-sources`
- `make check`
- `make build`
- `make build-full`
- `make build-geos`
- `make build-proj`
- `make build-gdal`
- `make build-sqlite-lib`
- `make build-geos-lib`
- `make build-proj-lib`
- `make build-gdal-lib`
- `make build-js`
