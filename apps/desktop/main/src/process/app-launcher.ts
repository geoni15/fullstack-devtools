import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { Logger } from '../logger';
import { buildNodeArgs, type LaunchProgram } from './launch-command';

const INSPECTOR_TIMEOUT_MS = 20_000;
const HTTP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 200;
const FETCH_TIMEOUT_MS = 800;
const FORCE_KILL_MS = 2500;
const MAX_OUTPUT_CHARS = 8192;
const MAX_DETAIL_CHARS = 600;

export interface LaunchOptions {
  label: string;
  port: number | null;
  inspectorPort: number | null;
  readyUrl: string | null;
  onUnexpectedExit: (code: number | null) => void;
  onOutput?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface LaunchedProcess {
  pid: number;
  inspectorPort: number | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasInspectorTarget(payload: unknown): boolean {
  return (
    Array.isArray(payload) &&
    payload.some((item) => isRecord(item) && typeof item.webSocketDebuggerUrl === 'string')
  );
}

function isDigitOrSemicolon(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x30 && code <= 0x39) || code === 0x3b;
}

function sanitizeOutput(text: string): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x1b && text[index + 1] === '[') {
      let end = index + 2;
      while (end < text.length && isDigitOrSemicolon(text.charAt(end))) {
        end += 1;
      }
      if (text[end] === 'm') {
        index = end + 1;
        continue;
      }
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      index += 1;
      continue;
    }
    result += text[index];
    index += 1;
  }
  return result;
}

export function findFreeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = isRecord(address) && typeof address.port === 'number' ? address.port : 0;
      server.close(() => {
        if (port > 0) {
          resolve(port);
        } else {
          reject(new Error('No se pudo reservar un puerto local.'));
        }
      });
    });
  });
}

export async function isUrlReachable(rawUrl: string): Promise<boolean> {
  try {
    await fetch(rawUrl, {
      method: 'GET',
      headers: { Accept: '*/*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

export class AppLauncher {
  private child: ChildProcess | null = null;
  private generation = 0;
  private ready = false;
  private stopping = false;
  private output = '';
  private exitHandler: ((code: number | null) => void) | null = null;
  private outputHandler: ((stream: 'stdout' | 'stderr', line: string) => void) | null = null;
  private readonly lineBuffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

  constructor(private readonly log: Logger) {}

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  async start(program: LaunchProgram, options: LaunchOptions): Promise<LaunchedProcess> {
    this.stop();
    const generation = ++this.generation;
    this.stopping = false;
    this.ready = false;
    this.output = '';
    this.exitHandler = options.onUnexpectedExit;
    this.outputHandler = options.onOutput ?? null;
    this.lineBuffers.stdout = '';
    this.lineBuffers.stderr = '';

    const env = { ...process.env };
    if (options.port !== null) {
      env.PORT = String(options.port);
    }

    let child: ChildProcess;
    try {
      if (program.kind === 'node') {
        const args =
          options.inspectorPort === null
            ? [...(program.node.nodeOptions ?? []), program.node.entryPath, ...program.node.args]
            : buildNodeArgs(program.node, options.inspectorPort);
        child = spawn(program.node.executable, args, {
          cwd: program.node.cwdPath,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
      } else if (process.platform === 'win32') {
        const comspec = process.env.ComSpec ?? 'cmd.exe';
        child = spawn(comspec, ['/d', '/s', '/c', `npm run ${program.npm.script}`], {
          cwd: program.npm.cwdPath,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
      } else {
        child = spawn('npm', ['run', program.npm.script], {
          cwd: program.npm.cwdPath,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
      }
    } catch (error) {
      throw this.failure(
        `No se pudo iniciar el ${options.label}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    this.child = child;

    let spawnError: Error | null = null;
    child.on('error', (error) => {
      spawnError = error;
      this.append(`Error al ejecutar el ${options.label}: ${error.message}`);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.append(text);
      this.emitLines('stdout', text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.append(text);
      this.emitLines('stderr', text);
    });
    child.on('exit', (code) => {
      if (this.generation !== generation) return;
      this.flushOutput();
      const wasReady = this.ready;
      this.child = null;
      this.ready = false;
      if (!this.stopping && wasReady) {
        const handler = this.exitHandler;
        this.exitHandler = null;
        handler?.(code);
      }
    });

    const inspectorPort = options.inspectorPort;
    const startedAt = Date.now();
    const deadline = Date.now() + (inspectorPort === null ? HTTP_TIMEOUT_MS : INSPECTOR_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (this.generation !== generation) {
        throw new Error(`El arranque del ${options.label} se canceló.`);
      }
      if (spawnError !== null) {
        const command = program.kind === 'npm' ? 'npm' : 'Node.js';
        throw this.failure(
          `No se pudo iniciar el ${options.label}. Comprueba que ${command} está instalado y en el PATH.`,
        );
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const detail = child.exitCode !== null ? ` (código ${String(child.exitCode)})` : '';
        throw this.failure(`El ${options.label} terminó antes de estar listo${detail}.`);
      }
      const ready =
        inspectorPort !== null
          ? await this.inspectorReady(inspectorPort)
          : options.readyUrl === null
            ? Date.now() - startedAt >= 1000
            : await isUrlReachable(options.readyUrl);
      if (ready) {
        if (child.pid === undefined) {
          throw this.failure(`El ${options.label} no expuso un PID utilizable.`);
        }
        this.ready = true;
        this.log.info(`${options.label} lanzado por la app`, {
          pid: child.pid,
          inspectorPort,
          readyUrl: options.readyUrl,
        });
        return { pid: child.pid, inspectorPort };
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw this.failure(
      inspectorPort === null
        ? `El ${options.label} no respondió en ${options.readyUrl ?? 'su puerto'} a tiempo.`
        : `El ${options.label} no abrió el inspector de Node a tiempo.`,
    );
  }

  stop(): void {
    this.generation += 1;
    this.stopping = true;
    this.ready = false;
    this.exitHandler = null;
    this.flushOutput();
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null || child.pid === undefined) {
      return;
    }
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        return;
      } catch {
        this.log.warn('No se pudo detener el proceso lanzado con taskkill');
      }
    }
    try {
      child.kill('SIGTERM');
    } catch {
      this.log.warn('No se pudo detener el proceso lanzado');
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // El proceso ya terminó.
      }
    }, FORCE_KILL_MS);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
    });
  }

  private failure(message: string): Error {
    this.stop();
    const tail = sanitizeOutput(this.output).trim().slice(-MAX_DETAIL_CHARS);
    return new Error(tail === '' ? message : `${message} Salida del proceso: ${tail}`);
  }

  private append(text: string): void {
    this.output = (this.output + text).slice(-MAX_OUTPUT_CHARS);
  }

  private emitLines(stream: 'stdout' | 'stderr', text: string): void {
    const handler = this.outputHandler;
    if (handler === null) return;
    const parts = (this.lineBuffers[stream] + text).split(/\r?\n/);
    this.lineBuffers[stream] = parts.pop() ?? '';
    for (const part of parts) {
      const line = sanitizeOutput(part).trimEnd();
      if (line.trim() !== '') {
        handler(stream, line);
      }
    }
  }

  private flushOutput(): void {
    const handler = this.outputHandler;
    for (const stream of ['stdout', 'stderr'] as const) {
      const line = sanitizeOutput(this.lineBuffers[stream]).trim();
      this.lineBuffers[stream] = '';
      if (handler !== null && line !== '') {
        handler(stream, line);
      }
    }
    this.outputHandler = null;
  }

  private async inspectorReady(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return false;
      }
      return hasInspectorTarget(await response.json());
    } catch {
      return false;
    }
  }
}
