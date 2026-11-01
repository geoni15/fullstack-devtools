import type { HandlerSource } from '@bdt/protocol';
import type { PageElementRef } from './page-inventory';

export interface RuntimeHandlerLink {
  element: PageElementRef;
  event: 'click' | 'submit';
  name: string | null;
  url: string | null;
  line: number | null;
  column: number | null;
  source: HandlerSource;
  note: string | null;
  at: number;
}

export class RuntimeHandlerLedger {
  private readonly links = new Map<string, RuntimeHandlerLink>();

  record(link: RuntimeHandlerLink): boolean {
    const key = [
      link.element.key,
      link.event,
      link.url ?? '',
      String(link.line ?? ''),
      String(link.column ?? ''),
      link.source,
      link.name ?? '',
    ].join('\u0000');
    const existing = this.links.get(key);
    if (existing === undefined) {
      this.links.set(key, { ...link });
      return true;
    }
    existing.element = link.element;
    existing.at = Math.max(existing.at, link.at);
    existing.note = link.note ?? existing.note;
    return false;
  }

  all(): RuntimeHandlerLink[] {
    return [...this.links.values()];
  }

  clear(): void {
    this.links.clear();
  }
}
