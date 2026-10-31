import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BdtError, ERROR_CODES } from '@bdt/protocol';
import { readCodeBlock } from './source-snippet';

let rootDir = '';

beforeAll(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdt-snippet-'));
  fs.mkdirSync(path.join(rootDir, 'backend'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'backend', 'server.js'),
    [
      "const http = require('node:http');",
      '',
      'function listarClientes(peticion, respuesta) {',
      '  respuesta.writeHead(200);',
      '  respuesta.end();',
      '}',
      '',
      "app.get('/api/clientes', listarClientes);",
      '',
    ].join('\r\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(rootDir, 'backend', 'larga.js'), `${'x'.repeat(400)}\n`, 'utf8');
  fs.writeFileSync(path.join(rootDir, 'secret.txt'), 'fuera', 'utf8');
});

afterAll(() => {
  if (rootDir !== '') {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

describe('readCodeBlock', () => {
  it('numera las líneas del manejador y normaliza la ruta', () => {
    const block = readCodeBlock(rootDir, 'backend/server.js', 3, 6);
    expect(block.file).toBe('backend/server.js');
    expect(block.startLine).toBe(3);
    expect(block.endLine).toBe(6);
    expect(block.truncated).toBe(false);
    expect(block.lines.map((line) => line.line)).toEqual([3, 4, 5, 6]);
    expect(block.lines[0]?.text).toBe('function listarClientes(peticion, respuesta) {');
    expect(block.note).toBeNull();
  });

  it('recorta el bloque al máximo de líneas y lo indica', () => {
    const block = readCodeBlock(rootDir, 'backend/server.js', 3, 6, { maxLines: 2 });
    expect(block.lines.map((line) => line.line)).toEqual([3, 4]);
    expect(block.truncated).toBe(true);
    expect(block.note).toContain('Vista parcial');
  });

  it('marca las líneas largas como recortadas', () => {
    const block = readCodeBlock(rootDir, 'backend/larga.js', 1, 1);
    expect(block.lines[0]?.text.length).toBeLessThan(400);
    expect(block.note).toContain('recortadas');
  });

  it('rechaza rutas que escapan de la raíz', () => {
    let code: string | null = null;
    try {
      readCodeBlock(rootDir, '../secret.txt', 1, 1);
    } catch (error) {
      code = error instanceof BdtError ? error.code : 'desconocido';
    }
    expect(code).toBe(ERROR_CODES.PATH_ESCAPE);
  });
});
