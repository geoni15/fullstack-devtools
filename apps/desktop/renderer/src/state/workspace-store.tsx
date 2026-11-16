import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type { CodeLocation, FileContent, FileNode, WorkspaceSnapshot } from '@bdt/protocol';
import { ERROR_CODES } from '@bdt/protocol';
import { bdt } from '../api';

export type OpenTab =
  | {
      path: string;
      name: string;
      status: 'ready';
      content: string;
      buffer: string;
      dirty: boolean;
      size: number;
      mtimeMs: number;
      externalChange: boolean;
    }
  | { path: string; name: string; status: 'error'; message: string };

export interface CodeRevealTarget {
  path: string;
  line: number;
  endLine: number | null;
  nonce: number;
}

export interface WorkspaceState {
  snapshot: WorkspaceSnapshot | null;
  busy: boolean;
  error: string | null;
  tabs: OpenTab[];
  activePath: string | null;
  reveal: CodeRevealTarget | null;
}

type Action =
  | { type: 'loading' }
  | { type: 'cancel' }
  | { type: 'snapshot'; snapshot: WorkspaceSnapshot | null }
  | { type: 'error'; message: string }
  | { type: 'activate'; path: string }
  | { type: 'add-tab'; tab: OpenTab }
  | { type: 'edit-tab'; path: string; buffer: string }
  | { type: 'write-tab'; path: string; file: FileContent }
  | { type: 'external-tab'; path: string }
  | { type: 'close-tab'; path: string }
  | { type: 'reveal'; target: CodeRevealTarget }
  | { type: 'dismiss-error' };

const INITIAL_STATE: WorkspaceState = {
  snapshot: null,
  busy: false,
  error: null,
  tabs: [],
  activePath: null,
  reveal: null,
};

function reducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case 'loading':
      return { ...state, busy: true, error: null };
    case 'cancel':
      return { ...state, busy: false };
    case 'snapshot': {
      if (action.snapshot === null) {
        return {
          ...state,
          snapshot: null,
          busy: false,
          tabs: [],
          activePath: null,
          reveal: null,
        };
      }
      const workspaceChanged =
        state.snapshot === null || state.snapshot.workspace.id !== action.snapshot.workspace.id;
      return {
        ...state,
        snapshot: action.snapshot,
        busy: false,
        error: null,
        tabs: workspaceChanged ? [] : state.tabs,
        activePath: workspaceChanged ? null : state.activePath,
        reveal: workspaceChanged ? null : state.reveal,
      };
    }
    case 'error':
      return { ...state, busy: false, error: action.message };
    case 'activate':
      return state.tabs.some((tab) => tab.path === action.path)
        ? { ...state, activePath: action.path }
        : state;
    case 'add-tab': {
      if (state.tabs.some((tab) => tab.path === action.tab.path)) {
        return { ...state, activePath: action.tab.path };
      }
      return { ...state, tabs: [...state.tabs, action.tab], activePath: action.tab.path };
    }
    case 'edit-tab':
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.path === action.path && tab.status === 'ready'
            ? { ...tab, buffer: action.buffer, dirty: action.buffer !== tab.content }
            : tab,
        ),
      };
    case 'write-tab':
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.path === action.path && tab.status === 'ready'
            ? {
                ...tab,
                content: action.file.content,
                buffer: action.file.content,
                dirty: false,
                size: action.file.size,
                mtimeMs: action.file.mtimeMs,
                externalChange: false,
              }
            : tab,
        ),
      };
    case 'external-tab':
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.path === action.path && tab.status === 'ready'
            ? { ...tab, externalChange: true }
            : tab,
        ),
      };
    case 'close-tab': {
      const closingIndex = state.tabs.findIndex((tab) => tab.path === action.path);
      if (closingIndex === -1) {
        return state;
      }
      const tabs = state.tabs.filter((tab) => tab.path !== action.path);
      if (state.activePath !== action.path) {
        return { ...state, tabs };
      }
      const nextActive = tabs[Math.min(closingIndex, tabs.length - 1)]?.path ?? null;
      return { ...state, tabs, activePath: nextActive };
    }
    case 'reveal':
      return { ...state, reveal: action.target };
    case 'dismiss-error':
      return { ...state, error: null };
    default:
      return state;
  }
}

function fileNameForPath(filePath: string): string {
  const segments = filePath.split('/');
  return segments[segments.length - 1] ?? filePath;
}

function readyTab(path: string, name: string, file: FileContent): OpenTab {
  return {
    path,
    name,
    status: 'ready',
    content: file.content,
    buffer: file.content,
    dirty: false,
    size: file.size,
    mtimeMs: file.mtimeMs,
    externalChange: false,
  };
}

type ReadyTab = Extract<OpenTab, { status: 'ready' }>;

function readyTabAt(tabs: readonly OpenTab[], path: string): ReadyTab | null {
  const tab = tabs.find((item) => item.path === path);
  return tab !== undefined && tab.status === 'ready' ? tab : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface WorkspaceContextValue {
  state: WorkspaceState;
  openWorkspace(): Promise<void>;
  openFile(node: FileNode): Promise<void>;
  activateTab(path: string): void;
  closeTab(path: string): void;
  editTab(path: string, buffer: string): void;
  saveTab(path: string, force?: boolean): Promise<boolean>;
  reloadTab(path: string): Promise<void>;
  revealCode(path: string, line: number, endLine: number | null): Promise<void>;
  dismissError(): void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const revealNonce = useRef(0);
  const tabsRef = useRef<OpenTab[]>([]);
  tabsRef.current = state.tabs;

  // El aviso del watcher no dice qué archivo cambió: se relee solo lo que ya está abierto.
  // Una pestaña sucia nunca se pisa; se marca el cambio externo para que decida el usuario.
  const syncOpenTabs = useCallback(async (): Promise<void> => {
    const paths = tabsRef.current.filter((tab) => tab.status === 'ready').map((tab) => tab.path);
    for (const path of paths) {
      if (readyTabAt(tabsRef.current, path) === null) continue;
      const result = await bdt.readFile(path);
      if (!result.ok) continue;
      const current = readyTabAt(tabsRef.current, path);
      if (current === null || result.value.mtimeMs === current.mtimeMs) continue;
      if (current.dirty) {
        dispatch({ type: 'external-tab', path });
        continue;
      }
      dispatch({ type: 'write-tab', path, file: result.value });
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await bdt.getState();
      if (result.ok) {
        dispatch({ type: 'snapshot', snapshot: result.value });
      } else {
        dispatch({ type: 'error', message: result.error.message });
      }
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    void refresh();
    return bdt.onWorkspaceChanged(() => {
      void refresh();
      void syncOpenTabs();
    });
  }, [refresh, syncOpenTabs]);

  const openWorkspace = useCallback(async (): Promise<void> => {
    dispatch({ type: 'loading' });
    try {
      const result = await bdt.openWorkspace();
      if (!result.ok) {
        dispatch({ type: 'error', message: result.error.message });
        return;
      }
      if (result.value === null) {
        dispatch({ type: 'cancel' });
        return;
      }
      dispatch({ type: 'snapshot', snapshot: result.value });
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    }
  }, []);

  const openFile = useCallback(async (node: FileNode): Promise<void> => {
    try {
      const result = await bdt.readFile(node.path);
      if (!result.ok) {
        dispatch({
          type: 'add-tab',
          tab: {
            path: node.path,
            name: node.name,
            status: 'error',
            message: result.error.message,
          },
        });
        return;
      }
      dispatch({
        type: 'add-tab',
        tab: readyTab(result.value.path, node.name, result.value),
      });
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    }
  }, []);

  const openCodeLocation = useCallback(async (location: CodeLocation): Promise<void> => {
    const name = fileNameForPath(location.path);
    try {
      const result = await bdt.readFile(location.path);
      if (!result.ok) {
        dispatch({
          type: 'add-tab',
          tab: {
            path: location.path,
            name,
            status: 'error',
            message: result.error.message,
          },
        });
        return;
      }
      dispatch({
        type: 'add-tab',
        tab: readyTab(result.value.path, name, result.value),
      });
      revealNonce.current += 1;
      dispatch({
        type: 'reveal',
        target: {
          path: result.value.path,
          line: location.line,
          endLine: location.endLine,
          nonce: revealNonce.current,
        },
      });
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    return bdt.onRevealLocation((location) => {
      void openCodeLocation(location);
    });
  }, [openCodeLocation]);

  const revealCode = useCallback(
    async (filePath: string, line: number, endLine: number | null): Promise<void> => {
      try {
        const result = await bdt.revealCode({ path: filePath, line, endLine });
        if (!result.ok) {
          dispatch({ type: 'error', message: result.error.message });
        } else if (result.value === null) {
          dispatch({
            type: 'error',
            message: 'Esa ubicación no corresponde a un archivo del proyecto abierto.',
          });
        }
      } catch (error) {
        dispatch({ type: 'error', message: errorMessage(error) });
      }
    },
    [],
  );

  const activateTab = useCallback((path: string): void => {
    dispatch({ type: 'activate', path });
  }, []);

  const closeTab = useCallback((path: string): void => {
    dispatch({ type: 'close-tab', path });
  }, []);

  const editTab = useCallback((path: string, buffer: string): void => {
    dispatch({ type: 'edit-tab', path, buffer });
  }, []);

  const reloadTab = useCallback(async (path: string): Promise<void> => {
    const result = await bdt.readFile(path);
    if (!result.ok) {
      dispatch({ type: 'error', message: result.error.message });
      return;
    }
    dispatch({ type: 'write-tab', path, file: result.value });
  }, []);

  const saveTab = useCallback(async (path: string, force = false): Promise<boolean> => {
    const tab = readyTabAt(tabsRef.current, path);
    if (tab === null) return false;
    let baseMtimeMs = tab.mtimeMs;
    if (force) {
      const read = await bdt.readFile(path);
      if (!read.ok) {
        dispatch({ type: 'error', message: read.error.message });
        return false;
      }
      baseMtimeMs = read.value.mtimeMs;
    }
    const result = await bdt.saveFile({ path, content: tab.buffer, baseMtimeMs });
    if (!result.ok) {
      if (result.error.code === ERROR_CODES.FILE_CONFLICT) {
        dispatch({ type: 'external-tab', path });
      }
      dispatch({ type: 'error', message: result.error.message });
      return false;
    }
    dispatch({
      type: 'write-tab',
      path,
      file: {
        path,
        content: tab.buffer,
        size: result.value.size,
        mtimeMs: result.value.mtimeMs,
      },
    });
    return true;
  }, []);

  const dismissError = useCallback((): void => {
    dispatch({ type: 'dismiss-error' });
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      state,
      openWorkspace,
      openFile,
      activateTab,
      closeTab,
      editTab,
      saveTab,
      reloadTab,
      revealCode,
      dismissError,
    }),
    [
      state,
      openWorkspace,
      openFile,
      activateTab,
      closeTab,
      editTab,
      saveTab,
      reloadTab,
      revealCode,
      dismissError,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (value === null) {
    throw new Error('useWorkspace debe usarse dentro de WorkspaceProvider.');
  }
  return value;
}
