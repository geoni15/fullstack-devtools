import type { CapturedBody, CapturedRequest } from '@bdt/protocol';

export interface JsonTextMatch {
  requestId: string;
  origin: 'response' | 'request';
  jsonPath: string;
  parentPath: string;
  key: string | null;
  value: string;
  partial: boolean;
  approximate: boolean;
  basis: 'text' | 'data';
  bodyTruncated: boolean;
  parent: string;
  parentTruncated: boolean;
}

export interface JsonDataHint {
  value: string;
  path: string;
}

interface ScanState {
  query: string;
  foldedQuery: string;
  exact: JsonTextMatch[];
  partial: JsonTextMatch[];
  reverse: JsonTextMatch[] | null;
  numbers: ReadonlySet<number> | null;
  requestId: string;
  origin: 'response' | 'request';
  bodyTruncated: boolean;
}

interface Fingerprints {
  strings: Set<string>;
  numbers: Set<number>;
}

interface GroupScore {
  path: string;
  node: unknown;
  score: number;
  first: { path: string; key: string | null; value: string };
}

interface DataScanState {
  fingerprints: Fingerprints;
  groups: Map<string, GroupScore>;
  ancestors: Array<{ path: string; node: unknown }>;
  requestId: string;
  bodyTruncated: boolean;
}

const MAX_DEPTH = 14;
const MAX_PARENT_CHARS = 2400;
const MAX_VALUE_CHARS = 200;
const MAX_EXACT = 8;
const MAX_PARTIAL = 12;
const MIN_QUERY_CHARS = 3;
const MIN_PARTIAL_QUERY_CHARS = 8;
const MIN_REVERSE_TEXT = 6;
const MAX_REVERSE_MATCHES = 12;
const MAX_REVERSE_RESULTS = 3;
const MAX_FINGERPRINTS = 160;
const MAX_DATA_RESULTS = 4;
const MAX_JSON_BOUNDARIES = 16;

const parsedBodies = new WeakMap<CapturedBody, unknown | null>();

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function foldText(value: string): string {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function numericVariants(raw: string): number[] {
  const cleaned = raw.replace(/[^\d.,-]/g, '');
  if (cleaned === '' || !/\d/.test(cleaned)) return [];
  const variants = new Set<string>();
  variants.add(cleaned.replace(/,/g, ''));
  variants.add(cleaned.replace(/\./g, '').replace(/,/g, '.'));
  variants.add(cleaned.replace(/[.,]/g, ''));
  const result: number[] = [];
  for (const variant of variants) {
    const value = Number(variant);
    if (Number.isFinite(value)) result.push(value);
  }
  return result;
}

function queryNumbers(query: string): Set<number> {
  const numbers = new Set<number>();
  for (const token of query.match(/\d[\d.,\s]*\d|\d/g) ?? []) {
    const digits = token.replace(/[^\d]/g, '');
    if (digits.length < 2) continue;
    for (const value of numericVariants(token)) numbers.add(value);
  }
  return numbers;
}

function hasFormattedNumber(value: string): boolean {
  return /\p{Sc}/u.test(value) || /\d[.,\u00a0\u202f]\d/.test(value);
}

function pathLeafKey(path: string): string | null {
  const match = /([A-Za-z_$][\w$]*)\s*\]?\s*$/.exec(path);
  return match?.[1] ?? null;
}

function normalizeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

// React/Vue data paths expose the source field (sale_price, unitPrice…) even
// when the rendered text is formatted beyond recognition in the JSON.
function relevantHintKeys(query: string, hints: readonly JsonDataHint[]): Set<string> {
  const keys = new Set<string>();
  if (hints.length === 0) return keys;
  const numbers = queryNumbers(query);
  const foldedQuery = foldText(query);
  for (const hint of hints) {
    const key = pathLeafKey(hint.path);
    if (key === null) continue;
    const value = normalizeText(hint.value);
    if (value.length < 2 || value === '[enmascarado]') continue;
    const numericHit = numericVariants(value).some((candidate) => numbers.has(candidate));
    const folded = foldText(value);
    const textHit =
      foldedQuery.length >= MIN_QUERY_CHARS &&
      folded.length >= MIN_QUERY_CHARS &&
      (foldedQuery.includes(folded) || folded.includes(foldedQuery));
    if (numericHit || textHit) keys.add(normalizeKey(key));
  }
  return keys;
}

function childPath(base: string, key: string): string {
  const clean = key.slice(0, 80);
  return /^[A-Za-z_$][\w$]*$/.test(clean)
    ? `${base}.${clean}`
    : `${base}[${JSON.stringify(clean)}]`;
}

interface JsonBoundary {
  end: number;
  closers: string;
}

function closersFor(stack: readonly string[]): string {
  let result = '';
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    result += stack[index] === '{' ? '}' : ']';
  }
  return result;
}

function parseJsonObject(text: string): unknown | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function tryBoundary(text: string, boundary: JsonBoundary): unknown | null {
  let end = boundary.end;
  while (end > 0 && /\s/.test(text[end - 1] ?? '')) end -= 1;
  let prefix = text.slice(0, end);
  if (prefix.endsWith(',')) prefix = prefix.slice(0, -1);
  if (prefix === '' || prefix.endsWith(':') || prefix.endsWith(',')) return null;
  return parseJsonObject(prefix + boundary.closers);
}

// A truncated body is valid JSON plus a cut in the middle: drop the incomplete
// tail and close the open containers so the captured prefix stays searchable.
function repairTruncatedJson(text: string): unknown | null {
  const stack: string[] = [];
  const boundaries: JsonBoundary[] = [];
  let inString = false;
  let escaped = false;
  const record = (end: number): void => {
    boundaries.push({ end, closers: closersFor(stack) });
    if (boundaries.length > MAX_JSON_BOUNDARIES) boundaries.shift();
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
        record(index + 1);
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      if (stack.length > 0) stack.pop();
      record(index + 1);
    } else if (char !== undefined && /[0-9a-z]/.test(char)) {
      const next = text[index + 1];
      if (next === undefined || !/[0-9a-zA-Z.+-]/.test(next)) record(index + 1);
    }
  }
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index];
    if (boundary === undefined) continue;
    const repaired = tryBoundary(text, boundary);
    if (repaired !== null) return repaired;
  }
  return null;
}

function parseBody(body: CapturedBody): unknown | null {
  if (parsedBodies.has(body)) {
    return parsedBodies.get(body) ?? null;
  }
  const parsed =
    parseJsonObject(body.text) ?? (body.truncated ? repairTruncatedJson(body.text) : null);
  parsedBodies.set(body, parsed);
  return parsed;
}

function parentText(value: unknown): { text: string; truncated: boolean } {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text.length > MAX_PARENT_CHARS) {
      return { text: text.slice(0, MAX_PARENT_CHARS), truncated: true };
    }
    return { text, truncated: false };
  } catch {
    return { text: '', truncated: false };
  }
}

function buildMatch(
  state: Pick<ScanState, 'requestId' | 'origin' | 'bodyTruncated'>,
  raw: string,
  jsonPath: string,
  parentPath: string,
  key: string | null,
  parent: unknown,
  flags: Pick<JsonTextMatch, 'partial' | 'approximate' | 'basis'>,
): JsonTextMatch {
  const value = normalizeText(raw);
  const container = parentText(parent);
  return {
    requestId: state.requestId,
    origin: state.origin,
    jsonPath,
    parentPath,
    key,
    value: value.slice(0, MAX_VALUE_CHARS),
    partial: flags.partial,
    approximate: flags.approximate,
    basis: flags.basis,
    bodyTruncated: state.bodyTruncated,
    parent: container.text,
    parentTruncated: container.truncated,
  };
}

function recordMatch(
  state: ScanState,
  raw: string,
  jsonPath: string,
  parentPath: string,
  key: string | null,
  parent: unknown,
): void {
  const value = normalizeText(raw);
  if (value === '' || value === '[enmascarado]') return;
  let partial: boolean;
  if (value === state.query) {
    partial = false;
  } else if (state.query.length >= MIN_PARTIAL_QUERY_CHARS && value.includes(state.query)) {
    partial = true;
  } else {
    const folded = foldText(value);
    if (state.query.length >= 4 && folded === state.foldedQuery) {
      partial = true;
    } else if (
      state.query.length >= MIN_PARTIAL_QUERY_CHARS &&
      state.foldedQuery.length >= MIN_PARTIAL_QUERY_CHARS &&
      folded.includes(state.foldedQuery)
    ) {
      partial = true;
    } else {
      return;
    }
  }
  const bucket = partial ? state.partial : state.exact;
  if (bucket.length >= (partial ? MAX_PARTIAL : MAX_EXACT)) return;
  if (bucket.some((entry) => entry.jsonPath === jsonPath)) return;
  bucket.push(
    buildMatch(state, value, jsonPath, parentPath, key, parent, {
      partial,
      approximate: false,
      basis: 'text',
    }),
  );
}

function recordReverse(
  state: ScanState,
  raw: string,
  numeric: number | null,
  jsonPath: string,
  parentPath: string,
  key: string | null,
  parent: unknown,
): void {
  const reverse = state.reverse;
  if (reverse === null || reverse.length >= MAX_REVERSE_MATCHES) return;
  const value = normalizeText(raw);
  if (value === '' || value === '[enmascarado]') return;
  if (reverse.some((entry) => entry.jsonPath === jsonPath)) return;
  const numbers = state.numbers;
  let numberHit = false;
  if (numbers !== null) {
    if (numeric !== null && Number.isFinite(numeric) && numbers.has(numeric)) {
      numberHit = true;
    } else {
      numberHit = numericVariants(value).some((candidate) => numbers.has(candidate));
    }
  }
  const textHit =
    value.length >= MIN_REVERSE_TEXT &&
    value.length <= MAX_VALUE_CHARS &&
    (state.query.includes(value) ||
      (state.foldedQuery.length >= MIN_REVERSE_TEXT &&
        state.foldedQuery.includes(foldText(value))));
  if (!numberHit && !textHit) return;
  reverse.push(
    buildMatch(state, value, jsonPath, parentPath, key, parent, {
      partial: true,
      approximate: true,
      basis: 'text',
    }),
  );
}

function walk(
  node: unknown,
  path: string,
  parentPath: string,
  parent: unknown,
  key: string | null,
  depth: number,
  state: ScanState,
): void {
  if (state.exact.length >= MAX_EXACT) return;
  if (state.reverse !== null && state.reverse.length >= MAX_REVERSE_MATCHES) return;

  if (typeof node === 'string') {
    recordMatch(state, node, path, parentPath, key, parent);
    recordReverse(state, node, null, path, parentPath, key, parent);
    return;
  }
  if (typeof node === 'number') {
    recordReverse(state, String(node), node, path, parentPath, key, parent);
    return;
  }
  if (depth >= MAX_DEPTH || node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      walk(node[index], `${path}[${String(index)}]`, path, node, null, depth + 1, state);
      if (state.exact.length >= MAX_EXACT) return;
    }
    return;
  }

  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(node as Record<string, unknown>);
  } catch {
    return;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    walk(entry[1], childPath(path, entry[0]), path, node, entry[0].slice(0, 80), depth + 1, state);
    if (state.exact.length >= MAX_EXACT) return;
  }
}

interface NumericCandidate {
  match: JsonTextMatch;
  score: number;
  requestIndex: number;
  order: number;
}

interface NumericScanState {
  numbers: ReadonlySet<number>;
  keys: ReadonlySet<string>;
  candidates: NumericCandidate[];
  requestId: string;
  origin: 'response' | 'request';
  bodyTruncated: boolean;
  requestIndex: number;
  order: number;
}

function walkNumeric(
  node: unknown,
  path: string,
  parentPath: string,
  parent: unknown,
  key: string | null,
  depth: number,
  state: NumericScanState,
): void {
  if (typeof node === 'number' || typeof node === 'string') {
    const raw =
      typeof node === 'number'
        ? Number.isFinite(node)
          ? String(node)
          : null
        : normalizeText(node);
    if (raw === null || raw === '' || raw === '[enmascarado]' || raw.length > MAX_VALUE_CHARS) {
      return;
    }
    const hit =
      typeof node === 'number'
        ? state.numbers.has(node)
        : numericVariants(node).some((candidate) => state.numbers.has(candidate));
    if (!hit) return;
    const keyHit = key !== null && state.keys.has(normalizeKey(key));
    state.candidates.push({
      match: buildMatch(
        { requestId: state.requestId, origin: state.origin, bodyTruncated: state.bodyTruncated },
        raw,
        path,
        parentPath,
        key,
        parent,
        { partial: true, approximate: true, basis: 'text' },
      ),
      score: (keyHit ? 4 : 0) + (state.origin === 'response' ? 1 : 0),
      requestIndex: state.requestIndex,
      order: state.order,
    });
    state.order += 1;
    return;
  }
  if (depth >= MAX_DEPTH || node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      walkNumeric(node[index], `${path}[${String(index)}]`, path, node, null, depth + 1, state);
    }
    return;
  }

  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(node as Record<string, unknown>);
  } catch {
    return;
  }
  for (const entry of entries) {
    walkNumeric(
      entry[1],
      childPath(path, entry[0]),
      path,
      node,
      entry[0].slice(0, 80),
      depth + 1,
      state,
    );
  }
}

function scanNumericMatches(
  requests: readonly CapturedRequest[],
  query: string,
  keys: ReadonlySet<string>,
  limit: number,
): JsonTextMatch[] {
  const numbers = queryNumbers(query);
  if (numbers.size === 0) return [];
  const candidates: NumericCandidate[] = [];
  for (const origin of ['response', 'request'] as const) {
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const request = requests[index];
      if (request === undefined) continue;
      const body = origin === 'response' ? request.responseBody : request.requestBody;
      if (body === null || body.text.length < MIN_QUERY_CHARS) continue;
      const parsed = parseBody(body);
      if (parsed === null) continue;
      const state: NumericScanState = {
        numbers,
        keys,
        candidates,
        requestId: request.id,
        origin,
        bodyTruncated: body.truncated,
        requestIndex: index,
        order: 0,
      };
      walkNumeric(parsed, '$', '$', parsed, null, 0, state);
    }
  }
  const seen = new Set<string>();
  return candidates
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.requestIndex - left.requestIndex ||
        left.order - right.order,
    )
    .filter((candidate) => {
      const key = `${candidate.match.requestId}|${candidate.match.origin}|${candidate.match.jsonPath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map((candidate) => candidate.match);
}

function mergeMatches(
  primary: readonly JsonTextMatch[],
  secondary: readonly JsonTextMatch[],
  limit: number,
): JsonTextMatch[] {
  const seen = new Set<string>();
  const result: JsonTextMatch[] = [];
  for (const match of [...primary, ...secondary]) {
    const key = `${match.requestId}|${match.origin}|${match.jsonPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(match);
    if (result.length >= limit) break;
  }
  return result;
}

function scanBody(
  body: CapturedBody,
  requestId: string,
  origin: 'response' | 'request',
  query: string,
): { exact: JsonTextMatch[]; partial: JsonTextMatch[] } {
  const parsed = parseBody(body);
  if (parsed === null) return { exact: [], partial: [] };
  const state: ScanState = {
    query,
    foldedQuery: foldText(query),
    exact: [],
    partial: [],
    reverse: null,
    numbers: null,
    requestId,
    origin,
    bodyTruncated: body.truncated,
  };
  walk(parsed, '$', '$', parsed, null, 0, state);
  return { exact: state.exact, partial: state.partial };
}

function scanOrigin(
  requests: readonly CapturedRequest[],
  query: string,
  origin: 'response' | 'request',
  limit: number,
  partialMatches: JsonTextMatch[],
): JsonTextMatch[] {
  const exact: JsonTextMatch[] = [];
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request === undefined) continue;
    const body = origin === 'response' ? request.responseBody : request.requestBody;
    if (body === null || body.text.length < MIN_QUERY_CHARS) continue;
    const found = scanBody(body, request.id, origin, query);
    for (const match of found.exact) {
      if (exact.length >= limit) break;
      exact.push(match);
    }
    for (const match of found.partial) {
      if (partialMatches.length >= MAX_PARTIAL) break;
      partialMatches.push(match);
    }
    if (exact.length >= limit) break;
  }
  return exact;
}

function scanReverse(requests: readonly CapturedRequest[], query: string): JsonTextMatch[] {
  const numbers = queryNumbers(query);
  const found: JsonTextMatch[] = [];
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request === undefined) continue;
    const body = request.responseBody;
    if (body === null || body.text.length < MIN_QUERY_CHARS) continue;
    const parsed = parseBody(body);
    if (parsed === null) continue;
    const state: ScanState = {
      query,
      foldedQuery: foldText(query),
      exact: [],
      partial: [],
      reverse: [],
      numbers,
      requestId: request.id,
      origin: 'response',
      bodyTruncated: body.truncated,
    };
    walk(parsed, '$', '$', parsed, null, 0, state);
    if (state.reverse !== null) found.push(...state.reverse);
    if (found.length >= MAX_REVERSE_MATCHES) break;
  }
  const seen = new Set<string>();
  return found
    .filter((match) => {
      const key = `${match.requestId}|${match.jsonPath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.value.length - left.value.length)
    .slice(0, MAX_REVERSE_RESULTS);
}

function buildFingerprints(values: readonly string[]): Fingerprints {
  const strings = new Set<string>();
  const numbers = new Set<number>();
  for (const raw of values.slice(0, MAX_FINGERPRINTS)) {
    const value = normalizeText(raw);
    if (value.length < 3 || value === '[enmascarado]') continue;
    strings.add(foldText(value));
    for (const candidate of numericVariants(value)) numbers.add(candidate);
  }
  return { strings, numbers };
}

function matchesFingerprint(node: string | number, fingerprints: Fingerprints): boolean {
  if (typeof node === 'number') {
    return Number.isFinite(node) && fingerprints.numbers.has(node);
  }
  const value = normalizeText(node);
  if (value.length < 3 || value === '[enmascarado]') return false;
  if (fingerprints.strings.has(foldText(value))) return true;
  return numericVariants(value).some((candidate) => fingerprints.numbers.has(candidate));
}

function isStrongValue(value: string): boolean {
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length >= 4) return true;
  return value.length >= 8 && /\s/.test(value);
}

function walkData(
  node: unknown,
  path: string,
  key: string | null,
  depth: number,
  state: DataScanState,
): void {
  if (typeof node === 'string' || typeof node === 'number') {
    if (!matchesFingerprint(node, state.fingerprints)) return;
    const value = normalizeText(String(node));
    if (value === '' || value === '[enmascarado]') return;
    for (
      let index = state.ancestors.length - 1;
      index >= 0 && index >= state.ancestors.length - 2;
      index -= 1
    ) {
      const ancestor = state.ancestors[index];
      if (ancestor === undefined) continue;
      const existing = state.groups.get(ancestor.path);
      if (existing !== undefined) {
        existing.score += 1;
        continue;
      }
      state.groups.set(ancestor.path, {
        path: ancestor.path,
        node: ancestor.node,
        score: 1,
        first: { path, key, value: value.slice(0, MAX_VALUE_CHARS) },
      });
    }
    return;
  }
  if (depth >= MAX_DEPTH || node === null || typeof node !== 'object') return;

  const container = node;
  state.ancestors.push({ path, node: container });
  if (Array.isArray(container)) {
    for (let index = 0; index < container.length; index += 1) {
      walkData(container[index], `${path}[${String(index)}]`, null, depth + 1, state);
    }
    state.ancestors.pop();
    return;
  }

  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(container as Record<string, unknown>);
  } catch {
    state.ancestors.pop();
    return;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    walkData(entry[1], childPath(path, entry[0]), entry[0].slice(0, 80), depth + 1, state);
  }
  state.ancestors.pop();
}

function isRowArray(node: unknown): boolean {
  if (!Array.isArray(node) || node.length === 0) return false;
  const first: unknown = node[0];
  return first !== null && typeof first === 'object';
}

function chooseDataMatch(state: DataScanState): { match: JsonTextMatch; score: number } | null {
  let best: GroupScore | null = null;
  let bestObject: GroupScore | null = null;
  for (const group of state.groups.values()) {
    if (group.score < 2 && !isStrongValue(group.first.value)) continue;
    const wins =
      best === null ||
      group.score > best.score ||
      (group.score === best.score && group.path.length > best.path.length);
    if (wins) best = group;
    if (isRowArray(group.node)) continue;
    if (
      bestObject === null ||
      group.score > bestObject.score ||
      (group.score === bestObject.score && group.path.length > bestObject.path.length)
    ) {
      bestObject = group;
    }
  }
  if (best === null) return null;
  if (bestObject !== null && isRowArray(best.node)) best = bestObject;
  const container = parentText(best.node);
  return {
    score: best.score,
    match: {
      requestId: state.requestId,
      origin: 'response',
      jsonPath: best.first.path,
      parentPath: best.path,
      key: best.first.key,
      value: best.first.value,
      partial: true,
      approximate: true,
      basis: 'data',
      bodyTruncated: state.bodyTruncated,
      parent: container.text,
      parentTruncated: container.truncated,
    },
  };
}

function scanDataMatches(
  requests: readonly CapturedRequest[],
  values: readonly string[],
  limit: number,
): JsonTextMatch[] {
  const fingerprints = buildFingerprints(values);
  if (fingerprints.strings.size === 0 && fingerprints.numbers.size === 0) return [];
  const candidates: Array<{ match: JsonTextMatch; score: number; index: number }> = [];
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request === undefined) continue;
    const body = request.responseBody;
    if (body === null || body.text.length < MIN_QUERY_CHARS) continue;
    const parsed = parseBody(body);
    if (parsed === null) continue;
    const state: DataScanState = {
      fingerprints,
      groups: new Map(),
      ancestors: [],
      requestId: request.id,
      bodyTruncated: body.truncated,
    };
    walkData(parsed, '$', null, 0, state);
    const best = chooseDataMatch(state);
    if (best !== null) candidates.push({ ...best, index });
  }
  const seen = new Set<string>();
  return candidates
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .filter((candidate) => {
      const key = `${candidate.match.requestId}|${candidate.match.parentPath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.min(limit, MAX_DATA_RESULTS))
    .map((candidate) => candidate.match);
}

export function findJsonTextMatches(
  requests: readonly CapturedRequest[],
  text: string,
  limit = 6,
  dataValues: readonly string[] = [],
  dataHints: readonly JsonDataHint[] = [],
): JsonTextMatch[] {
  const query = normalizeText(text);
  if (query.length < MIN_QUERY_CHARS && dataValues.length === 0) return [];
  const partialMatches: JsonTextMatch[] = [];
  if (query.length >= MIN_QUERY_CHARS) {
    const responseExact = scanOrigin(
      requests,
      query,
      'response',
      Math.min(limit, MAX_EXACT),
      partialMatches,
    );
    if (responseExact.length > 0) return responseExact;
    if (partialMatches.length > 0) return partialMatches.slice(0, limit);

    const requestExact = scanOrigin(
      requests,
      query,
      'request',
      Math.min(limit, MAX_EXACT),
      partialMatches,
    );
    if (requestExact.length > 0) return requestExact;
    if (partialMatches.length > 0) return partialMatches.slice(0, limit);
  }

  const hintKeys = relevantHintKeys(query, dataHints);
  const dataMatches = scanDataMatches(requests, dataValues, limit);
  const numericMatches =
    hasFormattedNumber(query) || hintKeys.size > 0
      ? scanNumericMatches(requests, query, hintKeys, limit)
      : [];
  if (numericMatches.length > 0 || dataMatches.length > 0) {
    return mergeMatches(numericMatches, dataMatches, limit);
  }

  if (query.length < MIN_QUERY_CHARS) return [];
  return scanReverse(requests, query);
}
