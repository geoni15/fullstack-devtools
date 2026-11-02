import { describe, expect, it } from 'vitest';
import { createWorkspaceFileIndex } from './workspace-file-index';

const index = createWorkspaceFileIndex([
  'index.html',
  'about.html',
  'src/App.tsx',
  'src/styles.css',
  'public/assets/logo.png',
  'packages/api/src/server.ts',
]);

describe('createWorkspaceFileIndex', () => {
  it('resuelve rutas relativas exactas', () => {
    expect(index.resolve('src/App.tsx')).toBe('src/App.tsx');
    expect(index.resolve('./src/App.tsx?t=1#hash')).toBe('src/App.tsx');
  });

  it('resuelve URL locales con query y hash', () => {
    expect(index.resolve('http://localhost:5173/src/App.tsx?t=123')).toBe('src/App.tsx');
    expect(index.resolve('http://127.0.0.1:3000/src/styles.css#x')).toBe('src/styles.css');
  });

  it('resuelve rutas absolutas por sufijo', () => {
    expect(index.resolve('file:///C:/proyecto/src/App.tsx')).toBe('src/App.tsx');
    expect(index.resolve('C:\\proyecto\\packages\\api\\src\\server.ts')).toBe(
      'packages/api/src/server.ts',
    );
  });

  it('resuelve recursos servidos desde subcarpetas', () => {
    expect(index.resolve('/assets/logo.png')).toBe('public/assets/logo.png');
  });

  it('usa index.html para la raíz y rutas SPA', () => {
    expect(index.page('http://localhost:5173/')).toBe('index.html');
    expect(index.page('http://localhost:5173/dashboard')).toBe('index.html');
    expect(index.page('http://localhost:5173/about/')).toBe('about.html');
    expect(index.page('http://localhost:5173/about.html')).toBe('about.html');
  });

  it('no resuelve una ruta SPA como si fuera un archivo', () => {
    expect(index.resolve('http://localhost:5173/dashboard')).toBeNull();
    expect(index.resolve('/api/clientes')).toBeNull();
  });

  it('ignora archivos externos o inexistentes', () => {
    expect(index.resolve('https://cdn.example.com/app.js')).toBeNull();
    expect(index.resolve('src/inexistente.ts')).toBeNull();
  });
});
