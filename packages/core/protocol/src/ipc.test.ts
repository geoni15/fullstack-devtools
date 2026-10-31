import { describe, expect, it } from 'vitest';
import { BdtError, ERROR_CODES, toIpcError } from './errors';
import {
  BROWSER_BOUNDS_SCHEMA,
  BROWSER_SET_INSPECTION_SCHEMA,
  BROWSER_TARGETS_REQUEST_SCHEMA,
  IPC_CHANNELS,
  NO_PAYLOAD_SCHEMA,
  READ_FILE_REQUEST_SCHEMA,
  type IpcChannel,
} from './ipc';

describe('canales IPC', () => {
  it('no contiene duplicados', () => {
    const channels = Object.values(IPC_CHANNELS);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it('usa el formato namespace:accion', () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      expect(channel).toMatch(/^[a-z]+:[a-z-]+$/);
    }
  });

  it('el tipo IpcChannel acepta los canales declarados', () => {
    const channel: IpcChannel = IPC_CHANNELS.readFile;
    expect(channel).toBe('file:read');
  });
});

describe('esquemas IPC', () => {
  it('acepta una petición readFile válida', () => {
    const parsed = READ_FILE_REQUEST_SCHEMA.safeParse({ path: 'src/main.ts' });
    expect(parsed.success).toBe(true);
  });

  it('rechaza payload vacío, claves extra y rutas demasiado largas', () => {
    expect(READ_FILE_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
    expect(READ_FILE_REQUEST_SCHEMA.safeParse({ path: 'a.ts', extra: true }).success).toBe(false);
    expect(READ_FILE_REQUEST_SCHEMA.safeParse({ path: 'x'.repeat(4097) }).success).toBe(false);
  });

  it('los canales sin payload solo aceptan undefined', () => {
    expect(NO_PAYLOAD_SCHEMA.safeParse(undefined).success).toBe(true);
    expect(NO_PAYLOAD_SCHEMA.safeParse({}).success).toBe(false);
  });

  it('acepta y rechaza configuraciones de navegador', () => {
    expect(
      BROWSER_TARGETS_REQUEST_SCHEMA.safeParse({
        frontendUrl: 'http://localhost:5173',
        backendUrl: 'http://localhost:3000',
        mode: 'window',
        nodeInspectorPort: 9229,
        backendLaunch: null,
      }).success,
    ).toBe(true);
    expect(
      BROWSER_TARGETS_REQUEST_SCHEMA.safeParse({
        frontendUrl: 'http://localhost:5173',
        backendUrl: 'http://localhost:3000',
        mode: 'window',
        nodeInspectorPort: null,
        backendLaunch: null,
      }).success,
    ).toBe(true);
    expect(
      BROWSER_TARGETS_REQUEST_SCHEMA.safeParse({
        frontendUrl: 'http://localhost:5173',
        backendUrl: 'http://localhost:3000',
        mode: 'window',
        nodeInspectorPort: null,
        backendLaunch: { command: 'node backend/server.js', cwd: '' },
      }).success,
    ).toBe(true);
    expect(
      BROWSER_TARGETS_REQUEST_SCHEMA.safeParse({ frontendUrl: 'http://localhost:5173' }).success,
    ).toBe(false);
    expect(
      BROWSER_TARGETS_REQUEST_SCHEMA.safeParse({
        frontendUrl: 'http://localhost:5173',
        backendUrl: 'http://localhost:3000',
        mode: 'embedded',
        extra: 1,
        nodeInspectorPort: null,
        backendLaunch: null,
      }).success,
    ).toBe(false);
    expect(
      BROWSER_TARGETS_REQUEST_SCHEMA.safeParse({
        frontendUrl: 'http://localhost:5173',
        backendUrl: 'http://localhost:3000',
        mode: 'otro',
        nodeInspectorPort: null,
        backendLaunch: null,
      }).success,
    ).toBe(false);
    expect(
      BROWSER_TARGETS_REQUEST_SCHEMA.safeParse({
        frontendUrl: 'http://localhost:5173',
        backendUrl: 'http://localhost:3000',
        mode: 'window',
        nodeInspectorPort: 0,
        backendLaunch: null,
      }).success,
    ).toBe(false);
    expect(
      BROWSER_TARGETS_REQUEST_SCHEMA.safeParse({
        frontendUrl: 'http://localhost:5173',
        backendUrl: 'http://localhost:3000',
        mode: 'window',
        nodeInspectorPort: 9229.5,
        backendLaunch: null,
      }).success,
    ).toBe(false);
    expect(
      BROWSER_TARGETS_REQUEST_SCHEMA.safeParse({
        frontendUrl: 'http://localhost:5173',
        backendUrl: 'http://localhost:3000',
        mode: 'window',
        nodeInspectorPort: null,
        backendLaunch: { command: '', cwd: '' },
      }).success,
    ).toBe(false);
    expect(
      BROWSER_TARGETS_REQUEST_SCHEMA.safeParse({
        frontendUrl: 'http://localhost:5173',
        backendUrl: 'http://localhost:3000',
        mode: 'window',
        nodeInspectorPort: null,
        backendLaunch: { command: 'node server.js', cwd: '', extra: true },
      }).success,
    ).toBe(false);
    expect(BROWSER_SET_INSPECTION_SCHEMA.safeParse({ enabled: false }).success).toBe(true);
    expect(BROWSER_SET_INSPECTION_SCHEMA.safeParse({ enabled: 'no' }).success).toBe(false);
  });

  it('valida los límites de la vista embebida', () => {
    expect(
      BROWSER_BOUNDS_SCHEMA.safeParse({ x: 10, y: 20, width: 800, height: 600, visible: true })
        .success,
    ).toBe(true);
    expect(
      BROWSER_BOUNDS_SCHEMA.safeParse({ x: 10, y: 20, width: -1, height: 600, visible: true })
        .success,
    ).toBe(false);
    expect(
      BROWSER_BOUNDS_SCHEMA.safeParse({ x: 10.5, y: 20, width: 800, height: 600, visible: true })
        .success,
    ).toBe(false);
  });
});

describe('errores tipados', () => {
  it('conserva código y mensaje de BdtError', () => {
    const result = toIpcError(new BdtError(ERROR_CODES.PATH_ESCAPE, 'Fuera de la raíz'));
    expect(result).toEqual({ code: 'BDT_E_PATH_ESCAPE', message: 'Fuera de la raíz' });
  });

  it('no filtra detalles de errores desconocidos', () => {
    const result = toIpcError(new Error('ruta secreta C:/datos'));
    expect(result.code).toBe('BDT_E_INTERNAL');
    expect(result.message).not.toContain('C:/datos');
  });
});
