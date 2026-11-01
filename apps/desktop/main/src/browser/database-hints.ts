import type { DatabaseHint } from './routes';

export function databaseHintLabel(hint: DatabaseHint): string {
  const engine = hint.engine ?? 'motor no declarado';
  const database =
    hint.database === null
      ? 'nombre no declarado'
      : `${hint.database}${hint.fallback ? ' (valor por defecto)' : ''}`;
  return `${engine} · ${database} · ${hint.file}`;
}

function topSegment(file: string): string {
  const index = file.indexOf('/');
  return index === -1 ? '' : file.slice(0, index);
}

export function pickDatabaseHint(
  hints: readonly DatabaseHint[],
  routeFile: string | null,
): DatabaseHint | null {
  const first = hints[0];
  if (first === undefined) return null;
  if (routeFile === null) return first;
  const root = topSegment(routeFile);
  return (
    hints.find(
      (hint) => topSegment(hint.file) === root && hint.database !== null && !hint.fallback,
    ) ??
    hints.find((hint) => topSegment(hint.file) === root && hint.database !== null) ??
    hints.find((hint) => topSegment(hint.file) === root) ??
    first
  );
}
