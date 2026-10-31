import fs from 'node:fs';
import path from 'node:path';
import { BdtError, ERROR_CODES } from '@bdt/protocol';
import { LIMITS } from '../config';

export interface RootScope {
  readonly rootReal: string;
  readonly rootName: string;
  resolve(relativePath: string): string;
}

function isWithinRoot(rootReal: string, target: string): boolean {
  const relative = path.relative(rootReal, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

export function isFilesystemRoot(absolutePath: string): boolean {
  return path.parse(absolutePath).root === absolutePath;
}

export function assertSafeRelativePath(relativePath: string): void {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.length > LIMITS.maxRelativePathLength
  ) {
    throw new BdtError(ERROR_CODES.PATH_INVALID, 'La ruta solicitada no es válida.');
  }
  if (relativePath.includes('\0')) {
    throw new BdtError(ERROR_CODES.PATH_INVALID, 'La ruta solicitada no es válida.');
  }
  if (
    path.isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath) ||
    /^[\\/]{2}/.test(relativePath)
  ) {
    throw new BdtError(
      ERROR_CODES.PATH_INVALID,
      'Solo se permiten rutas relativas a la carpeta del proyecto.',
    );
  }
  const segments = relativePath.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) {
    throw new BdtError(
      ERROR_CODES.PATH_ESCAPE,
      'La ruta solicitada intenta salir de la carpeta del proyecto.',
    );
  }
}

export function createRootScope(rootAbsolutePath: string): RootScope {
  let rootReal: string;
  try {
    rootReal = fs.realpathSync.native(rootAbsolutePath);
  } catch (error) {
    throw new BdtError(
      ERROR_CODES.WORKSPACE_OPEN_FAILED,
      'No se pudo abrir la carpeta seleccionada.',
      { cause: error },
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(rootReal);
  } catch (error) {
    throw new BdtError(
      ERROR_CODES.WORKSPACE_OPEN_FAILED,
      'No se pudo leer la carpeta seleccionada.',
      { cause: error },
    );
  }

  if (!stat.isDirectory()) {
    throw new BdtError(
      ERROR_CODES.WORKSPACE_OPEN_FAILED,
      'La ruta seleccionada no es una carpeta.',
    );
  }

  if (isFilesystemRoot(rootReal)) {
    throw new BdtError(
      ERROR_CODES.PATH_ROOT,
      'No se permite abrir la raíz del sistema de archivos. Elige una carpeta de proyecto.',
    );
  }

  return {
    rootReal,
    rootName: path.basename(rootReal) || rootReal,
    resolve(relativePath: string): string {
      assertSafeRelativePath(relativePath);
      const candidate = path.resolve(rootReal, relativePath);
      if (!isWithinRoot(rootReal, candidate)) {
        throw new BdtError(
          ERROR_CODES.PATH_ESCAPE,
          'La ruta solicitada queda fuera de la carpeta del proyecto.',
        );
      }

      let realTarget: string;
      try {
        realTarget = fs.realpathSync.native(candidate);
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') {
          throw new BdtError(ERROR_CODES.FILE_NOT_FOUND, 'El archivo solicitado no existe.', {
            cause: error,
          });
        }
        throw new BdtError(ERROR_CODES.READ_FAILED, 'No se pudo acceder al archivo solicitado.', {
          cause: error,
        });
      }

      if (!isWithinRoot(rootReal, realTarget)) {
        throw new BdtError(
          ERROR_CODES.PATH_ESCAPE,
          'La ruta solicitada apunta fuera de la carpeta del proyecto mediante un enlace.',
        );
      }

      return realTarget;
    },
  };
}
