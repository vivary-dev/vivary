export function resolveOriginalRuntime(directory: string | undefined): Promise<Readonly<{
  root: string;
  executable: string;
  version: string;
  /** The first 8 hex digits of the sha256 of `manifest.json`. It names this build's bytecode cache folder. */
  build: string;
}>>;
