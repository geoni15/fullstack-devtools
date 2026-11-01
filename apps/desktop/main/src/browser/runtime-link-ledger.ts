import type { PageElementRef } from './page-inventory';

export type RuntimeLinkBasis = 'identity' | 'content' | 'render';

export interface RuntimeLinkRoute {
  method: string;
  path: string;
  file: string;
  routeLine: number;
}

export interface RuntimeProvenanceLink {
  element: PageElementRef;
  requestId: string | null;
  method: string | null;
  path: string | null;
  route: RuntimeLinkRoute | null;
  basis: RuntimeLinkBasis;
  component: string | null;
  file: string | null;
  line: number | null;
  code: string | null;
  dataPath: string | null;
  value: string | null;
  at: number;
}

const BASIS_RANK: Record<RuntimeLinkBasis, number> = { render: 0, content: 1, identity: 2 };

export class RuntimeLinkLedger {
  private readonly links = new Map<string, RuntimeProvenanceLink>();

  record(link: RuntimeProvenanceLink): boolean {
    const key = [
      link.element.key,
      link.requestId ?? '',
      link.route === null
        ? ''
        : `${link.route.method} ${link.route.path}@${link.route.file}:${String(link.route.routeLine)}`,
      link.component ?? '',
      link.file ?? '',
      String(link.line ?? ''),
      link.dataPath ?? '',
    ].join('\u0000');
    const existing = this.links.get(key);
    if (existing === undefined) {
      this.links.set(key, { ...link });
      return true;
    }
    const changed =
      existing.value !== link.value || BASIS_RANK[link.basis] > BASIS_RANK[existing.basis];
    existing.element = link.element;
    existing.method = link.method;
    existing.path = link.path;
    existing.route = link.route ?? existing.route;
    existing.value = link.value;
    existing.at = Math.max(existing.at, link.at);
    existing.basis =
      BASIS_RANK[link.basis] > BASIS_RANK[existing.basis] ? link.basis : existing.basis;
    existing.code = link.code ?? existing.code;
    existing.component = link.component ?? existing.component;
    existing.file = link.file ?? existing.file;
    existing.line = link.line ?? existing.line;
    return changed;
  }

  all(): RuntimeProvenanceLink[] {
    return [...this.links.values()];
  }

  clear(): void {
    this.links.clear();
  }
}
