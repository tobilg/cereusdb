/*
 * Replacement for PROJ's src/embedded_resources.c in the WebAssembly build.
 *
 * PROJ is built with EMBED_RESOURCE_FILES=ON and USE_ONLY_EMBEDDED_RESOURCE_FILES=ON,
 * so it reads proj.db through pj_get_embedded_proj_db() and serves it with its own
 * in-memory SQLite VFS. Upstream embeds the raw 9+ MB database; this version embeds
 * it zstd-compressed and inflates it on first use, which keeps the wasm binary
 * about 8 MB smaller. scripts/emscripten/build-proj.sh compiles this file and
 * replaces PROJ's embedded_resources.c.o in libproj.a with it.
 *
 * Compile definitions:
 *   CEREUSDB_PROJ_DB_ZST  quoted path to the zstd-compressed proj.db
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <zstd.h>

#include "embedded_resources.h"

static const unsigned char proj_db_zst[] = {
#embed CEREUSDB_PROJ_DB_ZST
};

const unsigned char *pj_get_embedded_proj_db(unsigned int *pnSize) {
    /* The WebAssembly build is single-threaded, so lazy initialization is safe. */
    static unsigned char *proj_db = NULL;
    static unsigned int proj_db_size = 0;

    if (proj_db == NULL) {
        unsigned long long size =
            ZSTD_getFrameContentSize(proj_db_zst, sizeof(proj_db_zst));
        if (size == ZSTD_CONTENTSIZE_ERROR || size == ZSTD_CONTENTSIZE_UNKNOWN ||
            size > UINT32_MAX) {
            *pnSize = 0;
            return NULL;
        }

        unsigned char *buffer = (unsigned char *)malloc((size_t)size);
        if (buffer == NULL) {
            *pnSize = 0;
            return NULL;
        }

        size_t written =
            ZSTD_decompress(buffer, (size_t)size, proj_db_zst, sizeof(proj_db_zst));
        if (ZSTD_isError(written) || written != size) {
            free(buffer);
            *pnSize = 0;
            return NULL;
        }

        proj_db = buffer;
        proj_db_size = (unsigned int)size;
    }

    *pnSize = proj_db_size;
    return proj_db;
}

/* PROJ's generated table of small embedded resources (proj.ini, init files). */
#include "file_embed/embedded_resources.c"
