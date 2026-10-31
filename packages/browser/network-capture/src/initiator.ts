import type { InitiatorFrame, RequestInitiator } from '@bdt/protocol';

export interface RawCallFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface RawStackTrace {
  callFrames?: RawCallFrame[];
  parent?: RawStackTrace;
}

export interface RawInitiator {
  type?: string;
  stack?: RawStackTrace;
}

const MAX_FRAMES = 8;

function isHttpUrl(value: string | undefined): value is string {
  if (value === undefined || value.length === 0) return false;
  return value.startsWith('http://') || value.startsWith('https://');
}

function toFrame(frame: RawCallFrame): InitiatorFrame | null {
  if (!isHttpUrl(frame.url)) return null;
  return {
    functionName:
      frame.functionName !== undefined && frame.functionName.length > 0 ? frame.functionName : null,
    url: frame.url,
    line: (frame.lineNumber ?? 0) + 1,
    column: (frame.columnNumber ?? 0) + 1,
  };
}

export function normalizeInitiator(raw: RawInitiator | null | undefined): RequestInitiator | null {
  if (raw === null || raw === undefined) return null;
  const type = raw.type !== undefined && raw.type.length > 0 ? raw.type : 'other';
  const frames: InitiatorFrame[] = [];
  let stack = raw.stack;
  let async = false;
  const seen = new Set<RawStackTrace>();
  while (stack !== undefined && frames.length < MAX_FRAMES && !seen.has(stack)) {
    seen.add(stack);
    for (const rawFrame of stack.callFrames ?? []) {
      if (frames.length >= MAX_FRAMES) break;
      const frame = toFrame(rawFrame);
      if (frame !== null) frames.push(frame);
    }
    if (stack.parent !== undefined) {
      async = true;
      stack = stack.parent;
    } else {
      stack = undefined;
    }
  }
  return { type, frames, async, mapped: false };
}
