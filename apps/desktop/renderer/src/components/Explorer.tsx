import { useCallback, useState } from 'react';
import type { FileNode } from '@bdt/protocol';
import { useWorkspace } from '../state/workspace-store';

interface TreeBranchProps {
  nodes: FileNode[];
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle(path: string): void;
}

function TreeBranch({ nodes, depth, expanded, onToggle }: TreeBranchProps) {
  const { state, openFile } = useWorkspace();

  return (
    <>
      {nodes.map((node) => {
        const isOpen = expanded.has(node.path);
        const isActive = state.activePath === node.path;
        const handleClick = (): void => {
          if (node.kind === 'dir') {
            onToggle(node.path);
          } else {
            void openFile(node);
          }
        };

        return (
          <div key={node.path}>
            <button
              type="button"
              className={`tree-item${isActive ? ' is-active' : ''}`}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onClick={handleClick}
              aria-expanded={node.kind === 'dir' ? isOpen : undefined}
              data-testid={`tree-${node.kind}-${node.path}`}
            >
              <span className="tree-caret">{node.kind === 'dir' ? (isOpen ? '▾' : '▸') : '·'}</span>
              <span className="tree-name">{node.name}</span>
            </button>
            {node.kind === 'dir' && isOpen && node.children !== undefined ? (
              <TreeBranch
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function Explorer() {
  const { state } = useWorkspace();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = useCallback((path: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const snapshot = state.snapshot;
  const rootChildren = snapshot?.tree.children ?? [];

  return (
    <aside className="panel explorer">
      <div className="panel-head">
        <span>Archivos</span>
        {snapshot !== null ? (
          <span className="panel-head-meta">{snapshot.workspace.name}</span>
        ) : null}
      </div>

      <div className="explorer-body">
        {snapshot === null ? (
          <div className="panel-empty">
            <p className="empty-title">Sin proyecto abierto</p>
            <p className="empty-text">
              Usa «Abrir carpeta» para cargar la raíz de tu proyecto. La lectura queda limitada a
              esa carpeta.
            </p>
          </div>
        ) : rootChildren.length === 0 ? (
          <div className="panel-empty">
            <p className="empty-text">La carpeta no contiene archivos visibles.</p>
          </div>
        ) : (
          <TreeBranch nodes={rootChildren} depth={0} expanded={expanded} onToggle={toggle} />
        )}
      </div>

      <div className="panel-foot">
        {snapshot !== null
          ? `${snapshot.stats.files} archivos · ${snapshot.stats.dirs} carpetas${
              snapshot.stats.truncated ? ' · vista truncada' : ''
            }`
          : '—'}
      </div>
    </aside>
  );
}
