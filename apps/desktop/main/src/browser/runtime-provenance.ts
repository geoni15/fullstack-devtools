export interface RuntimeFrame {
  functionName: string | null;
  url: string;
  line: number;
  column: number;
}

export interface RuntimeRequestInfo {
  key: string;
  method: string;
  path: string;
  host: string;
  status: number | null;
  startedAt: number;
  frames: RuntimeFrame[];
}

export interface RuntimeFunctionInfo {
  name: string;
  framework: 'react' | 'vue';
  file: string | null;
  line: number | null;
  column: number | null;
}

export type RuntimeRenderOrigin = 'jsx' | 'stack' | 'file';

export interface RuntimeRenderInfo {
  component: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  origin: RuntimeRenderOrigin;
  code: string | null;
}

export type RuntimeDataKind = 'number' | 'text' | 'object';

export interface RuntimeDataInfo {
  component: string;
  framework: 'react' | 'vue';
  path: string;
  value: string;
  kind: RuntimeDataKind;
  jsonPath: string;
  requestKey: string;
}

export interface RuntimeProvenance {
  framework: 'react' | 'vue' | null;
  render: RuntimeRenderInfo | null;
  renderSources: RuntimeRenderInfo[];
  functions: RuntimeFunctionInfo[];
  data: RuntimeDataInfo[];
  requests: RuntimeRequestInfo[];
  note: string | null;
}

export const RUNTIME_NETWORK_SOURCE = String.raw`
(() => {
  const KEY = '__bdtRuntimeNetwork';
  const existing = globalThis[KEY];
  if (existing && existing.version === 1) return;

  const state = {
    seq: 0,
    responses: new WeakMap(),
    parsed: new WeakMap(),
    xhr: new WeakMap(),
    pendingTexts: new Map(),
    tagQueue: [],
    tagSeen: new WeakSet(),
    tagScheduled: false,
  };

  const PENDING_PRUNE_AFTER_MS = 60000;
  const STACK_LIMIT = Infinity;
  const TAG_SLICE_MS = 4;
  /*
   * La instrumentación de red solo alimenta la procedencia del inspector. Con la
   * inspección apagada se desactiva por completo: sin captura de pilas, sin
   * seguimiento de respuestas y sin etiquetado de JSON en el hilo de la página.
   */
  let runtimeEnabled = true;
  try {
    if (globalThis.__BDT_RUNTIME_ENABLED__ === false) runtimeEnabled = false;
  } catch (error) {
    void error;
  }
  const setRuntimeEnabled = function (value) {
    runtimeEnabled = value === true;
    state.pendingTexts.clear();
    state.tagQueue.length = 0;
    state.tagSeen = new WeakSet();
    state.tagScheduled = false;
    state.responses = new WeakMap();
    state.xhr = new WeakMap();
    state.parsed = new WeakMap();
  };
  globalThis.__bdtRuntimeSetEnabled = setRuntimeEnabled;
  const SCAN_SLICE_MS = 8;
  /*
   * Recorrer props y estado de React puede abarcar cientos de miles de objetos.
   * Se hace en tandas de ~8 ms: entre tandas la página recupera el hilo para
   * pintar y atender clics, en vez de quedarse congelada varios segundos.
   */
  const scanYield = (() => {
    if (typeof MessageChannel !== 'function') {
      return function () {
        return new Promise(function (resolve) {
          setTimeout(resolve, 0);
        });
      };
    }
    const channel = new MessageChannel();
    const pending = [];
    channel.port1.onmessage = function () {
      const resolve = pending.shift();
      if (resolve !== undefined) resolve();
    };
    return function () {
      return new Promise(function (resolve) {
        pending.push(resolve);
        channel.port2.postMessage(0);
      });
    };
  })();
  const createClock = function () {
    return { at: Date.now() };
  };
  const breathe = async function (clock) {
    if (Date.now() - clock.at < SCAN_SLICE_MS) return;
    await scanYield();
    clock.at = Date.now();
  };

  function __bdtClip(value, max) {
    const text = value === null || value === undefined ? '' : String(value);
    return text.length > max ? text.slice(0, max) : text;
  }

  function __bdtStripUrl(value) {
    try {
      const url = new URL(String(value), location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.origin + url.pathname;
    } catch (error) {
      return null;
    }
  }

  function __bdtParseStack(raw) {
    const frames = [];
    if (typeof raw !== 'string' || raw === '') return frames;
    const lines = raw.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line.indexOf('at ') !== 0) continue;
      const body = line.slice(3).trim();
      if (body === '') continue;
      let name = null;
      let location = body;
      const open = body.lastIndexOf(' (');
      if (open !== -1 && body.charAt(body.length - 1) === ')') {
        name = body.slice(0, open).trim();
        location = body.slice(open + 2, -1).trim();
      }
      if (name !== null && name.indexOf('async ') === 0) name = name.slice(6).trim();
      if (name !== null && name.indexOf('__bdt') !== -1) continue;
      const match = /^(.*):(\d+):(\d+)$/.exec(location);
      if (!match) continue;
      const url = __bdtStripUrl(match[1]);
      if (url === null) continue;
      frames.push({
        functionName: name === null || name === '' ? null : __bdtClip(name, 200),
        url: url,
        line: Number(match[2]),
        column: Number(match[3]),
      });
    }
    return frames;
  }

  function __bdtCaptureFrames() {
    let raw = '';
    let previous = 10;
    try {
      previous = Error.stackTraceLimit;
      Error.stackTraceLimit = STACK_LIMIT;
      raw = new Error().stack || '';
    } catch (error) {
      raw = '';
    } finally {
      try {
        Error.stackTraceLimit = previous;
      } catch (error) {
        void error;
      }
    }
    return __bdtParseStack(raw);
  }

  function __bdtDescribeUrl(value) {
    const raw = __bdtClip(value, 4096);
    try {
      const url = new URL(raw, location.href);
      return {
        url: __bdtClip(url.origin + url.pathname, 2048),
        path: __bdtClip(url.pathname, 2048),
        host: __bdtClip(url.host, 255),
      };
    } catch (error) {
      const clean = raw.split('#')[0].split('?')[0];
      return { url: __bdtClip(clean, 2048), path: __bdtClip(clean, 2048), host: '' };
    }
  }

  function __bdtMakeInfo(input, init) {
    let rawUrl = '';
    let method = 'GET';
    if (typeof input === 'string') {
      rawUrl = input;
    } else if (input !== null && typeof input === 'object') {
      if (typeof input.url === 'string') rawUrl = input.url;
      else if (typeof input.href === 'string') rawUrl = input.href;
      if (typeof input.method === 'string' && input.method !== '') method = input.method;
    }
    if (init !== null && typeof init === 'object' && typeof init.method === 'string' && init.method !== '') {
      method = init.method;
    }
    const target = __bdtDescribeUrl(rawUrl);
    state.seq += 1;
    return {
      key: 'r' + String(state.seq),
      method: __bdtClip(String(method || 'GET').toUpperCase(), 16),
      url: target.url,
      path: target.path,
      host: target.host,
      status: null,
      startedAt: Date.now(),
      frames: __bdtCaptureFrames(),
    };
  }

  function __bdtRegisterText(text, info) {
    if (!runtimeEnabled) return;
    if (typeof text !== 'string' || text.length === 0) return;
    const clean = text.replace(/^\s+/, '');
    if (clean.charAt(0) !== '{' && clean.charAt(0) !== '[') return;
    state.pendingTexts.delete(text);
    state.pendingTexts.set(text, { info: info, at: Date.now() });
    // Los textos pendientes retienen cuerpos completos en memoria: se sueltan
    // en cuanto dejan de ser útiles para evitar pausas largas del recolector.
    const cutoff = Date.now() - PENDING_PRUNE_AFTER_MS;
    for (const entry of state.pendingTexts) {
      if (entry[1].at <= cutoff) state.pendingTexts.delete(entry[0]);
    }
  }

  /*
   * Etiquetar un JSON enorme de golpe bloquea el hilo de la página. Se procesa en
   * tandas: la primera es síncrona (la mayoría de respuestas cabe entera) y el resto
   * se reparte en macrotareas para que la página siga respondiendo.
   */
  function __bdtTagStep() {
    const item = state.tagQueue.pop();
    if (item === undefined) return;
    const value = item.value;
    if (value === null || typeof value !== 'object') return;
    if (state.tagSeen.has(value)) return;
    state.tagSeen.add(value);
    if (!state.parsed.has(value)) {
      state.parsed.set(value, { info: item.info, jsonPath: item.path });
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        state.tagQueue.push({
          value: value[index],
          path: item.path + '[' + String(index) + ']',
          info: item.info,
        });
      }
      return;
    }
    let keys = [];
    try {
      keys = Object.keys(value);
    } catch (error) {
      return;
    }
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      let child;
      try {
        child = value[key];
      } catch (error) {
        continue;
      }
      state.tagQueue.push({ value: child, path: item.path + '.' + key, info: item.info });
    }
  }

  function __bdtDrainTagQueue() {
    state.tagScheduled = false;
    if (!runtimeEnabled) {
      state.tagQueue.length = 0;
      state.tagSeen = new WeakSet();
      return;
    }
    const started = Date.now();
    let processed = 0;
    while (state.tagQueue.length > 0) {
      __bdtTagStep();
      processed += 1;
      if ((processed & 255) === 0 && Date.now() - started >= TAG_SLICE_MS) break;
    }
    if (state.tagQueue.length > 0) {
      state.tagScheduled = true;
      scanYield().then(__bdtDrainTagQueue);
      return;
    }
    state.tagSeen = new WeakSet();
  }

  function __bdtTag(root, info, rootPath) {
    if (!runtimeEnabled) return;
    if (root === null || typeof root !== 'object') return;
    state.tagQueue.push({ value: root, path: rootPath, info: info });
    if (state.tagScheduled) return;
    __bdtDrainTagQueue();
  }

  try {
    const nativeParse = JSON.parse;
    JSON.parse = function __bdtJsonParse(text, reviver) {
      const value = nativeParse.apply(this, arguments);
      if (!runtimeEnabled) return value;
      if (typeof text === 'string' && state.pendingTexts.size > 0) {
        const pending = state.pendingTexts.get(text);
        if (pending !== undefined) {
          state.pendingTexts.delete(text);
          __bdtTag(value, pending.info, '$');
        }
      }
      return value;
    };
  } catch (error) {
    void error;
  }

  try {
    if (typeof Response === 'function' && Response.prototype) {
      const proto = Response.prototype;
      const nativeJson = proto.json;
      if (typeof nativeJson === 'function') {
        proto.json = function __bdtResponseJson() {
          const response = this;
          const info = state.responses.get(response);
          const result = nativeJson.apply(response, arguments);
          if (!runtimeEnabled) return result;
          if (info === undefined || result === null || typeof result.then !== 'function') return result;
          return result.then(function (value) {
            __bdtTag(value, info, '$');
            return value;
          });
        };
      }
      const nativeText = proto.text;
      if (typeof nativeText === 'function') {
        proto.text = function __bdtResponseText() {
          const response = this;
          const info = state.responses.get(response);
          const result = nativeText.apply(response, arguments);
          if (!runtimeEnabled) return result;
          if (info === undefined || result === null || typeof result.then !== 'function') return result;
          return result.then(function (value) {
            __bdtRegisterText(value, info);
            return value;
          });
        };
      }
      const nativeClone = proto.clone;
      if (typeof nativeClone === 'function') {
        proto.clone = function __bdtResponseClone() {
          const clone = nativeClone.apply(this, arguments);
          if (!runtimeEnabled) return clone;
          const info = state.responses.get(this);
          if (info !== undefined) state.responses.set(clone, info);
          return clone;
        };
      }
    }
  } catch (error) {
    void error;
  }

  try {
    const nativeFetch = globalThis.fetch;
    if (typeof nativeFetch === 'function') {
      globalThis.fetch = function __bdtFetch(input, init) {
        if (!runtimeEnabled) return nativeFetch.apply(this, arguments);
        const info = __bdtMakeInfo(input, init);
        const result = nativeFetch.apply(this, arguments);
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          result.then(
            function (response) {
              try {
                info.status = response.status;
                state.responses.set(response, info);
              } catch (error) {
                void error;
              }
            },
            function () {
              return undefined;
            },
          );
        }
        return result;
      };
    }
  } catch (error) {
    void error;
  }

  try {
    if (typeof XMLHttpRequest === 'function') {
      const xhrProto = XMLHttpRequest.prototype;
      const nativeOpen = xhrProto.open;
      if (typeof nativeOpen === 'function') {
        xhrProto.open = function __bdtXhrOpen(method, url) {
          const result = nativeOpen.apply(this, arguments);
          if (!runtimeEnabled) return result;
          try {
            state.xhr.set(this, __bdtMakeInfo(url, { method: method }));
          } catch (error) {
            void error;
          }
          return result;
        };
      }
      const nativeSend = xhrProto.send;
      if (typeof nativeSend === 'function') {
        xhrProto.send = function __bdtXhrSend() {
          if (!runtimeEnabled) return nativeSend.apply(this, arguments);
          const xhr = this;
          const info = state.xhr.get(xhr);
          if (info !== undefined) {
            try {
              xhr.addEventListener('loadend', function __bdtXhrEnd() {
                try {
                  info.status = xhr.status;
                } catch (error) {
                  void error;
                }
              });
            } catch (error) {
              void error;
            }
          }
          return nativeSend.apply(this, arguments);
        };
      }
      const textDescriptor = Object.getOwnPropertyDescriptor(xhrProto, 'responseText');
      if (textDescriptor !== undefined && typeof textDescriptor.get === 'function') {
        Object.defineProperty(xhrProto, 'responseText', {
          configurable: true,
          enumerable: textDescriptor.enumerable,
          get: function __bdtXhrText() {
            const value = textDescriptor.get.call(this);
            if (!runtimeEnabled) return value;
            const info = state.xhr.get(this);
            if (info !== undefined) {
              try {
                info.status = this.status;
              } catch (error) {
                void error;
              }
              if (typeof value === 'string' && value.length > 0) __bdtRegisterText(value, info);
            }
            return value;
          },
        });
      }
      const responseDescriptor = Object.getOwnPropertyDescriptor(xhrProto, 'response');
      if (responseDescriptor !== undefined && typeof responseDescriptor.get === 'function') {
        Object.defineProperty(xhrProto, 'response', {
          configurable: true,
          enumerable: responseDescriptor.enumerable,
          get: function __bdtXhrResponse() {
            const value = responseDescriptor.get.call(this);
            if (!runtimeEnabled) return value;
            const info = state.xhr.get(this);
            if (info !== undefined) {
              try {
                info.status = this.status;
              } catch (error) {
                void error;
              }
              if (value !== null && typeof value === 'object') __bdtTag(value, info, '$');
              else if (typeof value === 'string' && value.length > 0) __bdtRegisterText(value, info);
            }
            return value;
          },
        });
      }
    }
  } catch (error) {
    void error;
  }

  function __bdtNormalizeKey(value) {
    let text = __bdtClip(value, 200).trim().toLowerCase();
    while (text.length > 0 && (text.charAt(0) === '.' || text.charAt(0) === '$')) {
      text = text.slice(1);
    }
    return text;
  }

  const IDENTITY_FIELDS = [
    'id',
    '_id',
    'uuid',
    'guid',
    'key',
    'code',
    'sku',
    'slug',
    'pk',
    'ref',
    'product_id',
    'productId',
    'item_id',
    'itemId',
  ];

  function __bdtDirectIdentity(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    for (let index = 0; index < IDENTITY_FIELDS.length; index += 1) {
      const field = IDENTITY_FIELDS[index];
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
      let raw;
      try {
        raw = value[field];
      } catch (error) {
        continue;
      }
      if (raw === null || raw === undefined || typeof raw === 'object') continue;
      if (keys.has(__bdtNormalizeKey(raw))) return true;
    }
    return false;
  }

  async function __bdtContainsIdentity(root, keys, clock) {
    if (root === null || typeof root !== 'object') return false;
    const stack = [root];
    const seen = new WeakSet();
    let ticks = 0;
    while (stack.length > 0) {
      if ((++ticks & 1023) === 0) await breathe(clock);
      const value = stack.pop();
      if (value === null || typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);
      if (__bdtDirectIdentity(value, keys)) return true;
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) stack.push(value[index]);
        continue;
      }
      let names = [];
      try {
        names = Object.keys(value);
      } catch (error) {
        continue;
      }
      for (let index = 0; index < names.length; index += 1) {
        let child;
        try {
          child = value[names[index]];
        } catch (error) {
          continue;
        }
        stack.push(child);
      }
    }
    return false;
  }

  async function __bdtIdentityRoots(root, keys, clock) {
    const roots = [];
    if (root === null || typeof root !== 'object') return roots;
    const stack = [{ value: root, path: '$' }];
    const seen = new WeakSet();
    let ticks = 0;
    while (stack.length > 0) {
      if ((++ticks & 1023) === 0) await breathe(clock);
      const item = stack.pop();
      if (item === undefined) continue;
      const value = item.value;
      if (value === null || typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);
      if (__bdtDirectIdentity(value, keys)) {
        roots.push({ value: value, path: item.path });
        continue;
      }
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          stack.push({ value: value[index], path: item.path + '[' + String(index) + ']' });
        }
        continue;
      }
      let names = [];
      try {
        names = Object.keys(value);
      } catch (error) {
        continue;
      }
      for (let index = names.length - 1; index >= 0; index -= 1) {
        const name = names[index];
        let child;
        try {
          child = value[name];
        } catch (error) {
          continue;
        }
        stack.push({ value: child, path: item.path + '.' + name });
      }
    }
    return roots;
  }

  function __bdtNumbers(text) {
    const numbers = new Set();
    const clean = String(text).replace(/[^\d.,\s-]/g, ' ');
    const tokens = clean.match(/-?\d[\d.,\s]*\d|-?\d/g) || [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index].replace(/\s+/g, '');
      if (token === '' || token === '-' || token === '.' || token === ',') continue;
      const variants = [
        token.replace(/,/g, ''),
        token.replace(/\./g, '').replace(/,/g, '.'),
        token.replace(/[.,]/g, ''),
      ];
      for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
        const value = Number(variants[variantIndex]);
        if (isFinite(value)) numbers.add(value);
      }
    }
    return numbers;
  }

  function __bdtSameNumber(value, numbers) {
    if (!isFinite(value)) return false;
    if (numbers.has(value)) return true;
    const cents = Math.round(value * 100) / 100;
    if (numbers.has(cents)) return true;
    for (const candidate of numbers) {
      if (Math.abs(candidate - value) < 0.005) return true;
      if (Math.abs(candidate - cents) < 0.005) return true;
    }
    return false;
  }

  function __bdtTextScore(value, target) {
    const clean = String(value).replace(/\s+/g, ' ').trim();
    if (clean.length < 3) return 0;
    if (clean === target) return 5;
    if (target.length >= 4 && clean.indexOf(target) !== -1) return 3;
    if (clean.length >= 4 && target.indexOf(clean) !== -1) return 2;
    return 0;
  }

  function __bdtSensitiveKey(name) {
    return /password|token|secret|jwt|session|authorization|cookie|api_?key/i.test(name);
  }

  function __bdtSkipKey(name) {
    if (
      name === 'ref' ||
      name === 'key' ||
      name === 'children' ||
      name === 'style' ||
      name === 'className' ||
      name === 'sx' ||
      name === 'classes' ||
      name === 'theme' ||
      name === 'slotProps' ||
      name === 'components' ||
      name === 'componentsProps' ||
      name === 'ownerDocument' ||
      name === 'document' ||
      name === 'window' ||
      name === '$$typeof'
    ) {
      return true;
    }
    if (name.indexOf('__react') === 0 || name.indexOf('__vue') === 0) return true;
    return __bdtSensitiveKey(name);
  }

  function __bdtLeafKey(path) {
    const match = /([A-Za-z_$][\w$]*)\s*\]?\s*$/.exec(path);
    return match === null ? null : match[1];
  }

  function __bdtStringHasNumber(value, numbers) {
    if (numbers.size === 0) return false;
    const found = __bdtNumbers(value);
    for (const candidate of found) {
      if (__bdtSameNumber(candidate, numbers)) return true;
    }
    return false;
  }

  async function __bdtMatchValues(root, text, numbers, clock) {
    const matches = [];
    if (root === null || typeof root !== 'object') return matches;
    const stack = [{ value: root, path: '$' }];
    const seen = new WeakSet();
    let ticks = 0;
    while (stack.length > 0) {
      if ((++ticks & 1023) === 0) await breathe(clock);
      const item = stack.pop();
      if (item === undefined) continue;
      const value = item.value;
      if (value === null || value === undefined) continue;
      if (typeof value === 'number') {
        const leaf = __bdtLeafKey(item.path);
        if (leaf !== null && __bdtSensitiveKey(leaf)) continue;
        if (__bdtSameNumber(value, numbers)) {
          matches.push({ value: String(value), path: item.path, kind: 'number', score: 6 });
        }
        continue;
      }
      if (typeof value === 'string') {
        const leaf = __bdtLeafKey(item.path);
        if (leaf !== null && __bdtSensitiveKey(leaf)) continue;
        const score = __bdtTextScore(value, text);
        if (score > 0) {
          matches.push({ value: value, path: item.path, kind: 'text', score: score });
        } else if (__bdtStringHasNumber(value, numbers)) {
          matches.push({ value: value, path: item.path, kind: 'number', score: 5 });
        }
        continue;
      }
      if (typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          stack.push({ value: value[index], path: item.path + '[' + String(index) + ']' });
        }
        continue;
      }
      let names = [];
      try {
        names = Object.keys(value);
      } catch (error) {
        continue;
      }
      for (let index = names.length - 1; index >= 0; index -= 1) {
        const name = names[index];
        if (__bdtSkipKey(name)) continue;
        let child;
        try {
          child = value[name];
        } catch (error) {
          continue;
        }
        stack.push({ value: child, path: item.path + '.' + name });
      }
    }
    matches.sort(function (left, right) {
      if (left.score !== right.score) return right.score - left.score;
      if (left.path.length !== right.path.length) return left.path.length - right.path.length;
      return left.path.localeCompare(right.path);
    });
    return matches;
  }

  function __bdtTypeName(type) {
    if (type === null || type === undefined) return null;
    if (typeof type === 'function') return type.displayName || type.name || null;
    if (typeof type === 'string' || typeof type === 'symbol') return null;
    if (typeof type.displayName === 'string' && type.displayName !== '') return type.displayName;
    const inner = type.render !== undefined ? type.render : type.type;
    if (typeof inner === 'function') return inner.displayName || inner.name || null;
    return null;
  }

  function __bdtDebugSource(fiber) {
    try {
      const source = fiber._debugSource;
      if (source === null || source === undefined || typeof source.fileName !== 'string') return null;
      if (source.fileName === '') return null;
      const file = __bdtStripUrl(source.fileName) || source.fileName.split('?')[0];
      return {
        component: null,
        file: __bdtClip(file, 500),
        line: typeof source.lineNumber === 'number' ? source.lineNumber : null,
        column: typeof source.columnNumber === 'number' ? source.columnNumber : null,
        origin: 'jsx',
      };
    } catch (error) {
      return null;
    }
  }

  function __bdtIsRuntimeFrame(frame) {
    const name = frame.functionName || '';
    if (/^(?:jsxDEV|jsxs|jsx|_jsx|_jsxs|createElement)$/.test(name)) return true;
    const url = frame.url.toLowerCase();
    if (url.indexOf('node_modules') === -1) return false;
    return /\/(?:react|react-dom|react-dom-client|react_jsx[^/]*runtime|jsx-dev-runtime|jsx-runtime|scheduler)[^/]*\.js$/.test(
      url,
    );
  }

  function __bdtStackSource(fiber) {
    try {
      const debugStack = fiber._debugStack;
      if (debugStack === null || debugStack === undefined) return null;
      const raw = typeof debugStack === 'string' ? debugStack : debugStack.stack;
      const frames = __bdtParseStack(raw);
      if (frames.length === 0) return null;
      for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index];
        if (__bdtIsRuntimeFrame(frame)) continue;
        return {
          component: frame.functionName,
          file: frame.url,
          line: frame.line,
          column: frame.column,
          origin: 'stack',
        };
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function __bdtSourceFile(type) {
    try {
      const raw = type && (type.__file || (type.type && type.type.__file));
      if (typeof raw !== 'string' || raw === '') return null;
      return __bdtClip(__bdtStripUrl(raw) || raw.split('?')[0], 500);
    } catch (error) {
      return null;
    }
  }

  function __bdtHookStates(fiber) {
    const states = [];
    let hook = null;
    try {
      hook = fiber.memoizedState;
    } catch (error) {
      hook = null;
    }
    if (hook === null || hook === undefined) return states;
    if (
      typeof hook === 'object' &&
      typeof hook.memoizedState === 'undefined' &&
      typeof hook.next === 'undefined'
    ) {
      states.push({ value: hook, path: 'estado' });
      return states;
    }
    const seen = new Set();
    let index = 0;
    while (hook !== null && hook !== undefined && typeof hook === 'object' && !seen.has(hook)) {
      seen.add(hook);
      let value;
      try {
        value = hook.memoizedState;
      } catch (error) {
        value = undefined;
      }
      if (value !== undefined) states.push({ value: value, path: 'estado[' + String(index) + ']' });
      try {
        hook = hook.next;
      } catch (error) {
        hook = null;
      }
      index += 1;
    }
    return states;
  }

  function __bdtIsDomNode(value) {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof value.nodeType === 'number' &&
      typeof value.nodeName === 'string'
    );
  }

  async function __bdtWalkComponent(props, states, onFound, clock, seen) {
    const stack = [];
    if (props !== null && typeof props === 'object') stack.push({ value: props, path: 'props' });
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index];
      stack.push({ value: state.value, path: state.path });
    }
    let ticks = 0;
    while (stack.length > 0) {
      if ((++ticks & 1023) === 0) await breathe(clock);
      const item = stack.pop();
      if (item === undefined) continue;
      const value = item.value;
      if (value === null || typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);
      if (__bdtIsDomNode(value) || value.$$typeof || typeof value.then === 'function') continue;
      const tag = state.parsed.get(value);
      if (tag !== undefined) {
        onFound(value, item.path, tag);
        continue;
      }
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          stack.push({ value: value[index], path: item.path + '[' + String(index) + ']' });
        }
        continue;
      }
      let names = [];
      try {
        names = Object.keys(value);
      } catch (error) {
        continue;
      }
      for (let index = names.length - 1; index >= 0; index -= 1) {
        const name = names[index];
        if (__bdtSkipKey(name)) continue;
        let child;
        try {
          child = value[name];
        } catch (error) {
          continue;
        }
        stack.push({ value: child, path: item.path + '.' + name });
      }
    }
  }

  function __bdtAddKey(keys, raw, allowDigits) {
    if (raw === null || raw === undefined) return;
    if (typeof raw === 'object' || typeof raw === 'function') return;
    const exact = __bdtNormalizeKey(raw);
    if (exact !== '' && exact.length <= 200) keys.add(exact);
    if (allowDigits !== false) {
      const digits = /^[.$]*(\d+)$/.exec(String(raw).trim());
      if (digits !== null) keys.add(digits[1]);
    }
  }

  function __bdtDomKeys(element, keys) {
    let node = element;
    while (node !== null && node !== undefined && node.nodeType === 1) {
      try {
        const attributes = node.attributes;
        if (attributes) {
          for (let index = 0; index < attributes.length; index += 1) {
            const attribute = attributes.item(index);
            if (attribute === null) continue;
            const name = String(attribute.name).toLowerCase();
            if (name === 'value' || name === 'style') continue;
            if (
              name === 'id' ||
              name === 'name' ||
              name === 'for' ||
              name === 'key' ||
              name === 'data-id' ||
              name === 'data-key' ||
              name === 'data-row-key' ||
              name === 'data-product-id' ||
              name === 'data-item-id' ||
              (name.indexOf('data-') === 0 && name.indexOf('id') !== -1)
            ) {
              __bdtAddKey(keys, attribute.value, true);
            }
            if (name === 'href' || name === 'action') {
              try {
                const url = new URL(attribute.value, location.href);
                const segments = url.pathname.split('/').filter(function (part) {
                  return part !== '';
                });
                if (segments.length > 0) __bdtAddKey(keys, segments[segments.length - 1], true);
                url.searchParams.forEach(function (value, key) {
                  if (/id|key|code|sku/i.test(key)) __bdtAddKey(keys, value, true);
                });
              } catch (error) {
                void error;
              }
            }
          }
        }
      } catch (error) {
        void error;
      }
      node = node.parentElement;
    }
  }

  async function __bdtProvenance(element) {
    const clock = createClock();
    const componentSeen = new WeakSet();
    const result = {
      framework: null,
      render: null,
      renderSources: [],
      functions: [],
      data: [],
      requests: [],
      note: null,
    };
    try {
      if (element === null || element === undefined) return result;
      let target = '';
      try {
        target = String(element.innerText !== undefined ? element.innerText : element.textContent || '');
      } catch (error) {
        target = '';
      }
      target = target.replace(/\s+/g, ' ').trim().slice(0, 500);
      const numbers = __bdtNumbers(target);
      const identityKeys = new Set();
      __bdtDomKeys(element, identityKeys);

      const functionSeen = new Set();
      const addFunction = function (name, framework, file, line, column) {
        const label = __bdtClip(name, 200);
        const key = framework + '|' + label + '|' + String(file) + '|' + String(line);
        if (functionSeen.has(key)) return;
        functionSeen.add(key);
        result.functions.push({
          name: label,
          framework: framework,
          file: file === undefined ? null : file,
          line: line === undefined ? null : line,
          column: column === undefined ? null : column,
        });
      };

      const candidates = [];
      const foundObjects = new WeakSet();
      const noteCandidate = function (value, component, framework, path, tag) {
        if (foundObjects.has(value)) return;
        foundObjects.add(value);
        candidates.push({
          value: value,
          component: component,
          framework: framework,
          path: path,
          tag: tag,
        });
      };

      let reactFound = false;
      let renderSource = null;
      let renderOwner = null;
      let vueRender = null;
      const renderSourceSeen = new Set();
      try {
        const keys = Object.keys(element);
        let fiber = null;
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index];
          if (key.indexOf('__reactFiber$') !== 0 && key.indexOf('__reactInternalInstance$') !== 0) {
            continue;
          }
          try {
            fiber = element[key];
          } catch (error) {
            fiber = null;
          }
          if (fiber) break;
        }
        while (fiber !== null && fiber !== undefined) {
          if (fiber.key !== null && fiber.key !== undefined) __bdtAddKey(identityKeys, fiber.key, true);
          let props = null;
          try {
            props = fiber.memoizedProps || fiber.pendingProps;
          } catch (error) {
            props = null;
          }
          if (props !== null && typeof props === 'object') {
            __bdtAddKey(identityKeys, props.id, true);
            __bdtAddKey(identityKeys, props['data-id'], true);
            __bdtAddKey(identityKeys, props['data-key'], true);
          }
          const fiberSource = __bdtDebugSource(fiber) || __bdtStackSource(fiber);
          let fiberOwner = null;
          try {
            const owner = fiber._debugOwner;
            if (owner !== null && owner !== undefined) fiberOwner = __bdtTypeName(owner.type);
          } catch (error) {
            fiberOwner = null;
          }
          if (fiberSource !== null) {
            const sourceOwner = fiberSource.component || fiberOwner;
            if (renderSource === null) {
              renderSource = fiberSource;
              renderOwner = sourceOwner;
            }
            const sourceKey = fiberSource.file + ':' + String(fiberSource.line);
            if (!renderSourceSeen.has(sourceKey)) {
              renderSourceSeen.add(sourceKey);
              result.renderSources.push({
                component: sourceOwner,
                file: fiberSource.file,
                line: fiberSource.line,
                column: fiberSource.column,
                origin: fiberSource.origin,
                code: null,
              });
            }
          }
          let type = null;
          try {
            type = fiber.type;
          } catch (error) {
            type = null;
          }
          if (typeof type !== 'string' && type !== null && typeof type !== 'symbol') {
            const name = __bdtTypeName(type) || 'componente';
            const original =
              fiberSource !== null && fiberSource.origin === 'jsx' ? fiberSource : null;
            addFunction(
              name,
              'react',
              original === null ? null : original.file,
              original === null ? null : original.line,
              original === null ? null : original.column,
            );
            reactFound = true;
            const states = __bdtHookStates(fiber);
            await __bdtWalkComponent(
              props,
              states,
              function (value, path, tag) {
                noteCandidate(value, name, 'react', path, tag);
              },
              clock,
              componentSeen,
            );
          }
          try {
            fiber = fiber.return;
          } catch (error) {
            fiber = null;
          }
        }
      } catch (error) {
        void error;
      }

      if (!reactFound) {
        try {
          let component = null;
          try {
            component = element.__vueParentComponent || null;
          } catch (error) {
            component = null;
          }
          while (component !== null && component !== undefined) {
            let type = null;
            try {
              type = component.type;
            } catch (error) {
              type = null;
            }
            let name = null;
            if (type) name = type.name || type.displayName || null;
            if (!name) name = component.__name || null;
            if (typeof name !== 'string' || name === '') name = 'componente';
            const file = __bdtSourceFile(type);
            addFunction(name, 'vue', file, null, null);
            if (vueRender === null && file !== null) {
              vueRender = { component: name, file: file };
            }
            let props = null;
            try {
              props = component.props || (component.vnode && component.vnode.props) || null;
            } catch (error) {
              props = null;
            }
            const states = [];
            try {
              if (component.setupState) states.push({ value: component.setupState, path: 'setupState' });
            } catch (error) {
              void error;
            }
            try {
              const data = component.data || (component.proxy && component.proxy.$data);
              if (data) states.push({ value: data, path: 'datos' });
            } catch (error) {
              void error;
            }
            await __bdtWalkComponent(
              props,
              states,
              function (value, path, tag) {
                noteCandidate(value, name, 'vue', path, tag);
              },
              clock,
              componentSeen,
            );
            try {
              component = component.parent;
            } catch (error) {
              component = null;
            }
          }
        } catch (error) {
          void error;
        }
      }

      if (result.functions.length > 0) {
        result.framework = result.functions[0].framework;
      }

      const nearestFunction = result.functions.length > 0 ? result.functions[0] : null;
      if (renderSource !== null) {
        result.render = {
          component:
            renderSource.component ||
            renderOwner ||
            (nearestFunction === null ? null : nearestFunction.name),
          file: renderSource.file,
          line: renderSource.line,
          column: renderSource.column,
          origin: renderSource.origin,
          code: null,
        };
      } else if (vueRender !== null) {
        result.render = {
          component: vueRender.component,
          file: vueRender.file,
          line: null,
          column: null,
          origin: 'file',
          code: null,
        };
      }

      let selected = candidates;
      if (identityKeys.size > 0) {
        const matched = [];
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          if (await __bdtContainsIdentity(candidate.value, identityKeys, clock)) {
            matched.push(candidate);
          }
        }
        if (matched.length > 0) {
          selected = matched;
          selected.sort(function (left, right) {
            const leftDirect = __bdtDirectIdentity(left.value, identityKeys) ? 0 : 1;
            const rightDirect = __bdtDirectIdentity(right.value, identityKeys) ? 0 : 1;
            return leftDirect - rightDirect;
          });
        }
      }

      const requestSeen = new Map();
      const noteRequest = function (info) {
        if (info === null || info === undefined) return null;
        if (requestSeen.has(info.key)) return info.key;
        requestSeen.set(info.key, true);
        result.requests.push({
          key: info.key,
          method: info.method,
          path: info.path,
          host: info.host,
          status: info.status,
          startedAt: info.startedAt,
          frames: info.frames,
        });
        return info.key;
      };

      const dataSeen = new Set();
      let ambiguous = false;
      for (let candidateIndex = 0; candidateIndex < selected.length; candidateIndex += 1) {
        const candidate = selected[candidateIndex];
        const identityRoots =
          identityKeys.size > 0
            ? await __bdtIdentityRoots(candidate.value, identityKeys, clock)
            : [];
        const roots =
          identityRoots.length > 0 ? identityRoots : [{ value: candidate.value, path: '$' }];
        for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
          const root = roots[rootIndex];
          const matches = await __bdtMatchValues(root.value, target, numbers, clock);
          for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
            const match = matches[matchIndex];
            const rootSuffix = root.path === '$' ? '' : root.path.slice(1);
            const matchSuffix = match.path === '$' ? '' : match.path.slice(1);
            const suffix = rootSuffix + matchSuffix;
            const jsonPath = candidate.tag.jsonPath + suffix;
            const dataPath = candidate.path + suffix;
            const requestKey = noteRequest(candidate.tag.info);
            const dedupe = requestKey + '|' + jsonPath + '|' + match.value + '|' + match.kind;
            if (dataSeen.has(dedupe)) continue;
            dataSeen.add(dedupe);
            result.data.push({
              component: candidate.component,
              framework: candidate.framework,
              path: __bdtClip(dataPath, 500),
              value: __bdtClip(match.value, 500),
              kind: match.kind,
              jsonPath: __bdtClip(jsonPath, 500),
              requestKey: requestKey,
            });
          }
        }
      }

      if (result.data.length === 0 && selected.length > 0) {
        const candidate = selected[0];
        const requestKey = noteRequest(candidate.tag.info);
        result.data.push({
          component: candidate.component,
          framework: candidate.framework,
          path: __bdtClip(candidate.path, 500),
          value: '',
          kind: 'object',
          jsonPath: __bdtClip(candidate.tag.jsonPath, 500),
          requestKey: requestKey,
        });
        result.note =
          'La respuesta está enlazada por identidad, pero el texto no coincide con un campo visible.';
      }

      if (identityKeys.size === 0 && candidates.length > 1) {
        ambiguous = true;
      }
      if (result.data.length > 1 && identityKeys.size === 0) {
        ambiguous = true;
      }
      if (ambiguous && result.note === null) {
        result.note =
          'Varios objetos de la respuesta pueden corresponder al texto; falta una clave de fila para desambiguar.';
      }
    } catch (error) {
      result.note = 'No se pudo leer la procedencia en tiempo de ejecución.';
    }
    return result;
  }

  globalThis[KEY] = { version: 1, provenance: __bdtProvenance };
})();
`;

export const RUNTIME_PROVENANCE_CALL = String.raw`
function () {
  const runtime = globalThis.__bdtRuntimeNetwork;
  if (!runtime || typeof runtime.provenance !== 'function') return null;
  try {
    return runtime.provenance(this);
  } catch (error) {
    return null;
  }
}
`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

function cleanHttpUrl(value: unknown): string | null {
  const raw = cleanString(value, 2048);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname}`.slice(0, 2048);
  } catch {
    return null;
  }
}

function cleanFile(value: unknown): string | null {
  const raw = cleanString(value, 500);
  if (raw === null) return null;
  try {
    const url = new URL(raw, 'http://local.invalid');
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}${url.pathname}`.slice(0, 500);
    }
  } catch {
    // Keep relative source paths.
  }
  return raw.split('?')[0]?.slice(0, 500) ?? null;
}

function finiteInt(value: unknown, min: number): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.trunc(value))
    : null;
}

function parseRuntimeFrame(value: unknown): RuntimeFrame | null {
  const record = asRecord(value);
  if (record === null) return null;
  const url = cleanHttpUrl(record.url);
  const line = finiteInt(record.line, 1);
  const column = finiteInt(record.column, 1);
  if (url === null) return null;
  return {
    functionName: cleanString(record.functionName, 200),
    url,
    line: line ?? 1,
    column: column ?? 1,
  };
}

function parseRuntimeRequest(value: unknown): RuntimeRequestInfo | null {
  const record = asRecord(value);
  if (record === null) return null;
  const key = cleanString(record.key, 80);
  const method = cleanString(record.method, 16);
  const path = cleanString(record.path, 2048);
  if (key === null || method === null || path === null) return null;
  const startedAt = finiteInt(record.startedAt, 0);
  if (startedAt === null) return null;
  const status = finiteInt(record.status, 100);
  const frames: RuntimeFrame[] = [];
  if (Array.isArray(record.frames)) {
    for (const item of record.frames) {
      const frame = parseRuntimeFrame(item);
      if (frame !== null) frames.push(frame);
    }
  }
  return {
    key,
    method: method.toUpperCase(),
    path: path.split('?')[0]?.split('#')[0] ?? path,
    host: cleanString(record.host, 255) ?? '',
    status: status !== null && status <= 599 ? status : null,
    startedAt,
    frames,
  };
}

function parseRuntimeFunction(value: unknown): RuntimeFunctionInfo | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = cleanString(record.name, 200);
  const framework =
    record.framework === 'vue' ? 'vue' : record.framework === 'react' ? 'react' : null;
  if (name === null || framework === null) return null;
  return {
    name,
    framework,
    file: cleanFile(record.file),
    line: finiteInt(record.line, 1),
    column: finiteInt(record.column, 1),
  };
}

function parseRuntimeRender(value: unknown): RuntimeRenderInfo | null {
  const record = asRecord(value);
  if (record === null) return null;
  const component = cleanString(record.component, 200);
  const file = cleanFile(record.file);
  if (component === null && file === null) return null;
  const origin = record.origin === 'stack' ? 'stack' : record.origin === 'file' ? 'file' : 'jsx';
  return {
    component,
    file,
    line: finiteInt(record.line, 1),
    column: finiteInt(record.column, 1),
    origin,
    code: cleanString(record.code, 500),
  };
}

function parseRuntimeData(value: unknown): RuntimeDataInfo | null {
  const record = asRecord(value);
  if (record === null) return null;
  const component = cleanString(record.component, 200);
  const framework =
    record.framework === 'vue' ? 'vue' : record.framework === 'react' ? 'react' : null;
  const path = cleanString(record.path, 500);
  const jsonPath = cleanString(record.jsonPath, 500);
  const requestKey = cleanString(record.requestKey, 80);
  const kind =
    record.kind === 'number' || record.kind === 'text' || record.kind === 'object'
      ? record.kind
      : null;
  if (component === null || framework === null || path === null || jsonPath === null) return null;
  if (requestKey === null || kind === null) return null;
  return {
    component,
    framework,
    path,
    value: typeof record.value === 'string' ? record.value.slice(0, 500) : '',
    kind,
    jsonPath,
    requestKey,
  };
}

export function parseRuntimeProvenance(value: unknown): RuntimeProvenance | null {
  const record = asRecord(value);
  if (record === null) return null;
  const functions: RuntimeFunctionInfo[] = [];
  const functionSeen = new Set<string>();
  if (Array.isArray(record.functions)) {
    for (const item of record.functions) {
      const entry = parseRuntimeFunction(item);
      if (entry === null) continue;
      const key = `${entry.framework}|${entry.name}|${entry.file ?? ''}|${String(entry.line ?? '')}`;
      if (functionSeen.has(key)) continue;
      functionSeen.add(key);
      functions.push(entry);
    }
  }
  const requests: RuntimeRequestInfo[] = [];
  const requestSeen = new Set<string>();
  if (Array.isArray(record.requests)) {
    for (const item of record.requests) {
      const entry = parseRuntimeRequest(item);
      if (entry === null || requestSeen.has(entry.key)) continue;
      requestSeen.add(entry.key);
      requests.push(entry);
    }
  }
  const data: RuntimeDataInfo[] = [];
  const dataSeen = new Set<string>();
  if (Array.isArray(record.data)) {
    for (const item of record.data) {
      const entry = parseRuntimeData(item);
      if (entry === null) continue;
      if (!requestSeen.has(entry.requestKey)) continue;
      const key = `${entry.requestKey}|${entry.jsonPath}|${entry.value}|${entry.kind}`;
      if (dataSeen.has(key)) continue;
      dataSeen.add(key);
      data.push(entry);
    }
  }
  const renderSources: RuntimeRenderInfo[] = [];
  const renderSourceSeen = new Set<string>();
  if (Array.isArray(record.renderSources)) {
    for (const item of record.renderSources) {
      const entry = parseRuntimeRender(item);
      if (entry === null || entry.file === null) continue;
      const key = `${entry.file}|${String(entry.line ?? '')}|${String(entry.column ?? '')}`;
      if (renderSourceSeen.has(key)) continue;
      renderSourceSeen.add(key);
      renderSources.push(entry);
    }
  }
  const framework =
    record.framework === 'vue' ? 'vue' : record.framework === 'react' ? 'react' : null;
  return {
    framework,
    render: parseRuntimeRender(record.render),
    renderSources,
    functions,
    data,
    requests,
    note: cleanString(record.note, 300),
  };
}
