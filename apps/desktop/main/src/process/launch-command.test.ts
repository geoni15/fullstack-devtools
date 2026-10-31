import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BdtError } from '@bdt/protocol';
import {
  buildNodeArgs,
  parseNodeLaunch,
  tokenizeCommand,
  type NodeLaunchSpec,
} from './launch-command';

function codeOf(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof BdtError ? error.code : 'desconocido';
  }
}

let baseDir = '';
let rootDir = '';

beforeAll(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdt-launch-'));
  rootDir = path.join(baseDir, 'proyecto');
  fs.mkdirSync(path.join(rootDir, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'backend', 'server.js'), 'console.log("hola");\n', 'utf8');
  fs.writeFileSync(
    path.join(rootDir, 'backend', 'mi servidor.js'),
    'console.log("espacios");\n',
    'utf8',
  );
  fs.writeFileSync(path.join(baseDir, 'secreto.js'), 'console.log("fuera");\n', 'utf8');
});

afterAll(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('tokenizeCommand', () => {
  it('separa por espacios y respeta comillas simples y dobles', () => {
    expect(tokenizeCommand(`node "backend/mi servidor.js" --port 3000`)).toEqual([
      'node',
      'backend/mi servidor.js',
      '--port',
      '3000',
    ]);
    expect(tokenizeCommand(`node 'backend/mi servidor.js'`)).toEqual([
      'node',
      'backend/mi servidor.js',
    ]);
  });

  it('acepta rutas con barras invertidas y comillas vacías', () => {
    expect(tokenizeCommand('node backend\\server.js ""')).toEqual([
      'node',
      'backend\\server.js',
      '',
    ]);
  });

  it('rechaza comillas sin cerrar', () => {
    expect(codeOf(() => tokenizeCommand('node "backend/server.js'))).toBe(
      'BDT_E_BROWSER_CONFIG_INVALID',
    );
  });
});

describe('parseNodeLaunch', () => {
  it('resuelve la entrada dentro de la raíz desde el directorio del proyecto', () => {
    const spec = parseNodeLaunch('node backend/server.js --port 3000', '', rootDir);
    expect(spec.executable).toBe('node');
    expect(spec.entryPath).toBe(fs.realpathSync.native(path.join(rootDir, 'backend', 'server.js')));
    expect(spec.cwdPath).toBe(fs.realpathSync.native(rootDir));
    expect(spec.args).toEqual(['--port', '3000']);
  });

  it('resuelve la entrada relativa al directorio de trabajo indicado', () => {
    const spec = parseNodeLaunch('node "mi servidor.js"', 'backend', rootDir);
    expect(spec.entryPath).toBe(
      fs.realpathSync.native(path.join(rootDir, 'backend', 'mi servidor.js')),
    );
    expect(spec.cwdPath).toBe(fs.realpathSync.native(path.join(rootDir, 'backend')));
  });

  it('acepta node.exe y una ruta absoluta al ejecutable', () => {
    expect(parseNodeLaunch('node.exe backend/server.js', '', rootDir).executable).toBe('node.exe');
    expect(
      parseNodeLaunch(
        `"${path.join('C:', 'Program Files', 'nodejs', 'node.exe')}" backend/server.js`,
        '',
        rootDir,
      ).executable,
    ).toContain('node.exe');
  });

  it('rechaza comandos que no son node', () => {
    expect(codeOf(() => parseNodeLaunch('npm run dev', '', rootDir))).toBe(
      'BDT_E_BROWSER_CONFIG_INVALID',
    );
    expect(codeOf(() => parseNodeLaunch('PORT=3000 node server.js', '', rootDir))).toBe(
      'BDT_E_BROWSER_CONFIG_INVALID',
    );
    expect(codeOf(() => parseNodeLaunch('node', '', rootDir))).toBe('BDT_E_BROWSER_CONFIG_INVALID');
  });

  it('rechaza un --inspect propio y opciones antes del archivo', () => {
    expect(codeOf(() => parseNodeLaunch('node --inspect=9229 server.js', '', rootDir))).toBe(
      'BDT_E_BROWSER_CONFIG_INVALID',
    );
    expect(
      codeOf(() => parseNodeLaunch('node backend/server.js --inspect=9229', '', rootDir)),
    ).toBe('BDT_E_BROWSER_CONFIG_INVALID');
    expect(codeOf(() => parseNodeLaunch('node -r dotenv/config server.js', '', rootDir))).toBe(
      'BDT_E_BROWSER_CONFIG_INVALID',
    );
  });

  it('rechaza archivos fuera de la raíz, inexistentes o directorios', () => {
    expect(codeOf(() => parseNodeLaunch('node ../secreto.js', '', rootDir))).toBe(
      'BDT_E_PATH_ESCAPE',
    );
    expect(codeOf(() => parseNodeLaunch('node no-existe.js', '', rootDir))).toBe(
      'BDT_E_BROWSER_CONFIG_INVALID',
    );
    expect(codeOf(() => parseNodeLaunch('node backend', '', rootDir))).toBe(
      'BDT_E_BROWSER_CONFIG_INVALID',
    );
  });

  it('rechaza un directorio de trabajo fuera de la raíz o inexistente', () => {
    expect(codeOf(() => parseNodeLaunch('node server.js', '..', rootDir))).toBe(
      'BDT_E_PATH_ESCAPE',
    );
    expect(codeOf(() => parseNodeLaunch('node server.js', 'no-existe', rootDir))).toBe(
      'BDT_E_BROWSER_CONFIG_INVALID',
    );
  });
});

describe('buildNodeArgs', () => {
  it('antepone el inspector en bucle local y la entrada absoluta', () => {
    const spec: NodeLaunchSpec = {
      executable: 'node',
      entryPath: path.join(rootDir, 'backend', 'server.js'),
      cwdPath: rootDir,
      args: ['--port', '3000'],
    };
    expect(buildNodeArgs(spec, 9333)).toEqual([
      '--inspect=127.0.0.1:9333',
      path.join(rootDir, 'backend', 'server.js'),
      '--port',
      '3000',
    ]);
  });
});
