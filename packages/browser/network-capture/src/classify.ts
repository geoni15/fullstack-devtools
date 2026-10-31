import type { RequestOrigin } from '@bdt/protocol';

export interface ClassificationTargets {
  frontendOrigin: string;
  backendOrigin: string;
}

export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function classifyUrl(url: string, targets: ClassificationTargets): RequestOrigin {
  const origin = normalizeOrigin(url);
  if (origin === null) return 'external';
  if (origin === targets.backendOrigin) return 'backend';
  if (origin === targets.frontendOrigin) return 'frontend';
  return 'external';
}
