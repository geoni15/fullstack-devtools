import fs from 'node:fs';
import path from 'node:path';
import { BdtError, ERROR_CODES } from '@bdt/protocol';
import { createRootScope } from '../fs/root-guard';

const NODE_EXECUTABLE = /^node(?:\.exe)?$/i;
const INSPECT_FLAG = /^--inspect/i;

export interface NodeLaunchSpec {
  executable: string;
  entryPath: string;
  cwdPath: string;
  args: string[];
  nodeOptions?: string[];
}

export interface NpmLaunchSpec {
  script: string;
  cwdPath: string;
}

export type LaunchProgram =
  { kind: 'node'; node: NodeLaunchSpec } | { kind: 'npm'; npm: NpmLaunchSpec };

const NODE_OPTIONS_WITH_VALUE = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--conditions',
  '--env-file',
  '--env-file-if-exists',
]);

const NODE_OPTIONS_ALLOWED = new Set([
  '--enable-source-maps',
  '--no-warnings',
  '--trace-warnings',
  '--trace-uncaught',
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  '--no-deprecation',
  '--experimental-json-modules',
]);

const NPM_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

function invalid(message: string): BdtError {
  return new BdtError(ERROR_CODES.BROWSER_CONFIG_INVALID, message);
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function resolveProjectDirectory(
  cwdInput: string,
  rootPath: string,
  label: string,
): {
  scope: ReturnType<typeof createRootScope>;
  cwdPath: string;
} {
  const scope = createRootScope(rootPath);
  let cwdPath: string;
  try {
    cwdPath = cwdInput === '' ? scope.rootReal : scope.resolve(cwdInput);
  } catch (error) {
    if (error instanceof BdtError && error.code === ERROR_CODES.PATH_ESCAPE) {
      throw error;
    }
    throw invalid(`El directorio de trabajo del ${label} no existe dentro del proyecto.`);
  }
  let cwdStat: fs.Stats;
  try {
    cwdStat = fs.statSync(cwdPath);
  } catch {
    throw invalid(`El directorio de trabajo del ${label} no está disponible.`);
  }
  if (!cwdStat.isDirectory()) {
    throw invalid(`El directorio de trabajo del ${label} no es una carpeta.`);
  }
  return { scope, cwdPath };
}

export function tokenizeCommand(command: string): string[] {
  if (command.includes('\0')) {
    throw invalid('El comando para arrancar el backend no es válido.');
  }
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

  if (quote !== null) {
    throw invalid('El comando para arrancar el backend tiene comillas sin cerrar.');
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

function parseNodeEntry(
  executable: string,
  entry: string,
  args: string[],
  cwdInput: string,
  rootPath: string,
  label: string,
  nodeOptions: string[] = [],
): NodeLaunchSpec {
  const { scope, cwdPath } = resolveProjectDirectory(cwdInput, rootPath, label);

  const candidate = path.resolve(cwdPath, entry);
  if (!isWithinRoot(scope.rootReal, candidate)) {
    throw new BdtError(
      ERROR_CODES.PATH_ESCAPE,
      `El archivo de entrada del ${label} debe estar dentro de la carpeta del proyecto.`,
    );
  }

  let entryPath: string;
  try {
    entryPath = scope.resolve(path.relative(scope.rootReal, candidate));
  } catch (error) {
    if (error instanceof BdtError && error.code === ERROR_CODES.PATH_ESCAPE) {
      throw error;
    }
    throw invalid(`El archivo de entrada del ${label} no existe dentro del proyecto.`);
  }

  let entryStat: fs.Stats;
  try {
    entryStat = fs.statSync(entryPath);
  } catch {
    throw invalid(`El archivo de entrada del ${label} no está disponible.`);
  }
  if (!entryStat.isFile()) {
    throw invalid(`El archivo de entrada del ${label} no es un archivo.`);
  }

  return { executable, entryPath, cwdPath, args, nodeOptions };
}

export function parseNodeLaunch(
  command: string,
  cwdInput: string,
  rootPath: string,
): NodeLaunchSpec {
  const tokens = tokenizeCommand(command);
  const executable = tokens[0];
  if (executable === undefined) {
    throw invalid('Escribe un comando «node archivo.js» para arrancar el backend.');
  }
  if (!NODE_EXECUTABLE.test(path.basename(executable))) {
    throw invalid(
      'El arranque automático con --inspect solo admite comandos que empiecen por «node».',
    );
  }
  if (tokens.length < 2) {
    throw invalid(
      'El comando debe indicar el archivo de entrada, por ejemplo «node backend/server.js».',
    );
  }
  for (const token of tokens.slice(1)) {
    if (INSPECT_FLAG.test(token)) {
      throw invalid('El comando no debe incluir --inspect: la app añade ese flag al arrancar.');
    }
  }
  const entry = tokens[1];
  if (entry === undefined || entry.startsWith('-')) {
    throw invalid(
      'Escribe el archivo de entrada justo después de «node», por ejemplo «node backend/server.js».',
    );
  }

  return parseNodeEntry(executable, entry, tokens.slice(2), cwdInput, rootPath, 'backend');
}

export function parseAppLaunch(
  command: string,
  cwdInput: string,
  rootPath: string,
  label: 'frontend' | 'backend',
): LaunchProgram {
  const tokens = tokenizeCommand(command);
  const executable = tokens[0];
  if (executable === undefined) {
    throw invalid(`Escribe el comando para arrancar el ${label}.`);
  }
  const base = path
    .basename(executable)
    .replace(/\.(?:exe|cmd)$/i, '')
    .toLowerCase();

  if (base === 'node') {
    const options: string[] = [];
    let index = 1;
    let entry: string | null = null;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token === undefined) break;
      if (INSPECT_FLAG.test(token)) {
        throw invalid('El comando no debe incluir --inspect: la app añade ese flag al arrancar.');
      }
      if (!token.startsWith('-')) {
        entry = token;
        index += 1;
        break;
      }
      if (NODE_OPTIONS_WITH_VALUE.has(token)) {
        const value = tokens[index + 1];
        if (value === undefined) {
          throw invalid(`La opción «${token}» del comando del ${label} no tiene valor.`);
        }
        options.push(token, value);
        index += 2;
        continue;
      }
      if (!NODE_OPTIONS_ALLOWED.has(token)) {
        throw invalid(`La opción «${token}» no está permitida en el arranque del ${label}.`);
      }
      options.push(token);
      index += 1;
    }
    if (entry === null) {
      throw invalid(
        `El comando debe indicar el archivo de entrada, por ejemplo «node backend/server.js».`,
      );
    }
    const args = tokens.slice(index);
    return {
      kind: 'node',
      node: parseNodeEntry(executable, entry, args, cwdInput, rootPath, label, options),
    };
  }

  if (base === 'npm') {
    let script: string | null = null;
    let index = 0;
    if (tokens[1] === 'run' || tokens[1] === 'run-script') {
      script = tokens[2] ?? null;
      index = 3;
    } else if (tokens[1] === 'start') {
      script = 'start';
      index = 2;
    }
    if (script === null || !NPM_SCRIPT_NAME.test(script)) {
      throw invalid('El comando del ' + label + ' debe ser «npm run <script>» o «npm start».');
    }
    if (tokens.length > index) {
      throw invalid(`El comando del ${label} no admite argumentos adicionales después del script.`);
    }
    const { cwdPath } = resolveProjectDirectory(cwdInput, rootPath, label);
    return { kind: 'npm', npm: { script, cwdPath } };
  }

  throw invalid('El comando de arranque debe empezar por «node» o «npm run».');
}

export function buildNodeArgs(spec: NodeLaunchSpec, inspectorPort: number): string[] {
  return [
    `--inspect=127.0.0.1:${String(inspectorPort)}`,
    ...(spec.nodeOptions ?? []),
    spec.entryPath,
    ...spec.args,
  ];
}
