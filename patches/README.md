# Patch Series

This directory contains patch files only.

Each subdirectory maps to one upstream source repository:

- `sedona-db`
- `georust-geos`
- `georust-proj`
- `georust-gdal`

`make prepare-sources` exports the corresponding submodule source trees into
`build/patched-sources/` and applies these patch files in lexical order.
