export const APP_SCHEME = 'bdt-app';
export const APP_HOST = 'app';
export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;
export const DEV_SERVER_URL = 'http://127.0.0.1:5173';

export const LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxTreeEntries: 20_000,
  maxTreeDepth: 20,
  maxRelativePathLength: 4096,
} as const;

export const IGNORED_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'release',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  '.DS_Store',
]);

export function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name);
}
