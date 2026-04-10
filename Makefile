.PHONY: help deps deps-init deps-absorb prepare-sources check install-js-deps install-playground-deps \
	build build-minimal build-standard build-global build-full build-geos build-geos-proj build-geos-proj-s2 build-proj build-gdal \
	build-rust-minimal build-rust-standard build-rust-global build-rust-full build-rust-geos build-rust-geos-proj build-rust-geos-proj-s2 build-rust-proj build-rust-gdal \
	build-sqlite-lib build-geos-lib build-proj-lib build-gdal-deps-lib build-gdal-lib \
	s2-vcpkg-bootstrap s2-vcpkg-install s2-spike-vcpkg \
	build-js build-ts build-playground package-minimal package-standard package-global package-full package-all sync-versions \
	test-js test-js-minimal test-js-standard test-js-global test-js-full test-js-geos test-js-geos-proj test-js-geos-proj-s2 \
	patch-wasm-js optimize-wasm size-minimal size-standard size-global size-full size-report surface-report size-geos size-geos-proj size-geos-proj-s2 \
	clean clean-all serve

help:
	@printf '%s\n' \
		'make deps               Initialize all submodules' \
		'make prepare-sources    Generate patched source trees under build/' \
		'make check              Prepare sources and run cargo check' \
		'make install-js-deps    Install JavaScript test/build dependencies' \
		'make install-playground-deps Install playground dependencies' \
		'make build              Build the minimal browser package' \
		'make build-minimal      Build the minimal browser package (GEOS)' \
		'make build-standard     Build the standard browser package (GEOS + PROJ)' \
		'make build-global       Build the global browser package (GEOS + PROJ + S2)' \
		'make build-full         Build the full browser package (GEOS + PROJ + GDAL + S2)' \
		'make build-js           Build the minimal browser package and TypeScript wrapper' \
		'make build-ts           Compile the TypeScript wrapper only' \
		'make build-playground   Build the playground app against @cereusdb/standard' \
		'make package-minimal    Assemble the @cereusdb/minimal npm package' \
		'make package-standard   Assemble the @cereusdb/standard npm package' \
		'make package-global     Assemble the @cereusdb/global npm package' \
		'make package-full       Assemble the @cereusdb/full npm package' \
		'make package-all        Assemble all public npm packages' \
		'make sync-versions      Sync package versions from Cargo.toml' \
		'make test-js            Build the full browser package and run the Vitest suite' \
		'make test-js-minimal    Build the minimal package and run the Vitest suite' \
		'make test-js-standard   Build the standard package and run the Vitest suite' \
		'make test-js-global     Build the global package and run the Vitest suite' \
		'make test-js-full       Build the full browser package and run the Vitest suite' \
		'make build-sqlite-lib   Build SQLite static library for Emscripten' \
		'make build-geos-lib     Build GEOS static library for Emscripten' \
		'make build-proj-lib     Build PROJ static library for Emscripten' \
		'make build-gdal-lib     Build GDAL static library for Emscripten' \
		'make s2-vcpkg-bootstrap Bootstrap vcpkg for the optional S2 spike path' \
		'make s2-vcpkg-install   Install S2 spike deps (openssl, abseil) via vcpkg' \
		'make s2-spike-vcpkg    Run the isolated S2 + vcpkg Emscripten spike' \
		'make patch-wasm-js      Apply JS env shim to the current pkg/ symlink target' \
		'make optimize-wasm      Run wasm-opt on the generated WASM in pkg/' \
		'make size-minimal       Build and report minimal package size' \
		'make size-standard      Build and report standard package size' \
		'make size-global        Build and report global package size' \
		'make size-full          Build and report full package size' \
		'make size-report        Build and report all browser package sizes' \
		'make surface-report     Build all browser packages and regenerate the runtime surface report' \
		'make clean              Remove generated build artifacts' \
		'make serve              Start the Vite playground on http://127.0.0.1:8080'

deps: deps-init deps-absorb

deps-init:
	git submodule update --init --recursive

deps-absorb:
	git submodule absorbgitdirs deps/sedona-db deps/geos deps/proj deps/gdal deps/expat deps/zlib deps/georust-geos deps/georust-proj deps/georust-gdal deps/sqlite-src

prepare-sources:
	bash scripts/prepare-patched-sources.sh

check: prepare-sources
	cargo check -p cereusdb

install-js-deps:
	cd js && npm ci

install-playground-deps:
	cd packages/playground && npm ci

build: build-rust-minimal

build-minimal: build-rust-minimal

build-standard: build-rust-standard

build-global: build-rust-global

build-full: build-rust-full

build-geos: build-minimal

build-geos-proj: build-standard

build-geos-proj-s2: build-global

build-proj: build-geos-proj

build-gdal: build-full

build-rust-minimal:
	bash scripts/build.sh --with-geos --out-dir dist/minimal

build-rust-standard:
	bash scripts/build.sh --with-geos --with-proj --out-dir dist/standard

build-rust-global:
	bash scripts/build.sh --with-geos --with-proj --with-s2 --out-dir dist/global

build-rust-geos: build-rust-minimal

build-rust-geos-proj: build-rust-standard

build-rust-geos-proj-s2: build-rust-global

build-rust-proj: build-rust-geos-proj

build-rust-full:
	bash scripts/build.sh --full --out-dir dist/full

build-rust-gdal: build-rust-full

build-sqlite-lib:
	bash scripts/emscripten/build-sqlite.sh build/sqlite build/sysroot

build-geos-lib:
	bash scripts/emscripten/build-geos.sh build/geos build/sysroot

build-proj-lib:
	bash scripts/emscripten/build-proj.sh build/proj build/sysroot

build-gdal-deps-lib:
	bash scripts/emscripten/build-gdal-deps.sh build/gdal build/sysroot

build-gdal-lib:
	bash scripts/emscripten/build-gdal.sh build/gdal build/sysroot

s2-vcpkg-bootstrap:
	bash scripts/emscripten/bootstrap-vcpkg.sh

s2-vcpkg-install:
	bash scripts/emscripten/install-s2-vcpkg-deps.sh

s2-spike-vcpkg:
	bash scripts/emscripten/spike-s2-vcpkg.sh

build-js: build-minimal build-ts

build-ts: install-js-deps
	cd js && npm exec tsc

build-playground: package-standard
	cd packages/playground && npm run build

package-minimal: build-minimal build-ts
	node scripts/build-npm-package.mjs minimal

package-standard: build-standard build-ts
	node scripts/build-npm-package.mjs standard

package-global: build-global build-ts
	node scripts/build-npm-package.mjs global

package-full: build-full build-ts
	node scripts/build-npm-package.mjs full

package-all: package-minimal package-standard package-global package-full

sync-versions:
	node scripts/sync-package-versions.mjs

test-js: test-js-full

test-js-minimal: build-minimal build-ts
	cd js && npm run test:minimal

test-js-standard: build-standard build-ts
	cd js && npm run test:standard

test-js-global: build-global build-ts
	cd js && npm run test:global

test-js-full: build-full build-ts
	cd js && npm run test:full

test-js-geos: test-js-minimal

test-js-geos-proj: test-js-standard

test-js-geos-proj-s2: test-js-global

patch-wasm-js:
	bash scripts/patch-wasm-js.sh pkg

optimize-wasm:
	wasm-opt -Oz pkg/cereusdb_bg.wasm -o pkg/cereusdb_bg.wasm

size-minimal: build-minimal
	bash scripts/report-wasm-size.sh dist/minimal/cereusdb_bg.wasm minimal

size-standard: build-standard
	bash scripts/report-wasm-size.sh dist/standard/cereusdb_bg.wasm standard

size-global: build-global
	bash scripts/report-wasm-size.sh dist/global/cereusdb_bg.wasm global

size-full: build-full
	bash scripts/report-wasm-size.sh dist/full/cereusdb_bg.wasm full

size-geos: size-minimal

size-geos-proj: size-standard

size-geos-proj-s2: size-global

size-report: size-minimal size-standard size-global size-full

surface-report: build-minimal build-standard build-global build-full
	node scripts/generate-runtime-surface-report.mjs

clean:
	rm -rf build/ dist/ pkg/ target/

clean-all: clean

serve:
	cd packages/playground && npm run dev -- --host 127.0.0.1
