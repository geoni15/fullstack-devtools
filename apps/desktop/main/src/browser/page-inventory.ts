import {
  FLOW_INTERACTION_EVENTS,
  type FlowElementKind,
  type FlowInteractionEvent,
} from '@bdt/protocol';

const ELEMENT_KINDS: readonly FlowElementKind[] = [
  'button',
  'link',
  'input',
  'select',
  'textarea',
  'form',
  'details',
  'summary',
  'contenteditable',
  'interactive',
  'page',
];

const EVENT_NAMES = new Set<string>(FLOW_INTERACTION_EVENTS);

const HANDLER_SOURCES = new Set(['inline', 'react', 'vue', 'dom']);

export interface PageElementRef {
  key: string;
  pageUrl: string;
  selector: string;
  kind: FlowElementKind;
  tag: string;
  text: string | null;
  role: string | null;
  ariaLabel: string | null;
  inputType: string | null;
  name: string | null;
  href: string | null;
  formAction: string | null;
  formMethod: string | null;
  formKey: string | null;
  formSelector: string | null;
  disabled: boolean;
  visible: boolean;
}

export interface PageHandlerHint {
  event: FlowInteractionEvent;
  name: string | null;
  source: string;
}

export interface PageControl extends PageElementRef {
  handlers: PageHandlerHint[];
}

/*
 * Runs in the page's main world so React/Vue expandos are visible. The same
 * path/hash helpers run in the isolated inspector world for event signals, so
 * both sides produce identical keys for the same element.
 */
export const PAGE_DOM_HELPERS_SOURCE = String.raw`
  const __bdtPage = (() => {
    const INTERACTIVE_ROLES = new Set([
      'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
      'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton',
      'textbox', 'searchbox', 'combobox', 'treeitem',
    ]);
    const HANDLER_PROPS = [
      'onclick', 'ondblclick', 'oncontextmenu', 'onsubmit', 'oninput', 'onchange',
      'onfocus', 'onblur', 'onkeydown', 'onmouseenter', 'onmouseover', 'onscroll',
    ];
    const EVENT_MAP = {
      click: 'click',
      dblclick: 'dblclick',
      doubleclick: 'dblclick',
      contextmenu: 'contextmenu',
      submit: 'submit',
      input: 'input',
      change: 'change',
      focus: 'focus',
      focusin: 'focus',
      blur: 'blur',
      focusout: 'blur',
      keydown: 'keydown',
      mouseenter: 'hover',
      mouseover: 'hover',
      pointerenter: 'hover',
      pointerover: 'hover',
      scroll: 'scroll',
    };
    const CONTROL_KEYS = new Set([
      'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', ' ',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Home', 'End', 'PageUp', 'PageDown',
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
    ]);

    const clean = (value, max) => {
      if (value === null || value === undefined) return null;
      const text = String(value).replace(/\s+/g, ' ').trim();
      return text === '' ? null : text.slice(0, max);
    };
    const attr = (node, name) => {
      try {
        const value = node.getAttribute(name);
        return typeof value === 'string' ? value : null;
      } catch (error) {
        void error;
        return null;
      }
    };
    const tagOf = (node) =>
      typeof node.tagName === 'string' ? node.tagName.toLowerCase() : 'node';
    const pageUrl = () => {
      try {
        return location.origin + location.pathname + location.search;
      } catch (error) {
        void error;
        return 'page';
      }
    };
    const hash = (value) => {
      let state = 0x811c9dc5;
      for (let index = 0; index < value.length; index += 1) {
        state ^= value.charCodeAt(index);
        state = Math.imul(state, 0x01000193);
      }
      return (state >>> 0).toString(16).padStart(8, '0');
    };
    const pathOf = (node) => {
      if (!node) return '';
      if (node.nodeType === 9) return 'document';
      if (node.nodeType !== 1) return '';
      const parts = [];
      const seen = new Set();
      let current = node;
      while (current && current.nodeType === 1 && !seen.has(current)) {
        seen.add(current);
        const tag = tagOf(current);
        let part = tag;
        let id = '';
        try {
          id = typeof current.id === 'string' ? current.id : '';
        } catch (error) {
          void error;
          id = '';
        }
        if (id !== '') part += '#' + id.slice(0, 80);
        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === current.tagName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        part += ':nth-of-type(' + index + ')';
        parts.unshift(part);
        const parent = current.parentElement;
        if (parent) {
          current = parent;
          continue;
        }
        let root = null;
        try {
          root = current.getRootNode ? current.getRootNode() : null;
        } catch (error) {
          void error;
          root = null;
        }
        const host = root && root.host ? root.host : null;
        if (host) {
          parts[0] = 'shadow>' + parts[0];
          current = host;
          continue;
        }
        break;
      }
      return parts.join('>');
    };
    const keyFor = (node) => {
      const selector = pathOf(node);
      if (selector === '') return '';
      return hash(pageUrl() + String.fromCharCode(0) + selector);
    };
    const isEditable = (node) => {
      try {
        if (node.isContentEditable === true) return true;
        const value = node.getAttribute('contenteditable');
        return value === '' || value === 'true' || value === 'plaintext-only';
      } catch (error) {
        void error;
        return false;
      }
    };
    const kindOf = (node) => {
      if (node.nodeType === 9) return 'page';
      const tag = tagOf(node);
      if (tag === 'form') return 'form';
      if (tag === 'button') return 'button';
      if (tag === 'a' || tag === 'area') return 'link';
      if (tag === 'input') return 'input';
      if (tag === 'select') return 'select';
      if (tag === 'textarea') return 'textarea';
      if (tag === 'details') return 'details';
      if (tag === 'summary') return 'summary';
      if (isEditable(node)) return 'contenteditable';
      return 'interactive';
    };
    const labelOf = (node, tag) => {
      const aria = clean(attr(node, 'aria-label'), 120);
      if (tag === 'form') {
        if (aria) return aria;
        const name = clean(attr(node, 'name'), 80);
        if (name) return name;
        const id = clean(attr(node, 'id'), 80);
        return id ? 'formulario #' + id : 'formulario';
      }
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (aria) return aria;
        const type = clean(attr(node, 'type'), 24);
        if (tag === 'input' && (type === 'submit' || type === 'reset' || type === 'button')) {
          const value = clean(node.value, 120);
          if (value) return value;
        }
        const placeholder = clean(attr(node, 'placeholder'), 120);
        if (placeholder) return placeholder;
        const name = clean(attr(node, 'name'), 80);
        if (name) return name;
        return type ? tag + ' ' + type : tag;
      }
      let text = '';
      try {
        const raw = typeof node.innerText === 'string' ? node.innerText : node.textContent;
        if (typeof raw === 'string') text = raw.replace(/\s+/g, ' ').trim();
      } catch (error) {
        void error;
        text = '';
      }
      if (text !== '') return text.slice(0, 120);
      if (aria) return aria;
      const title = clean(attr(node, 'title'), 120);
      if (title) return title;
      const name = clean(attr(node, 'name'), 80);
      return name ?? tag;
    };
    const formOf = (node) => {
      try {
        if (tagOf(node) === 'form') return node;
        if (node.form) return node.form;
        if (node.closest) return node.closest('form');
      } catch (error) {
        void error;
      }
      return null;
    };
    const hrefOf = (node) => {
      const tag = tagOf(node);
      if (tag !== 'a' && tag !== 'area') return null;
      let raw = '';
      try {
        raw = typeof node.href === 'string' ? node.href : '';
      } catch (error) {
        void error;
        raw = '';
      }
      if (raw === '') raw = attr(node, 'href') ?? '';
      if (raw === '' || raw === '#' || raw.indexOf('javascript:') === 0) return null;
      try {
        const url = new URL(raw, pageUrl());
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          return clean(url.origin + url.pathname, 300);
        }
      } catch (error) {
        void error;
      }
      return clean(raw, 300);
    };
    const actionOf = (node, form) => {
      let raw = attr(node, 'formaction') ?? '';
      if (raw === '' && form) raw = attr(form, 'action') ?? '';
      if (raw === '' || raw.indexOf('javascript:') === 0) return null;
      try {
        const url = new URL(raw, pageUrl());
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          return clean(url.origin + url.pathname, 300);
        }
      } catch (error) {
        void error;
      }
      return clean(raw, 300);
    };
    const methodOf = (node, form) => {
      let raw = attr(node, 'formmethod') ?? '';
      if (raw === '' && form) {
        try {
          raw = typeof form.method === 'string' ? form.method : attr(form, 'method') ?? '';
        } catch (error) {
          void error;
          raw = '';
        }
      }
      const method = (raw === '' ? 'get' : raw).toUpperCase();
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        return method;
      }
      return 'GET';
    };
    const interactive = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const tag = tagOf(node);
      if (
        tag === 'button' ||
        tag === 'input' ||
        tag === 'select' ||
        tag === 'textarea' ||
        tag === 'form' ||
        tag === 'details' ||
        tag === 'summary'
      ) {
        return true;
      }
      if (tag === 'a' || tag === 'area') return attr(node, 'href') !== null;
      if (isEditable(node)) return true;
      const role = (attr(node, 'role') ?? '').toLowerCase();
      return INTERACTIVE_ROLES.has(role);
    };
    const closestInteractive = (start) => {
      let node = start;
      const seen = new Set();
      while (node && node.nodeType === 1 && !seen.has(node)) {
        seen.add(node);
        if (interactive(node)) return node;
        const parent = node.parentElement;
        if (parent) {
          node = parent;
          continue;
        }
        let root = null;
        try {
          root = node.getRootNode ? node.getRootNode() : null;
        } catch (error) {
          void error;
          root = null;
        }
        node = root && root.host ? root.host : null;
      }
      return null;
    };
    const visibleOf = (node) => {
      try {
        if (node.hidden === true) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none';
      } catch (error) {
        void error;
        return true;
      }
    };
    const refOf = (node) => {
      if (!node) return null;
      if (node.nodeType === 9) {
        return {
          key: keyFor(node),
          pageUrl: pageUrl(),
          selector: 'document',
          kind: 'page',
          tag: 'document',
          text: clean(document.title, 120),
          role: null,
          ariaLabel: null,
          inputType: null,
          name: null,
          href: null,
          formAction: null,
          formMethod: null,
          formKey: null,
          formSelector: null,
          disabled: false,
          visible: true,
        };
      }
      if (node.nodeType !== 1) return null;
      const tag = tagOf(node);
      const selector = pathOf(node);
      if (selector === '') return null;
      const form = formOf(node);
      const formKey = form ? keyFor(form) : null;
      const disabled = (() => {
        try {
          return node.disabled === true || attr(node, 'aria-disabled') === 'true';
        } catch (error) {
          void error;
          return false;
        }
      })();
      return {
        key: keyFor(node),
        pageUrl: pageUrl(),
        selector,
        kind: kindOf(node),
        tag,
        text: labelOf(node, tag),
        role: clean(attr(node, 'role'), 64),
        ariaLabel: clean(attr(node, 'aria-label'), 128),
        inputType: clean(attr(node, 'type'), 32),
        name: clean(attr(node, 'name'), 80),
        href: hrefOf(node),
        formAction: actionOf(node, form),
        formMethod: form === null ? null : methodOf(node, form),
        formKey,
        formSelector: form ? pathOf(form) : null,
        disabled,
        visible: visibleOf(node),
      };
    };
    const eventFor = (raw) => {
      if (typeof raw !== 'string' || raw === '') return null;
      let name = raw;
      const dot = name.indexOf('.');
      if (dot !== -1) name = name.slice(0, dot);
      if (name.indexOf('on') === 0 && name.length > 2) name = name.slice(2);
      return EVENT_MAP[name.toLowerCase()] ?? null;
    };
    const handlerName = (fn) => {
      try {
        return typeof fn.name === 'string' && fn.name !== '' ? fn.name.slice(0, 128) : null;
      } catch (error) {
        void error;
        return null;
      }
    };
    const addHandler = (list, event, fn, source) => {
      if (event === null || typeof fn !== 'function') return;
      const name = handlerName(fn);
      const key = event + '|' + source + '|' + (name ?? '');
      if (list.some((item) => item.event + '|' + item.source + '|' + (item.name ?? '') === key)) {
        return;
      }
      list.push({ event, name, source });
    };
    const collectProps = (list, props, source) => {
      if (!props || typeof props !== 'object') return;
      let keys = [];
      try {
        keys = Object.keys(props);
      } catch (error) {
        void error;
        return;
      }
      for (const key of keys) {
        const event = eventFor(key);
        if (event === null) continue;
        let value = null;
        try {
          value = props[key];
        } catch (error) {
          void error;
          value = null;
        }
        addHandler(list, event, value, source);
      }
    };
    const handlersOf = (node, deep) => {
      const list = [];
      let attributes = [];
      try {
        attributes = Array.from(node.attributes ?? []);
      } catch (error) {
        void error;
        attributes = [];
      }
      for (const attribute of attributes) {
        const name = String(attribute.name).toLowerCase();
        if (name.indexOf('on') !== 0) continue;
        const event = eventFor(name);
        if (event === null) continue;
        let fn = null;
        try {
          fn = node[name] ?? node.getAttribute(name);
        } catch (error) {
          void error;
          fn = null;
        }
        addHandler(list, event, fn, 'inline');
      }
      let own = [];
      try {
        own = Object.getOwnPropertyNames(node);
      } catch (error) {
        void error;
        own = [];
      }
      for (const key of own) {
        if (key.indexOf('__reactProps$') === 0 || key.indexOf('__reactEventHandlers$') === 0) {
          try {
            collectProps(list, node[key], 'react');
          } catch (error) {
            void error;
          }
          continue;
        }
        if (key === '_vei') {
          try {
            const invokers = node[key] ?? {};
            for (const entryKey of Object.keys(invokers)) {
              const event = eventFor(entryKey);
              const entry = invokers[entryKey];
              const fn =
                typeof entry === 'function'
                  ? entry
                  : entry && typeof entry.value === 'function'
                    ? entry.value
                    : null;
              addHandler(list, event, fn, 'vue');
            }
          } catch (error) {
            void error;
          }
          continue;
        }
        if (!deep) continue;
        if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
          let fiber = null;
          try {
            fiber = node[key];
          } catch (error) {
            void error;
            fiber = null;
          }
          for (let depth = 0; fiber && depth < 24; depth += 1) {
            let props = null;
            try {
              props = fiber.memoizedProps || fiber.pendingProps;
            } catch (error) {
              void error;
              props = null;
            }
            collectProps(list, props, 'react');
            try {
              fiber = fiber.return;
            } catch (error) {
              void error;
              fiber = null;
            }
          }
          continue;
        }
        if (key === '__vueParentComponent') {
          let component = null;
          try {
            component = node[key];
          } catch (error) {
            void error;
            component = null;
          }
          for (let depth = 0; component && depth < 24; depth += 1) {
            let props = null;
            try {
              props = component.props || (component.vnode && component.vnode.props);
            } catch (error) {
              void error;
              props = null;
            }
            collectProps(list, props, 'vue');
            try {
              component = component.parent;
            } catch (error) {
              void error;
              component = null;
            }
          }
        }
      }
      for (const property of HANDLER_PROPS) {
        let fn = null;
        try {
          fn = node[property];
        } catch (error) {
          void error;
          fn = null;
        }
        addHandler(list, eventFor(property), fn, 'dom');
      }
      return list;
    };
    const isControlKey = (key) => CONTROL_KEYS.has(key);

    return {
      pageUrl,
      pathOf,
      keyFor,
      kindOf,
      refOf,
      interactive,
      closestInteractive,
      handlersOf,
      isControlKey,
    };
  })();
`;

export const INVENTORY_SCRIPT = String.raw`
(() => {
  try {
${PAGE_DOM_HELPERS_SOURCE}
    const results = [];
    const seen = new Set();
    const documentRef = __bdtPage.refOf(document);
    if (documentRef !== null && documentRef.key !== '') {
      results.push({ ...documentRef, handlers: [] });
    }
    const visit = (root) => {
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll('*'));
      } catch (error) {
        void error;
        nodes = [];
      }
      for (const node of nodes) {
        if (seen.has(node)) continue;
        seen.add(node);
        try {
          if (node.shadowRoot) visit(node.shadowRoot);
        } catch (error) {
          void error;
        }
        try {
          const deep = __bdtPage.interactive(node);
          const handlers = __bdtPage.handlersOf(node, deep);
          if (!deep && handlers.length === 0) continue;
          const ref = __bdtPage.refOf(node);
          if (!ref || ref.key === '') continue;
          results.push({ ...ref, handlers });
        } catch (error) {
          void error;
        }
      }
    };
    visit(document);
    return results;
  } catch (error) {
    return [];
  }
})()
`;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean === '' ? null : clean.slice(0, max);
}

function bool(value: unknown): boolean {
  return value === true;
}

export function isFlowInteractionEvent(value: unknown): value is FlowInteractionEvent {
  return typeof value === 'string' && EVENT_NAMES.has(value);
}

export function parseElementRef(value: unknown): PageElementRef | null {
  const raw = record(value);
  if (raw === null) return null;
  const key = text(raw.key, 40);
  const selector = text(raw.selector, 1000);
  const tag = text(raw.tag, 40);
  if (key === null || !/^[0-9a-f]{6,40}$/i.test(key)) return null;
  if (selector === null || tag === null) return null;
  const kind =
    typeof raw.kind === 'string' && (ELEMENT_KINDS as readonly string[]).includes(raw.kind)
      ? (raw.kind as FlowElementKind)
      : 'interactive';
  return {
    key,
    pageUrl: text(raw.pageUrl, 1000) ?? '',
    selector,
    kind,
    tag: tag.toLowerCase(),
    text: text(raw.text, 160),
    role: text(raw.role, 64),
    ariaLabel: text(raw.ariaLabel, 128),
    inputType: text(raw.inputType, 32),
    name: text(raw.name, 80),
    href: text(raw.href, 500),
    formAction: text(raw.formAction, 500),
    formMethod: text(raw.formMethod, 16)?.toUpperCase() ?? null,
    formKey: text(raw.formKey, 40),
    formSelector: text(raw.formSelector, 1000),
    disabled: bool(raw.disabled),
    visible: raw.visible !== false,
  };
}

function parseHandlerHint(value: unknown): PageHandlerHint | null {
  const raw = record(value);
  if (raw === null) return null;
  if (!isFlowInteractionEvent(raw.event)) return null;
  const source = typeof raw.source === 'string' ? raw.source : '';
  if (!HANDLER_SOURCES.has(source)) return null;
  return {
    event: raw.event,
    name: text(raw.name, 128),
    source,
  };
}

export function parseInventory(value: unknown): PageControl[] {
  if (!Array.isArray(value)) return [];
  const controls = new Map<string, PageControl>();
  for (const item of value) {
    const ref = parseElementRef(item);
    if (ref === null) continue;
    const raw = record(item);
    const handlers: PageHandlerHint[] = [];
    const seen = new Set<string>();
    for (const entry of Array.isArray(raw?.handlers) ? raw.handlers : []) {
      const hint = parseHandlerHint(entry);
      if (hint === null) continue;
      const id = `${hint.event}|${hint.source}|${hint.name ?? ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      handlers.push(hint);
    }
    controls.set(ref.key, { ...ref, handlers });
  }
  return [...controls.values()];
}
