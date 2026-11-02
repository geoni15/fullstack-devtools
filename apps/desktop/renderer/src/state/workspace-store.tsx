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
import type { CodeLocation, FileNode, WorkspaceSnapshot } from '@bdt/protocol';
import { bdt } from '../api';

export type OpenTab =
  | { path: string; name: string; status: 'ready'; content: string; size: number }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface WorkspaceContextValue {
  state: WorkspaceState;
  openWorkspace(): Promise<void>;
  openFile(node: FileNode): Promise<void>;
  activateTab(path: string): void;
  closeTab(path: string): void;
  revealCode(path: string, line: number, endLine: number | null): Promise<void>;
  dismissError(): void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const revealNonce = useRef(0);

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
    });
  }, [refresh]);

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
        tab: {
          path: result.value.path,
          name: node.name,
          status: 'ready',
          content: result.value.content,
          size: result.value.size,
        },
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
        tab: {
          path: result.value.path,
          name,
          status: 'ready',
          content: result.value.content,
          size: result.value.size,
        },
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

  const dismissError = useCallback((): void => {
    dispatch({ type: 'dismiss-error' });
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({ state, openWorkspace, openFile, activateTab, closeTab, revealCode, dismissError }),
    [state, openWorkspace, openFile, activateTab, closeTab, revealCode, dismissError],
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
