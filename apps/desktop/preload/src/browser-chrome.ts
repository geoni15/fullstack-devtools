import { ipcRenderer } from 'electron';
import { BROWSER_CHROME_CHANNELS, type BrowserChromeState, type IpcResult } from '@bdt/protocol';

let messageTimer: ReturnType<typeof setTimeout> | null = null;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Falta el elemento ${id} en la barra del navegador.`);
  }
  return found as T;
}

function showMessage(message: string): void {
  const node = element('message');
  node.textContent = message;
  if (messageTimer !== null) {
    clearTimeout(messageTimer);
  }
  messageTimer = setTimeout(() => {
    node.textContent = '';
    messageTimer = null;
  }, 5000);
}

function render(state: BrowserChromeState): void {
  const back = element<HTMLButtonElement>('back');
  const forward = element<HTMLButtonElement>('forward');
  const reload = element<HTMLButtonElement>('reload');
  const inspect = element<HTMLButtonElement>('inspect');
  const url = element<HTMLInputElement>('url');
  const bar = element('bar');
  const status = element('status');

  back.disabled = !state.canGoBack;
  forward.disabled = !state.canGoForward;
  reload.disabled = state.loading;
  inspect.classList.toggle('is-on', state.inspectionEnabled);
  inspect.classList.toggle('is-off', !state.inspectionEnabled);
  inspect.textContent = state.inspectionEnabled ? 'Inspección ON' : 'Inspección OFF';
  const tip = element<HTMLButtonElement>('tip-toggle');
  tip.classList.toggle('is-on', state.hoverTipPinned);
  tip.setAttribute('aria-pressed', state.hoverTipPinned ? 'true' : 'false');
  bar.classList.toggle('is-loading', state.loading);
  status.textContent = state.captureActive ? 'N0 · captura activa' : 'N0 · sin captura';
  if (document.activeElement !== url) {
    url.value = state.url;
  }
  url.title = state.url;
  element('message').textContent = state.message ?? '';
}

async function invoke(channel: string, payload?: unknown): Promise<void> {
  try {
    const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<unknown>;
    if (!result.ok) {
      showMessage(result.error.message);
    }
  } catch {
    showMessage('La operación no está disponible.');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const form = element<HTMLFormElement>('nav');
  const url = element<HTMLInputElement>('url');

  element<HTMLButtonElement>('back').addEventListener('click', () => {
    void invoke(BROWSER_CHROME_CHANNELS.back);
  });
  element<HTMLButtonElement>('forward').addEventListener('click', () => {
    void invoke(BROWSER_CHROME_CHANNELS.forward);
  });
  element<HTMLButtonElement>('reload').addEventListener('click', () => {
    void invoke(BROWSER_CHROME_CHANNELS.reload);
  });
  element<HTMLButtonElement>('inspect').addEventListener('click', () => {
    void invoke(BROWSER_CHROME_CHANNELS.toggleInspection);
  });
  element<HTMLButtonElement>('tip-toggle').addEventListener('click', () => {
    void invoke(BROWSER_CHROME_CHANNELS.toggleHoverTip);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void invoke(BROWSER_CHROME_CHANNELS.navigate, url.value);
  });

  ipcRenderer.on(BROWSER_CHROME_CHANNELS.state, (_event, state: BrowserChromeState) => {
    render(state);
  });
  ipcRenderer.send(BROWSER_CHROME_CHANNELS.ready);
});
