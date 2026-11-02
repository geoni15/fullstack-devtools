import { describe, expect, it } from 'vitest';
import { buildFlowSnapshot } from './flow-graph';
import type { PageControl } from './page-inventory';

function control(
  overrides: Pick<PageControl, 'key' | 'kind' | 'tag' | 'selector' | 'pageUrl'> &
    Partial<PageControl>,
): PageControl {
  return {
    text: null,
    role: null,
    ariaLabel: null,
    inputType: null,
    name: null,
    href: null,
    formAction: null,
    formMethod: null,
    formKey: null,
    formSelector: null,
    disabled: false,
    visible: true,
    handlers: [],
    ...overrides,
  };
}

describe('buildFlowSnapshot file grouping', () => {
  it('crea un nodo por archivo y cuelga de él el documento y los recursos', () => {
    const pageUrl = 'http://localhost:5173/';
    const document = control({
      key: 'doc',
      kind: 'page',
      tag: 'document',
      selector: 'document',
      pageUrl,
      text: 'Demo',
    });
    const html = control({
      key: 'html',
      kind: 'structure',
      tag: 'html',
      selector: 'html:nth-of-type(1)',
      pageUrl,
      text: 'html',
    });
    const stylesheet = control({
      key: 'css',
      kind: 'asset',
      tag: 'link',
      selector: 'html:nth-of-type(1)>head:nth-of-type(1)>link:nth-of-type(1)',
      pageUrl,
      text: 'app.css',
      href: 'http://localhost:5173/src/app.css',
      role: 'stylesheet',
    });

    const snapshot = buildFlowSnapshot({
      traces: [],
      requests: [],
      routes: [],
      databases: [],
      revision: 1,
      frontend: null,
      workspaceOpen: true,
      workspaceFiles: ['index.html', 'src/app.css'],
      inventory: [document, html, stylesheet],
      interactions: [],
      references: [],
      occurrences: [],
      runtimeLinks: [],
      runtimeHandlers: [],
    });

    const htmlFile = snapshot.nodes.find((node) => node.id === 'file:index.html');
    const cssFile = snapshot.nodes.find((node) => node.id === 'file:src/app.css');
    expect(htmlFile?.type).toBe('file');
    expect(htmlFile?.file).toBe('index.html');
    expect(cssFile?.type).toBe('file');
    expect(cssFile?.file).toBe('src/app.css');
    expect(snapshot.stats.files).toBe(2);

    expect(
      snapshot.edges.some(
        (edge) =>
          edge.type === 'CONTAINS' && edge.from === 'file:index.html' && edge.to === 'element:doc',
      ),
    ).toBe(true);
    expect(
      snapshot.edges.some(
        (edge) =>
          edge.type === 'CONTAINS' && edge.from === 'file:src/app.css' && edge.to === 'asset:css',
      ),
    ).toBe(true);
  });
});
