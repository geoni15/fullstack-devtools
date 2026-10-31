import type { IpcError } from './model';

export const ERROR_CODES = {
  PATH_INVALID: 'BDT_E_PATH_INVALID',
  PATH_ESCAPE: 'BDT_E_PATH_ESCAPE',
  PATH_ROOT: 'BDT_E_PATH_ROOT',
  WORKSPACE_NONE: 'BDT_E_WORKSPACE_NONE',
  FILE_NOT_FOUND: 'BDT_E_FILE_NOT_FOUND',
  FILE_TOO_LARGE: 'BDT_E_FILE_TOO_LARGE',
  FILE_BINARY: 'BDT_E_FILE_BINARY',
  READ_FAILED: 'BDT_E_READ_FAILED',
  IPC_INVALID_PAYLOAD: 'BDT_E_IPC_INVALID_PAYLOAD',
  IPC_UNAUTHORIZED: 'BDT_E_IPC_UNAUTHORIZED',
  WORKSPACE_OPEN_FAILED: 'BDT_E_WORKSPACE_OPEN_FAILED',
  BROWSER_CONFIG_INVALID: 'BDT_E_BROWSER_CONFIG_INVALID',
  BROWSER_NOT_CONFIGURED: 'BDT_E_BROWSER_NOT_CONFIGURED',
  BROWSER_CONNECT_FAILED: 'BDT_E_BROWSER_CONNECT_FAILED',
  INTERNAL: 'BDT_E_INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class BdtError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BdtError';
    this.code = code;
  }
}

export function toIpcError(error: unknown): IpcError {
  if (error instanceof BdtError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: ERROR_CODES.INTERNAL,
    message: 'Error interno del programa. Revisa el registro del proceso principal.',
  };
}
