import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import type {
  ActivityEvent,
  BackendLaunchRequest,
  BrowserEvent,
  BrowserMode,
  BrowserSnapshot,
  BrowserState,
  CapturedRequest,
  LaunchRequest,
} from '@bdt/protocol';
import { bdt } from '../api';

export interface BrowserUiState {
  state: BrowserState | null;
  requests: CapturedRequest[];
  activities: ActivityEvent[];
  busy: boolean;
  error: string | null;
}

type Action =
  | { type: 'snapshot'; snapshot: BrowserSnapshot }
  | { type: 'state'; state: BrowserState }
  | { type: 'requests'; requests: CapturedRequest[] }
  | { type: 'cleared' }
  | { type: 'activity'; activity: ActivityEvent[] }
  | { type: 'activity-cleared' }
  | { type: 'busy' }
  | { type: 'idle' }
  | { type: 'error'; message: string }
  | { type: 'dismiss-error' };

const INITIAL_STATE: BrowserUiState = {
  state: null,
  requests: [],
  activities: [],
  busy: false,
  error: null,
};

function mergeRequests(
  current: readonly CapturedRequest[],
  incoming: readonly CapturedRequest[],
): CapturedRequest[] {
  const merged = new Map(current.map((request) => [request.id, request]));
  for (const request of incoming) {
    merged.set(request.id, request);
  }
  return [...merged.values()].sort((left, right) => left.startedAt - right.startedAt);
}

function mergeActivity(
  current: readonly ActivityEvent[],
  incoming: readonly ActivityEvent[],
): ActivityEvent[] {
  const merged = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) {
    merged.set(event.id, event);
  }
  return [...merged.values()].sort(
    (left, right) => left.at - right.at || left.id.localeCompare(right.id),
  );
}

function reducer(state: BrowserUiState, action: Action): BrowserUiState {
  switch (action.type) {
    case 'snapshot':
      return {
        ...state,
        state: action.snapshot.state,
        requests: action.snapshot.requests,
        activities: action.snapshot.activity,
        busy: false,
        error: null,
      };
    case 'state':
      return {
        ...state,
        state: action.state,
        busy: false,
        error: action.state.error ?? state.error,
      };
    case 'requests':
      return { ...state, requests: mergeRequests(state.requests, action.requests) };
    case 'cleared':
      return { ...state, requests: [] };
    case 'activity':
      return { ...state, activities: mergeActivity(state.activities, action.activity) };
    case 'activity-cleared':
      return { ...state, activities: [] };
    case 'busy':
      return { ...state, busy: true, error: null };
    case 'idle':
      return { ...state, busy: false };
    case 'error':
      return { ...state, busy: false, error: action.message };
    case 'dismiss-error':
      return { ...state, error: null };
    default:
      return state;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyEvent(dispatch: (action: Action) => void, event: BrowserEvent): void {
  switch (event.type) {
    case 'state':
      dispatch({ type: 'state', state: event.state });
      break;
    case 'requests':
      dispatch({ type: 'requests', requests: event.requests });
      break;
    case 'requests-cleared':
      dispatch({ type: 'cleared' });
      break;
    case 'activity':
      dispatch({ type: 'activity', activity: event.activity });
      break;
    case 'activity-cleared':
      dispatch({ type: 'activity-cleared' });
      break;
    default:
      break;
  }
}

export interface BrowserContextValue {
  state: BrowserUiState;
  connect(
    frontendUrl: string,
    backendUrl: string,
    mode: BrowserMode,
    nodeInspectorPort: number | null,
    frontendLaunch: LaunchRequest | null,
    backendLaunch: BackendLaunchRequest | null,
  ): Promise<void>;
  disconnect(): Promise<void>;
  reload(): Promise<void>;
  clearRequests(): Promise<void>;
  setInspection(enabled: boolean): Promise<void>;
  focusBrowserWindow(): Promise<void>;
  dismissError(): void;
}

const BrowserContext = createContext<BrowserContextValue | null>(null);

export function BrowserProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await bdt.getBrowserSnapshot();
        if (!active) return;
        if (result.ok) {
          dispatch({ type: 'snapshot', snapshot: result.value });
        } else {
          dispatch({ type: 'error', message: result.error.message });
        }
      } catch (error) {
        if (active) dispatch({ type: 'error', message: errorMessage(error) });
      }
    })();
    const unsubscribe = bdt.onBrowserEvent((event) => {
      applyEvent(dispatch, event);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const connect = useCallback(
    async (
      frontendUrl: string,
      backendUrl: string,
      mode: BrowserMode,
      nodeInspectorPort: number | null,
      frontendLaunch: LaunchRequest | null,
      backendLaunch: BackendLaunchRequest | null,
    ): Promise<void> => {
      dispatch({ type: 'busy' });
      try {
        const result = await bdt.configureBrowser({
          frontendUrl,
          backendUrl,
          mode,
          nodeInspectorPort,
          frontendLaunch,
          backendLaunch,
        });
        if (!result.ok) {
          dispatch({ type: 'error', message: result.error.message });
          return;
        }
        dispatch({ type: 'snapshot', snapshot: result.value });
      } catch (error) {
        dispatch({ type: 'error', message: errorMessage(error) });
      }
    },
    [],
  );

  const disconnect = useCallback(async (): Promise<void> => {
    try {
      const result = await bdt.disconnectBrowser();
      if (!result.ok) {
        dispatch({ type: 'error', message: result.error.message });
        return;
      }
      dispatch({
        type: 'snapshot',
        snapshot: { state: result.value, requests: [], activity: [] },
      });
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    }
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const result = await bdt.reloadBrowser();
      if (!result.ok) {
        dispatch({ type: 'error', message: result.error.message });
      }
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    }
  }, []);

  const clearRequests = useCallback(async (): Promise<void> => {
    try {
      const result = await bdt.clearBrowserRequests();
      if (!result.ok) {
        dispatch({ type: 'error', message: result.error.message });
        return;
      }
      dispatch({ type: 'cleared' });
      dispatch({ type: 'state', state: result.value });
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    }
  }, []);

  const setInspection = useCallback(async (enabled: boolean): Promise<void> => {
    try {
      const result = await bdt.setBrowserInspection(enabled);
      if (!result.ok) {
        dispatch({ type: 'error', message: result.error.message });
        return;
      }
      dispatch({ type: 'state', state: result.value });
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    }
  }, []);

  const focusBrowserWindow = useCallback(async (): Promise<void> => {
    try {
      const result = await bdt.focusBrowserWindow();
      if (!result.ok) {
        dispatch({ type: 'error', message: result.error.message });
      }
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    }
  }, []);

  const dismissError = useCallback((): void => {
    dispatch({ type: 'dismiss-error' });
  }, []);

  const value = useMemo<BrowserContextValue>(
    () => ({
      state,
      connect,
      disconnect,
      reload,
      clearRequests,
      setInspection,
      focusBrowserWindow,
      dismissError,
    }),
    [
      state,
      connect,
      disconnect,
      reload,
      clearRequests,
      setInspection,
      focusBrowserWindow,
      dismissError,
    ],
  );

  return <BrowserContext.Provider value={value}>{children}</BrowserContext.Provider>;
}

export function useBrowser(): BrowserContextValue {
  const value = useContext(BrowserContext);
  if (value === null) {
    throw new Error('useBrowser debe usarse dentro de BrowserProvider.');
  }
  return value;
}
