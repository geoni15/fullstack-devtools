import { describe, expect, it } from 'vitest';
import { BdtError } from '@bdt/protocol';
import { isLoopbackHost, parseBrowserTargets } from './endpoints';

function codeOf(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof BdtError ? error.code : 'desconocido';
  }
}

describe('parseBrowserTargets', () => {
  it('acepta frontend y backend locales con puertos distintos', () => {
    const config = parseBrowserTargets({
      frontendUrl: 'http://localhost:5173/',
      backendUrl: 'http://127.0.0.1:8080/api',
      mode: 'window',
      nodeInspectorPort: null,
      backendLaunch: null,
    });
    expect(config.frontend).toEqual({
      url: 'http://localhost:5173/',
      origin: 'http://localhost:5173',
      host: 'localhost:5173',
      port: 5173,
    });
    expect(config.backend.port).toBe(8080);
    expect(config.backend.origin).toBe('http://127.0.0.1:8080');
    expect(config.mode).toBe('window');
    expect(config.nodeInspectorPort).toBeNull();
    expect(config.backendLaunch).toBeNull();
  });

  it('conserva el puerto opcional del inspector de Node', () => {
    const config = parseBrowserTargets({
      frontendUrl: 'http://localhost:5173',
      backendUrl: 'http://localhost:8080',
      mode: 'window',
      nodeInspectorPort: 9229,
      backendLaunch: null,
    });
    expect(config.nodeInspectorPort).toBe(9229);
  });

  it('normaliza el comando y el directorio de arranque sin lanzarlo', () => {
    const config = parseBrowserTargets({
      frontendUrl: 'http://localhost:5173',
      backendUrl: 'http://localhost:8080',
      mode: 'window',
      nodeInspectorPort: 9230,
      backendLaunch: {
        command: '  node backend/server.js  ',
        cwd: ' backend ',
      },
    });
    expect(config.backendLaunch).toEqual({
      command: 'node backend/server.js',
      cwd: 'backend',
      pid: null,
      inspectorPort: 9230,
    });
  });

  it('rechaza un comando de arranque vacío o con saltos de línea', () => {
    const invalid = 'BDT_E_BROWSER_CONFIG_INVALID';
    for (const command of ['   ', 'node server.js\nrm -rf /']) {
      expect(
        codeOf(() =>
          parseBrowserTargets({
            frontendUrl: 'http://localhost:5173',
            backendUrl: 'http://localhost:8080',
            mode: 'window',
            nodeInspectorPort: null,
            backendLaunch: { command, cwd: '' },
          }),
        ),
      ).toBe(invalid);
    }
  });

  it('rechaza puertos de inspector fuera de rango', () => {
    const invalid = 'BDT_E_BROWSER_CONFIG_INVALID';
    for (const port of [0, 65536, 9229.5, Number.NaN]) {
      expect(
        codeOf(() =>
          parseBrowserTargets({
            frontendUrl: 'http://localhost:5173',
            backendUrl: 'http://localhost:8080',
            mode: 'window',
            nodeInspectorPort: port,
            backendLaunch: null,
          }),
        ),
      ).toBe(invalid);
    }
  });

  it('usa el puerto por defecto del protocolo cuando se omite', () => {
    expect(
      parseBrowserTargets({
        frontendUrl: 'https://localhost',
        backendUrl: 'http://localhost:9000',
        mode: 'embedded',
        nodeInspectorPort: null,
        backendLaunch: null,
      }).frontend.port,
    ).toBe(443);
    expect(
      parseBrowserTargets({
        frontendUrl: 'http://localhost',
        backendUrl: 'http://localhost:9000',
        mode: 'embedded',
        nodeInspectorPort: null,
        backendLaunch: null,
      }).frontend.port,
    ).toBe(80);
  });

  it('rechaza URLs inválidas o con protocolos no permitidos', () => {
    const invalid = 'BDT_E_BROWSER_CONFIG_INVALID';
    expect(
      codeOf(() =>
        parseBrowserTargets({
          frontendUrl: 'no-url',
          backendUrl: 'http://localhost:8080',
          mode: 'window',
          nodeInspectorPort: null,
          backendLaunch: null,
        }),
      ),
    ).toBe(invalid);
    expect(
      codeOf(() =>
        parseBrowserTargets({
          frontendUrl: 'file:///C:/app',
          backendUrl: 'http://localhost:8080',
          mode: 'window',
          nodeInspectorPort: null,
          backendLaunch: null,
        }),
      ),
    ).toBe(invalid);
    expect(
      codeOf(() =>
        parseBrowserTargets({
          frontendUrl: 'http://localhost:5173',
          backendUrl: 'ftp://localhost:21',
          mode: 'window',
          nodeInspectorPort: null,
          backendLaunch: null,
        }),
      ),
    ).toBe(invalid);
  });

  it('rechaza hosts remotos y credenciales embebidas', () => {
    expect(
      codeOf(() =>
        parseBrowserTargets({
          frontendUrl: 'http://192.168.1.10:5173',
          backendUrl: 'http://localhost:8080',
          mode: 'window',
          nodeInspectorPort: null,
          backendLaunch: null,
        }),
      ),
    ).toBe('BDT_E_BROWSER_CONFIG_INVALID');
    expect(
      codeOf(() =>
        parseBrowserTargets({
          frontendUrl: 'http://usuario:clave@localhost:5173',
          backendUrl: 'http://localhost:8080',
          mode: 'window',
          nodeInspectorPort: null,
          backendLaunch: null,
        }),
      ),
    ).toBe('BDT_E_BROWSER_CONFIG_INVALID');
  });

  it('exige orígenes distintos para frontend y backend', () => {
    expect(
      codeOf(() =>
        parseBrowserTargets({
          frontendUrl: 'http://localhost:5173/a',
          backendUrl: 'http://localhost:5173/b',
          mode: 'window',
          nodeInspectorPort: null,
          backendLaunch: null,
        }),
      ),
    ).toBe('BDT_E_BROWSER_CONFIG_INVALID');
  });

  it('reconoce solo hosts de bucle local', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.2')).toBe(false);
  });
});
