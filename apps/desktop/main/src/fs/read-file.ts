import fs from 'node:fs';
import path from 'node:path';
import { BdtError, ERROR_CODES, type FileContent } from '@bdt/protocol';
import { LIMITS } from '../config';
import type { RootScope } from './root-guard';
import { toPosixPath } from './posix';

const BINARY_SNIFF_BYTES = 8192;

export function readTextFile(scope: RootScope, relativePath: string): FileContent {
  const absolutePath = scope.resolve(relativePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch (error) {
    throw new BdtError(ERROR_CODES.READ_FAILED, 'No se pudo leer el archivo solicitado.', {
      cause: error,
    });
  }

  if (!stat.isFile()) {
    throw new BdtError(ERROR_CODES.READ_FAILED, 'La ruta solicitada no es un archivo.');
  }

  if (stat.size > LIMITS.maxFileBytes) {
    const limitMiB = Math.floor(LIMITS.maxFileBytes / (1024 * 1024));
    throw new BdtError(
      ERROR_CODES.FILE_TOO_LARGE,
      `El archivo supera el límite de ${limitMiB} MiB y no se abre en el editor.`,
    );
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch (error) {
    throw new BdtError(ERROR_CODES.READ_FAILED, 'No se pudo leer el archivo solicitado.', {
      cause: error,
    });
  }

  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new BdtError(
      ERROR_CODES.FILE_BINARY,
      'El archivo parece binario y no se abre en el editor.',
    );
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new BdtError(
      ERROR_CODES.FILE_BINARY,
      'El archivo no contiene texto UTF-8 y no se abre en el editor.',
    );
  }

  return {
    path: toPosixPath(path.relative(scope.rootReal, absolutePath)),
    size: buffer.byteLength,
    content,
  };
}
