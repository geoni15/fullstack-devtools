const SENSITIVE_PARTS = [
  'authorization',
  'cookie',
  'x-api-key',
  'password',
  'token',
  'secret',
  'jwt',
  'session',
];

const MAX_HEADERS = 40;
const MAX_NAME_LENGTH = 128;
const MAX_VALUE_LENGTH = 512;
const MASK = '[enmascarado]';

export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_PARTS.some((part) => lower.includes(part));
}

export function maskHeaders(
  headers: Record<string, string> | undefined | null,
): Record<string, string> {
  if (headers === undefined || headers === null) return {};
  const masked: Record<string, string> = {};
  let stored = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (stored >= MAX_HEADERS) break;
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) continue;
    masked[name] = isSensitiveHeader(name) ? MASK : value.slice(0, MAX_VALUE_LENGTH);
    stored += 1;
  }
  return masked;
}

export interface MaskedUrl {
  url: string;
  path: string;
}

export function maskUrlParts(value: string): MaskedUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { url: value.slice(0, 2048), path: value.slice(0, 2048) };
  }
  for (const name of [...url.searchParams.keys()]) {
    if (isSensitiveHeader(name)) url.searchParams.set(name, MASK);
  }
  const path = (url.pathname + url.search).slice(0, 2048);
  return { url: url.toString().slice(0, 2048), path };
}

export function maskUrl(value: string): string {
  return maskUrlParts(value).url;
}
