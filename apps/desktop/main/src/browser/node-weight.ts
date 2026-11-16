import fs from 'node:fs';
import type { FlowNode, FlowNodeWeight, FlowSnapshot } from '@bdt/protocol';
import { LIMITS } from '../config';
import { createRootScope, type RootScope } from '../fs/root-guard';

const MAX_RANGE_CACHE = 4000;
const BINARY_SNIFF_BYTES = 8192;

const encoder = new TextEncoder();

export function textBytes(text: string): number {
  return encoder.encode(text).length;
}

export interface RequestWeight {
  bytes: number;
  truncated: boolean;
}

export interface NodeWeightSources {
  rootPath: string | null;
  requestBytes: ReadonlyMap<string, RequestWeight>;
}

interface ObservedRows {
  bytes: number;
  rows: number;
  truncated: boolean;
}

function cellBytes(value: string | number | boolean | null): number {
  return value === null ? 0 : textBytes(String(value));
}

// El peso de tablas y bases sale de las filas observadas de sus consultas, no del disco: se cuenta
// cada consulta una sola vez por destino aunque tenga aristas de lectura y escritura.
function observedRowBytes(snapshot: FlowSnapshot): Map<string, ObservedRows> {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const counted = new Map<string, Set<string>>();
  const out = new Map<string, ObservedRows>();
  for (const edge of snapshot.edges) {
    const target = byId.get(edge.to);
    if (target === undefined || (target.type !== 'table' && target.type !== 'database')) continue;
    const source = byId.get(edge.from);
    if (source === undefined || source.type !== 'query') continue;
    const result = source.result;
    if (result === null || result === undefined) continue;
    let seen = counted.get(target.id);
    if (seen === undefined) {
      seen = new Set<string>();
      counted.set(target.id, seen);
    }
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    let bytes = 0;
    for (const row of result.rows) {
      for (const cell of row) bytes += cellBytes(cell);
    }
    const previous = out.get(target.id) ?? { bytes: 0, rows: 0, truncated: false };
    out.set(target.id, {
      bytes: previous.bytes + bytes,
      rows: previous.rows + result.rows.length,
      truncated: previous.truncated || result.truncated,
    });
  }
  return out;
}

function lineStarts(content: string): number[] {
  const starts: number[] = [0];
  let index = content.indexOf('\n');
  while (index !== -1) {
    starts.push(index + 1);
    index = content.indexOf('\n', index + 1);
  }
  if (starts.length > 1 && starts[starts.length - 1] === content.length) starts.pop();
  return starts;
}

function rangeBytes(content: string, line: number, endLine: number): number | null {
  const starts = lineStarts(content);
  const from = starts[line - 1];
  if (from === undefined) return null;
  const to = endLine >= starts.length ? content.length : (starts[endLine] ?? content.length);
  return textBytes(content.slice(from, to));
}

function boundedSet<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export class NodeWeightMeter {
  private readonly ranges = new Map<string, number>();

  async apply(snapshot: FlowSnapshot, sources: NodeWeightSources): Promise<void> {
    const observed = observedRowBytes(snapshot);
    const scope = this.scopeFor(sources.rootPath, snapshot);
    for (const node of snapshot.nodes) {
      const weight = await this.weightOf(node, scope, observed, sources.requestBytes);
      if (weight !== null) node.weight = weight;
    }
  }

  private scopeFor(rootPath: string | null, snapshot: FlowSnapshot): RootScope | null {
    if (rootPath === null) return null;
    if (!snapshot.nodes.some((node) => node.file !== null && node.file !== '')) return null;
    try {
      return createRootScope(rootPath);
    } catch {
      return null;
    }
  }

  private async weightOf(
    node: FlowNode,
    scope: RootScope | null,
    observed: ReadonlyMap<string, ObservedRows>,
    requestBytes: ReadonlyMap<string, RequestWeight>,
  ): Promise<FlowNodeWeight | null> {
    if (node.type === 'table' || node.type === 'database') {
      const rows = observed.get(node.id);
      if (rows === undefined || rows.rows === 0) {
        return {
          bytes: null,
          basis: 'rows',
          note: 'Sin filas observadas: no hay peso que medir.',
        };
      }
      const sample = `Muestra observada de ${String(rows.rows)} filas; no es el tamaño en disco.`;
      return {
        bytes: rows.bytes,
        basis: 'rows',
        note: rows.truncated ? `${sample} La captura está recortada.` : sample,
      };
    }

    if (node.type === 'request') {
      let bytes = 0;
      let found = false;
      let truncated = false;
      for (const id of node.requestIds) {
        const entry = requestBytes.get(id);
        if (entry === undefined) continue;
        found = true;
        bytes += entry.bytes;
        truncated = truncated || entry.truncated;
      }
      if (!found) {
        return { bytes: null, basis: 'bodies', note: 'Sin cuerpos capturados para esta petición.' };
      }
      return {
        bytes,
        basis: 'bodies',
        note: truncated
          ? 'Cuerpos recortados en la captura: el peso es del texto conservado.'
          : null,
      };
    }

    return this.codeWeight(node, scope);
  }

  private async codeWeight(
    node: FlowNode,
    scope: RootScope | null,
  ): Promise<FlowNodeWeight | null> {
    const file = node.file;
    if (file === null || file === '' || file.includes('://')) return null;
    if (scope === null) {
      return { bytes: null, basis: 'file', note: 'No hay carpeta de proyecto abierta.' };
    }

    let absolute: string;
    try {
      absolute = scope.resolve(file);
    } catch {
      return {
        bytes: null,
        basis: 'file',
        note: 'El archivo no está dentro del proyecto abierto.',
      };
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absolute);
    } catch {
      return { bytes: null, basis: 'file', note: 'El archivo ya no existe en disco.' };
    }
    if (!stat.isFile()) return null;

    const line = node.line;
    if (line === null || line < 1) return { bytes: stat.size, basis: 'file', note: null };
    const endLine = Math.max(line, node.endLine ?? line);
    const key = `${absolute}:${String(stat.mtimeMs)}:${String(line)}:${String(endLine)}`;
    const cached = this.ranges.get(key);
    if (cached !== undefined) return { bytes: cached, basis: 'range', note: null };

    if (stat.size > LIMITS.maxFileBytes) {
      return {
        bytes: stat.size,
        basis: 'file',
        note: 'Rango no medible: el archivo supera el límite de lectura. Se pesa el archivo completo.',
      };
    }

    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(absolute);
    } catch {
      return {
        bytes: stat.size,
        basis: 'file',
        note: 'No se pudo leer el archivo para medir el rango. Se pesa el archivo completo.',
      };
    }
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return {
        bytes: stat.size,
        basis: 'file',
        note: 'Archivo binario: se pesa el archivo completo.',
      };
    }

    const bytes = rangeBytes(buffer.toString('utf8'), line, endLine);
    if (bytes === null) {
      return {
        bytes: stat.size,
        basis: 'file',
        note: 'La línea del nodo queda fuera del archivo. Se pesa el archivo completo.',
      };
    }
    boundedSet(this.ranges, key, bytes, MAX_RANGE_CACHE);
    return { bytes, basis: 'range', note: null };
  }
}
