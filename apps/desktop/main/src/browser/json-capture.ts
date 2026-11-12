export interface CapturedJsonFrame {
  functionName: string | null;
  file: string;
  line: number;
  column: number;
}

export type CapturedJsonKind = 'request' | 'response' | 'parse' | 'stringify';

export type CapturedJsonDirection = 'in' | 'out' | 'internal';

export interface CapturedJsonExecution {
  kind: CapturedJsonKind;
  direction: CapturedJsonDirection;
  method: string | null;
  path: string | null;
  status: number | null;
  at: number;
  body: string;
  truncated: boolean;
  frames: CapturedJsonFrame[];
}

export interface JsonCaptureInfo {
  ok: boolean;
  hooks: string[];
  error: string | null;
}

export const JSON_CAPTURE_DRAIN_EXPRESSION = String.raw`
(() => {
  const capture = globalThis.__bdtJsonCapture;
  if (capture === undefined || capture === null) return '[]';
  try {
    return capture.serialize(capture.drain());
  } catch (error) {
    return '[]';
  }
})()
`;

export const JSON_CAPTURE_SOURCE = String.raw`
(async () => {
  try {
    const CAPTURE_VERSION = '1';
    const installedAt = Date.now();
    const previous = globalThis.__bdtJsonCapture;
    if (
      previous !== undefined &&
      previous !== null &&
      previous.info &&
      previous.version === CAPTURE_VERSION
    ) {
      return JSON.stringify(previous.info);
    }
    const originalStringify = JSON.stringify;
    const buffer = [];
    const recent = new Map();
    const MAX_BUFFER = 2000;
    const MAX_RECENT = 1000;
    const MAX_BODY = 16000;
    let suppress = 0;
    const hooks = [];
    const state = {
      version: CAPTURE_VERSION,
      info: { ok: false, hooks, error: null },
      serialize(value) {
        suppress += 1;
        try {
          return originalStringify(value);
        } finally {
          suppress -= 1;
        }
      },
      drain() {
        let entries = buffer.splice(0, buffer.length);
        if (
          previous !== undefined &&
          previous !== null &&
          previous !== state &&
          typeof previous.drain === 'function'
        ) {
          try {
            const older = previous.drain();
            if (Array.isArray(older) && older.length > 0) {
              const kept = older.filter(
                (entry) =>
                  entry !== null &&
                  typeof entry === 'object' &&
                  typeof entry.at === 'number' &&
                  entry.at < installedAt,
              );
              if (kept.length > 0) entries = kept.concat(entries);
            }
          } catch (error) {
            void error;
          }
        }
        return entries;
      },
    };
    globalThis.__bdtJsonCapture = state;

    const hook = (name) => {
      if (hooks.indexOf(name) === -1) hooks.push(name);
    };

    const clip = (value, max) => {
      const text = String(value);
      return text.length > max ? text.slice(0, max) : text;
    };

    const cleanPath = (value) => {
      if (typeof value !== 'string' || value === '') return null;
      const mark = value.indexOf('?');
      const clean = mark === -1 ? value : value.slice(0, mark);
      return clip(clean, 400);
    };

    const looksJson = (text) => {
      if (typeof text !== 'string') return false;
      const trimmed = text.trim();
      if (trimmed.length < 2) return false;
      const first = trimmed.charAt(0);
      return (first === '{' || first === '[') && trimmed.length <= MAX_BODY * 8;
    };

    const parseFrame = (line) => {
      const text = line.trim();
      if (text.indexOf('__bdt') !== -1) return null;
      if (text.indexOf('node_modules') !== -1) return null;
      if (text.indexOf('node:internal') !== -1) return null;
      if (text.indexOf('(internal/') !== -1) return null;
      let match = /^at (.+?) \((.+):(\d+):(\d+)\)$/.exec(text);
      if (match !== null) {
        return {
          functionName: match[1],
          file: match[2],
          line: Number(match[3]),
          column: Number(match[4]),
        };
      }
      match = /^at (.+):(\d+):(\d+)$/.exec(text);
      if (match !== null) {
        return {
          functionName: null,
          file: match[1],
          line: Number(match[2]),
          column: Number(match[3]),
        };
      }
      return null;
    };

    const captureStack = () => {
      const frames = [];
      try {
        const stack = new Error().stack || '';
        for (const line of stack.split('\n').slice(1)) {
          const frame = parseFrame(line);
          if (frame === null) continue;
          if (frame.file.indexOf('node:') === 0) continue;
          if (frame.file.indexOf('internal/') === 0) continue;
          frames.push({
            functionName:
              frame.functionName === null ? null : clip(frame.functionName, 120),
            file: clip(frame.file, 400),
            line: frame.line,
            column: frame.column,
          });
          if (frames.length >= 4) break;
        }
      } catch (error) {
        void error;
      }
      return frames;
    };

    const record = (kind, direction, method, path, status, body) => {
      try {
        if (typeof body !== 'string' || body.length === 0) return null;
        if (!looksJson(body)) return null;
        const now = Date.now();
        const key =
          kind + '\u0000' + (method === null ? '' : method) + '\u0000' +
          (path === null ? '' : path) + '\u0000' + String(body.length) + '\u0000' +
          body.slice(0, 240);
        const last = recent.get(key);
        if (last !== undefined && now - last < 30) return null;
        recent.set(key, now);
        if (recent.size > MAX_RECENT) {
          const oldest = recent.keys().next();
          if (!oldest.done) recent.delete(oldest.value);
        }
        const entry = {
          kind,
          direction,
          method: method === null ? null : clip(method, 12),
          path,
          status,
          at: now,
          body: clip(body, MAX_BODY),
          truncated: body.length > MAX_BODY,
          frames: captureStack(),
        };
        buffer.push(entry);
        if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
        return entry;
      } catch (error) {
        return null;
      }
    };

    try {
      const original = JSON.parse;
      if (typeof original === 'function') {
        const patched = function (...args) {
          const result = original.apply(this, args);
          if (suppress === 0 && result !== null && typeof result === 'object') {
            try {
              if (looksJson(args[0])) record('parse', 'internal', null, null, null, args[0]);
            } catch (error) {
              void error;
            }
          }
          return result;
        };
        patched.__bdtJsonPatched = true;
        JSON.parse = patched;
        hook('JSON.parse');
      }
    } catch (error) {
      void error;
    }

    try {
      const original = JSON.stringify;
      if (typeof original === 'function') {
        const patched = function (...args) {
          const result = original.apply(this, args);
          if (
            suppress === 0 &&
            typeof result === 'string' &&
            args[0] !== null &&
            typeof args[0] === 'object' &&
            looksJson(result)
          ) {
            try {
              record('stringify', 'internal', null, null, null, result);
            } catch (error) {
              void error;
            }
          }
          return result;
        };
        patched.__bdtJsonPatched = true;
        JSON.stringify = patched;
        hook('JSON.stringify');
      }
    } catch (error) {
      void error;
    }

    const moduleApi = (() => {
      try {
        if (typeof process.getBuiltinModule === 'function') {
          return process.getBuiltinModule('node:module');
        }
      } catch (error) {
        void error;
      }
      try {
        if (process.mainModule && process.mainModule.constructor) {
          return process.mainModule.constructor;
        }
      } catch (error) {
        void error;
      }
      return null;
    })();

    const bases = [];
    try {
      if (process.argv && typeof process.argv[1] === 'string') bases.push(process.argv[1]);
    } catch (error) {
      void error;
    }
    try {
      bases.push(process.cwd() + '/index.js');
    } catch (error) {
      void error;
    }

    const loaders = [];
    try {
      if (typeof require === 'function') loaders.push(require);
    } catch (error) {
      void error;
    }
    try {
      if (process.mainModule && typeof process.mainModule.require === 'function') {
        loaders.push(process.mainModule.require.bind(process.mainModule));
      }
    } catch (error) {
      void error;
    }
    if (moduleApi !== null && typeof moduleApi.createRequire === 'function') {
      for (const base of bases) {
        try {
          loaders.push(moduleApi.createRequire(base));
        } catch (error) {
          void error;
        }
      }
    }

    const load = (name) => {
      for (const loader of loaders) {
        try {
          const module = loader(name);
          if (module !== undefined && module !== null) return module;
        } catch (error) {
          void error;
        }
      }
      return null;
    };

    const bufferText = (value) => {
      try {
        if (typeof value === 'string') return value;
        if (value === null || value === undefined) return null;
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value.toString('utf8');
        if (ArrayBuffer.isView(value)) {
          return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
        }
      } catch (error) {
        void error;
      }
      return null;
    };

    const headerIsJson = (target) => {
      try {
        if (target === null || target === undefined || typeof target.getHeader !== 'function') {
          return false;
        }
        const value = target.getHeader('content-type');
        if (typeof value === 'string') return /json/i.test(value);
        if (Array.isArray(value)) return value.some((item) => typeof item === 'string' && /json/i.test(item));
      } catch (error) {
        void error;
      }
      return false;
    };

    const collect = (store, owner, chunk) => {
      if (chunk === null || chunk === undefined) return;
      const current = store.get(owner);
      if (current !== undefined && current.length > MAX_BODY * 8) return;
      const text = bufferText(chunk);
      if (text === null || text === '') return;
      store.set(owner, current === undefined ? text : current + text);
      if (store.size > 2000) {
        const oldest = store.keys().next();
        if (!oldest.done) store.delete(oldest.value);
      }
    };

    const patchServerResponse = (label, prototype) => {
      if (prototype === undefined || prototype === null) return;
      const bodies = new WeakMap();
      let patched = false;
      try {
        const originalWrite = prototype.write;
        if (typeof originalWrite === 'function' && originalWrite.__bdtJsonPatched !== true) {
          const write = function (chunk, ...rest) {
            try {
              if (suppress === 0) collect(bodies, this, chunk);
            } catch (error) {
              void error;
            }
            return originalWrite.call(this, chunk, ...rest);
          };
          write.__bdtJsonPatched = true;
          write.__bdtJsonOriginal = originalWrite;
          prototype.write = write;
          patched = true;
        }
      } catch (error) {
        void error;
      }
      try {
        const originalEnd = prototype.end;
        if (typeof originalEnd === 'function' && originalEnd.__bdtJsonPatched !== true) {
          const end = function (chunk, ...rest) {
            try {
              if (suppress === 0) {
                if (chunk !== null && chunk !== undefined && typeof chunk !== 'function') {
                  collect(bodies, this, chunk);
                }
                const body = bodies.get(this);
                bodies.delete(this);
                if (body !== undefined && (headerIsJson(this) || looksJson(body))) {
                  const request = this.req;
                  const method =
                    request !== null && request !== undefined && typeof request.method === 'string'
                      ? request.method
                      : null;
                  const path =
                    request !== null && request !== undefined && typeof request.url === 'string'
                      ? cleanPath(request.url)
                      : null;
                  const status = typeof this.statusCode === 'number' ? this.statusCode : null;
                  record('response', 'out', method, path, status, body);
                }
              } else {
                bodies.delete(this);
              }
            } catch (error) {
              void error;
            }
            return originalEnd.call(this, chunk, ...rest);
          };
          end.__bdtJsonPatched = true;
          end.__bdtJsonOriginal = originalEnd;
          prototype.end = end;
          patched = true;
        }
      } catch (error) {
        void error;
      }
      if (patched) hook(label);
    };

    const patchClientRequest = (label, prototype) => {
      if (prototype === undefined || prototype === null) return;
      const bodies = new WeakMap();
      let patched = false;
      const describe = (request) => {
        let method = null;
        let path = null;
        try {
          method = typeof request.method === 'string' ? request.method : null;
          if (typeof request.path === 'string') path = cleanPath(request.path);
          if (path === null && typeof request.host === 'string') path = clip(request.host, 400);
        } catch (error) {
          void error;
        }
        return { method, path };
      };
      for (const name of ['write', 'end']) {
        try {
          const original = prototype[name];
          if (typeof original !== 'function' || original.__bdtJsonPatched === true) continue;
          const wrapped = function (chunk, ...rest) {
            try {
              if (suppress === 0) {
                if (chunk !== null && chunk !== undefined && typeof chunk !== 'function') {
                  collect(bodies, this, chunk);
                }
                if (name === 'end') {
                  const body = bodies.get(this);
                  bodies.delete(this);
                  if (body !== undefined && (headerIsJson(this) || looksJson(body))) {
                    const info = describe(this);
                    record('request', 'out', info.method, info.path, null, body);
                  }
                }
              } else if (name === 'end') {
                bodies.delete(this);
              }
            } catch (error) {
              void error;
            }
            return original.call(this, chunk, ...rest);
          };
          wrapped.__bdtJsonPatched = true;
          wrapped.__bdtJsonOriginal = original;
          prototype[name] = wrapped;
          patched = true;
        } catch (error) {
          void error;
        }
      }
      if (patched) hook(label);
    };

    const http = load('node:http') ?? load('http');
    if (http !== null && typeof http === 'object') {
      try {
        patchServerResponse('http.server', http.ServerResponse && http.ServerResponse.prototype);
      } catch (error) {
        void error;
      }
      try {
        patchClientRequest('http.client', http.ClientRequest && http.ClientRequest.prototype);
      } catch (error) {
        void error;
      }
    }
    const https = load('node:https') ?? load('https');
    if (https !== null && typeof https === 'object') {
      try {
        patchServerResponse('https.server', https.ServerResponse && https.ServerResponse.prototype);
      } catch (error) {
        void error;
      }
      try {
        patchClientRequest('https.client', https.ClientRequest && https.ClientRequest.prototype);
      } catch (error) {
        void error;
      }
    }

    try {
      if (typeof globalThis.fetch === 'function' && globalThis.fetch.__bdtJsonPatched !== true) {
        const originalFetch = globalThis.fetch;
        const wrapped = function (input, init) {
          let method = 'GET';
          let path = null;
          let body = null;
          try {
            if (input !== null && typeof input === 'object' && typeof input.url === 'string') {
              method = typeof input.method === 'string' ? input.method : method;
              const parsed = new URL(input.url);
              path = clip(parsed.pathname, 400);
            } else if (typeof input === 'string') {
              const parsed = new URL(input, 'http://localhost');
              path = clip(parsed.pathname, 400);
            }
            if (init !== null && typeof init === 'object') {
              if (typeof init.method === 'string') method = init.method;
              if (typeof init.body === 'string' && looksJson(init.body)) body = init.body;
            }
          } catch (error) {
            void error;
          }
          if (body !== null && suppress === 0) {
            try {
              record('request', 'out', method, path, null, body);
            } catch (error) {
              void error;
            }
          }
          const promise = originalFetch.apply(this, arguments);
          try {
            if (promise !== null && typeof promise.then === 'function') {
              const observed = promise.then((response) => {
                try {
                  if (
                    suppress === 0 &&
                    response !== null &&
                    typeof response === 'object' &&
                    typeof response.clone === 'function'
                  ) {
                    const contentType =
                      response.headers && typeof response.headers.get === 'function'
                        ? response.headers.get('content-type')
                        : null;
                    if (typeof contentType === 'string' && /json/i.test(contentType)) {
                      response
                        .clone()
                        .text()
                        .then((text) => {
                          try {
                            if (text.length > 0) {
                              record(
                                'response',
                                'in',
                                method,
                                path,
                                typeof response.status === 'number' ? response.status : null,
                                text,
                              );
                            }
                          } catch (error) {
                            void error;
                          }
                        })
                        .catch(() => undefined);
                    }
                  }
                } catch (error) {
                  void error;
                }
                return response;
              });
              if (typeof observed.catch === 'function') {
                observed.catch(() => undefined);
              }
            }
          } catch (error) {
            void error;
          }
          return promise;
        };
        wrapped.__bdtJsonPatched = true;
        wrapped.__bdtJsonOriginal = originalFetch;
        globalThis.fetch = wrapped;
        hook('fetch');
      }
    } catch (error) {
      void error;
    }

    state.info = {
      ok: hooks.length > 0,
      hooks,
      error:
        hooks.length === 0
          ? 'El runtime del backend no expone hooks utilizables para leer JSON.'
          : null,
    };
    return originalStringify(state.info);
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    try {
      if (globalThis.__bdtJsonCapture) {
        globalThis.__bdtJsonCapture.info = { ok: false, hooks: [], error: message };
      }
    } catch (inner) {
      void inner;
    }
    return JSON.stringify({ ok: false, hooks: [], error: message });
  }
})()
`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function cleanStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = cleanText(item, max);
    if (text !== null && !result.includes(text)) result.push(text);
  }
  return result;
}

export function parseJsonCaptureInfo(value: unknown): JsonCaptureInfo | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    ok: record.ok === true,
    hooks: cleanStringList(record.hooks, 40),
    error: cleanText(record.error, 300),
  };
}

function parseFrames(value: unknown): CapturedJsonFrame[] {
  if (!Array.isArray(value)) return [];
  const frames: CapturedJsonFrame[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === null) continue;
    const file = cleanText(record.file, 400);
    if (file === null) continue;
    const line = typeof record.line === 'number' && Number.isFinite(record.line) ? record.line : 0;
    const column =
      typeof record.column === 'number' && Number.isFinite(record.column) ? record.column : 0;
    frames.push({
      functionName: cleanText(record.functionName, 120),
      file,
      line: Math.max(0, Math.trunc(line)),
      column: Math.max(0, Math.trunc(column)),
    });
    if (frames.length >= 4) break;
  }
  return frames;
}

const KINDS: CapturedJsonKind[] = ['request', 'response', 'parse', 'stringify'];

function parseKind(value: unknown): CapturedJsonKind | null {
  return typeof value === 'string' && (KINDS as string[]).includes(value)
    ? (value as CapturedJsonKind)
    : null;
}

function parseDirection(value: unknown, kind: CapturedJsonKind): CapturedJsonDirection {
  if (value === 'in' || value === 'out' || value === 'internal') return value;
  if (kind === 'parse' || kind === 'stringify') return 'internal';
  return kind === 'request' ? 'out' : 'in';
}

export function parseCapturedJson(raw: string): CapturedJsonExecution[] {
  if (raw.length === 0 || raw.length > 4_000_000) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const executions: CapturedJsonExecution[] = [];
  for (const item of data) {
    const record = asRecord(item);
    if (record === null) continue;
    const kind = parseKind(record.kind);
    const body = cleanText(record.body, 16000);
    if (kind === null || body === null) continue;
    const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : Date.now();
    const status =
      typeof record.status === 'number' && Number.isFinite(record.status)
        ? Math.trunc(record.status)
        : null;
    executions.push({
      kind,
      direction: parseDirection(record.direction, kind),
      method: cleanText(record.method, 12),
      path: cleanText(record.path, 400),
      status,
      at,
      body,
      truncated: record.truncated === true,
      frames: parseFrames(record.frames),
    });
    if (executions.length >= 200) break;
  }
  return executions;
}
