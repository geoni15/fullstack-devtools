import fs from 'node:fs';
import { protocol } from 'electron';
import { APP_SCHEME } from './config';
import { mimeTypeFor, RENDERER_CSP, resolveRendererAsset } from './app-assets';
import { createLogger } from './logger';

const log = createLogger('app-protocol');

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
      },
    },
  ]);
}

export function registerAppProtocol(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const filePath = resolveRendererAsset(rendererDir, request.url);
    if (filePath === null) {
      return new Response('No encontrado', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    try {
      const data = await fs.promises.readFile(filePath);
      const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': mimeTypeFor(filePath),
          'content-security-policy': RENDERER_CSP,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (error) {
      log.error('No se pudo servir un recurso de la interfaz', {
        file: filePath,
        message: error instanceof Error ? error.message : String(error),
      });
      return new Response('Error interno', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  });
}
