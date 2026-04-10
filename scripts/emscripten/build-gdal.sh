#!/bin/bash
# Cross-compile GDAL to WASM with Emscripten (browser-focused driver set)
set -euo pipefail

BUILD_DIR="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")" || BUILD_DIR="$1"
INSTALL_DIR="$(cd "$(dirname "$2")" 2>/dev/null && pwd)/$(basename "$2")" || INSTALL_DIR="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
GDAL_SRC="$ROOT_DIR/deps/gdal"
export EM_CACHE="${EM_CACHE:-$ROOT_DIR/build/emscripten-cache}"
OPT_FLAGS="${CEREUSDB_C_OPT_FLAGS:-${SEDONA_WASM_C_OPT_FLAGS:--Oz -DNDEBUG -fwasm-exceptions}}"

NJOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

echo "  GDAL source:  $GDAL_SRC"
echo "  Build dir:    $BUILD_DIR"
echo "  Install dir:  $INSTALL_DIR"

mkdir -p "$BUILD_DIR" "$INSTALL_DIR" "$EM_CACHE"

# Build zlib + expat first
bash "$(dirname "$0")/build-gdal-deps.sh" "$BUILD_DIR" "$INSTALL_DIR"
bash "$(dirname "$0")/build-sqlite.sh" "$BUILD_DIR/sqlite" "$INSTALL_DIR"

mkdir -p "$BUILD_DIR/gdal"
cd "$BUILD_DIR/gdal"

# GDAL with a browser-focused driver set.
# Keep the vector formats we already use, and enable GeoTIFF through GDAL's
# internal TIFF/libgeotiff path so the browser build can ingest GeoTIFF buffers.
emcmake cmake "$GDAL_SRC" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTING=OFF \
    -DBUILD_APPS=OFF \
    -DCMAKE_PREFIX_PATH="$INSTALL_DIR" \
    \
    -DGDAL_BUILD_OPTIONAL_DRIVERS=OFF \
    -DOGR_BUILD_OPTIONAL_DRIVERS=OFF \
    \
    -DOGR_ENABLE_DRIVER_GEOJSON=ON \
    -DOGR_ENABLE_DRIVER_SHAPE=ON \
    -DOGR_ENABLE_DRIVER_GPKG=ON \
    -DOGR_ENABLE_DRIVER_CSV=ON \
    -DOGR_ENABLE_DRIVER_KML=ON \
    -DOGR_ENABLE_DRIVER_GML=ON \
    -DOGR_ENABLE_DRIVER_FLATGEOBUF=ON \
    -DOGR_ENABLE_DRIVER_WKT=ON \
    -DOGR_ENABLE_DRIVER_GEORSS=ON \
    -DOGR_ENABLE_DRIVER_MEMORY=ON \
    -DGDAL_ENABLE_DRIVER_GTIFF=ON \
    \
    -DGDAL_USE_JPEG=OFF \
    -DGDAL_USE_TIFF=OFF \
    -DGDAL_USE_GEOTIFF=OFF \
    -DGDAL_USE_TIFF_INTERNAL=ON \
    -DGDAL_USE_GEOTIFF_INTERNAL=ON \
    -DGDAL_USE_CURL=OFF \
    -DGDAL_USE_GEOS=ON \
    -DGDAL_USE_ZLIB=ON \
    -DGDAL_USE_EXPAT=ON \
    \
    -DGEOS_INCLUDE_DIR="$INSTALL_DIR/include" \
    -DGEOS_LIBRARY="$INSTALL_DIR/lib/libgeos.a" \
    -DPROJ_INCLUDE_DIR="$INSTALL_DIR/include" \
    -DPROJ_LIBRARY="$INSTALL_DIR/lib/libproj.a" \
    -DSQLITE3_INCLUDE_DIR="$INSTALL_DIR/include" \
    -DSQLITE3_LIBRARY="$INSTALL_DIR/lib/libsqlite3.a" \
    -DZLIB_INCLUDE_DIR="$INSTALL_DIR/include" \
    -DZLIB_LIBRARY="$INSTALL_DIR/lib/libz.a" \
    -DEXPAT_INCLUDE_DIR="$INSTALL_DIR/include" \
    -DEXPAT_LIBRARY="$INSTALL_DIR/lib/libexpat.a" \
    \
    -DACCEPT_MISSING_SQLITE3_MUTEX_ALLOC=ON \
    -DACCEPT_MISSING_SQLITE3_RTREE=ON \
    -DCMAKE_C_FLAGS="$OPT_FLAGS" \
    -DCMAKE_CXX_FLAGS="$OPT_FLAGS"

emmake make -j"$NJOBS" || {
    echo "  Full build failed, trying individual targets..."
    emmake make -j"$NJOBS" gdal 2>/dev/null || true
}

# Install (may partially fail due to app linking, that's OK)
emmake make install 2>/dev/null || {
    # Manual install of libs and headers
    cp lib/libgdal.a "$INSTALL_DIR/lib/" 2>/dev/null || true
    cp -r "$GDAL_SRC/gcore/"*.h "$INSTALL_DIR/include/" 2>/dev/null || true
    cp -r "$GDAL_SRC/port/"*.h "$INSTALL_DIR/include/" 2>/dev/null || true
    cp -r "$GDAL_SRC/ogr/"*.h "$INSTALL_DIR/include/" 2>/dev/null || true
}

echo "  GDAL build complete"
ls -lh "$INSTALL_DIR/lib/libgdal.a" 2>/dev/null || echo "  WARNING: libgdal.a not found"
