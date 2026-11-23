import { isAbsolute, join } from 'node:path';

/** The display name may change; the storage identity must not. */
export function resolveDataPath(options: {
  appData: string;
  packaged: boolean;
  commandLineProfile?: string;
  developmentProfile?: string;
}): string {
  if (!options.packaged && options.developmentProfile && isAbsolute(options.developmentProfile)) {
    return options.developmentProfile;
  }
  // Electron has already resolved --user-data-dir, including relative arguments.
  return options.commandLineProfile ?? join(options.appData, 'Whistle Mock Manager');
}
