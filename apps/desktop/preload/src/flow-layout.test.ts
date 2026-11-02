import type { FlowEdge, FlowNode, FlowNodeType, FlowSnapshot } from '@bdt/protocol';
import { describe, expect, it } from 'vitest';
import { layoutFlow } from './flow-layout';

function node(id: string, type: FlowNodeType, overrides: Partial<FlowNode> = {}): FlowNode {
  return {
    id,
    type,
    title: id,
    subtitle: null,
    file: null,
    line: null,
    endLine: null,
    method: null,
    path: null,
    url: null,
    requestIds: [],
    traceIds: [],
    evidence: ['STATIC'],
    occurrences: 1,
    firstSeen: 0,
    lastSeen: 0,
    note: null,
    ...overrides,
  };
}

function snapshot(nodes: FlowNode[], edges: FlowEdge[] = []): FlowSnapshot {
  return {
    revision: 1,
    builtAt: 1,
    nodes,
    edges,
    stats: {
      clicks: 0,
      files: nodes.filter((item) => item.type === 'file').length,
      interactions: 0,
      controls: 0,
      forms: 0,
      requests: 0,
      externalRequests: 0,
      preflightRequests: 0,
      routes: 0,
      functions: 0,
      queries: 0,
      tables: 0,
      databases: 0,
    },
    stack: { frontend: null, backend: null, database: null, workspaceOpen: true },
  };
}

function edge(type: FlowEdge['type'], from: string, to: string): FlowEdge {
  return {
    id: `${type}|${from}|${to}`,
    type,
    from,
    to,
    evidence: ['STATIC'],
    correlation: 'direct',
    occurrences: 1,
    lastSeen: 0,
    traceIds: [],
    note: null,
  };
}

function positionY(layout: ReturnType<typeof layoutFlow>, id: string): number {
  const placed = layout.positions.get(id);
  if (placed === undefined) throw new Error(`Nodo sin posición: ${id}`);
  return placed.y;
}

describe('layoutFlow structural', () => {
  it('ordena el DOM por selector, no por hora', () => {
    const early = node('dom-10', 'element', {
      selector: 'html>body>div:nth-of-type(10)',
      pageUrl: 'http://localhost/',
      firstSeen: 1,
    });
    const late = node('dom-2', 'element', {
      selector: 'html>body>div:nth-of-type(2)',
      pageUrl: 'http://localhost/',
      firstSeen: 50,
    });
    const structural = layoutFlow(snapshot([early, late]), 'structural');
    const chronological = layoutFlow(snapshot([early, late]), 'chronological');
    expect(positionY(structural, 'dom-2')).toBeLessThan(positionY(structural, 'dom-10'));
    expect(positionY(chronological, 'dom-10')).toBeLessThan(positionY(chronological, 'dom-2'));
  });

  it('ordena el código por archivo y línea', () => {
    const later = node('handler-b', 'handler', {
      file: 'src/b.ts',
      line: 2,
      firstSeen: 1,
    });
    const earlier = node('handler-a', 'handler', {
      file: 'src/a.ts',
      line: 20,
      firstSeen: 50,
    });
    const layout = layoutFlow(snapshot([later, earlier]), 'structural');
    expect(positionY(layout, 'handler-a')).toBeLessThan(positionY(layout, 'handler-b'));
  });

  it('ordena archivos por ruta', () => {
    const z = node('file:src/z.ts', 'file', { file: 'src/z.ts', line: 1 });
    const a = node('file:src/a.ts', 'file', { file: 'src/a.ts', line: 1 });
    const layout = layoutFlow(snapshot([z, a]), 'structural');
    expect(positionY(layout, 'file:src/a.ts')).toBeLessThan(positionY(layout, 'file:src/z.ts'));
  });
});

describe('layoutFlow hierarchical', () => {
  it('cuelga el documento y sus controles del archivo de origen', () => {
    const file = node('file:index.html', 'file', { file: 'index.html', line: 1 });
    const document = node('element:doc', 'element', {
      kind: 'page',
      selector: 'document',
      pageUrl: 'http://localhost/',
    });
    const button = node('element:button', 'element', {
      kind: 'button',
      selector: 'html>body>button:nth-of-type(1)',
      pageUrl: 'http://localhost/',
    });
    const layout = layoutFlow(
      snapshot(
        [file, document, button],
        [edge('CONTAINS', file.id, document.id), edge('CONTAINS', document.id, button.id)],
      ),
      'hierarchical',
    );
    expect(positionY(layout, file.id)).toBeLessThan(positionY(layout, document.id));
    expect(positionY(layout, document.id)).toBeLessThan(positionY(layout, button.id));
  });
});
