import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DetectedAppSetup, ProjectSetupDetection } from '@bdt/protocol';
import { isIgnoredName } from '../config';

interface Manifest {
  dirAbs: string;
  dirRel: string;
  name: string | null;
  scripts: Record<string, string>;
  deps: Set<string>;
}

export interface DetectedManifest extends Manifest {
  role: 'frontend' | 'backend';
  framework: string | null;
  scriptName: string | null;
  scriptCommand: string | null;
  launchCommand: string | null;
  entry: string | null;
  port: number | null;
  portEvidence: string | null;
  evidence: string[];
}

const FRONTEND_FRAMEWORKS: Record<string, string> = {
  react: 'React',
  'react-dom': 'React',
  vue: 'Vue',
  '@angular/core': 'Angular',
  svelte: 'Svelte',
  next: 'Next.js',
  nuxt: 'Nuxt',
  astro: 'Astro',
  'solid-js': 'Solid',
  preact: 'Preact',
  '@remix-run/react': 'Remix',
  gatsby: 'Gatsby',
  'ember-source': 'Ember',
  '@sveltejs/kit': 'SvelteKit',
};

const BACKEND_FRAMEWORKS: Record<string, string> = {
  express: 'Express',
  fastify: 'Fastify',
  koa: 'Koa',
  '@nestjs/core': 'NestJS',
  '@hapi/hapi': 'hapi',
  hapi: 'hapi',
  restify: 'Restify',
  '@adonisjs/core': 'AdonisJS',
  '@feathersjs/feathers': 'Feathers',
  'socket.io': 'Socket.IO',
  'apollo-server': 'Apollo',
  '@apollo/server': 'Apollo',
  'graphql-yoga': 'GraphQL Yoga',
  hono: 'Hono',
  elysia: 'Elysia',
  '@trpc/server': 'tRPC',
};

const FRONTEND_TOOLS = new Set([
  'vite',
  'parcel',
  'webpack',
  'react-scripts',
  '@angular/cli',
  'expo',
  'snowpack',
  'wmr',
  '@vitejs/plugin-react',
  '@vitejs/plugin-vue',
]);

const FRONTEND_DEV_HINT =
  /^(?:vite|next|nuxt|astro|ng\s+(?:serve|start)|react-scripts|remix|gatsby|parcel|svelte-kit|solid-start|expo|webpack\s+serve)\b/i;
const BACKEND_DEV_HINT =
  /^(?:node|nodemon|tsx|ts-node|ts-node-dev|nest|bun|deno)\b|\b(?:nodemon|ts-node-dev|tsx)\b/i;

const NODE_RUNNERS = new Set(['node', 'nodemon', 'tsx', 'ts-node', 'ts-node-dev']);
const SOURCE_ENTRY = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$/i;

const FRONTEND_SCRIPTS = ['dev', 'start', 'serve', 'develop', 'dev:client', 'client', 'frontend'];
const BACKEND_SCRIPTS = ['start', 'dev', 'server', 'serve', 'start:dev', 'api', 'backend', 'prod'];

const FRONTEND_DEFAULT_PORTS: Record<string, number> = {
  Vite: 5173,
  React: 3000,
  'Next.js': 3000,
  Nuxt: 3000,
  Angular: 4200,
  Astro: 4321,
  Svelte: 5173,
  SvelteKit: 5173,
  Remix: 3000,
  Gatsby: 8000,
  Parcel: 1234,
  Solid: 3000,
  Preact: 8080,
  Ember: 4200,
};

const BACKEND_ENTRY_CANDIDATES = [
  'index.js',
  'server.js',
  'app.js',
  'main.js',
  'src/index.js',
  'src/server.js',
  'src/app.js',
  'src/main.js',
];

const CONFIG_FILE =
  /^(?:vite|next|nuxt|astro|svelte|solid|remix|gatsby|angular|parcel)\.config\.(?:js|mjs|cjs|ts|mts|cts)$/i;

const NON_RUN_SCRIPT =
  /^(?:build|test|lint|format|typecheck|verify|package|prepare|postinstall|preinstall|prepublish)/i;

function manifestDir(relative: string): string {
  return relative === '' ? '.' : relative.split(path.sep).join('/');
}

async function collectManifests(root: string): Promise<Manifest[]> {
  const manifests: Manifest[] = [];
  const pending: string[] = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isIgnoredName(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'package.json') continue;
      let raw: string;
      try {
        raw = await readFile(absolute, 'utf8');
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const scripts: Record<string, string> = {};
      const rawScripts = record.scripts;
      if (typeof rawScripts === 'object' && rawScripts !== null && !Array.isArray(rawScripts)) {
        for (const [name, value] of Object.entries(rawScripts as Record<string, unknown>)) {
          if (typeof value === 'string' && value.trim() !== '') scripts[name] = value.trim();
        }
      }
      const deps = new Set<string>();
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        const rawDeps = record[field];
        if (typeof rawDeps !== 'object' || rawDeps === null || Array.isArray(rawDeps)) continue;
        for (const name of Object.keys(rawDeps as Record<string, unknown>)) deps.add(name);
      }
      manifests.push({
        dirAbs: directory,
        dirRel: manifestDir(path.relative(root, directory)),
        name: typeof record.name === 'string' ? record.name : null,
        scripts,
        deps,
      });
    }
  }
  return manifests;
}

function frontendFramework(deps: ReadonlySet<string>): string | null {
  for (const [dep, name] of Object.entries(FRONTEND_FRAMEWORKS)) {
    if (deps.has(dep)) return name;
  }
  return null;
}

function backendFramework(deps: ReadonlySet<string>): string | null {
  for (const [dep, name] of Object.entries(BACKEND_FRAMEWORKS)) {
    if (deps.has(dep)) return name;
  }
  return null;
}

function hasFrontendHint(command: string): boolean {
  return FRONTEND_DEV_HINT.test(command);
}

function hasBackendHint(command: string): boolean {
  return BACKEND_DEV_HINT.test(command);
}

function frontendScore(manifest: Manifest): number {
  let score = 0;
  if (frontendFramework(manifest.deps) !== null) score += 5;
  for (const dep of manifest.deps) {
    if (FRONTEND_TOOLS.has(dep)) score += 2;
  }
  for (const command of Object.values(manifest.scripts)) {
    if (hasFrontendHint(command)) score += 4;
  }
  return score;
}

function backendScore(manifest: Manifest): number {
  let score = 0;
  if (backendFramework(manifest.deps) !== null) score += 5;
  for (const dep of manifest.deps) {
    if (
      /^(?:mysql2?|pg|mariadb|sqlite3|better-sqlite3|mongoose|mongodb|sequelize|prisma|@prisma\/client|typeorm|knex|mssql|oracledb)$/.test(
        dep,
      )
    ) {
      score += 2;
      break;
    }
  }
  if (
    [
      'dotenv',
      'cors',
      'jsonwebtoken',
      'bcrypt',
      'bcryptjs',
      'express-session',
      'cookie-parser',
    ].some((dep) => manifest.deps.has(dep))
  ) {
    score += 1;
  }
  for (const command of Object.values(manifest.scripts)) {
    if (hasBackendHint(command)) score += 4;
  }
  return score;
}

function chooseScript(
  scripts: Record<string, string>,
  order: readonly string[],
  hint: (command: string) => boolean,
): string | null {
  for (const name of order) {
    const command = scripts[name];
    if (command !== undefined && hint(command)) return name;
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (hint(command)) return name;
  }
  for (const name of order) {
    if (scripts[name] !== undefined) return name;
  }
  return null;
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function quoteArgument(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}

interface DerivedCommand {
  command: string | null;
  entry: string | null;
}

function deriveBackendCommand(scriptCommand: string | null): DerivedCommand {
  if (scriptCommand === null) return { command: null, entry: null };
  const tokens = tokenize(scriptCommand);
  const runnerIndex = tokens.findIndex((token) =>
    NODE_RUNNERS.has(
      path
        .basename(token)
        .replace(/\.(?:exe|cmd)$/i, '')
        .toLowerCase(),
    ),
  );
  if (runnerIndex === -1) {
    return { command: null, entry: null };
  }
  const runner = path
    .basename(tokens[runnerIndex] ?? '')
    .replace(/\.(?:exe|cmd)$/i, '')
    .toLowerCase();
  let entryIndex = -1;
  for (let index = runnerIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.startsWith('-')) continue;
    if (SOURCE_ENTRY.test(token)) {
      entryIndex = index;
      break;
    }
    if (entryIndex === -1 && runner === 'node') entryIndex = index;
  }
  const entry = entryIndex === -1 ? undefined : tokens[entryIndex];
  if (entry === undefined) return { command: null, entry: null };
  const rest = tokens.slice(entryIndex + 1).map(quoteArgument);
  const entryArg = quoteArgument(entry);
  let command: string;
  if (runner === 'tsx') {
    command = ['node', '--import', 'tsx', entryArg, ...rest].join(' ');
  } else if (runner === 'ts-node' || runner === 'ts-node-dev') {
    command = ['node', '-r', 'ts-node/register', entryArg, ...rest].join(' ');
  } else {
    command = ['node', entryArg, ...rest].join(' ');
  }
  return { command, entry };
}

async function readIfFile(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function portFromScript(command: string | null): number | null {
  if (command === null) return null;
  const patterns = [/(?:--port|-p)[=\s]+(\d{2,5})\b/, /\bPORT=(\d{2,5})\b/];
  for (const pattern of patterns) {
    const match = pattern.exec(command);
    const value = match?.[1];
    if (value === undefined) continue;
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  }
  return null;
}

function portFromText(text: string): number | null {
  const patterns = [
    /process\.env\.PORT\s*(?:\|\||\?\?)\s*(\d{2,5})/i,
    /\.listen\(\s*(?:process\.env\.PORT\s*(?:\|\||\?\?)\s*)?(\d{2,5})/i,
    /\bport\s*[:=]\s*(\d{2,5})\b/i,
    /["']?port["']?\s*:\s*(\d{2,5})\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1];
    if (value === undefined) continue;
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  }
  return null;
}

function frontendDefaultPort(
  deps: ReadonlySet<string>,
  framework: string | null,
): { port: number; label: string } | null {
  if (deps.has('vite') || deps.has('@vitejs/plugin-react') || deps.has('@vitejs/plugin-vue')) {
    return { port: 5173, label: 'Vite' };
  }
  if (deps.has('next')) return { port: 3000, label: 'Next.js' };
  if (deps.has('nuxt')) return { port: 3000, label: 'Nuxt' };
  if (deps.has('react-scripts')) return { port: 3000, label: 'React' };
  if (deps.has('@angular/cli')) return { port: 4200, label: 'Angular' };
  if (deps.has('astro')) return { port: 4321, label: 'Astro' };
  if (deps.has('expo')) return { port: 8081, label: 'Expo' };
  if (deps.has('parcel')) return { port: 1234, label: 'Parcel' };
  if (deps.has('@sveltejs/kit')) return { port: 5173, label: 'SvelteKit' };
  if (deps.has('gatsby')) return { port: 8000, label: 'Gatsby' };
  if (deps.has('ember-source')) return { port: 4200, label: 'Ember' };
  if (framework === null) return null;
  const port = FRONTEND_DEFAULT_PORTS[framework];
  return port === undefined ? null : { port, label: framework };
}

async function detectPort(
  manifest: Manifest,
  role: 'frontend' | 'backend',
  scriptCommand: string | null,
  entry: string | null,
  framework: string | null,
): Promise<{ port: number | null; evidence: string | null }> {
  const fromScript = portFromScript(scriptCommand);
  if (fromScript !== null) {
    return { port: fromScript, evidence: `puerto ${String(fromScript)} en el script` };
  }
  const configFiles: string[] = [];
  if (role === 'frontend') {
    const listing = await readdirSafe(manifest.dirAbs);
    for (const fileName of listing) {
      if (CONFIG_FILE.test(fileName) || fileName === 'angular.json') {
        configFiles.push(fileName);
      }
    }
  } else {
    const candidates = entry === null ? [] : [entry];
    configFiles.push(...candidates, ...BACKEND_ENTRY_CANDIDATES);
  }
  for (const fileName of configFiles) {
    const content = await readIfFile(path.join(manifest.dirAbs, fileName));
    if (content === null) continue;
    const port = portFromText(content);
    if (port !== null) {
      return { port, evidence: `puerto ${String(port)} en ${fileName}` };
    }
  }
  if (role === 'frontend') {
    const fallback = frontendDefaultPort(manifest.deps, framework);
    if (fallback === null) return { port: null, evidence: null };
    return {
      port: fallback.port,
      evidence: `puerto ${String(fallback.port)} por defecto de ${fallback.label}`,
    };
  }
  return { port: 3000, evidence: 'puerto 3000 por defecto del backend' };
}

async function readdirSafe(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function findEntryFile(dirAbs: string): Promise<string | null> {
  for (const candidate of BACKEND_ENTRY_CANDIDATES) {
    const content = await readIfFile(path.join(dirAbs, candidate));
    if (content !== null) return candidate;
  }
  return null;
}

async function buildFrontendSetup(manifest: Manifest): Promise<DetectedAppSetup | null> {
  const framework = frontendFramework(manifest.deps);
  const tools = [...manifest.deps].filter((dep) => FRONTEND_TOOLS.has(dep));
  if (framework === null && tools.length === 0) return null;
  const scriptName = chooseScript(manifest.scripts, FRONTEND_SCRIPTS, hasFrontendHint);
  const scriptCommand = scriptName === null ? null : (manifest.scripts[scriptName] ?? null);
  const { port, evidence: portEvidence } = await detectPort(
    manifest,
    'frontend',
    scriptCommand,
    null,
    framework,
  );
  const evidence: string[] = [];
  if (framework !== null) evidence.push(`${framework} en dependencies`);
  if (tools.length > 0) evidence.push(`herramientas: ${tools.slice(0, 4).join(', ')}`);
  if (scriptName !== null && scriptCommand !== null) {
    evidence.push(`script ${scriptName}: ${scriptCommand}`);
  }
  if (portEvidence !== null) evidence.push(portEvidence);
  return {
    role: 'frontend',
    dir: manifest.dirRel,
    packageName: manifest.name,
    framework,
    scriptName,
    scriptCommand,
    launchCommand: scriptName === null ? null : `npm run ${scriptName}`,
    launchCwd: manifest.dirRel,
    port,
    evidence,
  };
}

async function buildBackendSetup(manifest: Manifest): Promise<DetectedAppSetup | null> {
  const framework = backendFramework(manifest.deps);
  const scriptName = chooseScript(manifest.scripts, BACKEND_SCRIPTS, hasBackendHint);
  if (framework === null && scriptName !== null && NON_RUN_SCRIPT.test(scriptName)) {
    return null;
  }
  const scriptCommand = scriptName === null ? null : (manifest.scripts[scriptName] ?? null);
  if (framework === null && scriptCommand === null) return null;
  const derived = deriveBackendCommand(scriptCommand);
  let launchCommand = derived.command;
  let entry = derived.entry;
  if (launchCommand === null) {
    const fallbackEntry = await findEntryFile(manifest.dirAbs);
    if (fallbackEntry !== null) {
      entry = fallbackEntry;
      launchCommand = `node ${quoteArgument(fallbackEntry)}`;
    } else if (scriptName !== null) {
      launchCommand = `npm run ${scriptName}`;
    }
  }
  const { port, evidence: portEvidence } = await detectPort(
    manifest,
    'backend',
    scriptCommand,
    entry,
    framework,
  );
  const evidence: string[] = [];
  if (framework !== null) evidence.push(`${framework} en dependencies`);
  if (scriptName !== null && scriptCommand !== null) {
    evidence.push(`script ${scriptName}: ${scriptCommand}`);
  }
  if (entry !== null && scriptCommand === null) evidence.push(`entrada ${entry} (sin script)`);
  if (launchCommand !== null && scriptName !== null && launchCommand.startsWith('npm ')) {
    evidence.push('arranque por script npm (sin inspector)');
  }
  if (portEvidence !== null) evidence.push(portEvidence);
  return {
    role: 'backend',
    dir: manifest.dirRel,
    packageName: manifest.name,
    framework,
    scriptName,
    scriptCommand,
    launchCommand,
    launchCwd: manifest.dirRel,
    port,
    evidence,
  };
}

export async function detectProjectSetup(root: string): Promise<ProjectSetupDetection> {
  const manifests = await collectManifests(root);
  const frontendCandidates = manifests
    .map((manifest) => ({ manifest, score: frontendScore(manifest) }))
    .filter((candidate) => candidate.score >= 4)
    .sort((left, right) => right.score - left.score);
  const backendCandidates = manifests
    .map((manifest) => ({ manifest, score: backendScore(manifest) }))
    .filter((candidate) => candidate.score >= 4)
    .sort((left, right) => right.score - left.score);
  let frontend: DetectedAppSetup | null = null;
  for (const candidate of frontendCandidates) {
    frontend = await buildFrontendSetup(candidate.manifest);
    if (frontend !== null) break;
  }
  let backend: DetectedAppSetup | null = null;
  for (const candidate of backendCandidates) {
    backend = await buildBackendSetup(candidate.manifest);
    if (backend !== null) break;
  }
  return {
    frontend,
    backend,
    packageCount: manifests.length,
    detectedAt: Date.now(),
  };
}
