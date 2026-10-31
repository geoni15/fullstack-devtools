import type { InspectionCodeBlock, InspectionCodeLine } from '@bdt/protocol';
import { readTextFile } from '../fs/read-file';
import { createRootScope } from '../fs/root-guard';

const DEFAULT_MAX_LINES = 80;
const MAX_LINE_CHARS = 320;

export interface CodeBlockOptions {
  maxLines?: number;
}

export function readCodeBlock(
  rootPath: string,
  relativeFile: string,
  startLine: number,
  endLine: number,
  options: CodeBlockOptions = {},
): InspectionCodeBlock {
  const scope = createRootScope(rootPath);
  const file = readTextFile(scope, relativeFile);
  const sourceLines = file.content.split(/\r\n|\n|\r/);
  if (sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === '') {
    sourceLines.pop();
  }

  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);
  const from = Math.max(1, Math.min(startLine, endLine));
  const requestedEnd = Math.max(from, endLine);
  const last = Math.min(sourceLines.length, requestedEnd, from + maxLines - 1);
  const lines: InspectionCodeLine[] = [];
  let cutLongLine = false;

  for (let lineNumber = from; lineNumber <= last; lineNumber += 1) {
    const raw = sourceLines[lineNumber - 1] ?? '';
    const text = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)} …` : raw;
    if (raw.length > MAX_LINE_CHARS) {
      cutLongLine = true;
    }
    lines.push({ line: lineNumber, text });
  }

  const truncated = requestedEnd > last;
  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `Vista parcial: se muestran las líneas ${String(from)}–${String(last)} de ${String(requestedEnd)} solicitadas.`,
    );
  }
  if (cutLongLine) {
    notes.push(`Las líneas de más de ${String(MAX_LINE_CHARS)} caracteres aparecen recortadas.`);
  }
  if (lines.length === 0) {
    notes.push('La línea solicitada queda fuera del archivo.');
  }

  return {
    file: file.path,
    startLine: from,
    endLine: last,
    lines,
    truncated,
    note: notes.length > 0 ? notes.join(' ') : null,
  };
}
