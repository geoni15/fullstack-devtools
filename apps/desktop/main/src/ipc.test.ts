import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { isTrustedSender } from './ipc';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

function fakeWindow(options: { destroyed?: boolean; contents?: object } = {}): BrowserWindow {
  return {
    isDestroyed: () => options.destroyed ?? false,
    webContents: options.contents ?? {},
  } as unknown as BrowserWindow;
}

function fakeEvent(sender: object, senderFrame: object | null): IpcMainInvokeEvent {
  return { sender, senderFrame } as unknown as IpcMainInvokeEvent;
}

describe('isTrustedSender', () => {
  it('rechaza cuando no hay ventana principal', () => {
    expect(isTrustedSender(fakeEvent({}, {}), null)).toBe(false);
  });

  it('rechaza cuando la ventana está destruida', () => {
    const contents = { mainFrame: {} };
    const window = fakeWindow({ destroyed: true, contents });
    expect(isTrustedSender(fakeEvent(contents, contents.mainFrame), window)).toBe(false);
  });

  it('rechaza un remitente que no es la ventana principal', () => {
    const contents = { mainFrame: {} };
    const window = fakeWindow({ contents });
    expect(isTrustedSender(fakeEvent({}, contents.mainFrame), window)).toBe(false);
  });

  it('rechaza un frame nulo', () => {
    const contents = { mainFrame: {} };
    const window = fakeWindow({ contents });
    expect(isTrustedSender(fakeEvent(contents, null), window)).toBe(false);
  });

  it('rechaza un iframe aunque comparta webContents', () => {
    const contents = { mainFrame: {} };
    const window = fakeWindow({ contents });
    expect(isTrustedSender(fakeEvent(contents, {}), window)).toBe(false);
  });

  it('acepta el frame principal de la ventana principal', () => {
    const contents = { mainFrame: {} };
    const window = fakeWindow({ contents });
    expect(isTrustedSender(fakeEvent(contents, contents.mainFrame), window)).toBe(true);
  });
});
