import type { CapturedBody } from '@bdt/protocol';

const MAX_DEPTH = 64;

interface OutputBudget {
  text: string;
  truncated: boolean;
  limit: number;
}

function push(budget: OutputBudget, chunk: string): void {
  if (budget.truncated) return;
  const remaining = budget.limit - budget.text.length;
  if (chunk.length <= remaining) {
    budget.text += chunk;
    return;
  }
  budget.text += chunk.slice(0, remaining);
  budget.truncated = true;
}

// Los valores se conservan tal cual, incluidas claves sensibles: el usuario audita
// el dato real. Solo se acota el tamaño y la profundidad; nada sale del proceso ni
// se escribe en disco. El enmascarado de cabeceras y query sigue vigente.
function writeBody(value: unknown, depth: number, budget: OutputBudget): void {
  if (budget.truncated) return;
  if (depth > MAX_DEPTH) {
    push(budget, 'null');
    return;
  }
  if (Array.isArray(value)) {
    push(budget, '[');
    for (let index = 0; index < value.length; index += 1) {
      if (budget.truncated) return;
      if (index > 0) push(budget, ',');
      writeBody(value[index], depth + 1, budget);
    }
    push(budget, ']');
    return;
  }
  if (value !== null && typeof value === 'object') {
    push(budget, '{');
    let first = true;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (budget.truncated) return;
      if (!first) push(budget, ',');
      first = false;
      push(budget, JSON.stringify(key));
      push(budget, ':');
      writeBody(item, depth + 1, budget);
    }
    push(budget, '}');
    return;
  }
  const serialized = JSON.stringify(value);
  if (typeof serialized === 'string') push(budget, serialized);
}

export function sanitizeJsonBody(
  raw: string | null | undefined,
  maxChars: number,
): CapturedBody | null {
  if (raw === null || raw === undefined || maxChars <= 0) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const budget: OutputBudget = { text: '', truncated: false, limit: maxChars };
  try {
    writeBody(parsed, 0, budget);
  } catch {
    return null;
  }
  if (budget.text === '') return null;
  return { text: budget.text, truncated: budget.truncated };
}
