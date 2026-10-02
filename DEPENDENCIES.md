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
| `deps/zstd` | `facebook/zstd` | ZSTD for Parquet (all packages) and GeoTIFF (`full`) |
| `deps/georust-geos` | `georust/geos` | Rust `geos` / `geos-sys` sources |
| `deps/georust-proj` | `georust/proj` | Rust `proj-sys` source |
| `deps/georust-gdal` | `georust/gdal` | Rust `gdal-sys` source |
| `deps/object-store` | `apache/arrow-rs-object-store` | Rust `object_store` source |
| `deps/vcpkg` | `microsoft/vcpkg` | Ports for the S2 dependencies (`global`, `full`) |

## Pinned Versions

`deps/versions.env` is the single place that lists every pinned build input:

- the toolchain (`EMSDK_VERSION`, `WASM_PACK_VERSION`, `NODE_VERSION`,
  `NPM_VERSION`); Rust is
  pinned in `rust-toolchain.toml`
- for each submodule, its upstream `<NAME>_TAG`, or `<NAME>_COMMIT` for the
  few dependencies without a suitable tag (sedona-db, georust-geos, vcpkg)

`scripts/build.sh` sources the file, and both GitHub workflows load it into
their environment. `make check-deps` fails when a submodule gitlink or its
checked-out commit is not the commit the tag points at, or when a workflow's
Rust toolchain disagrees with `rust-toolchain.toml`. Tags are resolved from the
submodule when available and from upstream otherwise; `make check-deps-remote`
always resolves them upstream, and CI runs this variant.

To bump a dependency:

```bash
git -C deps/geos fetch --tags
git -C deps/geos checkout 3.13.2
# set GEOS_TAG=3.13.2 in deps/versions.env
git add deps/geos deps/versions.env
make check-deps-remote
```

After changing a C/C++ library or the Emscripten version, run `make clean` so
the cached builds in `build/` are regenerated.

## PROJ database

PROJ is built with `EMBED_RESOURCE_FILES=ON` and `USE_ONLY_EMBEDDED_RESOURCE_FILES=ON`,
so it serves `proj.db` from memory through its own SQLite VFS.
`scripts/emscripten/build-proj.sh` replaces PROJ's `embedded_resources.c.o` in
`libproj.a` with `scripts/emscripten/proj-embedded-resources.c`, which embeds the
database zstd-compressed and inflates it on first use. GDAL and `sedona-proj`
share this single copy.

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
