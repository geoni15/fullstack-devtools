import crypto from 'node:crypto';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import {
  BdtError,
  ERROR_CODES,
  type FileContent,
  type FileNode,
  type WorkspaceInfo,
  type WorkspaceSnapshot,
} from '@bdt/protocol';
import { isIgnoredName } from './config';
import { buildFileTree, type BuiltTree } from './fs/file-tree';
import { readTextFile } from './fs/read-file';
import { createRootScope, type RootScope } from './fs/root-guard';
import { createLogger, type Logger } from './logger';

interface OpenWorkspace {
  info: WorkspaceInfo;
  scope: RootScope;
  watcher: FSWatcher;
  debounceTimer: NodeJS.Timeout | null;
}

function workspaceIdFor(rootReal: string): string {
  const digest = crypto.createHash('sha1').update(rootReal).digest('hex').slice(0, 12);
  return `workspace:${digest}`;
}

export class WorkspaceService {
  private current: OpenWorkspace | null = null;
  private builtTree: BuiltTree | null = null;
  private filePaths: string[] | null = null;

  constructor(
    private readonly onChange: () => void,
    private readonly log: Logger = createLogger('workspace'),
  ) {}

  async open(rootAbsolutePath: string): Promise<WorkspaceSnapshot> {
    const scope = createRootScope(rootAbsolutePath);

    const watcher = watch(scope.rootReal, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      ignored: (watchedPath: string) => {
        const relative = path.relative(scope.rootReal, watchedPath);
        if (relative === '' || relative.startsWith('..')) {
          return false;
        }
        return relative.split(/[\\/]+/).some((segment) => isIgnoredName(segment));
      },
    });

    const openWorkspace: OpenWorkspace = {
      info: {
        id: workspaceIdFor(scope.rootReal),
        name: scope.rootName,
        rootPath: scope.rootReal,
      },
      scope,
      watcher,
      debounceTimer: null,
    };

    watcher.on('all', () => {
      if (this.current !== openWorkspace) return;
      this.builtTree = null;
      this.filePaths = null;
      if (openWorkspace.debounceTimer !== null) {
        clearTimeout(openWorkspace.debounceTimer);
      }
      openWorkspace.debounceTimer = setTimeout(() => {
        openWorkspace.debounceTimer = null;
        this.onChange();
      }, 200);
    });

    watcher.on('error', (error: unknown) => {
      this.log.warn('Error del observador de archivos', {
        message: error instanceof Error ? error.message : String(error),
      });
    });

    this.closeCurrent();
    this.current = openWorkspace;
    this.log.info('Espacio de trabajo abierto', { root: scope.rootReal });

    return this.snapshot(openWorkspace);
  }

  getSnapshot(): WorkspaceSnapshot | null {
    return this.current ? this.snapshot(this.current) : null;
  }

  getRootPath(): string | null {
    return this.current?.scope.rootReal ?? null;
  }

  getFilePaths(): readonly string[] {
    const current = this.current;
    if (current === null) return [];
    if (this.filePaths !== null) return this.filePaths;
    const paths: string[] = [];
    const walk = (node: FileNode): void => {
      if (node.kind === 'file') {
        paths.push(node.path);
        return;
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(this.built(current).tree);
    this.filePaths = paths;
    return paths;
  }

  readFile(relativePath: string): FileContent {
    if (!this.current) {
      throw new BdtError(ERROR_CODES.WORKSPACE_NONE, 'No hay ninguna carpeta de proyecto abierta.');
    }
    return readTextFile(this.current.scope, relativePath);
  }

  dispose(): void {
    this.closeCurrent();
    this.current = null;
  }

  private built(openWorkspace: OpenWorkspace): BuiltTree {
    if (this.builtTree === null) {
      this.builtTree = buildFileTree(openWorkspace.scope.rootReal, openWorkspace.info.name);
    }
    return this.builtTree;
  }

  private snapshot(openWorkspace: OpenWorkspace): WorkspaceSnapshot {
    const { tree, stats } = this.built(openWorkspace);
    return {
      workspace: openWorkspace.info,
      tree,
      stats,
      watcher: 'active',
    };
  }

  private closeCurrent(): void {
    if (!this.current) {
      return;
    }
    if (this.current.debounceTimer !== null) {
      clearTimeout(this.current.debounceTimer);
    }
    void this.current.watcher.close().catch((error: unknown) => {
      this.log.warn('No se pudo cerrar el observador de archivos', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.current = null;
    this.builtTree = null;
    this.filePaths = null;
  }
}
