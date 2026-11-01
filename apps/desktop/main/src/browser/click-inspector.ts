import type { Debugger as CdpDebugger } from 'electron';
import type {
  FlowInteractionEvent,
  HandlerSource,
  InspectionCodeBlock,
  InspectionElement,
  InspectionHandler,
  InspectionMode,
} from '@bdt/protocol';
import type { Logger } from '../logger';
import {
  PAGE_DOM_HELPERS_SOURCE,
  isFlowInteractionEvent,
  parseElementRef,
  type PageElementRef,
} from './page-inventory';
import {
  RUNTIME_NETWORK_SOURCE,
  RUNTIME_PROVENANCE_CALL,
  parseRuntimeProvenance,
  type RuntimeProvenance,
  type RuntimeRenderInfo,
} from './runtime-provenance';
import { mapGeneratedLocation, parseInlineSourceMap, type InlineSourceMap } from './source-maps';

const WORLD_NAME = 'bdt-inspector-world';
const BINDING_NAME = 'bdtInspectorClick';
const MAX_SIGNAL_BYTES = 16384;
const MAX_HANDLER_SOURCE = 12000;
const MAX_HANDLER_LINES = 80;
const HANDLER_CONTEXT_LINES = 12;

const INTERNAL_HANDLER_NAMES = new Set([
  'dispatchEvent',
  'dispatchDiscreteEvent',
  'dispatchContinuousEvent',
  'invokeGuardedCallbackDev',
  'noop',
]);

const LISTENER_SOURCE = String.raw`
(() => {
  if (globalThis.__bdtInspectorBound === true) return;
  if (typeof globalThis.bdtInspectorClick !== 'function') return;
  globalThis.__bdtInspectorBound = true;
${PAGE_DOM_HELPERS_SOURCE}
  const emit = (payload) => {
    try {
      globalThis.bdtInspectorClick(JSON.stringify(payload));
    } catch (error) {
      void error;
    }
  };
  const describe = (el) => {
    const attribute = (name) => {
      try { return el.getAttribute(name); } catch (error) { void error; return null; }
    };
    let text = null;
    try {
      const raw = el.innerText !== undefined ? el.innerText : el.textContent;
      if (typeof raw === 'string') {
        const clean = raw.replace(/\s+/g, ' ').trim();
        if (clean !== '') text = clean.slice(0, 120);
      }
    } catch (error) {
      void error;
    }
    if (text === null) {
      const alternatives = [attribute('aria-label'), attribute('title'), attribute('alt'), attribute('placeholder')];
      try {
        if (el.value !== undefined && typeof el.value === 'string') alternatives.push(el.value);
      } catch (error) { void error; }
      for (const candidate of alternatives) {
        if (typeof candidate !== 'string') continue;
        const clean = candidate.replace(/\s+/g, ' ').trim();
        if (clean === '') continue;
        text = clean.slice(0, 120);
        break;
      }
    }
    let role = null;
    let ariaLabel = null;
    let inputType = null;
    try { role = el.getAttribute('role'); } catch (error) { void error; }
    try { ariaLabel = el.getAttribute('aria-label'); } catch (error) { void error; }
    try { if (el instanceof HTMLInputElement) inputType = el.type; } catch (error) { void error; }
    let submitLike = false;
    try {
      const control = el.closest ? el.closest('form, button, input[type="submit"], input[type="image"]') : null;
      if (control) {
        const controlTag = typeof control.tagName === 'string' ? control.tagName.toLowerCase() : '';
        if (controlTag === 'form') {
          submitLike = true;
        } else if (controlTag === 'button') {
          const type = typeof control.type === 'string' ? control.type.toLowerCase() : 'submit';
          submitLike = type === 'submit';
        } else if (controlTag === 'input') {
          submitLike = true;
        }
      }
    } catch (error) { void error; }
    const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : 'desconocido';
    return { tag, text, role, ariaLabel, inputType, submitLike };
  };
  const rectOf = (el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const deepTarget = (target, x, y) => {
    let current = target;
    const seen = new Set();
    while (current instanceof Element && !seen.has(current)) {
      seen.add(current);
      const root = current.shadowRoot;
      if (root === null || root === undefined) break;
      let inner = null;
      try { inner = root.elementFromPoint(x, y); } catch (error) { inner = null; }
      if (!(inner instanceof Element) || inner === current) break;
      current = inner;
    }
    return current;
  };
  const style = (element, name, value) => {
    try { element.style.setProperty(name, value, 'important'); } catch (error) { void error; }
  };

  let tipHost = null;
  let tipMode = null;
  let tipTitle = null;
  let tipSub = null;
  let tipRows = null;
  let tipCode = null;
  let tipFooter = null;
  let boxHost = null;

  const ensureBox = () => {
    if (boxHost !== null && boxHost.isConnected) return;
    boxHost = null;
    const host = document.createElement('bdt-hover-box');
    style(host, 'position', 'fixed');
    style(host, 'z-index', '2147483646');
    style(host, 'pointer-events', 'none');
    style(host, 'display', 'none');
    style(host, 'background', 'rgba(88, 166, 255, 0.20)');
    style(host, 'margin', '0');
    style(host, 'padding', '0');
    style(host, 'contain', 'strict');
    (document.documentElement || document.body).append(host);
    boxHost = host;
  };

  const showBox = (rect) => {
    if (!rect || typeof rect !== 'object') return;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (!isFinite(x) || !isFinite(y) || !isFinite(width) || !isFinite(height)) return;
    if (width <= 0 || height <= 0) return;
    ensureBox();
    style(boxHost, 'display', 'block');
    style(boxHost, 'left', Math.round(x) + 'px');
    style(boxHost, 'top', Math.round(y) + 'px');
    style(boxHost, 'width', Math.round(width) + 'px');
    style(boxHost, 'height', Math.round(height) + 'px');
  };

  const hideBox = () => {
    if (boxHost !== null) style(boxHost, 'display', 'none');
  };

  let mapHighlightTimers = [];
  globalThis.__bdtMapHighlight = (key, selector, durationMs) => {
    try {
      if (typeof selector !== 'string' || selector === '') return false;
      let target = null;
      try {
        target = globalThis.__bdtResolveRef ? globalThis.__bdtResolveRef(key, selector) : null;
      } catch (error) {
        target = null;
      }
      if (!(target instanceof Element)) {
        try {
          target = globalThis.__bdtResolveRef ? globalThis.__bdtResolveRef(null, selector) : null;
        } catch (error) {
          target = null;
        }
      }
      if (!(target instanceof Element)) return false;
      try {
        target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      } catch (error) {
        void error;
      }
      for (const timer of mapHighlightTimers) clearTimeout(timer);
      mapHighlightTimers = [];
      const total =
        typeof durationMs === 'number' && isFinite(durationMs)
          ? Math.max(800, Math.min(12000, durationMs))
          : 2600;
      showBox(rectOf(target));
      mapHighlightTimers.push(setTimeout(() => { hideBox(); }, Math.round(total * 0.32)));
      mapHighlightTimers.push(setTimeout(() => { showBox(rectOf(target)); }, Math.round(total * 0.42)));
      mapHighlightTimers.push(setTimeout(() => { hideBox(); }, total));
      return true;
    } catch (error) {
      void error;
      return false;
    }
  };

  const ensureTip = () => {
    if (tipHost !== null && tipHost.isConnected) return;
    tipHost = null;
    tipMode = null;
    tipTitle = null;
    tipSub = null;
    tipRows = null;
    tipCode = null;
    tipFooter = null;
    const host = document.createElement('bdt-hover-tip');
    style(host, 'position', 'fixed');
    style(host, 'z-index', '2147483647');
    style(host, 'pointer-events', 'auto');
    style(host, 'display', 'none');
    style(host, 'margin', '0');
    style(host, 'padding', '0');
    style(host, 'background', 'transparent');
    style(host, 'max-width', '92vw');
    style(host, 'contain', 'layout style');

    const shadow = host.attachShadow({ mode: 'closed' });
    const css = ':host { all: initial; } * { box-sizing: border-box; margin: 0; padding: 0; }' +
      '.tip { width: 430px; max-width: 92vw; max-height: calc(100vh - 20px); overflow-y: auto; overscroll-behavior: contain; background: #0b1118; color: #d4d4d4; font: 11px/1.45 "Cascadia Mono", Consolas, monospace; }' +
      '.mode { padding: 3px 8px; background: #1d3a5c; color: #cfe6ff; font: 600 9px/1.5 system-ui, "Segoe UI", sans-serif; letter-spacing: 0.08em; text-transform: uppercase; }' +
      '.mode[data-mode="frontend"] { background: #3a2a56; color: #e6d6ff; }' +
      '.mode[data-mode="backend"] { background: #163a2a; color: #c8f0d8; }' +
      '.mode[data-mode="request"] { background: #3a2a1b; color: #ffd7a8; }' +
      '.mode[data-mode="database"] { background: #1f3a3a; color: #b8e8e8; }' +
      '.title { padding: 6px 8px 0; color: #e6edf3; font: 600 12px/1.4 system-ui, "Segoe UI", sans-serif; word-break: break-word; }' +
      '.sub { padding: 1px 8px 4px; color: #7d8b99; font-size: 10px; word-break: break-word; }' +
      '.rows { display: flex; flex-direction: column; }' +
      '.row { display: flex; gap: 8px; padding: 2px 8px; }' +
      '.row:nth-child(even) { background: #101923; }' +
      '.label { flex: none; width: 78px; color: #7d8b99; }' +
      '.value { flex: 1; color: #d4d4d4; white-space: pre-wrap; word-break: break-word; }' +
      '.row.is-ok .value { color: #9fe3b8; }' +
      '.row.is-warn .value { color: #ffd7a8; }' +
      '.row.is-dim .value { color: #8b98a5; }' +
      '.code { margin: 4px 8px 0; padding: 4px 6px; background: #070c11; overflow-x: auto; }' +
      '.code-head { color: #a9cdf0; font-size: 10px; padding-bottom: 3px; word-break: break-all; }' +
      '.code-line { display: flex; gap: 8px; white-space: pre; }' +
      '.code-number { flex: none; width: 34px; color: #56616d; text-align: right; }' +
      '.code-text { color: #d4d4d4; }' +
      '.footer { padding: 4px 8px 0; color: #7d8b99; font-size: 10px; }' +
      '.footer[hidden] { display: none; }';
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
    } catch (error) {
      const element = document.createElement('style');
      element.textContent = css;
      shadow.append(element);
    }

    const root = document.createElement('div');
    root.className = 'tip';
    tipMode = document.createElement('div');
    tipMode.className = 'mode';
    tipTitle = document.createElement('div');
    tipTitle.className = 'title';
    tipSub = document.createElement('div');
    tipSub.className = 'sub';
    tipRows = document.createElement('div');
    tipRows.className = 'rows';
    tipCode = document.createElement('div');
    tipCode.className = 'code';
    tipFooter = document.createElement('div');
    tipFooter.className = 'footer';
    root.append(tipMode, tipTitle, tipSub, tipRows, tipCode, tipFooter);
    shadow.append(root);
    (document.documentElement || document.body).append(host);
    tipHost = host;
  };

  const setText = (node, value, max) => {
    node.textContent = typeof value === 'string' ? value.slice(0, max) : '';
    node.hidden = node.textContent === '';
  };

  const positionTip = (x, y) => {
    if (tipHost === null) return;
    style(tipHost, 'left', '0px');
    style(tipHost, 'top', '0px');
    const bounds = tipHost.getBoundingClientRect();
    const viewWidth = window.innerWidth || 0;
    const viewHeight = window.innerHeight || 0;
    let left = x + 16;
    let top = y + 16;
    if (left + bounds.width > viewWidth - 10) left = Math.max(10, x - bounds.width - 16);
    if (top + bounds.height > viewHeight - 10) top = Math.max(10, y - bounds.height - 16);
    style(tipHost, 'left', Math.round(left) + 'px');
    style(tipHost, 'top', Math.round(top) + 'px');
  };

  globalThis.__bdtShowTip = (data) => {
    if (!data || typeof data !== 'object') return;
    ensureTip();
    const modeName = typeof data.mode === 'string' ? data.mode : 'html';
    tipMode.dataset.mode = modeName;
    tipMode.textContent = typeof data.modeLabel === 'string' ? data.modeLabel.slice(0, 32) : modeName.toUpperCase();
    setText(tipTitle, data.title, 240);
    setText(tipSub, data.subtitle, 320);
    tipRows.replaceChildren();
    const rows = Array.isArray(data.rows) ? data.rows : [];
    for (const row of rows) {
      if (!row || typeof row.label !== 'string' || typeof row.value !== 'string') continue;
      const node = document.createElement('div');
      node.className = row.tone === 'ok' ? 'row is-ok' : row.tone === 'warn' ? 'row is-warn' : row.tone === 'dim' ? 'row is-dim' : 'row';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = row.label;
      const value = document.createElement('span');
      value.className = 'value';
      value.textContent = row.value;
      node.append(label, value);
      tipRows.append(node);
    }
    tipCode.replaceChildren();
    tipCode.hidden = true;
    const code = data.code;
    if (code && typeof code === 'object' && Array.isArray(code.lines) && code.lines.length > 0) {
      tipCode.hidden = false;
      const head = document.createElement('div');
      head.className = 'code-head';
      const file = typeof code.file === 'string' ? code.file : '';
      const range = typeof code.range === 'string' ? code.range : '';
      head.textContent = (file + ' ' + range).trim().slice(0, 240);
      tipCode.append(head);
      for (const line of code.lines) {
        if (!line || typeof line.text !== 'string') continue;
        const row = document.createElement('div');
        row.className = 'code-line';
        const number = document.createElement('span');
        number.className = 'code-number';
        number.textContent = typeof line.line === 'number' ? String(line.line) : '';
        const text = document.createElement('span');
        text.className = 'code-text';
        const content = line.text.replace(/\t/g, '  ').slice(0, 180);
        text.textContent = content === '' ? ' ' : content;
        row.append(number, text);
        tipCode.append(row);
      }
    }
    setText(tipFooter, data.footer, 240);
    style(tipHost, 'display', 'block');
    const x = typeof data.x === 'number' && isFinite(data.x) ? data.x : 0;
    const y = typeof data.y === 'number' && isFinite(data.y) ? data.y : 0;
    positionTip(x, y);
    if (data.rect) showBox(data.rect);
  };

  const hideTip = () => {
    if (tipHost !== null) style(tipHost, 'display', 'none');
  };

  globalThis.__bdtHideTip = () => {
    hideTip();
    hideBox();
  };

  let hoverTarget = null;
  let hoverX = 0;
  let hoverY = 0;

  globalThis.__bdtHoverClear = () => {
    hoverTarget = null;
    globalThis.__bdtHoverTarget = null;
    hideTip();
    hideBox();
  };

  const endHover = () => {
    if (hoverTarget === null) return;
    hoverTarget = null;
    globalThis.__bdtHoverTarget = null;
    hideTip();
    hideBox();
    emit({ kind: 'hover-end' });
  };

  const sendHover = (target, x, y) => {
    showBox(rectOf(target));
    emit({
      kind: 'hover',
      x: Math.round(x),
      y: Math.round(y),
      docX: Math.round(window.scrollX + x),
      docY: Math.round(window.scrollY + y),
      rect: rectOf(target),
      ref: refOfControl(target),
      element: describe(target),
    });
  };

  const dispatchHover = (target) => {
    if (globalThis.__BDT_INSPECT_ENABLED__ === false) return;
    if (!(target instanceof Element) || !target.isConnected) return;
    const hit = deepTarget(target, hoverX, hoverY);
    hoverTarget = hit;
    globalThis.__bdtHoverTarget = hit;
    sendHover(hit, hoverX, hoverY);
  };

  const inspectEnabled = () => globalThis.__BDT_INSPECT_ENABLED__ !== false;
  const ownUi = (node) => {
    if (node === null || node === undefined) return false;
    if (node === tipHost || node === boxHost) return true;
    if (!(node instanceof Element)) return false;
    try {
      return node.closest('bdt-hover-tip, bdt-hover-box') !== null;
    } catch (error) {
      void error;
      return false;
    }
  };
  const refCache = new WeakMap();
  const refOfControl = (node) => {
    if (node === null || node === undefined) return null;
    if (node instanceof Element) {
      const cached = refCache.get(node);
      if (cached !== undefined && Date.now() - cached.at < 800) return cached.value;
    }
    try {
      const control =
        node.nodeType === 9 ? node : __bdtPage.closestInteractive(node) || node;
      const ref = __bdtPage.refOf(control);
      const value = ref !== null && ref.key !== '' ? ref : null;
      if (node instanceof Element) refCache.set(node, { at: Date.now(), value });
      if (control instanceof Element && control !== node) {
        refCache.set(control, { at: Date.now(), value });
      }
      return value;
    } catch (error) {
      void error;
      return null;
    }
  };
  const sendInteraction = (event, node) => {
    if (!inspectEnabled() || ownUi(node)) return;
    const ref = refOfControl(node);
    if (ref === null) return;
    emit({ kind: 'interaction', event, at: Date.now(), ref });
  };
  globalThis.__bdtResolveRef = (key, selector) => {
    try {
      if (typeof selector !== 'string' || selector === '') return null;
      if (selector === 'document') return document;
      const tokens = selector.split('>');
      let current = null;
      let shadow = null;
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === 'shadow') {
          shadow = current && current.shadowRoot ? current.shadowRoot : null;
          if (!shadow) return null;
          current = null;
          continue;
        }
        const scope = current === null ? shadow || document : current;
        let match = null;
        try {
          match = scope.querySelector(':scope > ' + token);
        } catch (error) {
          void error;
          match = null;
        }
        if (!match && scope === document) {
          try {
            match = document.querySelector(token);
          } catch (error) {
            void error;
            match = null;
          }
        }
        if (!match) return null;
        current = match;
        shadow = null;
      }
      if (!current || current.nodeType !== 1) return null;
      if (typeof key === 'string' && key !== '' && __bdtPage.keyFor(current) !== key) return null;
      return current;
    } catch (error) {
      void error;
      return null;
    }
  };
  const interactionNode = (target, x, y) => {
    if (target === window || target === document) return document;
    if (!(target instanceof Element) || ownUi(target)) return null;
    let deep = target;
    try {
      let px = typeof x === 'number' ? x : 0;
      let py = typeof y === 'number' ? y : 0;
      if (px === 0 && py === 0) {
        const rect = target.getBoundingClientRect();
        px = rect.left + rect.width / 2;
        py = rect.top + rect.height / 2;
      }
      deep = deepTarget(target, px, py);
    } catch (error) {
      void error;
      deep = target;
    }
    try {
      return __bdtPage.closestInteractive(deep) || deep;
    } catch (error) {
      void error;
      return deep;
    }
  };

  window.addEventListener('dblclick', (event) => {
    const target = interactionNode(event.target, event.clientX, event.clientY);
    if (target !== null) sendInteraction('dblclick', target);
  }, true);
  window.addEventListener('contextmenu', (event) => {
    const target = interactionNode(event.target, event.clientX, event.clientY);
    if (target !== null) sendInteraction('contextmenu', target);
  }, true);
  window.addEventListener('input', (event) => {
    const target = interactionNode(event.target);
    if (target !== null) sendInteraction('input', target);
  }, true);
  window.addEventListener('change', (event) => {
    const target = interactionNode(event.target);
    if (target !== null) sendInteraction('change', target);
  }, true);
  window.addEventListener('focusin', (event) => {
    const target = interactionNode(event.target);
    if (target !== null) sendInteraction('focus', target);
  }, true);
  window.addEventListener('focusout', (event) => {
    const target = interactionNode(event.target);
    if (target !== null) sendInteraction('blur', target);
  }, true);
  window.addEventListener('keydown', (event) => {
    if (!__bdtPage.isControlKey(event.key)) return;
    const target = interactionNode(event.target);
    if (target !== null) sendInteraction('keydown', target);
  }, true);

  let hoverKey = null;
  window.addEventListener('mouseover', (event) => {
    if (!inspectEnabled()) return;
    if (!(event.target instanceof Element) || ownUi(event.target)) return;
    let control = null;
    try {
      let deep = event.target;
      try {
        deep = deepTarget(event.target, event.clientX, event.clientY);
      } catch (error) {
        void error;
        deep = event.target;
      }
      control = __bdtPage.closestInteractive(deep) || deep;
    } catch (error) {
      void error;
      control = null;
    }
    if (control === null) {
      hoverKey = null;
      return;
    }
    let key = '';
    try {
      key = __bdtPage.keyFor(control);
    } catch (error) {
      void error;
      key = '';
    }
    if (key === '' || key === hoverKey) return;
    hoverKey = key;
    sendInteraction('hover', control);
  }, true);
  window.addEventListener('mouseout', (event) => {
    if (event.relatedTarget === null) hoverKey = null;
  }, true);

  let scrollTimer = null;
  let scrollTarget = null;
  window.addEventListener('scroll', (event) => {
    if (!inspectEnabled()) return;
    const raw = event.target === document || event.target === window ? document : event.target;
    if (!(raw instanceof Element) && raw !== document) return;
    if (raw instanceof Element && ownUi(raw)) return;
    scrollTarget = raw;
    if (scrollTimer !== null) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      const target = scrollTarget;
      scrollTarget = null;
      if (target !== null) sendInteraction('scroll', target);
    }, 200);
  }, true);

  let domTimer = null;
  const observedRoots = new WeakSet();
  let observer = null;
  const observeRoot = (root) => {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    try {
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'class', 'style', 'hidden', 'disabled', 'role', 'aria-label',
          'aria-disabled', 'href', 'action', 'method', 'type', 'name', 'id',
        ],
      });
    } catch (error) {
      void error;
    }
    let nodes = [];
    try {
      nodes = Array.from(root.querySelectorAll('*'));
    } catch (error) {
      void error;
      nodes = [];
    }
    for (const node of nodes) {
      try {
        if (node.shadowRoot) observeRoot(node.shadowRoot);
      } catch (error) {
        void error;
      }
    }
  };
  const mutationRelevant = (records) => {
    for (const record of records) {
      if (record.target instanceof Element && ownUi(record.target)) continue;
      if (record.type === 'childList' && record.removedNodes.length === 0) {
        let onlyTool = record.addedNodes.length > 0;
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) {
            onlyTool = false;
            break;
          }
          const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
          if (tag.indexOf('bdt-') !== 0) {
            onlyTool = false;
            break;
          }
        }
        if (onlyTool) continue;
      }
      return true;
    }
    return false;
  };
  observer = new MutationObserver((records) => {
    if (!inspectEnabled() || !mutationRelevant(records)) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        try {
          if (node instanceof Element && node.shadowRoot) observeRoot(node.shadowRoot);
        } catch (error) {
          void error;
        }
      }
    }
    if (domTimer !== null) return;
    domTimer = setTimeout(() => {
      domTimer = null;
      emit({ kind: 'dom-changed' });
    }, 400);
  });
  observeRoot(document);

  window.addEventListener('mousemove', (event) => {
    if (globalThis.__BDT_INSPECT_ENABLED__ === false) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target === tipHost || target === boxHost) return;
    hoverX = event.clientX;
    hoverY = event.clientY;
    dispatchHover(target);
  }, true);

  globalThis.__bdtHoverRefresh = () => {
    if (globalThis.__BDT_INSPECT_ENABLED__ === false) return;
    if (!(hoverTarget instanceof Element) || !hoverTarget.isConnected) return;
    sendHover(hoverTarget, hoverX, hoverY);
  };

  window.addEventListener('mouseout', (event) => {
    if (event.relatedTarget === null) endHover();
  }, true);
  window.addEventListener('scroll', (event) => {
    if (event.target === tipHost || event.target === boxHost) return;
    endHover();
  }, true);
  window.addEventListener('blur', endHover, true);

  window.addEventListener('click', (event) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target === tipHost || event.target === boxHost) return;
    let x = event.clientX;
    let y = event.clientY;
    let docX = event.pageX;
    let docY = event.pageY;
    if (x === 0 && y === 0) {
      const rect = event.target.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
      docX = window.scrollX + x;
      docY = window.scrollY + y;
    }
    const hit = deepTarget(event.target, x, y);
    globalThis.__bdtClickTarget = hit;
    const ref = refOfControl(hit);
    emit({
      kind: 'click',
      x: Math.round(x),
      y: Math.round(y),
      docX: Math.round(docX),
      docY: Math.round(docY),
      at: Date.now(),
      ref,
      element: describe(hit),
    });
  }, true);
  window.addEventListener('submit', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target === tipHost || event.target === boxHost) return;
    const rect = event.target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    globalThis.__bdtClickTarget = event.target;
    let submitter = null;
    try {
      if (event.submitter) submitter = refOfControl(event.submitter);
    } catch (error) {
      void error;
    }
    emit({
      kind: 'submit',
      x: Math.round(x),
      y: Math.round(y),
      docX: Math.round(window.scrollX + x),
      docY: Math.round(window.scrollY + y),
      at: Date.now(),
      ref: refOfControl(event.target),
      submitter,
      element: describe(event.target),
    });
  }, true);
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    hideTip();
    hideBox();
    hoverTarget = null;
    globalThis.__bdtHoverTarget = null;
    globalThis.__bdtClickTarget = null;
    emit({ kind: 'escape' });
  }, true);
})();
`;

const ANCESTORS_FUNCTION = String.raw`
function () {
  const nodes = [];
  const seen = new Set();
  let node = this;
  while (node !== null && !seen.has(node)) {
    seen.add(node);
    nodes.push(node);
    let parent = node.parentElement;
    if (!parent && typeof node.getRootNode === 'function') {
      const root = node.getRootNode();
      parent = root && root.host ? root.host : null;
    }
    node = parent;
  }
  return nodes;
}
`;

const HINT_FUNCTION = String.raw`
function (eventType) {
  const prop = 'on' + eventType.charAt(0).toUpperCase() + eventType.slice(1);
  const result = { kind: null, name: null, source: null };
  const describe = (fn) => {
    let name = null;
    try {
      name = typeof fn.name === 'string' && fn.name !== '' ? fn.name : null;
    } catch (error) {
      void error;
    }
    let source = null;
    try {
      const text = Function.prototype.toString.call(fn);
      if (text.trim() !== '') source = text.slice(0, 6000);
    } catch (error) {
      void error;
    }
    return { name, source };
  };
  let keys = [];
  try {
    keys = Object.keys(this);
  } catch (error) {
    return result;
  }
  for (const key of keys) {
    if (key.indexOf('__reactProps$') === 0 || key.indexOf('__reactEventHandlers$') === 0) {
      try {
        const props = this[key];
        const fn = props ? props[prop] : null;
        if (typeof fn === 'function') {
          const info = describe(fn);
          result.kind = 'react';
          result.name = info.name;
          result.source = info.source;
          return result;
        }
      } catch (error) {
        void error;
      }
    }
    if (key === '_vei') {
      try {
        const invokers = this[key] || {};
        for (const entryKey of Object.keys(invokers)) {
          if (entryKey.toLowerCase() !== prop.toLowerCase()) continue;
          const entry = invokers[entryKey];
          const fn =
            typeof entry === 'function'
              ? entry
              : entry && typeof entry.value === 'function'
                ? entry.value
                : null;
          if (fn !== null) {
            const info = describe(fn);
            result.kind = 'vue';
            result.name = info.name;
            result.source = info.source;
            return result;
          }
        }
      } catch (error) {
        void error;
      }
    }
  }
  return result;
}
`;

const CANCELLED_ERROR = 'Object id does not exist';

const FIBER_HINT_FUNCTION = String.raw`
function (eventType) {
  const prop = 'on' + eventType.charAt(0).toUpperCase() + eventType.slice(1);
  const result = { kind: null, name: null, source: null };
  const describe = (fn) => {
    let name = null;
    try {
      name = typeof fn.name === 'string' && fn.name !== '' ? fn.name : null;
    } catch (error) {
      void error;
    }
    let source = null;
    try {
      const text = Function.prototype.toString.call(fn);
      if (text.trim() !== '') source = text.slice(0, 6000);
    } catch (error) {
      void error;
    }
    return { name, source };
  };
  const readProps = (props) => {
    if (!props || typeof props !== 'object') return false;
    let fn = null;
    try { fn = props[prop]; } catch (error) { fn = null; }
    if (typeof fn !== 'function') return false;
    const info = describe(fn);
    result.kind = 'react';
    result.name = info.name;
    result.source = info.source;
    return true;
  };
  let keys = [];
  try { keys = Object.keys(this); } catch (error) { return result; }
  let fiber = null;
  for (const key of keys) {
    if (key.indexOf('__reactFiber$') !== 0 && key.indexOf('__reactInternalInstance$') !== 0) continue;
    try { fiber = this[key]; } catch (error) { fiber = null; }
    if (fiber) break;
  }
  for (let depth = 0; fiber && depth < 24; depth += 1) {
    let props = null;
    try { props = fiber.memoizedProps || fiber.pendingProps; } catch (error) { props = null; }
    if (readProps(props)) return result;
    try { fiber = fiber.return; } catch (error) { fiber = null; }
  }
  let component = null;
  try { component = this.__vueParentComponent || null; } catch (error) { component = null; }
  for (let depth = 0; component && depth < 24; depth += 1) {
    let props = null;
    try { props = component.props || (component.vnode && component.vnode.props); } catch (error) { props = null; }
    if (props && typeof props === 'object') {
      let fn = null;
      try { fn = props[prop]; } catch (error) { fn = null; }
      if (typeof fn === 'function') {
        const info = describe(fn);
        result.kind = 'vue';
        result.name = info.name;
        result.source = info.source;
        return result;
      }
    }
    try { component = component.parent; } catch (error) { component = null; }
  }
  return result;
}
`;

const ELEMENT_INFO_FUNCTION = String.raw`
function () {
  const result = {
    tag: 'desconocido',
    id: null,
    classes: [],
    attributes: [],
    text: null,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    styles: [],
    reactComponents: [],
    vueComponents: [],
    textProps: [],
    dataValues: [],
    form: null,
    link: null,
  };
  const clip = (value, max) => {
    if (value === null || value === undefined) return '';
    return String(value).slice(0, max);
  };
  try {
    result.tag = typeof this.tagName === 'string' ? this.tagName.toLowerCase() : 'desconocido';
  } catch (error) { void error; }
  try {
    result.id = typeof this.id === 'string' && this.id !== '' ? this.id.slice(0, 80) : null;
  } catch (error) { void error; }
  try {
    const classes = this.classList;
    if (classes) {
      for (let index = 0; index < classes.length && index < 10; index += 1) {
        result.classes.push(clip(classes.item(index), 80));
      }
    }
  } catch (error) { void error; }
  try {
    const attributes = this.attributes;
    if (attributes) {
      for (let index = 0; index < attributes.length && result.attributes.length < 14; index += 1) {
        const attribute = attributes.item(index);
        if (!attribute) continue;
        const name = clip(attribute.name, 40);
        if (name === 'class' || name === 'style') continue;
        result.attributes.push({ name, value: clip(attribute.value, 160) });
      }
    }
  } catch (error) { void error; }
  try {
    const raw = this.innerText !== undefined ? this.innerText : this.textContent;
    if (typeof raw === 'string') {
      const clean = raw.replace(/\s+/g, ' ').trim();
      if (clean !== '') result.text = clean.slice(0, 160);
    }
  } catch (error) { void error; }
  try {
    const rect = this.getBoundingClientRect();
    result.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  } catch (error) { void error; }
  try {
    const computed = getComputedStyle(this);
    const names = [
      'display', 'position', 'width', 'height', 'margin', 'padding',
      'color', 'background-color', 'font-family', 'font-size', 'font-weight',
      'line-height', 'flex-direction', 'gap', 'grid-template-columns',
      'z-index', 'opacity', 'overflow-x', 'overflow-y', 'text-align', 'box-sizing',
    ];
    for (const name of names) {
      const value = computed.getPropertyValue(name);
      if (value !== '') result.styles.push({ name, value: clip(value, 120) });
    }
  } catch (error) { void error; }

  const targetText = result.text;
  const propHits = result.textProps;
  const dataValues = result.dataValues;
  const dataSeen = new Set();
  const noteDataValue = (component, framework, path, raw) => {
    if (dataValues.length >= 80) return;
    if (typeof raw !== 'string' && typeof raw !== 'number') return;
    if (typeof raw === 'number' && !isFinite(raw)) return;
    const value = String(raw).replace(/\s+/g, ' ').trim();
    if (value.length < 3 || value.length > 120) return;
    if (value === '[enmascarado]') return;
    const id = component + '|' + path + '|' + value;
    if (dataSeen.has(id)) return;
    dataSeen.add(id);
    dataValues.push({
      component: component.slice(0, 80),
      framework,
      path: path.slice(0, 120),
      value: value.slice(0, 120),
    });
  };
  const notePropHit = (component, framework, key, raw, partial) => {
    if (propHits.length >= 6) return;
    if (typeof raw !== 'string') return;
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (clean === '' || clean === '[enmascarado]') return;
    if (propHits.some((hit) => hit.component === component && hit.key === key && hit.value === clean)) return;
    propHits.push({
      component: component.slice(0, 80),
      framework,
      key: key.slice(0, 120),
      value: clean.slice(0, 160),
      partial,
    });
  };
  const isDomNode = (value) =>
    value !== null &&
    typeof value === 'object' &&
    typeof value.nodeType === 'number' &&
    typeof value.nodeName === 'string';
  const typeName = (type) => {
    if (type === null || type === undefined) return null;
    if (typeof type === 'function') return type.displayName || type.name || null;
    if (typeof type === 'string') return null;
    if (typeof type.displayName === 'string' && type.displayName !== '') return type.displayName;
    const inner = type.render !== undefined ? type.render : type.type;
    if (typeof inner === 'function') return inner.displayName || inner.name || null;
    return null;
  };
  let inspectedNodes = 0;
  const inspectPropValue = (component, framework, value, path, depth, seen) => {
    if (inspectedNodes >= 2000) return;
    inspectedNodes += 1;
    if ((propHits.length >= 6 && dataValues.length >= 80) || value === null || value === undefined) return;
    if (typeof value === 'string') {
      noteDataValue(component, framework, path, value);
      if (targetText === null || targetText.length < 2) return;
      const clean = value.replace(/\s+/g, ' ').trim();
      if (clean === targetText) {
        notePropHit(component, framework, path, value, false);
      } else if (targetText.length >= 8 && clean.indexOf(targetText) !== -1) {
        notePropHit(component, framework, path, value, true);
      } else if (clean.length >= 6 && targetText.indexOf(clean) !== -1) {
        notePropHit(component, framework, path, value, true);
      }
      return;
    }
    if (typeof value === 'number') {
      noteDataValue(component, framework, path, value);
      if (targetText === null || !isFinite(value)) return;
      const digits = String(Math.abs(value)).replace(/[^\d]/g, '');
      if (digits.length < 2) return;
      const tokens = targetText.match(/\d[\d.,\s]*\d|\d/g) || [];
      for (let index = 0; index < tokens.length; index += 1) {
        const tokenDigits = tokens[index].replace(/[^\d]/g, '');
        if (tokenDigits.length < 2) continue;
        if (Number(tokens[index].replace(/[,\s]/g, '')) === value) {
          notePropHit(component, framework, path, String(value), true);
          return;
        }
        const alternate = tokens[index].replace(/\./g, '').replace(/,/g, '.');
        if (Number(alternate) === value) {
          notePropHit(component, framework, path, String(value), true);
          return;
        }
      }
      return;
    }
    if (depth >= 3 || typeof value !== 'object' || value.$$typeof) return;
    if (isDomNode(value) || typeof value.then === 'function') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      const length = Math.min(value.length, 30);
      for (let index = 0; index < length; index += 1) {
        inspectPropValue(component, framework, value[index], path + '[' + index + ']', depth + 1, seen);
      }
      return;
    }
    let keys = [];
    try { keys = Object.keys(value); } catch (error) { return; }
    const length = Math.min(keys.length, 30);
    for (let index = 0; index < length; index += 1) {
      const key = keys[index];
      if (key === 'ref' || key === 'key' || key === 'children' || key === 'className' || key === 'style' || key === 'sx' || key === 'classes' || key === 'dangerouslySetInnerHTML') continue;
      if (key === 'theme' || key === 'slotProps' || key === 'components' || key === 'componentsProps' || key === 'ownerDocument' || key === 'document' || key === 'window') continue;
      if (key.indexOf('__react') === 0 || key.indexOf('__vue') === 0) continue;
      if (/password|token|secret|jwt|session|authorization|cookie|api_?key/i.test(key)) continue;
      let child;
      try { child = value[key]; } catch (error) { continue; }
      inspectPropValue(component, framework, child, path + '.' + key, depth + 1, seen);
    }
  };

  try {
    const keys = Object.keys(this);
    for (const key of keys) {
      if (key.indexOf('__reactFiber$') !== 0 && key.indexOf('__reactInternalInstance$') !== 0) continue;
      let fiber = this[key];
      for (let depth = 0; fiber && depth < 12; depth += 1) {
        const name = typeName(fiber.type);
        if (typeof name === 'string' && name !== '' && result.reactComponents.length < 10 && result.reactComponents.indexOf(name) === -1) {
          result.reactComponents.push(name.slice(0, 80));
        }
        const composite = typeof fiber.type !== 'string';
        if (composite) {
          const label = typeof name === 'string' && name !== '' ? name : 'componente';
          let props = null;
          try { props = fiber.memoizedProps || fiber.pendingProps; } catch (error) { props = null; }
          if (props && typeof props === 'object') {
            inspectPropValue(label, 'react', props, 'props', 0, new WeakSet());
          }
          let hook = null;
          try { hook = fiber.memoizedState; } catch (error) { hook = null; }
          if (hook && typeof hook === 'object' && typeof hook.memoizedState === 'undefined' && typeof hook.next === 'undefined') {
            inspectPropValue(label, 'react', hook, 'estado', 0, new WeakSet());
          } else {
            for (let hookIndex = 0; hook && hookIndex < 24 && dataValues.length < 80; hookIndex += 1) {
              let hookState;
              try { hookState = hook.memoizedState; } catch (error) { hookState = null; }
              if (hookState !== null && hookState !== undefined) {
                inspectPropValue(label, 'react', hookState, 'estado[' + hookIndex + ']', 0, new WeakSet());
              }
              try { hook = hook.next; } catch (error) { hook = null; }
            }
          }
        }
        try { fiber = fiber.return; } catch (error) { fiber = null; }
      }
      break;
    }
  } catch (error) { void error; }
  try {
    const keys = Object.keys(this);
    for (const key of keys) {
      if (key.indexOf('__vueParentComponent') !== 0) continue;
      let component = this[key];
      for (let depth = 0; component && depth < 12; depth += 1) {
        const type = component.type;
        let name = null;
        if (type) name = type.name || type.displayName || null;
        if (!name) name = component.__name || null;
        if (typeof name === 'string' && name !== '' && result.vueComponents.indexOf(name) === -1) {
          result.vueComponents.push(name.slice(0, 80));
        }
        const label = typeof name === 'string' && name !== '' ? name : 'componente';
        let props = null;
        try {
          props = component.props || (component.vnode && component.vnode.props);
        } catch (error) { props = null; }
        if (props) inspectPropValue(label, 'vue', props, 'props', 0, new WeakSet());
        let setupState = null;
        try { setupState = component.setupState; } catch (error) { setupState = null; }
        if (setupState && typeof setupState === 'object') {
          inspectPropValue(label, 'vue', setupState, 'estado', 0, new WeakSet());
        }
        let stateData = null;
        try { stateData = component.data || (component.proxy && component.proxy.$data); } catch (error) { stateData = null; }
        if (stateData && typeof stateData === 'object') {
          inspectPropValue(label, 'vue', stateData, 'datos', 0, new WeakSet());
        }
        component = component.parent;
      }
      break;
    }
  } catch (error) { void error; }
  try {
    const action = this.getAttribute('formaction');
    if (typeof action === 'string' && action !== '') {
      const method = this.getAttribute('formmethod');
      result.form = { action: action.slice(0, 300), method: clip(method || 'GET', 16).toUpperCase() };
    }
  } catch (error) { void error; }
  if (result.form === null) {
    try {
      let form = this.form;
      if (!form && typeof this.closest === 'function') form = this.closest('form');
      if (form) {
        result.form = {
          action: clip(form.getAttribute('action') || '', 300),
          method: clip(form.getAttribute('method') || 'GET', 16).toUpperCase(),
        };
      }
    } catch (error) { void error; }
  }
  try {
    if (typeof this.closest === 'function') {
      const link = this.closest('a[href]');
      if (link) {
        const href = link.getAttribute('href');
        if (typeof href === 'string' && href !== '') result.link = href.slice(0, 300);
      }
    }
  } catch (error) { void error; }
  return result;
}
`;

interface ScriptInfo {
  url: string;
  startLine: number;
  startColumn: number;
}

const NON_HANDLER_NAMES = new Set([
  'function',
  'async',
  'await',
  'return',
  'const',
  'let',
  'var',
  'new',
  'this',
  'window',
  'document',
  'handleEvent',
  'addEventListener',
]);

function wordAt(text: string, column: number): string | null {
  const isWord = (character: string | undefined): boolean =>
    character !== undefined && /[A-Za-z0-9_$]/.test(character);
  let index = Math.min(Math.max(column, 0), text.length);
  if (!isWord(text[index])) index -= 1;
  if (index < 0 || !isWord(text[index])) return null;
  let right = index;
  while (right + 1 < text.length && isWord(text[right + 1])) right += 1;
  let left = index;
  while (left > 0 && isWord(text[left - 1])) left -= 1;
  const word = text.slice(left, right + 1);
  return NON_HANDLER_NAMES.has(word) ? null : word;
}

interface EventListenerEntry {
  type: string;
  useCapture: boolean;
  passive: boolean;
  once: boolean;
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
  handler?: {
    description?: string;
    objectId?: string;
  };
}

interface HintValue {
  kind: 'react' | 'vue' | null;
  name: string | null;
  source: string | null;
}

function hintHandler(eventType: 'click' | 'submit', hint: HintValue): InspectionHandler {
  const kind = hint.kind as HandlerSource;
  return {
    event: eventType,
    name: hint.name,
    url: null,
    line: null,
    column: null,
    source: kind,
    note: null,
    code:
      hint.source === null
        ? null
        : functionCodeBlock(hint.source, kind === 'react' ? '(React)' : '(Vue)'),
  };
}

function parseHintValue(value: unknown): HintValue | null {
  const record = asRecord(value);
  if (record === null) return null;
  const kind = record.kind === 'react' || record.kind === 'vue' ? record.kind : null;
  return {
    kind,
    name: cleanString(record.name, 120),
    source: cleanString(record.source, MAX_HANDLER_SOURCE),
  };
}

export interface InspectorClickSignal {
  kind: 'click' | 'submit';
  x: number;
  y: number;
  docX: number;
  docY: number;
  contextId: number | null;
  at: number;
  ref: PageElementRef | null;
  submitter: PageElementRef | null;
  element: InspectionElement;
}

export interface InspectorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InspectorHoverSignal {
  kind: 'hover';
  x: number;
  y: number;
  docX: number;
  docY: number;
  contextId: number | null;
  rect: InspectorRect | null;
  ref: PageElementRef | null;
  element: InspectionElement;
}

export interface InspectorInteractionSignal {
  kind: 'interaction';
  event: FlowInteractionEvent;
  at: number;
  ref: PageElementRef;
}

export interface InspectorDomChangedSignal {
  kind: 'dom-changed';
}

export type InspectorSignal =
  | InspectorClickSignal
  | InspectorHoverSignal
  | InspectorInteractionSignal
  | InspectorDomChangedSignal
  | { kind: 'hover-end' }
  | { kind: 'escape' };

export interface HoverTextProp {
  component: string;
  framework: 'react' | 'vue';
  key: string;
  value: string;
  partial: boolean;
}

export interface HoverDataValue {
  component: string;
  framework: 'react' | 'vue';
  path: string;
  value: string;
}

export interface HoverElementInfo {
  tag: string;
  id: string | null;
  classes: string[];
  attributes: Array<{ name: string; value: string }>;
  text: string | null;
  rect: InspectorRect;
  styles: Array<{ name: string; value: string }>;
  reactComponents: string[];
  vueComponents: string[];
  textProps: HoverTextProp[];
  dataValues: HoverDataValue[];
  form: { action: string; method: string } | null;
  link: string | null;
  ref: PageElementRef | null;
  runtime: RuntimeProvenance | null;
}

export interface HoverResolution {
  element: HoverElementInfo;
  handler: InspectionHandler | null;
  handlerEvent: 'click' | 'submit' | null;
  listeners: string[];
}

export type HoverTipTone = 'normal' | 'ok' | 'warn' | 'dim';

export interface HoverTipRow {
  label: string;
  value: string;
  tone?: HoverTipTone;
}

export interface HoverTipCode {
  file: string;
  range: string;
  lines: Array<{ line: number; text: string }>;
}

export interface HoverTipData {
  mode: InspectionMode;
  modeLabel: string;
  title: string;
  subtitle: string | null;
  rows: HoverTipRow[];
  code: HoverTipCode | null;
  footer: string | null;
  x: number;
  y: number;
  rect: InspectorRect | null;
}

interface RawRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): RawRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseRect(value: unknown): InspectorRect | null {
  const record = asRecord(value);
  if (record === null) return null;
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  const width = finiteNumber(record.width);
  const height = finiteNumber(record.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < 0 || height < 0) return null;
  if (Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) return null;
  if (width > 1_000_000 || height > 1_000_000) return null;
  return { x, y, width, height };
}

function parseHoverElement(value: unknown): HoverElementInfo | null {
  const record = asRecord(value);
  if (record === null) return null;
  const tag = cleanString(record.tag, 32);
  if (tag === null) return null;

  const classes: string[] = [];
  for (const item of asArray(record.classes)) {
    const name = cleanString(item, 80);
    if (name !== null && !classes.includes(name)) classes.push(name);
    if (classes.length >= 10) break;
  }

  const attributes: Array<{ name: string; value: string }> = [];
  for (const item of asArray(record.attributes)) {
    const attribute = asRecord(item);
    if (attribute === null) continue;
    const name = cleanString(attribute.name, 40);
    if (name === null || attributes.some((entry) => entry.name === name)) continue;
    const value = typeof attribute.value === 'string' ? attribute.value.slice(0, 160) : '';
    attributes.push({ name, value });
    if (attributes.length >= 14) break;
  }

  const styles: Array<{ name: string; value: string }> = [];
  for (const item of asArray(record.styles)) {
    const style = asRecord(item);
    if (style === null) continue;
    const name = cleanString(style.name, 40);
    const styleValue = typeof style.value === 'string' ? style.value.slice(0, 120) : '';
    if (name === null || styleValue === '') continue;
    styles.push({ name, value: styleValue });
    if (styles.length >= 24) break;
  }

  const cleanList = (input: unknown, max: number): string[] => {
    const result: string[] = [];
    for (const item of asArray(input)) {
      const name = cleanString(item, 80);
      if (name !== null && !result.includes(name)) result.push(name);
      if (result.length >= max) break;
    }
    return result;
  };

  const formRecord = asRecord(record.form);
  let form: HoverElementInfo['form'] = null;
  if (formRecord !== null) {
    const action = typeof formRecord.action === 'string' ? formRecord.action.slice(0, 300) : '';
    const method = cleanString(formRecord.method, 16)?.toUpperCase() ?? 'GET';
    if (action !== '') form = { action, method };
  }

  const textProps: HoverTextProp[] = [];
  for (const item of asArray(record.textProps)) {
    const prop = asRecord(item);
    if (prop === null) continue;
    const component = cleanString(prop.component, 80);
    const key = cleanString(prop.key, 120);
    const value = typeof prop.value === 'string' ? prop.value.slice(0, 160) : '';
    const framework =
      prop.framework === 'vue' ? 'vue' : prop.framework === 'react' ? 'react' : null;
    if (component === null || key === null || value === '' || framework === null) continue;
    if (
      textProps.some(
        (entry) => entry.component === component && entry.key === key && entry.value === value,
      )
    ) {
      continue;
    }
    textProps.push({ component, framework, key, value, partial: prop.partial === true });
    if (textProps.length >= 6) break;
  }

  const dataValues: HoverDataValue[] = [];
  for (const item of asArray(record.dataValues)) {
    const entry = asRecord(item);
    if (entry === null) continue;
    const component = cleanString(entry.component, 80);
    const value = typeof entry.value === 'string' ? entry.value.trim().slice(0, 120) : '';
    const dataPath = cleanString(entry.path, 120);
    const framework =
      entry.framework === 'vue' ? 'vue' : entry.framework === 'react' ? 'react' : null;
    if (component === null || dataPath === null || value === '' || framework === null) continue;
    if (dataValues.some((existing) => existing.value === value && existing.path === dataPath)) {
      continue;
    }
    dataValues.push({ component, framework, path: dataPath, value });
    if (dataValues.length >= 80) break;
  }

  return {
    tag: tag.toLowerCase(),
    id: cleanString(record.id, 80),
    classes,
    attributes,
    text: cleanString(record.text, 160),
    rect: parseRect(record.rect) ?? { x: 0, y: 0, width: 0, height: 0 },
    styles,
    reactComponents: cleanList(record.reactComponents, 10),
    vueComponents: cleanList(record.vueComponents, 10),
    textProps,
    dataValues,
    form,
    link: cleanString(record.link, 300),
    ref: null,
    runtime: null,
  };
}

function documentCoordinate(value: unknown, fallback: number): number {
  const parsed = finiteNumber(value);
  if (parsed === null || Math.abs(parsed) > 10_000_000) return fallback;
  return parsed;
}

function parseSignal(raw: string, contextId: number | null): InspectorSignal | null {
  if (raw.length === 0 || raw.length > MAX_SIGNAL_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(data);
  if (record === null) return null;
  if (record.kind === 'escape') {
    return { kind: 'escape' };
  }
  if (record.kind === 'hover-end') {
    return { kind: 'hover-end' };
  }
  if (record.kind === 'dom-changed') {
    return { kind: 'dom-changed' };
  }
  if (record.kind === 'interaction') {
    if (!isFlowInteractionEvent(record.event)) return null;
    const ref = parseElementRef(record.ref);
    if (ref === null) return null;
    const at = finiteNumber(record.at);
    return {
      kind: 'interaction',
      event: record.event,
      at: at === null ? Date.now() : at,
      ref,
    };
  }
  if (record.kind !== 'click' && record.kind !== 'submit' && record.kind !== 'hover') {
    return null;
  }
  const x = typeof record.x === 'number' && Number.isFinite(record.x) ? record.x : null;
  const y = typeof record.y === 'number' && Number.isFinite(record.y) ? record.y : null;
  if (x === null || y === null || Math.abs(x) > 30000 || Math.abs(y) > 30000) return null;
  const docX = documentCoordinate(record.docX, x);
  const docY = documentCoordinate(record.docY, y);
  const element = asRecord(record.element);
  const tag = element === null ? null : cleanString(element.tag, 32);
  if (element === null || tag === null) return null;
  const ref = parseElementRef(record.ref);
  const parsedElement: InspectionElement = {
    tag: tag.toLowerCase(),
    text: cleanString(element.text, 120),
    role: cleanString(element.role, 64),
    ariaLabel: cleanString(element.ariaLabel, 128),
    inputType: cleanString(element.inputType, 32),
    submitLike: element.submitLike === true,
  };
  if (record.kind === 'hover') {
    return {
      kind: 'hover',
      x: Math.round(x),
      y: Math.round(y),
      docX: Math.round(docX),
      docY: Math.round(docY),
      contextId,
      rect: parseRect(record.rect),
      ref: parseElementRef(record.ref),
      element: parsedElement,
    };
  }
  if (ref !== null) {
    parsedElement.key = ref.key;
    parsedElement.selector = ref.selector;
    parsedElement.kind = ref.kind;
    parsedElement.href = ref.href;
    parsedElement.formAction = ref.formAction;
    parsedElement.formMethod = ref.formMethod;
    parsedElement.formKey = ref.formKey;
  }
  const at = finiteNumber(record.at);
  return {
    kind: record.kind,
    x: Math.round(x),
    y: Math.round(y),
    docX: Math.round(docX),
    docY: Math.round(docY),
    contextId,
    at: at === null ? Date.now() : at,
    ref,
    submitter: record.kind === 'submit' ? parseElementRef(record.submitter) : null,
    element: parsedElement,
  };
}

function nameFromDescription(description: string | undefined): string | null {
  if (description === undefined) return null;
  const declaration = /^(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/.exec(description);
  if (declaration !== null) return declaration[1] ?? null;
  const chromium = /^ƒ\s*([\w$]+)\s*\(/.exec(description);
  if (chromium !== null) return chromium[1] ?? null;
  return null;
}

function isSubmitLike(element: InspectionElement): boolean {
  if (element.submitLike === true) return true;
  if (element.tag === 'form' || element.tag === 'button') return true;
  return element.inputType === 'submit' || element.inputType === 'image';
}

function isInternalUrl(url: string): boolean {
  if (url === '') return false;
  return (
    url.startsWith('chrome-extension://') ||
    url.startsWith('devtools://') ||
    url.startsWith('extensions::') ||
    url.includes('react-dom')
  );
}

function clipLine(text: string): string {
  const expanded = text.replace(/\t/g, '  ');
  return expanded.length > 400 ? expanded.slice(0, 400) : expanded;
}

function codeBlockFromWindow(
  source: string,
  file: string,
  firstLine: number,
  focusLine: number,
): InspectionCodeBlock {
  const all = source.replace(/\r\n/g, '\n').split('\n');
  const focusIndex = Math.max(0, Math.min(all.length - 1, focusLine - firstLine));
  const start = Math.max(0, focusIndex - HANDLER_CONTEXT_LINES);
  const end = Math.min(all.length, start + MAX_HANDLER_LINES);
  const lines = all.slice(start, end).map((text, index) => ({
    line: firstLine + start + index,
    text: clipLine(text),
  }));
  return {
    file,
    startLine: firstLine + start,
    endLine: firstLine + start + Math.max(lines.length, 1) - 1,
    lines,
    truncated: start > 0 || end < all.length,
    note: null,
  };
}

function functionCodeBlock(source: string, file: string): InspectionCodeBlock {
  return codeBlockFromWindow(source, file, 1, 1);
}

function listenerCodeBlock(
  source: string,
  candidate: EventListenerEntry,
  script: ScriptInfo | undefined,
): InspectionCodeBlock {
  const firstLine = (script?.startLine ?? 0) + 1;
  const file = script !== undefined && script.url !== '' ? script.url : '(script en línea)';
  return codeBlockFromWindow(source, file, firstLine, firstLine + candidate.lineNumber);
}

function nameFromSource(
  source: string,
  candidate: EventListenerEntry,
  script: ScriptInfo | undefined,
): string | null {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const text = lines[candidate.lineNumber] ?? '';
  const column =
    candidate.lineNumber === 0
      ? Math.max(0, candidate.columnNumber - (script?.startColumn ?? 0))
      : candidate.columnNumber;
  return wordAt(text, column);
}

export class ClickInspector {
  private target: CdpDebugger | null = null;
  private enabled = true;
  private installed = false;
  private worldSequence = 0;
  private nodeGroupSequence = 0;
  private readonly scriptInfos = new Map<string, ScriptInfo>();
  private readonly scriptSources = new Map<string, string>();
  private readonly sourceMaps = new Map<string, InlineSourceMap | null>();
  private readonly worldContexts = new Set<number>();
  private readonly mainContexts = new Map<string, number>();
  private primaryContextId: number | null = null;
  private runtimeScriptId: string | null = null;

  constructor(
    private readonly onSignal: (signal: InspectorSignal) => void,
    private readonly log: Logger,
  ) {}

  async install(target: CdpDebugger): Promise<void> {
    this.target = target;
    try {
      await target.sendCommand('Runtime.enable');
      await target.sendCommand('Page.enable');
      await target.sendCommand('DOM.enable');
      await this.installRuntimeHooks(target);
      this.installed = true;
      this.log.debug('Inspector de clics instalado');
    } catch (error) {
      this.installed = false;
      this.log.warn('No se pudo instalar el inspector de clics', {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async installRuntimeHooks(target: CdpDebugger): Promise<void> {
    try {
      const added = (await target.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: RUNTIME_NETWORK_SOURCE,
        runImmediately: true,
      })) as { identifier?: string };
      this.runtimeScriptId = typeof added.identifier === 'string' ? added.identifier : null;
    } catch (error) {
      this.runtimeScriptId = null;
      this.log.debug('No se pudo instalar el enlace de red en el mundo principal', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await target.sendCommand('Runtime.evaluate', {
        expression: RUNTIME_NETWORK_SOURCE,
        silent: true,
      });
    } catch (error) {
      this.log.debug('No se pudo activar el enlace de red en el documento actual', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureWorld(frameId: string): Promise<void> {
    const target = this.target;
    if (target === null || !this.installed) return;
    const sequence = ++this.worldSequence;
    try {
      const created = (await target.sendCommand('Page.createIsolatedWorld', {
        frameId,
        worldName: WORLD_NAME,
        grantUniveralAccess: false,
      })) as { executionContextId?: number };
      if (sequence !== this.worldSequence) return;
      const contextId = created.executionContextId;
      if (typeof contextId !== 'number') return;
      this.worldContexts.add(contextId);
      await target.sendCommand('Runtime.addBinding', {
        name: BINDING_NAME,
        executionContextId: contextId,
      });
      const expression = `globalThis.__BDT_INSPECT_ENABLED__ = ${
        this.enabled ? 'true' : 'false'
      };\n${LISTENER_SOURCE}`;
      await target.sendCommand('Runtime.evaluate', {
        expression,
        contextId,
        silent: true,
      });
      this.primaryContextId = contextId;
    } catch (error) {
      if (sequence !== this.worldSequence) return;
      this.log.debug('No se pudo preparar el mundo aislado del inspector', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!this.installed) return;
    const expression = enabled
      ? 'globalThis.__BDT_INSPECT_ENABLED__ = true;'
      : 'globalThis.__BDT_INSPECT_ENABLED__ = false; if (globalThis.__bdtHoverClear) globalThis.__bdtHoverClear();';
    void this.evaluateInWorlds(expression);
  }

  handleMessage(method: string, params: unknown): void {
    switch (method) {
      case 'Debugger.scriptParsed': {
        const record = asRecord(params);
        if (record === null) return;
        const scriptId = typeof record.scriptId === 'string' ? record.scriptId : null;
        if (scriptId === null) return;
        if (this.scriptInfos.size > 4000) {
          this.scriptInfos.clear();
        }
        this.scriptInfos.set(scriptId, {
          url: typeof record.url === 'string' ? record.url : '',
          startLine: typeof record.startLine === 'number' ? record.startLine : 0,
          startColumn: typeof record.startColumn === 'number' ? record.startColumn : 0,
        });
        break;
      }
      case 'Runtime.executionContextCreated': {
        const record = asRecord(params);
        const context = record === null ? null : asRecord(record.context);
        if (context === null) return;
        const auxData = asRecord(context.auxData);
        const frameId =
          auxData !== null && typeof auxData.frameId === 'string' ? auxData.frameId : null;
        const mainId = typeof context.id === 'number' ? context.id : null;
        if (auxData !== null && auxData.isDefault === true && frameId !== null && mainId !== null) {
          this.mainContexts.set(frameId, mainId);
        }
        if (context.name !== WORLD_NAME) return;
        const id = typeof context.id === 'number' ? context.id : null;
        if (id === null) return;
        this.worldContexts.add(id);
        if (!this.enabled) {
          void this.evaluateInWorlds('globalThis.__BDT_INSPECT_ENABLED__ = false;', new Set([id]));
        }
        break;
      }
      case 'Runtime.executionContextDestroyed': {
        const record = asRecord(params);
        const id =
          record !== null && typeof record.executionContextId === 'number'
            ? record.executionContextId
            : null;
        if (id !== null) {
          this.worldContexts.delete(id);
          for (const [frameId, contextId] of this.mainContexts) {
            if (contextId === id) this.mainContexts.delete(frameId);
          }
          if (this.primaryContextId === id) this.primaryContextId = null;
        }
        break;
      }
      case 'Runtime.executionContextsCleared':
        this.worldContexts.clear();
        this.mainContexts.clear();
        this.primaryContextId = null;
        break;
      case 'Page.frameNavigated': {
        const record = asRecord(params);
        const frame = record === null ? null : asRecord(record.frame);
        if (frame === null || frame.parentId !== undefined) return;
        const frameId = typeof frame.id === 'string' ? frame.id : null;
        if (frameId !== null) {
          void this.ensureWorld(frameId);
        }
        break;
      }
      case 'Runtime.bindingCalled': {
        const record = asRecord(params);
        if (record === null || record.name !== BINDING_NAME) return;
        this.log.debug('Señal del inspector recibida');
        if (typeof record.payload !== 'string') return;
        const contextId =
          typeof record.executionContextId === 'number' ? record.executionContextId : null;
        const signal = parseSignal(record.payload, contextId);
        if (signal !== null) this.onSignal(signal);
        break;
      }
      default:
        break;
    }
  }

  async resolveHandler(signal: InspectorClickSignal): Promise<InspectionHandler | null> {
    const target = this.target;
    if (target === null || !this.installed) return null;
    const nodes = await this.nodesAt(target, signal, '__bdtClickTarget');
    if (nodes === null) return null;
    try {
      if (nodes.ids.length === 0) return null;
      const primary = await this.findHandler(target, nodes.ids, signal.kind);
      if (primary !== null) return primary;
      if (signal.kind === 'click' && isSubmitLike(signal.element)) {
        return this.findHandler(target, nodes.ids, 'submit');
      }
      return null;
    } finally {
      await this.releaseGroup(target, nodes.group);
    }
  }

  async resolveHover(
    signal: InspectorHoverSignal,
    withHandler: boolean,
  ): Promise<HoverResolution | null> {
    const target = this.target;
    if (target === null || !this.installed) return null;
    const nodes = await this.nodesAt(target, signal, '__bdtHoverTarget');
    if (nodes === null) return null;
    try {
      const primary = nodes.ids[0];
      if (primary === undefined) return null;
      const info = await this.elementInfo(target, primary);
      if (info === null) return null;
      info.ref = signal.ref;
      if (!withHandler) {
        return { element: info, handler: null, handlerEvent: null, listeners: [] };
      }
      info.runtime = await this.runtimeProvenance(target, primary, nodes.group);

      let listeners: string[] = [];
      let entries: EventListenerEntry[] = [];
      try {
        entries = await this.listenersAt(target, primary);
        listeners = [...new Set(entries.map((entry) => entry.type))];
      } catch (error) {
        this.log.debug('No se pudieron leer los eventos del elemento', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await this.releaseListenerHandlers(target, entries);

      let handler: InspectionHandler | null = null;
      let handlerEvent: 'click' | 'submit' | null = null;
      try {
        handler = await this.findHandler(target, nodes.ids, 'click');
        handlerEvent = handler === null ? null : 'click';
        if (handler === null && isSubmitLike(signal.element)) {
          handler = await this.findHandler(target, nodes.ids, 'submit');
          if (handler !== null) handlerEvent = 'submit';
        }
      } catch (error) {
        this.log.debug('No se pudo resolver el manejador al pasar el mouse', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return { element: info, handler, handlerEvent, listeners };
    } finally {
      await this.releaseGroup(target, nodes.group);
    }
  }

  async resolveRef(ref: PageElementRef, withHandler: boolean): Promise<HoverResolution | null> {
    const target = this.target;
    if (target === null || !this.installed || !this.enabled) return null;
    const contextId = this.tooltipContext();
    if (contextId === null) return null;
    const group = `bdt-ref-${String(++this.nodeGroupSequence)}`;
    try {
      const evaluated = (await target.sendCommand('Runtime.evaluate', {
        expression: `globalThis.__bdtResolveRef ? globalThis.__bdtResolveRef(${JSON.stringify(
          ref.key,
        )}, ${JSON.stringify(ref.selector)}) : null`,
        contextId,
        objectGroup: group,
        silent: true,
      })) as { result?: { objectId?: string } };
      const primary = evaluated.result?.objectId;
      if (primary === undefined) return null;

      const ids: string[] = [primary];
      try {
        const described = (await target.sendCommand('DOM.describeNode', {
          objectId: primary,
        })) as { node?: { backendNodeId?: number; frameId?: string } };
        const backendNodeId = described.node?.backendNodeId;
        if (typeof backendNodeId === 'number') {
          const frameId = described.node?.frameId;
          const mainContextId = frameId === undefined ? undefined : this.mainContexts.get(frameId);
          const resolvedMain = (await target.sendCommand('DOM.resolveNode', {
            backendNodeId,
            objectGroup: group,
            ...(mainContextId === undefined ? {} : { executionContextId: mainContextId }),
          })) as { object?: { objectId?: string } };
          const mainObjectId = resolvedMain.object?.objectId;
          if (mainObjectId !== undefined) ids.unshift(mainObjectId);
        }
      } catch (error) {
        this.log.debug('No se pudo resolver el elemento indexado en el mundo principal', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        const ancestors = (await target.sendCommand('Runtime.callFunctionOn', {
          objectId: primary,
          functionDeclaration: ANCESTORS_FUNCTION,
          returnByValue: false,
          objectGroup: group,
        })) as { result?: { objectId?: string } };
        const arrayId = ancestors.result?.objectId;
        if (arrayId !== undefined) {
          const properties = (await target.sendCommand('Runtime.getProperties', {
            objectId: arrayId,
            ownProperties: true,
          })) as { result?: Array<{ name: string; value?: { objectId?: string } }> };
          const entries = (properties.result ?? [])
            .filter((entry) => /^\d+$/.test(entry.name))
            .sort((left, right) => Number(left.name) - Number(right.name));
          for (const entry of entries) {
            const id = entry.value?.objectId;
            if (id !== undefined) ids.push(id);
          }
        }
      } catch (error) {
        this.log.debug('No se pudieron leer los ancestros del elemento indexado', {
          message: error instanceof Error ? error.message : String(error),
        });
      }

      const info = await this.elementInfo(target, primary);
      if (info === null) return null;
      info.ref = ref;
      if (!withHandler) {
        return { element: info, handler: null, handlerEvent: null, listeners: [] };
      }
      info.runtime = await this.runtimeProvenance(target, primary, group);
      let handler: InspectionHandler | null = null;
      let handlerEvent: 'click' | 'submit' | null = null;
      try {
        handler = await this.findHandler(target, ids, 'click');
        handlerEvent = handler === null ? null : 'click';
        if (handler === null && isSubmitLike(ref)) {
          handler = await this.findHandler(target, ids, 'submit');
          if (handler !== null) handlerEvent = 'submit';
        }
      } catch (error) {
        this.log.debug('No se pudo resolver el manejador del elemento indexado', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return { element: info, handler, handlerEvent, listeners: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(CANCELLED_ERROR)) {
        this.log.debug('No se pudo resolver el elemento indexado', { message });
      }
      return null;
    } finally {
      await this.releaseGroup(target, group);
    }
  }

  showTooltip(tip: HoverTipData): void {
    if (!this.enabled) return;
    const target = this.target;
    const contextId = this.tooltipContext();
    if (target === null || contextId === null) return;
    const expression = `if (globalThis.__bdtShowTip) { globalThis.__bdtShowTip(${JSON.stringify(tip)}); }`;
    void target
      .sendCommand('Runtime.evaluate', { expression, contextId, silent: true })
      .catch((error: unknown) => {
        this.log.debug('No se pudo mostrar la información del elemento', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  hideTooltip(): void {
    const target = this.target;
    const contextId = this.tooltipContext();
    if (target === null || contextId === null) return;
    void target
      .sendCommand('Runtime.evaluate', {
        expression: 'if (globalThis.__bdtHideTip) globalThis.__bdtHideTip();',
        contextId,
        silent: true,
      })
      .catch(() => undefined);
  }

  highlightRef(key: string | null, selector: string): void {
    const target = this.target;
    const contextId = this.tooltipContext();
    if (target === null || contextId === null) return;
    const expression = `if (globalThis.__bdtMapHighlight) { globalThis.__bdtMapHighlight(${JSON.stringify(
      key,
    )}, ${JSON.stringify(selector)}, 2600); }`;
    void target
      .sendCommand('Runtime.evaluate', { expression, contextId, silent: true })
      .catch((error: unknown) => {
        this.log.debug('No se pudo resaltar en la página el elemento elegido en el mapa', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  refreshHover(): void {
    if (!this.enabled) return;
    const target = this.target;
    const contextId = this.tooltipContext();
    if (target === null || contextId === null) return;
    void target
      .sendCommand('Runtime.evaluate', {
        expression: 'if (globalThis.__bdtHoverRefresh) globalThis.__bdtHoverRefresh();',
        contextId,
        silent: true,
      })
      .catch(() => undefined);
  }

  private tooltipContext(): number | null {
    if (this.primaryContextId !== null && this.worldContexts.has(this.primaryContextId)) {
      return this.primaryContextId;
    }
    let last: number | null = null;
    for (const id of this.worldContexts) {
      last = id;
    }
    return last;
  }

  private async elementInfo(
    target: CdpDebugger,
    objectId: string,
  ): Promise<HoverElementInfo | null> {
    try {
      const response = (await target.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: ELEMENT_INFO_FUNCTION,
        returnByValue: true,
        silent: true,
      })) as { result?: { value?: unknown } };
      return parseHoverElement(response.result?.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(CANCELLED_ERROR)) {
        this.log.debug('No se pudo leer la información del elemento', { message });
      }
      return null;
    }
  }

  private async runtimeProvenance(
    target: CdpDebugger,
    objectId: string,
    group: string,
  ): Promise<RuntimeProvenance | null> {
    try {
      const described = (await target.sendCommand('DOM.describeNode', { objectId })) as {
        node?: { backendNodeId?: number; frameId?: string };
      };
      const backendNodeId = described.node?.backendNodeId;
      if (typeof backendNodeId !== 'number') return null;
      const frameId = described.node?.frameId;
      const mainContextId = frameId === undefined ? undefined : this.mainContexts.get(frameId);
      const resolved = (await target.sendCommand('DOM.resolveNode', {
        backendNodeId,
        objectGroup: group,
        ...(mainContextId === undefined ? {} : { executionContextId: mainContextId }),
      })) as { object?: { objectId?: string } };
      const mainObjectId = resolved.object?.objectId;
      if (mainObjectId === undefined) return null;
      const response = (await target.sendCommand('Runtime.callFunctionOn', {
        objectId: mainObjectId,
        functionDeclaration: RUNTIME_PROVENANCE_CALL,
        returnByValue: true,
        silent: true,
      })) as { result?: { value?: unknown } };
      const runtime = parseRuntimeProvenance(response.result?.value);
      if (runtime === null) return null;
      await this.mapRuntimeSources(target, runtime);
      return runtime;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(CANCELLED_ERROR)) {
        this.log.debug('No se pudo leer la procedencia en tiempo de ejecución', { message });
      }
      return null;
    }
  }

  private async mapRuntimeSources(target: CdpDebugger, runtime: RuntimeProvenance): Promise<void> {
    if (runtime.framework !== 'react') return;
    const entries: RuntimeRenderInfo[] = [];
    if (runtime.render?.origin === 'stack') entries.push(runtime.render);
    for (const source of runtime.renderSources) {
      if (source.origin === 'stack') entries.push(source);
    }
    if (entries.length === 0) return;
    const mapped = new Map<string, RuntimeRenderInfo | null>();
    const keyOf = (entry: RuntimeRenderInfo): string =>
      `${entry.file ?? ''}\u0000${String(entry.line ?? '')}\u0000${String(entry.column ?? '')}`;
    for (const entry of entries) {
      const key = keyOf(entry);
      if (mapped.has(key)) continue;
      mapped.set(key, await this.mapRuntimeSource(target, entry));
    }
    const lookup = (entry: RuntimeRenderInfo): RuntimeRenderInfo | null =>
      mapped.get(keyOf(entry)) ?? null;
    const fallback =
      runtime.renderSources
        .map((entry) => (entry.origin === 'stack' ? lookup(entry) : entry))
        .find((entry) => entry !== null) ?? null;
    if (runtime.render !== null && runtime.render.origin === 'stack') {
      runtime.render = lookup(runtime.render) ?? fallback;
    }
    const sources: RuntimeRenderInfo[] = [];
    const seen = new Set<string>();
    for (const source of runtime.renderSources) {
      const value = source.origin === 'stack' ? lookup(source) : source;
      if (value === null) continue;
      const key = keyOf(value);
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(value);
    }
    runtime.renderSources = sources;
  }

  private async mapRuntimeSource(
    target: CdpDebugger,
    entry: RuntimeRenderInfo,
  ): Promise<RuntimeRenderInfo | null> {
    if (entry.file === null || entry.line === null) return null;
    const script = this.findScriptByUrl(entry.file);
    if (script === null) return null;
    let map = this.sourceMaps.get(script.scriptId);
    if (map === undefined) {
      const source = await this.scriptSource(target, script.scriptId);
      map = source === null ? null : parseInlineSourceMap(source, script.url || entry.file);
      if (this.sourceMaps.size >= 32) this.sourceMaps.clear();
      this.sourceMaps.set(script.scriptId, map);
    }
    if (map === null) return null;
    const location = mapGeneratedLocation(map, entry.line - script.startLine, entry.column ?? 1);
    if (location === null) return null;
    return {
      component: entry.component,
      file: location.file,
      line: location.line,
      column: location.column,
      origin: 'stack',
      code: location.code,
    };
  }

  private findScriptByUrl(url: string): (ScriptInfo & { scriptId: string }) | null {
    const target = url.split('?')[0]?.split('#')[0] ?? url;
    let found: (ScriptInfo & { scriptId: string }) | null = null;
    for (const [scriptId, script] of this.scriptInfos) {
      if (script.url === '') continue;
      const candidate = script.url.split('?')[0]?.split('#')[0] ?? script.url;
      if (candidate !== target) continue;
      found = { scriptId, ...script };
    }
    return found;
  }

  dispose(): void {
    this.worldSequence += 1;
    const target = this.target;
    const scriptId = this.runtimeScriptId;
    this.runtimeScriptId = null;
    if (target !== null && scriptId !== null) {
      try {
        if (target.isAttached()) {
          void target
            .sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId })
            .catch(() => undefined);
        }
      } catch {
        // The debugger is already gone.
      }
    }
    this.target = null;
    this.installed = false;
    this.primaryContextId = null;
    this.worldContexts.clear();
    this.mainContexts.clear();
    this.scriptInfos.clear();
    this.scriptSources.clear();
    this.sourceMaps.clear();
  }

  private async evaluateInWorlds(
    expression: string,
    contexts: ReadonlySet<number> = this.worldContexts,
  ): Promise<void> {
    const target = this.target;
    if (target === null) return;
    for (const contextId of contexts) {
      try {
        await target.sendCommand('Runtime.evaluate', { expression, contextId, silent: true });
      } catch {
        this.worldContexts.delete(contextId);
      }
    }
  }

  private async nodesAt(
    target: CdpDebugger,
    signal: InspectorClickSignal | InspectorHoverSignal,
    property: '__bdtHoverTarget' | '__bdtClickTarget',
  ): Promise<{ ids: string[]; group: string } | null> {
    const group = `bdt-inspect-${String(++this.nodeGroupSequence)}`;
    try {
      const objectId =
        (await this.pageTargetObject(target, signal.contextId, property, group)) ??
        (await this.pointObject(target, signal.docX, signal.docY, group));
      if (objectId === null) {
        await this.releaseGroup(target, group);
        return null;
      }
      const ancestors = (await target.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: ANCESTORS_FUNCTION,
        returnByValue: false,
        objectGroup: group,
      })) as { result?: { objectId?: string } };
      const arrayId = ancestors.result?.objectId;
      if (arrayId === undefined) {
        await this.releaseGroup(target, group);
        return null;
      }
      const properties = (await target.sendCommand('Runtime.getProperties', {
        objectId: arrayId,
        ownProperties: true,
      })) as {
        result?: Array<{ name: string; value?: { objectId?: string } }>;
      };
      const entries = (properties.result ?? [])
        .filter((entry) => /^\d+$/.test(entry.name))
        .sort((left, right) => Number(left.name) - Number(right.name));
      const ids: string[] = [];
      for (const entry of entries) {
        const id = entry.value?.objectId;
        if (id !== undefined) ids.push(id);
      }
      return { ids, group };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(CANCELLED_ERROR)) {
        this.log.debug('No se pudo resolver el elemento bajo el puntero', { message });
      }
      await this.releaseGroup(target, group);
      return null;
    }
  }

  private async pageTargetObject(
    target: CdpDebugger,
    contextId: number | null,
    property: '__bdtHoverTarget' | '__bdtClickTarget',
    group: string,
  ): Promise<string | null> {
    if (contextId === null) return null;
    try {
      const response = (await target.sendCommand('Runtime.evaluate', {
        expression: `globalThis.${property} || null`,
        contextId,
        objectGroup: group,
        silent: true,
      })) as { result?: { objectId?: string } };
      return response.result?.objectId ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(CANCELLED_ERROR)) {
        this.log.debug('No se pudo leer el elemento señalado por la página', {
          message,
          property,
        });
      }
      return null;
    }
  }

  private async pointObject(
    target: CdpDebugger,
    x: number,
    y: number,
    group: string,
  ): Promise<string | null> {
    const location = (await target.sendCommand('DOM.getNodeForLocation', {
      x,
      y,
      ignorePointerEventsNone: true,
    })) as { backendNodeId?: number };
    if (typeof location.backendNodeId !== 'number') return null;
    const resolved = (await target.sendCommand('DOM.resolveNode', {
      backendNodeId: location.backendNodeId,
      objectGroup: group,
    })) as { object?: { objectId?: string } };
    return resolved.object?.objectId ?? null;
  }

  private async releaseGroup(target: CdpDebugger, group: string): Promise<void> {
    try {
      await target.sendCommand('Runtime.releaseObjectGroup', { objectGroup: group });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(CANCELLED_ERROR)) {
        this.log.debug('No se pudo liberar el grupo de objetos del inspector', { message });
      }
    }
  }

  private async releaseListenerHandlers(
    target: CdpDebugger,
    entries: readonly EventListenerEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      const objectId = entry.handler?.objectId;
      if (objectId === undefined) continue;
      try {
        await target.sendCommand('Runtime.releaseObject', { objectId });
      } catch (error) {
        void error;
      }
    }
  }

  private async findHandler(
    target: CdpDebugger,
    nodes: readonly string[],
    eventType: 'click' | 'submit',
  ): Promise<InspectionHandler | null> {
    let fiberChecked = false;
    for (const objectId of nodes) {
      const hint = await this.readHint(target, objectId, eventType);
      if (hint !== null && hint.kind !== null) {
        return hintHandler(eventType, hint);
      }
      if (!fiberChecked) {
        fiberChecked = true;
        const fiberHint = await this.readFiberHint(target, objectId, eventType);
        if (fiberHint !== null && fiberHint.kind !== null) {
          return hintHandler(eventType, fiberHint);
        }
      }

      const listeners = await this.listenersAt(target, objectId);
      try {
        const candidates = listeners.filter((entry) => entry.type === eventType);
        for (const candidate of candidates) {
          const script = this.scriptInfos.get(candidate.scriptId);
          if (script !== undefined && isInternalUrl(script.url)) continue;
          const source = await this.scriptSource(target, candidate.scriptId);
          const name =
            nameFromDescription(candidate.handler?.description) ??
            (source === null ? null : nameFromSource(source, candidate, script));
          if (name !== null && INTERNAL_HANDLER_NAMES.has(name)) continue;
          const notes: string[] = [];
          if (candidate.passive) notes.push('Listener pasivo');
          if (script === undefined) notes.push('Sin ubicación en el código');
          const inlineColumn =
            script !== undefined && candidate.lineNumber === 0
              ? Math.max(0, candidate.columnNumber - script.startColumn)
              : candidate.columnNumber;
          return {
            event: eventType,
            name,
            url: script !== undefined && script.url !== '' ? script.url : null,
            line:
              script !== undefined && script.url !== ''
                ? candidate.lineNumber + script.startLine + 1
                : null,
            column: script !== undefined && script.url !== '' ? inlineColumn + 1 : null,
            source: 'listener',
            note: notes.length > 0 ? notes.join(' · ') : null,
            code: source === null ? null : listenerCodeBlock(source, candidate, script),
          };
        }
      } finally {
        await this.releaseListenerHandlers(target, listeners);
      }
    }
    return null;
  }

  private async scriptSource(target: CdpDebugger, scriptId: string): Promise<string | null> {
    const cached = this.scriptSources.get(scriptId);
    if (cached !== undefined) return cached;
    try {
      const response = (await target.sendCommand('Debugger.getScriptSource', {
        scriptId,
      })) as { scriptSource?: string };
      const source = typeof response.scriptSource === 'string' ? response.scriptSource : null;
      if (source === null) return null;
      if (this.scriptSources.size >= 64) {
        this.scriptSources.clear();
      }
      this.scriptSources.set(scriptId, source);
      return source;
    } catch (error) {
      this.log.debug('No se pudo leer el código del listener', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async readHint(
    target: CdpDebugger,
    objectId: string,
    eventType: 'click' | 'submit',
  ): Promise<HintValue | null> {
    try {
      const response = (await target.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: HINT_FUNCTION,
        arguments: [{ value: eventType }],
        returnByValue: true,
        silent: true,
      })) as { result?: { value?: unknown } };
      return parseHintValue(response.result?.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(CANCELLED_ERROR)) {
        this.log.debug('No se pudo leer el manejador del elemento', { message });
      }
      return null;
    }
  }

  private async readFiberHint(
    target: CdpDebugger,
    objectId: string,
    eventType: 'click' | 'submit',
  ): Promise<HintValue | null> {
    try {
      const response = (await target.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: FIBER_HINT_FUNCTION,
        arguments: [{ value: eventType }],
        returnByValue: true,
        silent: true,
      })) as { result?: { value?: unknown } };
      return parseHintValue(response.result?.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(CANCELLED_ERROR)) {
        this.log.debug('No se pudo leer el manejador del componente', { message });
      }
      return null;
    }
  }

  private async listenersAt(target: CdpDebugger, objectId: string): Promise<EventListenerEntry[]> {
    try {
      const response = (await target.sendCommand('DOMDebugger.getEventListeners', {
        objectId,
        depth: 0,
        pierce: true,
      })) as { listeners?: EventListenerEntry[] };
      return response.listeners ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(CANCELLED_ERROR)) {
        this.log.debug('No se pudieron leer los listeners del elemento', { message });
      }
      return [];
    }
  }
}
