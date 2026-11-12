export interface CapturedSqlFrame {
  functionName: string | null;
  file: string;
  line: number;
  column: number;
}

export interface CapturedSqlSample {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  truncated: boolean;
}

export interface CapturedSqlExecution {
  driver: string;
  sql: string;
  at: number;
  frames: CapturedSqlFrame[];
  sample: CapturedSqlSample | null;
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
    const json = globalThis.__bdtJsonCapture;
    if (json !== undefined && json !== null && typeof json.serialize === 'function') {
      return json.serialize(capture.drain());
    }
    return JSON.stringify(capture.drain());
  } catch (error) {
    return '[]';
  }
})()
`;

export const SQL_CAPTURE_SOURCE = String.raw`
(async () => {
  try {
    const safeStringify = (value) => {
      const json = globalThis.__bdtJsonCapture;
      if (json !== undefined && json !== null && typeof json.serialize === 'function') {
        try {
          return json.serialize(value);
        } catch (error) {
          void error;
        }
      }
      return JSON.stringify(value);
    };
    const CAPTURE_VERSION = '9';
    const installedAt = Date.now();
    const previous = globalThis.__bdtSqlCapture;
    if (
      previous !== undefined &&
      previous !== null &&
      previous.info &&
      previous.version === CAPTURE_VERSION
    ) {
      return safeStringify(previous.info);
    }
    const buffer = [];
    const recent = new Map();
    const MAX_BUFFER = 2000;
    const MAX_RECENT = 1000;
    let sampleBudget = 200000;
    const state = {
      version: CAPTURE_VERSION,
      info: { ok: false, drivers: [], prisma: false, error: null },
      drain() {
        sampleBudget = 200000;
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
    globalThis.__bdtSqlCapture = state;

    const clip = (value, max) => {
      const text = String(value);
      return text.length > max ? text.slice(0, max) : text;
    };

    const SAMPLE_ROWS = 12;
    const SAMPLE_COLUMNS = 24;
    const SAMPLE_CELL = 240;

    const sampleValue = (value) => {
      try {
        if (value === null || value === undefined) return null;
        const type = typeof value;
        if (type === 'string') return clip(value, SAMPLE_CELL);
        if (type === 'number') return isFinite(value) ? value : String(value);
        if (type === 'boolean') return value;
        if (type === 'bigint') return value.toString();
        if (value instanceof Date) return value.toISOString();
        if (ArrayBuffer.isView(value)) return '<binario ' + String(value.byteLength) + ' B>';
        if (type === 'object' && typeof value.toISOString === 'function') {
          try {
            return value.toISOString();
          } catch (error) {
            void error;
          }
        }
        if (type === 'object') return clip(safeStringify(value), SAMPLE_CELL);
        return clip(String(value), SAMPLE_CELL);
      } catch (error) {
        return '[valor no serializable]';
      }
    };

    const sampleColumns = (fields, firstRow) => {
      const names = [];
      try {
        if (Array.isArray(fields)) {
          for (const field of fields) {
            if (field !== null && typeof field === 'object' && typeof field.name === 'string') {
              names.push(field.name);
            }
          }
        }
        if (names.length === 0 && firstRow !== null && typeof firstRow === 'object' && !Array.isArray(firstRow)) {
          for (const key of Object.keys(firstRow)) names.push(key);
        }
      } catch (error) {
        void error;
      }
      return names.slice(0, SAMPLE_COLUMNS);
    };

    const captureRows = (entry, rows, fields) => {
      try {
        if (entry === null || !Array.isArray(rows)) return;
        const first = rows.length > 0 ? rows[0] : null;
        const names = sampleColumns(fields, first);
        if (rows.length === 0 && names.length === 0) return;
        const captured = [];
        for (let index = 0; index < rows.length && index < SAMPLE_ROWS; index++) {
          const row = rows[index];
          const cells = [];
          if (Array.isArray(row)) {
            for (let position = 0; position < row.length && position < SAMPLE_COLUMNS; position++) {
              cells.push(sampleValue(row[position]));
            }
          } else if (row !== null && typeof row === 'object') {
            for (const name of names) cells.push(sampleValue(row[name]));
          } else {
            cells.push(sampleValue(row));
          }
          captured.push(cells);
        }
        const columns = names.slice();
        if (columns.length === 0 && Array.isArray(first)) {
          for (let position = 0; position < first.length && position < SAMPLE_COLUMNS; position++) {
            columns.push('columna_' + String(position + 1));
          }
        }
        let size = 0;
        for (const name of columns) size += name.length;
        for (const row of captured) {
          for (const cell of row) {
            if (typeof cell === 'string') size += cell.length;
          }
        }
        if (size > sampleBudget) return;
        sampleBudget -= size;
        const fieldCount = Array.isArray(fields) ? fields.length : 0;
        const keyCount =
          first !== null && typeof first === 'object' && !Array.isArray(first)
            ? Object.keys(first).length
            : 0;
        const wideCells = rows
          .slice(0, SAMPLE_ROWS)
          .some((row) => Array.isArray(row) && row.length > SAMPLE_COLUMNS);
        entry.sample = {
          columns,
          rows: captured,
          rowCount: rows.length,
          truncated:
            rows.length > SAMPLE_ROWS ||
            fieldCount > SAMPLE_COLUMNS ||
            keyCount > SAMPLE_COLUMNS ||
            wideCells,
        };
      } catch (error) {
        void error;
      }
    };

    const captureRowObject = (entry, value) => {
      try {
        if (entry === null || value === null || typeof value !== 'object' || Array.isArray(value)) return;
        if (
          'affectedRows' in value ||
          'insertId' in value ||
          'changes' in value ||
          'lastInsertRowid' in value ||
          'rowsAffected' in value
        ) {
          return;
        }
        if (Object.keys(value).length === 0) return;
        captureRows(entry, [value], []);
      } catch (error) {
        void error;
      }
    };

    const captureResult = (entry, result) => {
      try {
        if (entry === null || result === null || result === undefined) return;
        if (Array.isArray(result)) {
          if (result.length === 2 && Array.isArray(result[1]) && !Array.isArray(result[0])) {
            return;
          }
          if (result.length > 0 && Array.isArray(result[0])) {
            captureRows(entry, result[0], Array.isArray(result[1]) ? result[1] : []);
            return;
          }
          captureRows(entry, result, []);
          return;
        }
        if (typeof result === 'object' && Array.isArray(result.recordset)) {
          captureRows(entry, result.recordset, Array.isArray(result.fields) ? result.fields : []);
          return;
        }
        if (typeof result === 'object' && Array.isArray(result.rows)) {
          captureRows(entry, result.rows, Array.isArray(result.fields) ? result.fields : []);
          return;
        }
        captureRowObject(entry, result);
      } catch (error) {
        void error;
      }
    };

    const attachQueryObject = (entry, query) => {
      try {
        if (query === null || typeof query !== 'object') return;
        if (typeof query.on !== 'function' || typeof query.once !== 'function') return;
        const rows = [];
        let fields = [];
        let finished = false;
        const isSummary = (value) =>
          value !== null &&
          typeof value === 'object' &&
          ('affectedRows' in value ||
            'insertId' in value ||
            'changes' in value ||
            'lastInsertRowid' in value ||
            'rowsAffected' in value);
        const finish = () => {
          if (finished) return;
          finished = true;
          try {
            let selected = rows.length > 0 ? rows : null;
            let selectedFields = fields;
            if (selected === null && Array.isArray(query._rows)) {
              const firstSet = query._rows[0];
              if (Array.isArray(firstSet)) {
                selected = firstSet;
                const firstFields = Array.isArray(query._fields) ? query._fields[0] : null;
                if (Array.isArray(firstFields)) selectedFields = firstFields;
              }
            }
            if (selected === null && Array.isArray(query.rows)) {
              selected = query.rows;
              if (Array.isArray(query.fields)) selectedFields = query.fields;
            }
            if (selected !== null) {
              const visible = selected.filter((row) => !isSummary(row));
              if (visible.length > 0) captureRows(entry, visible, selectedFields);
            }
          } catch (error) {
            void error;
          }
        };
        query.on('fields', (value) => {
          if (Array.isArray(value)) fields = value;
        });
        query.on('result', (row) => {
          if (!isSummary(row) && rows.length < SAMPLE_ROWS) rows.push(row);
        });
        query.on('end', finish);
        query.once('error', () => {
          finished = true;
        });
      } catch (error) {
        void error;
      }
    };

    const wrapResultCallback = (entry, callback) => {
      return function (...callbackArgs) {
        try {
          const result = callbackArgs[1];
          if (typeof result === 'object' && result !== null && Array.isArray(result.rows)) {
            captureRows(entry, result.rows, Array.isArray(result.fields) ? result.fields : []);
          } else if (Array.isArray(result)) {
            captureRows(entry, result, Array.isArray(callbackArgs[2]) ? callbackArgs[2] : []);
          } else {
            captureRowObject(entry, result);
          }
        } catch (error) {
          void error;
        }
        return callback.apply(this, callbackArgs);
      };
    };

    const wrapThenable = (entry, value) => {
      try {
        if (
          value !== null &&
          (typeof value === 'object' || typeof value === 'function') &&
          typeof value.then === 'function' &&
          typeof value.catch === 'function'
        ) {
          const observer = value.then(
            (result) => {
              captureResult(entry, result);
              return result;
            },
            () => undefined,
          );
          if (observer !== null && typeof observer === 'object' && typeof observer.catch === 'function') {
            observer.catch(() => undefined);
          }
        }
      } catch (error) {
        void error;
      }
      return value;
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
        if (typeof rawSql !== 'string') return null;
        const sql = rawSql.replace(/\s+/g, ' ').trim();
        if (sql === '' || sql.length > 4000) return null;
        const now = Date.now();
        const key = driver + '\u0000' + sql;
        const last = recent.get(key);
        if (last !== undefined && now - last < 20) return null;
        recent.set(key, now);
        if (recent.size > MAX_RECENT) {
          const oldest = recent.keys().next();
          if (!oldest.done) recent.delete(oldest.value);
        }
        const entry = { driver, sql: clip(sql, 2000), at: now, frames: captureStack(), sample: null };
        buffer.push(entry);
        if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
        return entry;
      } catch (error) {
        return null;
      }
    };

    const wrap = (driver, target, method, readSql, capturePromise, captureCallback) => {
      if (target === undefined || target === null) return false;
      let original;
      try {
        original = target[method];
      } catch (error) {
        return false;
      }
      if (typeof original !== 'function') return false;
      if (original.__bdtSqlPatched === true) {
        if (original.__bdtSqlVersion === CAPTURE_VERSION) return true;
        if (typeof original.__bdtSqlOriginal === 'function') original = original.__bdtSqlOriginal;
      }
      const wrapped = function (...args) {
        let entry = null;
        try {
          const sql = readSql(args, this);
          if (typeof sql === 'string') entry = record(driver, sql);
        } catch (error) {
          void error;
        }
        if (entry !== null && args.length > 0) attachQueryObject(entry, args[0]);
        let hasCallback = false;
        if (entry !== null && captureCallback !== false) {
          for (let index = args.length - 1; index >= 0; index--) {
            if (typeof args[index] === 'function') {
              args[index] = wrapResultCallback(entry, args[index]);
              hasCallback = true;
              break;
            }
          }
        }
        const result = original.apply(this, args);
        if (entry !== null && capturePromise === true && !hasCallback) {
          return wrapThenable(entry, result);
        }
        return result;
      };
      wrapped.__bdtSqlPatched = true;
      wrapped.__bdtSqlVersion = CAPTURE_VERSION;
      wrapped.__bdtSqlOriginal = original;
      try {
        target[method] = wrapped;
      } catch (error) {
        return false;
      }
      return true;
    };

    const wrapPrepare = (driver, target, methods, readSql, captureMode) => {
      if (target === undefined || target === null) return false;
      let original;
      try {
        original = target.prepare;
      } catch (error) {
        return false;
      }
      if (typeof original !== 'function') return false;
      if (original.__bdtSqlPatched === true) {
        if (original.__bdtSqlVersion === CAPTURE_VERSION) return true;
        if (typeof original.__bdtSqlOriginal === 'function') original = original.__bdtSqlOriginal;
      }
      const captureFor = (method) => {
        if (captureMode === 'callback') return 'callback';
        if (captureMode !== null && typeof captureMode === 'object') {
          return captureMode[method] === undefined ? null : captureMode[method];
        }
        return null;
      };
      const wrapped = function (...args) {
        const statement = original.apply(this, args);
        try {
          if (statement !== null && statement !== undefined) {
            for (const method of methods) {
              let run = statement[method];
              if (typeof run !== 'function') continue;
              if (run.__bdtSqlPatched === true) {
                if (run.__bdtSqlVersion === CAPTURE_VERSION) continue;
                if (typeof run.__bdtSqlOriginal === 'function') run = run.__bdtSqlOriginal;
              }
              const mode = captureFor(method);
              const patched = function (...inner) {
                let entry = null;
                try {
                  const sql = readSql(this, args);
                  if (typeof sql === 'string') entry = record(driver, sql);
                } catch (error) {
                  void error;
                }
                if (entry !== null && mode === 'callback') {
                  for (let index = inner.length - 1; index >= 0; index--) {
                    if (typeof inner[index] === 'function') {
                      inner[index] = wrapResultCallback(entry, inner[index]);
                      break;
                    }
                  }
                }
                const value = run.apply(this, inner);
                if (entry !== null && mode === 'array' && Array.isArray(value)) {
                  captureRows(entry, value, []);
                } else if (entry !== null && mode === 'row') {
                  captureRowObject(entry, value);
                }
                return value;
              };
              patched.__bdtSqlPatched = true;
              patched.__bdtSqlVersion = CAPTURE_VERSION;
              patched.__bdtSqlOriginal = run;
              statement[method] = patched;
            }
          }
        } catch (error) {
          void error;
        }
        return statement;
      };
      wrapped.__bdtSqlPatched = true;
      wrapped.__bdtSqlVersion = CAPTURE_VERSION;
      wrapped.__bdtSqlOriginal = original;
      try {
        target.prepare = wrapped;
      } catch (error) {
        return false;
      }
      return true;
    };

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

    const packageOf = (file) => {
      if (typeof file !== 'string') return null;
      const parts = file.split(/[\\/]/);
      let depth = -1;
      for (let index = parts.length - 1; index >= 0; index--) {
        if (parts[index] === 'node_modules') {
          depth = index;
          break;
        }
      }
      if (depth === -1 || depth + 1 >= parts.length) return null;
      const first = parts[depth + 1];
      if (first.charAt(0) === '@') {
        if (depth + 2 >= parts.length) return null;
        return first + '/' + parts[depth + 2];
      }
      return first;
    };

    const firstString = (value) => (typeof value === 'string' ? value : null);
    const firstSql = (value) => {
      if (typeof value === 'string') return value;
      if (value !== null && typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (typeof value.sql === 'string') return value.sql;
        if (typeof value.query === 'string') return value.query;
      }
      return null;
    };
    const preparedSql = (args) => firstSql(args[0]);

    const drivers = [];
    const markDriver = (name) => {
      if (drivers.indexOf(name) === -1) drivers.push(name);
    };
    const readSqlArg = (args) => firstSql(args[0]);

    const adapters = {
      pg: (module) => {
        const client = module.Client && module.Client.prototype;
        return wrap('pg', client, 'query', readSqlArg, true);
      },
      mysql2: (module) => {
        const targets = new Set();
        const add = (value) => {
          if (typeof value !== 'function' || value.prototype === null || value.prototype === undefined) {
            return;
          }
          const name = typeof value.name === 'string' ? value.name : '';
          if (/Pool(Cluster)?$/.test(name)) return;
          let proto = value.prototype;
          let depth = 0;
          while (proto !== null && proto !== undefined && proto !== Object.prototype && depth < 5) {
            targets.add(proto);
            proto = Object.getPrototypeOf(proto);
            depth += 1;
          }
        };
        if (typeof module === 'function') add(module);
        if (module !== null && typeof module === 'object') {
          add(module.Connection);
          add(module.PoolConnection);
        }
        let patched = false;
        for (const target of targets) {
          if (wrap('mysql2', target, 'query', readSqlArg, true)) patched = true;
          if (wrap('mysql2', target, 'execute', readSqlArg, true)) patched = true;
        }
        return patched;
      },
      mysql: (module) => {
        const connection = module.Connection && module.Connection.prototype;
        return wrap('mysql', connection, 'query', readSqlArg, false);
      },
      mariadb: (module) => {
        const connection = module.Connection && module.Connection.prototype;
        const query = wrap('mariadb', connection, 'query', readSqlArg, true);
        const execute = wrap('mariadb', connection, 'execute', readSqlArg, true);
        return query || execute;
      },
      mssql: (module) => {
        const request = module.Request && module.Request.prototype;
        return wrap('mssql', request, 'query', readSqlArg, true);
      },
      sqlite3: (module) => {
        const database = module.Database && module.Database.prototype;
        let patched = false;
        for (const method of ['run', 'all', 'get', 'each', 'exec']) {
          if (wrap('sqlite3', database, method, (args) => firstString(args[0]), false, method !== 'each')) {
            patched = true;
          }
        }
        if (
          wrapPrepare(
            'sqlite3',
            database,
            ['run', 'all', 'get'],
            (statement, args) => preparedSql(args),
            'callback',
          )
        ) {
          patched = true;
        }
        return patched;
      },
      'better-sqlite3': (module) => {
        const database = module.prototype;
        let patched = false;
        if (wrap('better-sqlite3', database, 'exec', (args) => firstString(args[0]), false)) patched = true;
        if (wrap('better-sqlite3', database, 'pragma', (args) => firstString(args[0]), false)) patched = true;
        if (
          wrapPrepare(
            'better-sqlite3',
            database,
            ['run', 'get', 'all', 'iterate'],
            (statement) => (statement && typeof statement.source === 'string' ? statement.source : null),
            { all: 'array', get: 'row' },
          )
        ) {
          patched = true;
        }
        return patched;
      },
    };
    const adapterNames = Object.keys(adapters);
    const hasAdapter = (name) => adapterNames.indexOf(name) !== -1;

    for (const name of adapterNames) {
      try {
        const module = load(name);
        if (module !== null && adapters[name](module)) markDriver(name);
      } catch (error) {
        void error;
      }
    }

    const skipGeneric =
      /^(?:sequelize|typeorm|knex|kysely|drizzle-orm|objection|pg-pool|tedious|prisma|@prisma\/client|@mikro-orm\/[^/]+|mikro-orm)$/i;
    const hintGeneric =
      /(sql|database|postgres|mysql|maria|sqlite|mssql|oracle|odbc|duckdb|clickhouse|snowflake|firebird|libsql|neon|planetscale)/i;
    const genericPatched = new Set();
    const looksLikeClient = (exportName, value) => {
      const label =
        (typeof exportName === 'string' ? exportName : '') +
        ' ' +
        (typeof value.name === 'string' ? value.name : '');
      return /connection|client|pool|database|session/i.test(label);
    };
    const patchGeneric = (driver, exports) => {
      if (
        exports === null ||
        exports === undefined ||
        (typeof exports !== 'object' && typeof exports !== 'function')
      ) {
        return false;
      }
      let patched = false;
      const visit = (exportName, value) => {
        if (typeof value !== 'function' || value.prototype === null || value.prototype === undefined) {
          return;
        }
        if (genericPatched.has(value.prototype)) return;
        if (!looksLikeClient(exportName, value)) return;
        let touched = false;
        for (const method of ['query', 'execute']) {
          let current = null;
          try {
            current = value.prototype[method];
          } catch (error) {
            void error;
          }
          if (typeof current !== 'function') continue;
          if (wrap(driver, value.prototype, method, readSqlArg, true)) {
            touched = true;
            patched = true;
          }
        }
        if (touched) genericPatched.add(value.prototype);
      };
      try {
        if (typeof exports === 'function') visit('', exports);
        const keys = Object.keys(exports).slice(0, 60);
        for (const key of keys) visit(key, exports[key]);
        if (exports.default !== undefined && exports.default !== exports) visit('default', exports.default);
      } catch (error) {
        void error;
      }
      return patched;
    };

    const cache = new Map();
    for (const loader of loaders) {
      let entries = null;
      try {
        entries = loader.cache;
      } catch (error) {
        void error;
      }
      if (entries === undefined || entries === null) continue;
      try {
        for (const file of Object.keys(entries)) {
          if (!cache.has(file)) cache.set(file, entries[file]);
        }
      } catch (error) {
        void error;
      }
    }
    for (const file of cache.keys()) {
      const name = packageOf(file);
      if (name === null) continue;
      const adapter = hasAdapter(name);
      if (!adapter && (skipGeneric.test(name) || !hintGeneric.test(name))) continue;
      const cached = cache.get(file);
      if (cached === undefined || cached === null) continue;
      try {
        if (adapter) {
          if (adapters[name](cached.exports)) markDriver(name);
        } else if (patchGeneric(name, cached.exports)) {
          markDriver(name);
        }
      } catch (error) {
        void error;
      }
    }

    try {
      if (moduleApi !== null && typeof moduleApi._load === 'function') {
        const previousLoad = moduleApi._load;
        const hooked = function (request, parent, isMain) {
          const result = previousLoad.apply(this, arguments);
          try {
            if (typeof request === 'string' && request.length > 0 && result !== null && result !== undefined) {
              let name = null;
              if (/^[A-Za-z]:[\\/]/.test(request) || request.charAt(0) === '/') {
                name = packageOf(request);
              } else if (request.charAt(0) !== '.') {
                name =
                  request.charAt(0) === '@'
                    ? request.split('/').slice(0, 2).join('/')
                    : request.split('/')[0];
              }
              if (name !== null) {
                if (hasAdapter(name)) {
                  if (adapters[name](result)) markDriver(name);
                } else if (!skipGeneric.test(name) && hintGeneric.test(name)) {
                  if (patchGeneric(name, result)) markDriver(name);
                }
              }
            }
          } catch (error) {
            void error;
          }
          return result;
        };
        hooked.__bdtSqlPatched = true;
        moduleApi._load = hooked;
      }
    } catch (error) {
      void error;
    }

    let prisma = false;
    try {
      prisma = load('@prisma/client') !== null;
    } catch (error) {
      void error;
    }

    state.info = {
      ok: loaders.length > 0,
      drivers,
      prisma,
      error:
        loaders.length === 0
          ? 'El runtime del backend no expone un cargador de módulos; se requiere CommonJS o Node 22.3+ para backends ESM.'
          : null,
    };
    return safeStringify(state.info);
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
    return safeStringify({ ok: false, drivers: [], prisma: false, error: message });
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

function cleanSampleCell(value: unknown): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.length > 240 ? value.slice(0, 240) : value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

function parseSampleColumns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const columns: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name === '') continue;
    columns.push(name.length > 240 ? name.slice(0, 240) : name);
    if (columns.length >= 24) break;
  }
  return columns;
}

function parseSample(value: unknown): CapturedSqlSample | null {
  const record = asRecord(value);
  if (record === null) return null;
  const columns = parseSampleColumns(record.columns);
  if (!Array.isArray(record.rows)) return null;
  const rows: Array<Array<string | number | boolean | null>> = [];
  for (const item of record.rows) {
    if (!Array.isArray(item)) continue;
    rows.push(item.slice(0, 24).map(cleanSampleCell));
    if (rows.length >= 12) break;
  }
  if (columns.length === 0 && rows.length === 0) return null;
  const rowCount =
    typeof record.rowCount === 'number' && Number.isFinite(record.rowCount)
      ? Math.max(0, Math.trunc(record.rowCount))
      : rows.length;
  return {
    columns,
    rows,
    rowCount,
    truncated: record.truncated === true || rowCount > rows.length,
  };
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
    executions.push({
      driver,
      sql,
      at,
      frames: parseFrames(record.frames),
      sample: parseSample(record.sample),
    });
    if (executions.length >= 100) break;
  }
  return executions;
}
