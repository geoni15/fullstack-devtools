import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractRoutesFromSource,
  initRouteParser,
  matchRoute,
  type StaticRoute,
} from '@bdt/routes-index';
import { isIgnoredName } from '../config';
import type { Logger } from '../logger';

const CACHE_TTL_MS = 60_000;
const ROUTE_HINTS =
  /\.(?:get|post|put|patch|delete|options|head|all|route|api_route)\(|@[\w.]*\.(?:get|post|put|patch|delete|route|api_route)\(|APIRouter|Blueprint/i;
const SOURCE_EXTENSIONS = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|py|prisma)$/i;
const PARSE_EXTENSIONS = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|py)$/i;

const grammarDir = fileURLToPath(new URL('./grammars/', import.meta.url));

interface CandidateFile {
  absolute: string;
  relative: string;
}

interface BuildState {
  root: string;
  routes: StaticRoute[];
  databases: DatabaseHint[];
  builtAt: number;
}

export interface DatabaseHint {
  engine: string | null;
  database: string | null;
  fallback: boolean;
  file: string;
}

export class BackendRouteIndex {
  private state: BuildState | null = null;
  private building: Promise<void> | null = null;
  private parserReady = false;

  constructor(
    private readonly getWorkspaceRoot: () => string | null,
    private readonly log: Logger,
  ) {}

  invalidate(): void {
    this.state = null;
  }

  match(method: string, pathname: string): StaticRoute | null {
    if (this.state === null) {
      return null;
    }
    return matchRoute(this.state.routes, method, pathname);
  }

  all(): readonly StaticRoute[] {
    return this.state?.routes ?? [];
  }

  databases(): readonly DatabaseHint[] {
    return this.state?.databases ?? [];
  }

  async refresh(): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (root === null) {
      this.state = null;
      return;
    }
    if (
      this.state !== null &&
      this.state.root === root &&
      Date.now() - this.state.builtAt < CACHE_TTL_MS
    ) {
      return;
    }
    if (this.building !== null) {
      await this.building;
      if (this.state !== null && this.state.root === root) {
        return;
      }
    }
    this.building = this.build(root).finally(() => {
      this.building = null;
    });
    await this.building;
  }

  private async build(root: string): Promise<void> {
    const started = Date.now();
    try {
      await this.ensureParser();
      const files = await this.collectFiles(root);
      const routes: StaticRoute[] = [];
      const databases: DatabaseHint[] = [];
      let parsedFiles = 0;

      for (const file of files) {
        let content: string;
        try {
          content = (await readFile(file.absolute)).toString('utf8');
        } catch {
          continue;
        }
        databases.push(...detectDatabaseHints(file.relative, content));
        if (!PARSE_EXTENSIONS.test(file.relative) || !ROUTE_HINTS.test(content)) {
          continue;
        }
        try {
          routes.push(...extractRoutesFromSource({ filePath: file.relative, source: content }));
          parsedFiles += 1;
        } catch (error) {
          this.log.warn('No se pudo analizar un archivo de rutas', {
            file: file.relative,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.state = {
        root,
        routes: dedupe(routes),
        databases: dedupeDatabases(databases),
        builtAt: Date.now(),
      };
      this.log.info('Índice de rutas estático construido', {
        root,
        routes: this.state.routes.length,
        databases: this.state.databases.length,
        files: files.length,
        parsedFiles,
        ms: Date.now() - started,
      });
    } catch (error) {
      this.state = { root, routes: [], databases: [], builtAt: Date.now() };
      this.log.warn('No se pudo construir el índice de rutas estático', {
        root,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureParser(): Promise<void> {
    if (this.parserReady) {
      return;
    }
    await initRouteParser({
      runtimeWasm: path.join(grammarDir, 'tree-sitter.wasm'),
      javascriptWasm: path.join(grammarDir, 'tree-sitter-javascript.wasm'),
      pythonWasm: path.join(grammarDir, 'tree-sitter-python.wasm'),
    });
    this.parserReady = true;
  }

  private async collectFiles(root: string): Promise<CandidateFile[]> {
    const rootReal = await realpath(root);
    const files: CandidateFile[] = [];
    const pending = [rootReal];

    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) {
        break;
      }
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || isIgnoredName(entry.name)) {
          continue;
        }
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(absolute);
          continue;
        }
        if (!entry.isFile() || !SOURCE_EXTENSIONS.test(entry.name)) {
          continue;
        }
        if (/\.(?:min|d)\.(?:js|ts)$/i.test(entry.name)) {
          continue;
        }
        files.push({
          absolute,
          relative: path.relative(rootReal, absolute).split(path.sep).join('/'),
        });
      }
    }

    return files;
  }
}

function dedupe(routes: readonly StaticRoute[]): StaticRoute[] {
  const seen = new Set<string>();
  const result: StaticRoute[] = [];
  for (const route of routes) {
    const key = `${route.method} ${route.path} ${route.file}:${route.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(route);
  }
  return result;
}

const DB_HINT =
  /\b(?:database|databaseName|dbName|mysql2?|mariadb|postgres(?:ql)?|mongodb|mongoose|sqlite3?|better-sqlite3|mssql|oracledb|sequelize|knex|typeorm|DataSource|PrismaClient|@prisma\/client)\b/i;
const DB_USAGE =
  /\b(?:createPool|createConnection|new\s+Pool|new\s+Client|new\s+Sequelize|new\s+DataSource|new\s+PrismaClient|PrismaClient|knex\s*\(|mongoose\.connect|client\.db|sqlite3\.Database|better-sqlite3|mysql\.create|MongoClient)\b/;
const DATABASE_KEYS =
  /\b(?:database|databaseName|dbName)\s*:\s*(?:process\.env(?:\.\w+|\[['"]\w+['"]\])\s*(?:\|\||\?\?)\s*)?['"`]([A-Za-z0-9_.-]{1,64})['"`]/g;
const MONGO_DB_CALL = /\bclient\.db\(\s*['"`]([A-Za-z0-9_.-]{1,64})['"`]/g;
const SEQUELIZE_DB = /\bnew\s+Sequelize\(\s*['"`]([A-Za-z0-9_.-]{1,64})['"`]/g;
const MONGO_URL = /\bmongodb(?:\+srv)?:\/\/[^\s'"`/]+\/([A-Za-z0-9_.-]{1,64})(?:[?'"`]|$)/g;
const SQLITE_FILE =
  /\b(?:better-sqlite3|sqlite3\.Database|new\s+Database)\s*\(\s*['"`]([^'"`\n]{1,120})['"`]/g;
const PRISMA_PROVIDER =
  /provider\s*=\s*["'](mysql|mariadb|postgresql|sqlite|sqlserver|mongodb)["']/i;
const PRISMA_URL_DB =
  /\burl\s*=\s*["'][a-z][a-z0-9+.-]*:\/\/[^"'\n]*?\/([A-Za-z0-9_.-]{1,64})(?:[?"']|$)/i;

const DATABASE_ENGINE_BY_PROVIDER: Record<string, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
};

function detectDatabaseEngine(content: string): string | null {
  const provider = PRISMA_PROVIDER.exec(content);
  if (provider !== null) {
    const mapped = DATABASE_ENGINE_BY_PROVIDER[provider[1]?.toLowerCase() ?? ''];
    if (mapped !== undefined) return `Prisma · ${mapped}`;
  }
  if (/\b(?:mongodb|mongoose)\b/i.test(content)) return 'MongoDB';
  if (/\b(?:mysql2?|mariadb)\b/i.test(content)) return 'MySQL';
  if (/\b(?:postgres(?:ql)?|pg)\b/i.test(content)) return 'PostgreSQL';
  if (/\b(?:better-sqlite3|sqlite3|sqlite)\b/i.test(content)) return 'SQLite';
  if (/\bmssql\b/i.test(content)) return 'SQL Server';
  if (/\boracledb\b/i.test(content)) return 'Oracle';
  if (/\bPrismaClient\b/.test(content)) return 'Prisma';
  if (/\bSequelize\b/.test(content)) return 'Sequelize';
  if (/\bDataSource\b/.test(content)) return 'TypeORM';
  if (/\bknex\b/i.test(content)) return 'Knex';
  return null;
}

interface DetectedName {
  name: string;
  fallback: boolean;
}

function pushDatabaseName(names: DetectedName[], raw: string | undefined, fallback = false): void {
  if (raw === undefined) return;
  const name = raw.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) return;
  if (name === '[enmascarado]' || names.some((entry) => entry.name === name)) return;
  names.push({ name, fallback });
}

function detectDatabaseHints(file: string, content: string): DatabaseHint[] {
  if (!DB_HINT.test(content)) return [];
  const engine = detectDatabaseEngine(content);
  const names: DetectedName[] = [];

  for (const match of content.matchAll(DATABASE_KEYS)) {
    pushDatabaseName(names, match[1], /process\.env/.test(match[0]));
  }
  for (const match of content.matchAll(MONGO_DB_CALL)) {
    pushDatabaseName(names, match[1]);
  }
  for (const match of content.matchAll(SEQUELIZE_DB)) {
    pushDatabaseName(names, match[1]);
  }
  for (const match of content.matchAll(MONGO_URL)) {
    pushDatabaseName(names, match[1]);
  }
  for (const match of content.matchAll(SQLITE_FILE)) {
    const target = match[1];
    if (target === undefined || /[$`{}]/.test(target)) continue;
    pushDatabaseName(names, path.basename(target));
  }
  if (PRISMA_PROVIDER.test(content)) {
    pushDatabaseName(names, PRISMA_URL_DB.exec(content)?.[1]);
  }

  if (names.length > 0) {
    const preferred = [...names].sort(
      (left, right) => Number(left.fallback) - Number(right.fallback),
    );
    return preferred
      .slice(0, 3)
      .map((entry) => ({ engine, database: entry.name, fallback: entry.fallback, file }));
  }
  if (engine !== null && (DB_USAGE.test(content) || PRISMA_PROVIDER.test(content))) {
    return [{ engine, database: null, fallback: false, file }];
  }
  return [];
}

function databaseScore(hint: DatabaseHint): number {
  let score = 0;
  if (hint.database !== null) score += 4;
  if (hint.database !== null && !hint.fallback) score += 1;
  if (hint.engine !== null) score += 2;
  if (
    !/(?:^|\/)(?:test|tests|__tests__|spec)\//i.test(hint.file) &&
    !/\.(?:test|spec)\./i.test(hint.file)
  ) {
    score += 2;
  }
  if (/(?:^|\/)(?:src|server|api|db|database|config|prisma)\//i.test(hint.file)) {
    score += 1;
  }
  return score;
}

function dedupeDatabases(hints: readonly DatabaseHint[]): DatabaseHint[] {
  const sorted = [...hints].sort((left, right) => databaseScore(right) - databaseScore(left));
  const seen = new Set<string>();
  const result: DatabaseHint[] = [];
  for (const hint of sorted) {
    const key = `${hint.engine ?? ''}|${hint.database ?? ''}|${String(hint.fallback)}|${hint.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hint);
    if (result.length >= 8) break;
  }
  return result;
}
