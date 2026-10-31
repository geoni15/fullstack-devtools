export interface CapturedSqlFrame {
  functionName: string | null;
  file: string;
  line: number;
  column: number;
}

export interface CapturedSqlExecution {
  driver: string;
  sql: string;
  at: number;
  frames: CapturedSqlFrame[];
}

export interface SqlCaptureInfo {
  ok: boolean;
  drivers: string[];
  prisma: boolean;
  error: string | null;
}

export const SQL_CAPTURE_DRAIN_EXPRESSION = String.raw`
(() => {
  const capture = globalThis.__bdtSqlCapture;
  if (capture === undefined || capture === null) return '[]';
  try {
    return JSON.stringify(capture.drain());
  } catch (error) {
    return '[]';
  }
})()
`;

export const SQL_CAPTURE_SOURCE = String.raw`
(async () => {
  try {
    const existing = globalThis.__bdtSqlCapture;
    if (existing !== undefined && existing !== null && existing.info) {
      return JSON.stringify(existing.info);
    }
    const buffer = [];
    const recent = new Map();
    const state = {
      info: { ok: false, drivers: [], prisma: false, error: null },
      drain() {
        return buffer.splice(0, buffer.length);
      },
    };
    globalThis.__bdtSqlCapture = state;

    const clip = (value, max) => {
      const text = String(value);
      return text.length > max ? text.slice(0, max) : text;
    };

    const parseFrame = (line) => {
      const text = line.trim();
      if (text.indexOf('__bdt') !== -1) return null;
      if (text.indexOf('node_modules') !== -1) return null;
      if (text.indexOf('node:internal') !== -1) return null;
      if (text.indexOf('(internal/') !== -1) return null;
      const withFunction = /^at (.+?) \((.+):(\d+):(\d+)\)$/.exec(text);
      if (withFunction !== null) {
        return {
          functionName: withFunction[1],
          file: withFunction[2],
          line: Number(withFunction[3]),
          column: Number(withFunction[4]),
        };
      }
      const bare = /^at (.+):(\d+):(\d+)$/.exec(text);
      if (bare !== null) {
        return {
          functionName: null,
          file: bare[1],
          line: Number(bare[2]),
          column: Number(bare[3]),
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

    const record = (driver, rawSql) => {
      try {
        if (typeof rawSql !== 'string') return;
        const sql = rawSql.replace(/\s+/g, ' ').trim();
        if (sql === '' || sql.length > 4000) return;
        const now = Date.now();
        const key = driver + '\u0000' + sql;
        const last = recent.get(key);
        if (last !== undefined && now - last < 20) return;
        recent.set(key, now);
        buffer.push({ driver, sql: clip(sql, 2000), at: now, frames: captureStack() });
      } catch (error) {
        void error;
      }
    };

    const wrap = (driver, target, method, readSql) => {
      if (target === undefined || target === null) return false;
      let original;
      try {
        original = target[method];
      } catch (error) {
        return false;
      }
      if (typeof original !== 'function') return false;
      if (original.__bdtSqlPatched === true) return true;
      const wrapped = function (...args) {
        try {
          const sql = readSql(args, this);
          if (typeof sql === 'string') record(driver, sql);
        } catch (error) {
          void error;
        }
        return original.apply(this, args);
      };
      wrapped.__bdtSqlPatched = true;
      try {
        target[method] = wrapped;
      } catch (error) {
        return false;
      }
      return true;
    };

    const wrapPrepare = (driver, target, methods, readSql) => {
      if (target === undefined || target === null) return false;
      let original;
      try {
        original = target.prepare;
      } catch (error) {
        return false;
      }
      if (typeof original !== 'function') return false;
      if (original.__bdtSqlPatched === true) return true;
      const wrapped = function (...args) {
        const statement = original.apply(this, args);
        try {
          if (statement !== null && statement !== undefined) {
            for (const method of methods) {
              const run = statement[method];
              if (typeof run !== 'function' || run.__bdtSqlPatched === true) continue;
              const patched = function (...inner) {
                try {
                  const sql = readSql(this, args);
                  if (typeof sql === 'string') record(driver, sql);
                } catch (error) {
                  void error;
                }
                return run.apply(this, inner);
              };
              patched.__bdtSqlPatched = true;
              statement[method] = patched;
            }
          }
        } catch (error) {
          void error;
        }
        return statement;
      };
      wrapped.__bdtSqlPatched = true;
      try {
        target.prepare = wrapped;
      } catch (error) {
        return false;
      }
      return true;
    };

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
    try {
      const moduleApi = await import('node:module');
      for (const base of bases) {
        try {
          loaders.push(moduleApi.createRequire(base));
        } catch (error) {
          void error;
        }
      }
    } catch (error) {
      void error;
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

    const firstString = (value) => (typeof value === 'string' ? value : null);
    const firstSql = (value) => {
      if (typeof value === 'string') return value;
      if (value !== null && typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (typeof value.sql === 'string') return value.sql;
      }
      return null;
    };
    const preparedSql = (args) => firstSql(args[0]);

    const drivers = [];
    const apply = (name, patch) => {
      try {
        const module = load(name);
        if (module === null) return;
        if (patch(module)) drivers.push(name);
      } catch (error) {
        void error;
      }
    };

    apply('pg', (module) => {
      const client = module.Client && module.Client.prototype;
      return wrap('pg', client, 'query', (args) => firstSql(args[0]));
    });
    apply('mysql2', (module) => {
      const connection = module.Connection && module.Connection.prototype;
      const query = wrap('mysql2', connection, 'query', (args) => firstSql(args[0]));
      const execute = wrap('mysql2', connection, 'execute', (args) => firstSql(args[0]));
      return query || execute;
    });
    apply('mysql', (module) => {
      const connection = module.Connection && module.Connection.prototype;
      return wrap('mysql', connection, 'query', (args) => firstSql(args[0]));
    });
    apply('sqlite3', (module) => {
      const database = module.Database && module.Database.prototype;
      let patched = false;
      for (const method of ['run', 'all', 'get', 'each', 'exec']) {
        if (wrap('sqlite3', database, method, (args) => firstString(args[0]))) patched = true;
      }
      if (
        wrapPrepare('sqlite3', database, ['run', 'all', 'get', 'each'], (statement, args) =>
          preparedSql(args),
        )
      ) {
        patched = true;
      }
      return patched;
    });
    apply('better-sqlite3', (module) => {
      const database = module.prototype;
      let patched = false;
      if (wrap('better-sqlite3', database, 'exec', (args) => firstString(args[0]))) patched = true;
      if (wrap('better-sqlite3', database, 'pragma', (args) => firstString(args[0]))) patched = true;
      if (
        wrapPrepare('better-sqlite3', database, ['run', 'get', 'all', 'iterate'], (statement) =>
          statement && typeof statement.source === 'string' ? statement.source : null,
        )
      ) {
        patched = true;
      }
      return patched;
    });

    let prisma = false;
    try {
      prisma = load('@prisma/client') !== null;
    } catch (error) {
      void error;
    }

    state.info = { ok: true, drivers, prisma, error: null };
    return JSON.stringify(state.info);
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    try {
      if (globalThis.__bdtSqlCapture) {
        globalThis.__bdtSqlCapture.info = {
          ok: false,
          drivers: [],
          prisma: false,
          error: message,
        };
      }
    } catch (inner) {
      void inner;
    }
    return JSON.stringify({ ok: false, drivers: [], prisma: false, error: message });
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

export function parseSqlCaptureInfo(value: unknown): SqlCaptureInfo | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    ok: record.ok === true,
    drivers: cleanStringList(record.drivers, 40),
    prisma: record.prisma === true,
    error: cleanText(record.error, 300),
  };
}

function parseFrames(value: unknown): CapturedSqlFrame[] {
  if (!Array.isArray(value)) return [];
  const frames: CapturedSqlFrame[] = [];
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

export function parseCapturedSql(raw: string): CapturedSqlExecution[] {
  if (raw.length === 0 || raw.length > 1_500_000) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const executions: CapturedSqlExecution[] = [];
  for (const item of data) {
    const record = asRecord(item);
    if (record === null) continue;
    const driver = cleanText(record.driver, 40);
    const sql = cleanText(record.sql, 2000);
    if (driver === null || sql === null) continue;
    const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : Date.now();
    executions.push({ driver, sql, at, frames: parseFrames(record.frames) });
    if (executions.length >= 100) break;
  }
  return executions;
}
