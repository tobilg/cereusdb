# Patch Series

This directory contains patch files only.

Each subdirectory maps to one upstream source repository:

- `sedona-db`
- `object-store`
- `georust-geos`
- `georust-proj`
- `georust-gdal`

or to one crates.io crate, taken from the local Cargo registry (or downloaded):

- `datafusion-common` (52.5.0)
- `arrow-ipc` (57.3.0): backport of apache/arrow-rs#10989, which writes the
  length prefix of compressed IPC buffers as 8 bytes on wasm32. Remove it once
  the dependency tree is on arrow >= 60.

`make prepare-sources` exports the corresponding source trees into
`build/patched-sources/` and applies these patch files in lexical order. The
root `Cargo.toml` redirects the crates to the patched copies via
`[patch.crates-io]`.
