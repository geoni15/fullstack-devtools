import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mimeTypeFor, resolveRendererAsset } from './app-assets';
import { isAllowedAppUrl } from './security';

let rendererDir = '';
let secretFile = '';

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bdt-assets-'));
  rendererDir = path.join(base, 'renderer');
  fs.mkdirSync(path.join(rendererDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(rendererDir, 'index.html'), '<!doctype html>', 'utf8');
  fs.writeFileSync(path.join(rendererDir, 'assets', 'app.js'), 'console.info("x")', 'utf8');
  secretFile = path.join(base, 'secreto.txt');
  fs.writeFileSync(secretFile, 'no debe servirse', 'utf8');
});

afterAll(() => {
  if (rendererDir !== '') {
    fs.rmSync(path.dirname(rendererDir), { recursive: true, force: true });
  }
});

describe('isAllowedAppUrl', () => {
  it('permite el protocolo propio solo en el host app', () => {
    expect(isAllowedAppUrl('bdt-app://app/index.html', null)).toBe(true);
    expect(isAllowedAppUrl('bdt-app://otro/index.html', null)).toBe(false);
    expect(isAllowedAppUrl('file:///C:/Windows/win.ini', null)).toBe(false);
    expect(isAllowedAppUrl('https://ejemplo.com', null)).toBe(false);
    expect(isAllowedAppUrl('no-es-una-url', null)).toBe(false);
  });

  it('permite en desarrollo únicamente el origen configurado', () => {
    const dev = 'http://127.0.0.1:5173';
    expect(isAllowedAppUrl('http://127.0.0.1:5173/src/main.tsx', dev)).toBe(true);
    expect(isAllowedAppUrl('http://localhost:5173/src/main.tsx', dev)).toBe(false);
    expect(isAllowedAppUrl('http://127.0.0.1:5174/', dev)).toBe(false);
    expect(isAllowedAppUrl('https://ejemplo.com', dev)).toBe(false);
    expect(isAllowedAppUrl('bdt-app://app/index.html', dev)).toBe(true);
  });
});

describe('resolveRendererAsset', () => {
  it('sirve la raíz como index.html', () => {
    expect(resolveRendererAsset(rendererDir, 'bdt-app://app/')).toBe(
      path.join(rendererDir, 'index.html'),
    );
  });

  it('sirve recursos dentro del directorio del renderer', () => {
    expect(resolveRendererAsset(rendererDir, 'bdt-app://app/assets/app.js')).toBe(
      path.join(rendererDir, 'assets', 'app.js'),
    );
  });

  it('rechaza host distinto, traversal codificado y archivos inexistentes', () => {
    expect(resolveRendererAsset(rendererDir, 'bdt-app://otro/index.html')).toBeNull();
    expect(resolveRendererAsset(rendererDir, 'bdt-app://app/%2e%2e/secreto.txt')).toBeNull();
    expect(resolveRendererAsset(rendererDir, 'bdt-app://app/no-existe.js')).toBeNull();
    expect(resolveRendererAsset(rendererDir, 'bdt-app://app/assets')).toBeNull();
  });

  it('rechaza solicitudes fuera del protocolo esperado', () => {
    expect(resolveRendererAsset(rendererDir, secretFile)).toBeNull();
    expect(resolveRendererAsset(rendererDir, 'no-es-una-url')).toBeNull();
  });

  it('asigna tipos MIME por extensión', () => {
    expect(mimeTypeFor('a.js')).toContain('text/javascript');
    expect(mimeTypeFor('a.css')).toContain('text/css');
    expect(mimeTypeFor('a.unknown')).toBe('application/octet-stream');
  });
});
