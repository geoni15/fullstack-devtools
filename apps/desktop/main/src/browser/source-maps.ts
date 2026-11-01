export interface InlineSourceMap {
  scriptUrl: string;
  sources: string[];
  sourceRoot: string | null;
  sourcesContent: Array<string | null> | null;
  lines: number[][][];
}

export interface MappedSourceLocation {
  file: string;
  line: number;
  column: number;
  code: string | null;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Map<string, number>(
  Array.from(BASE64, (char, index) => [char, index] as const),
);

interface RawSourceMap {
  sources?: unknown;
  sourceRoot?: unknown;
  sourcesContent?: unknown;
  mappings?: unknown;
}

function inlineSourceMapPayload(source: string): string | null {
  const pattern =
    /\/\/[#@]\s*sourceMappingURL=(\S+)|(?:\/\*[#@]\s*sourceMappingURL=(\S+?)\s*\*\/)/g;
  let match: RegExpExecArray | null;
  let payload: string | null = null;
  while ((match = pattern.exec(source)) !== null) {
    const value = (match[1] ?? match[2] ?? '').replace(/^['"]|['"]$/g, '');
    if (value !== '') payload = value;
  }
  if (payload === null || !payload.startsWith('data:')) return null;
  const comma = payload.indexOf(',');
  if (comma === -1) return null;
  const meta = payload.slice(5, comma);
  const body = payload.slice(comma + 1);
  try {
    if (/;base64(?:;|$)/i.test(meta)) return Buffer.from(body, 'base64').toString('utf8');
    return decodeURIComponent(body);
  } catch {
    return null;
  }
}

function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let shift = 0;
  let value = 0;
  for (const char of segment) {
    const digit = BASE64_VALUES.get(char);
    if (digit === undefined) return [];
    value += (digit & 31) * 2 ** shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      if (shift > 40) return [];
      continue;
    }
    values.push(value & 1 ? -Math.floor(value / 2) : Math.floor(value / 2));
    shift = 0;
    value = 0;
  }
  return values;
}

function decodeMappings(mappings: string): number[][][] {
  const lines: number[][][] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  for (const group of mappings.split(';')) {
    const segments: number[][] = [];
    let generatedColumn = 0;
    for (const raw of group.split(',')) {
      if (raw === '') continue;
      const fields = decodeVlq(raw);
      if (fields.length === 0) continue;
      generatedColumn += fields[0] ?? 0;
      if (fields.length < 4) continue;
      sourceIndex += fields[1] ?? 0;
      originalLine += fields[2] ?? 0;
      originalColumn += fields[3] ?? 0;
      segments.push([generatedColumn, sourceIndex, originalLine, originalColumn]);
    }
    lines.push(segments);
  }
  return lines;
}

export function parseInlineSourceMap(
  scriptSource: string,
  scriptUrl: string,
): InlineSourceMap | null {
  const raw = inlineSourceMapPayload(scriptSource);
  if (raw === null) return null;
  let parsed: RawSourceMap;
  try {
    parsed = JSON.parse(raw) as RawSourceMap;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.sources) || typeof parsed.mappings !== 'string') return null;
  const sources: string[] = [];
  for (const entry of parsed.sources) {
    if (typeof entry !== 'string') return null;
    sources.push(entry);
  }
  if (sources.length === 0) return null;
  const sourcesContent = Array.isArray(parsed.sourcesContent)
    ? parsed.sourcesContent.map((entry) => (typeof entry === 'string' ? entry : null))
    : null;
  const sourceRoot =
    typeof parsed.sourceRoot === 'string' && parsed.sourceRoot !== '' ? parsed.sourceRoot : null;
  return {
    scriptUrl,
    sources,
    sourceRoot,
    sourcesContent,
    lines: decodeMappings(parsed.mappings),
  };
}

function sourceFile(map: InlineSourceMap, source: string): string {
  let base = map.scriptUrl;
  if (map.sourceRoot !== null) {
    try {
      base = new URL(
        map.sourceRoot.endsWith('/') ? map.sourceRoot : `${map.sourceRoot}/`,
        map.scriptUrl,
      ).href;
    } catch {
      base = map.scriptUrl;
    }
  }
  try {
    return new URL(source, base).href;
  } catch {
    return source;
  }
}

function sourceLine(content: string | null | undefined, line: number): string | null {
  if (content === null || content === undefined) return null;
  const lines = content.split(/\r\n|\r|\n/);
  const text = lines[line];
  if (text === undefined) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean === '' ? null : clean;
}

export function mapGeneratedLocation(
  map: InlineSourceMap,
  generatedLine: number,
  generatedColumn: number,
): MappedSourceLocation | null {
  // Stack locations are 1-based; source map mappings are 0-based.
  const segments = map.lines[generatedLine - 1];
  if (segments === undefined || segments.length === 0) return null;
  const column = Math.max(0, generatedColumn - 1);
  let selected: number[] | null = null;
  for (const segment of segments) {
    if ((segment[0] ?? 0) > column) break;
    selected = segment;
  }
  if (selected === null) return null;
  const sourceIndex = selected[1] ?? -1;
  const originalLine = selected[2] ?? -1;
  const originalColumn = selected[3] ?? 0;
  const source = map.sources[sourceIndex];
  if (source === undefined || originalLine < 0) return null;
  return {
    file: sourceFile(map, source),
    line: originalLine + 1,
    column: originalColumn + 1,
    code: sourceLine(map.sourcesContent?.[sourceIndex], originalLine),
  };
}
