import type { FlowInteractionEvent } from '@bdt/protocol';
import type { PageElementRef } from './page-inventory';

export interface FlowInteractionSummary {
  key: string;
  event: FlowInteractionEvent;
  count: number;
  firstSeen: number;
  lastSeen: number;
  ref: PageElementRef;
}

export interface FlowInteractionOccurrence {
  key: string;
  event: FlowInteractionEvent;
  at: number;
  submitterKey: string | null;
}

const NO_OCCURRENCE: ReadonlySet<FlowInteractionEvent> = new Set(['hover']);

const OCCURRENCE_WINDOW_MS: Partial<Record<FlowInteractionEvent, number>> = {
  input: 200,
  scroll: 500,
};

export class InteractionLedger {
  private readonly summaries = new Map<string, FlowInteractionSummary>();
  private readonly references = new Map<string, PageElementRef>();
  private readonly occurrences: FlowInteractionOccurrence[] = [];
  private readonly lastOccurrence = new Map<string, number>();
  private total = 0;

  record(
    ref: PageElementRef,
    event: FlowInteractionEvent,
    at: number,
    submitter: PageElementRef | null = null,
  ): void {
    const time = Number.isFinite(at) && at > 0 ? at : Date.now();
    const id = `${ref.key}|${event}`;
    const existing = this.summaries.get(id);
    if (existing === undefined) {
      this.summaries.set(id, {
        key: ref.key,
        event,
        count: 1,
        firstSeen: time,
        lastSeen: time,
        ref,
      });
    } else {
      existing.count += 1;
      existing.firstSeen = Math.min(existing.firstSeen, time);
      existing.lastSeen = Math.max(existing.lastSeen, time);
      existing.ref = ref;
    }
    this.references.set(ref.key, ref);
    if (submitter !== null) this.references.set(submitter.key, submitter);
    this.total += 1;

    if (NO_OCCURRENCE.has(event)) return;
    const window = OCCURRENCE_WINDOW_MS[event] ?? 0;
    const index = this.lastOccurrence.get(id);
    const current = index === undefined ? undefined : this.occurrences[index];
    if (current !== undefined && window > 0 && time - current.at <= window) {
      current.at = Math.max(current.at, time);
      if (submitter !== null) current.submitterKey = submitter.key;
      return;
    }
    this.lastOccurrence.set(id, this.occurrences.length);
    this.occurrences.push({
      key: ref.key,
      event,
      at: time,
      submitterKey: submitter === null ? null : submitter.key,
    });
  }

  summariesAll(): FlowInteractionSummary[] {
    return [...this.summaries.values()];
  }

  occurrenceList(): readonly FlowInteractionOccurrence[] {
    return this.occurrences;
  }

  referencesAll(): PageElementRef[] {
    return [...this.references.values()];
  }

  totalInteractions(): number {
    return this.total;
  }

  eventCount(event: FlowInteractionEvent): number {
    let count = 0;
    for (const summary of this.summaries.values()) {
      if (summary.event === event) count += summary.count;
    }
    return count;
  }

  clear(): void {
    this.summaries.clear();
    this.references.clear();
    this.occurrences.length = 0;
    this.lastOccurrence.clear();
    this.total = 0;
  }
}
