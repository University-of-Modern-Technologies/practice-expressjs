import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

export interface ServiceInfo {
  readonly name: string;
  readonly version: string;
}

const FALLBACK_SERVICE_INFO: ServiceInfo = { name: 'nodejs-backend', version: '0.0.0' };

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * Walks up from `startDirectory` until a readable `package.json` is found.
 * The compiled layout (`dist/app/health`) and the source layout
 * (`src/app/health`) both resolve to the project root this way, so the version
 * stays correct without bundling the manifest into the TypeScript program.
 */
const findPackageManifest = (startDirectory: string): Record<string, unknown> | undefined => {
  const { root } = parse(startDirectory);
  let current = startDirectory;

  for (;;) {
    try {
      const raw = readFileSync(join(current, 'package.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);

      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not a package root (or unreadable manifest); keep walking upwards.
    }

    if (current === root) return undefined;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

let cachedServiceInfo: ServiceInfo | undefined;

/**
 * Resolves the service name and version from the nearest `package.json`.
 * The result is cached because it never changes for the life of the process.
 */
export const readServiceInfo = (startDirectory: string = __dirname): ServiceInfo => {
  if (cachedServiceInfo) return cachedServiceInfo;

  const manifest = findPackageManifest(startDirectory);
  const name = manifest && isNonEmptyString(manifest.name) ? manifest.name : undefined;
  const version = manifest && isNonEmptyString(manifest.version) ? manifest.version : undefined;

  cachedServiceInfo = {
    name: name ?? FALLBACK_SERVICE_INFO.name,
    version: version ?? FALLBACK_SERVICE_INFO.version,
  };

  return cachedServiceInfo;
};

/** Clears the memoised manifest lookup. Intended for tests only. */
export const resetServiceInfoCache = (): void => {
  cachedServiceInfo = undefined;
};
