import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BdtError, ERROR_CODES, type FileSaveResult } from '@bdt/protocol';
import { LIMITS } from '../config';
import { toPosixPath } from './posix';
import type { RootScope } from './root-guard';

// El mtime del sistema de archivos puede redondearse entre dos stat del mismo estado.
const MTIME_TOLERANCE_MS = 1;

export async function writeTextAtomic(
  target: string,
  content: string,
  mode?: number,
): Promise<void> {
  const temp = `${target}.${randomUUID()}.tmp`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.writeFile(temp, content, 'utf8');
    if (mode !== undefined) await fs.promises.chmod(temp, mode);
    await fs.promises.rename(temp, target);
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function saveTextFile(
  scope: RootScope,
  relativePath: string,
  content: string,
  baseMtimeMs: number,
): Promise<FileSaveResult> {
  const absolutePath = scope.resolve(relativePath);
  const size = Buffer.byteLength(content, 'utf8');
  if (size > LIMITS.maxFileBytes) {
    const limitMiB = Math.floor(LIMITS.maxFileBytes / (1024 * 1024));
    throw new BdtError(
      ERROR_CODES.FILE_TOO_LARGE,
      `El contenido supera el límite de ${limitMiB} MiB y no se guarda.`,
    );
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absolutePath);
  } catch (error) {
    throw new BdtError(ERROR_CODES.WRITE_FAILED, 'No se pudo acceder al archivo para guardarlo.', {
      cause: error,
    });
  }
  if (!stat.isFile()) {
    throw new BdtError(ERROR_CODES.WRITE_FAILED, 'La ruta solicitada no es un archivo.');
  }
  if (Math.abs(stat.mtimeMs - baseMtimeMs) > MTIME_TOLERANCE_MS) {
    throw new BdtError(
      ERROR_CODES.FILE_CONFLICT,
      'El archivo cambió en disco desde que se abrió. Recarga o guarda encima.',
    );
  }

  try {
    await writeTextAtomic(absolutePath, content, stat.mode);
  } catch (error) {
    throw new BdtError(ERROR_CODES.WRITE_FAILED, 'No se pudo guardar el archivo.', {
      cause: error,
    });
  }

  let saved: fs.Stats;
  try {
    saved = await fs.promises.stat(absolutePath);
  } catch (error) {
    throw new BdtError(ERROR_CODES.WRITE_FAILED, 'El archivo se guardó pero no se pudo releer.', {
      cause: error,
    });
  }

  return {
    path: toPosixPath(path.relative(scope.rootReal, absolutePath)),
    size,
    mtimeMs: saved.mtimeMs,
  };
}
