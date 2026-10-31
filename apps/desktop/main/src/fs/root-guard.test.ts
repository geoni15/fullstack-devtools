import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BdtError, ERROR_CODES, type ErrorCode } from '@bdt/protocol';
import { LIMITS } from '../config';
import {
  assertSafeRelativePath,
  createRootScope,
  isFilesystemRoot,
  type RootScope,
} from './root-guard';
import { readTextFile } from './read-file';

function captureError(run: () => unknown): BdtError {
  try {
    run();
  } catch (error) {
    if (error instanceof BdtError) {
      return error;
    }
    throw error;
  }
  throw new Error('Se esperaba un BdtError y no se lanzó ninguno.');
}

function expectCode(run: () => unknown, code: ErrorCode): void {
  expect(captureError(run).code).toBe(code);
}

let rootDir = '';
let outsideDir = '';
let scope: RootScope;
let junctionCreated = false;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bdt-guard-'));
  rootDir = path.join(base, 'proyecto');
  outsideDir = path.join(base, 'fuera');
  fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'src', 'app.ts'), 'export const value = 42;\n', 'utf8');
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# Proyecto\n', 'utf8');
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secreto-fuera-de-raiz\n', 'utf8');
  fs.writeFileSync(path.join(rootDir, 'binario.dat'), Buffer.from([1, 0, 2, 3]));
  fs.writeFileSync(path.join(rootDir, 'grande.txt'), Buffer.alloc(LIMITS.maxFileBytes + 1, 97));

  try {
    fs.symlinkSync(outsideDir, path.join(rootDir, 'enlace-fuera'), 'junction');
    junctionCreated = true;
  } catch {
    junctionCreated = false;
  }

  scope = createRootScope(rootDir);
});

afterAll(() => {
  if (scope) {
    fs.rmSync(path.dirname(scope.rootReal), { recursive: true, force: true });
  }
});

describe('assertSafeRelativePath', () => {
  it('acepta rutas relativas normales', () => {
    expect(() => assertSafeRelativePath('src/app.ts')).not.toThrow();
    expect(() => assertSafeRelativePath('src/nested/file.ts')).not.toThrow();
  });

  it('rechaza traversal, rutas absolutas, unidades y bytes nulos', () => {
    expectCode(() => assertSafeRelativePath('../secret.txt'), ERROR_CODES.PATH_ESCAPE);
    expectCode(() => assertSafeRelativePath('src/../../secret.txt'), ERROR_CODES.PATH_ESCAPE);
    expectCode(
      () => assertSafeRelativePath(path.join(rootDir, 'README.md')),
      ERROR_CODES.PATH_INVALID,
    );
    expectCode(() => assertSafeRelativePath('C:\\Windows\\win.ini'), ERROR_CODES.PATH_INVALID);
    expectCode(() => assertSafeRelativePath('\\\\servidor\\recurso'), ERROR_CODES.PATH_INVALID);
    expectCode(() => assertSafeRelativePath('src/app\0.ts'), ERROR_CODES.PATH_INVALID);
    expectCode(() => assertSafeRelativePath(''), ERROR_CODES.PATH_INVALID);
  });
});

describe('RootScope', () => {
  it('resuelve archivos dentro de la raíz y los lee', () => {
    const resolved = scope.resolve('src/app.ts');
    expect(resolved).toBe(fs.realpathSync.native(path.join(scope.rootReal, 'src', 'app.ts')));

    const file = readTextFile(scope, 'src/app.ts');
    expect(file.path).toBe('src/app.ts');
    expect(file.content).toContain('value = 42');
  });

  it('rechaza leer fuera de la raíz', () => {
    expectCode(() => scope.resolve('../fuera/secret.txt'), ERROR_CODES.PATH_ESCAPE);
    expectCode(() => scope.resolve(path.join(outsideDir, 'secret.txt')), ERROR_CODES.PATH_INVALID);
  });

  it('rechaza enlaces que escapan de la raíz', () => {
    if (!junctionCreated) {
      return;
    }
    expectCode(() => scope.resolve('enlace-fuera/secret.txt'), ERROR_CODES.PATH_ESCAPE);
  });

  it('distingue archivo inexistente', () => {
    expectCode(() => scope.resolve('no-existe.txt'), ERROR_CODES.FILE_NOT_FOUND);
  });

  it('rechaza la raíz del sistema de archivos', () => {
    const filesystemRoot = path.parse(rootDir).root;
    expect(isFilesystemRoot(filesystemRoot)).toBe(true);
    expectCode(() => createRootScope(filesystemRoot), ERROR_CODES.PATH_ROOT);
  });

  it('rechaza abrir un archivo como raíz', () => {
    expectCode(
      () => createRootScope(path.join(rootDir, 'README.md')),
      ERROR_CODES.WORKSPACE_OPEN_FAILED,
    );
  });
});

describe('readTextFile', () => {
  it('rechaza archivos binarios', () => {
    expectCode(() => readTextFile(scope, 'binario.dat'), ERROR_CODES.FILE_BINARY);
  });

  it('rechaza archivos por encima del límite', () => {
    expectCode(() => readTextFile(scope, 'grande.txt'), ERROR_CODES.FILE_TOO_LARGE);
  });

  it('rechaza leer un directorio', () => {
    expectCode(() => readTextFile(scope, 'src'), ERROR_CODES.READ_FAILED);
  });
});
