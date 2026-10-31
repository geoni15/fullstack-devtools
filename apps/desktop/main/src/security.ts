import type { Session, WebContents } from 'electron';
import { APP_HOST, APP_SCHEME } from './config';
import type { Logger } from './logger';

export function isAllowedAppUrl(rawUrl: string, devServerUrl: string | null): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (devServerUrl !== null) {
    try {
      if (url.origin === new URL(devServerUrl).origin) {
        return true;
      }
    } catch {
      return false;
    }
  }

  return url.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST;
}

export function hardenSession(ses: Session): void {
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
}

export function guardWebContents(
  contents: WebContents,
  devServerUrl: string | null,
  log: Logger,
): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const blockForeignNavigation = (event: { preventDefault: () => void }, url: string): void => {
    if (!isAllowedAppUrl(url, devServerUrl)) {
      event.preventDefault();
      log.warn('Navegación bloqueada', { url });
    }
  };

  contents.on('will-navigate', (event, url) => {
    blockForeignNavigation(event, url);
  });
  contents.on('will-redirect', (event, url) => {
    blockForeignNavigation(event, url);
  });
}
