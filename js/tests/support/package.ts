export type PackageName = 'minimal' | 'standard' | 'global' | 'full';

const rawPackageName = process.env.CEREUSDB_PACKAGE ?? process.env.SEDONA_WASM_PACKAGE ?? 'full';
const packageName =
  rawPackageName === 'geos'
    ? 'minimal'
    : rawPackageName === 'geos-proj'
      ? 'standard'
      : rawPackageName === 'geos-proj-s2'
        ? 'global'
        : rawPackageName;

if (
  packageName !== 'minimal' &&
  packageName !== 'standard' &&
  packageName !== 'global' &&
  packageName !== 'full'
) {
  throw new Error(`Unsupported CEREUSDB_PACKAGE: ${rawPackageName}`);
}

export const targetPackage = packageName as PackageName;

export const packageExpectations: Record<
  PackageName,
  {
    hasTransform: boolean;
    hasRaster: boolean;
    hasSpatialJoin: boolean;
    hasKnn: boolean;
    hasS2: boolean;
  }
> = {
  minimal: { hasTransform: false, hasRaster: false, hasSpatialJoin: true, hasKnn: true, hasS2: false },
  standard: { hasTransform: true, hasRaster: false, hasSpatialJoin: true, hasKnn: true, hasS2: false },
  global: { hasTransform: true, hasRaster: false, hasSpatialJoin: true, hasKnn: true, hasS2: true },
  full: { hasTransform: true, hasRaster: true, hasSpatialJoin: true, hasKnn: true, hasS2: true },
};
