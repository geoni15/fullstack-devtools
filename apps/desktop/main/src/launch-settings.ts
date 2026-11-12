import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { STORED_LAUNCH_SETUP_SCHEMA, type StoredLaunchSetup } from '@bdt/protocol';
import { createLogger, type Logger } from './logger';

const FILE_NAME = 'launch-setups.json';
const FILE_VERSION = 1;
const MAX_PATH_LENGTH = 4096;

interface SettingsFile {
  version: number;
  setups: Record<string, StoredLaunchSetup>;
  lastWorkspace: string | null;
}

function parseSetup(value: unknown): StoredLaunchSetup | null {
  const parsed = STORED_LAUNCH_SETUP_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseLastWorkspace(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > MAX_PATH_LENGTH) return null;
  return path.isAbsolute(value) ? value : null;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

export class LaunchSettingsStore {
  private readonly log: Logger;
  private cache: SettingsFile | null = null;
  private loading: Promise<SettingsFile> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(log: Logger = createLogger('launch-settings')) {
    this.log = log;
  }

  private filePath(): string {
    return path.join(app.getPath('userData'), FILE_NAME);
  }

  private async load(): Promise<SettingsFile> {
    if (this.cache !== null) return this.cache;
    if (this.loading !== null) return this.loading;
    this.loading = (async () => {
      const file: SettingsFile = { version: FILE_VERSION, setups: {}, lastWorkspace: null };
      try {
        const raw = await fs.readFile(this.filePath(), 'utf8');
        const parsed = JSON.parse(raw) as {
          version?: unknown;
          setups?: unknown;
          lastWorkspace?: unknown;
        };
        if (
          parsed.version === FILE_VERSION &&
          typeof parsed.setups === 'object' &&
          parsed.setups !== null
        ) {
          for (const [workspaceId, value] of Object.entries(parsed.setups)) {
            const setup = parseSetup(value);
            if (setup !== null) file.setups[workspaceId] = setup;
          }
          file.lastWorkspace = parseLastWorkspace(parsed.lastWorkspace);
        }
        this.log.debug('Configuración de arranque leída', {
          file: this.filePath(),
          workspaces: Object.keys(file.setups).length,
          lastWorkspace: file.lastWorkspace,
        });
      } catch (error) {
        if (!isMissingFile(error)) {
          this.log.warn('No se pudo leer la configuración guardada de arranque', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.cache = file;
      return file;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private enqueue(run: () => Promise<void>, description: string): Promise<void> {
    const next = this.writeChain.then(run, run).catch((error: unknown) => {
      this.log.warn(`No se pudo guardar ${description}`, {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.writeChain = next;
    return next;
  }

  private async persist(file: SettingsFile): Promise<void> {
    const target = this.filePath();
    const temp = `${target}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const payload: SettingsFile = {
      version: FILE_VERSION,
      setups: file.setups,
      lastWorkspace: file.lastWorkspace,
    };
    await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(temp, target);
  }

  async get(workspaceId: string): Promise<StoredLaunchSetup | null> {
    const file = await this.load();
    return file.setups[workspaceId] ?? null;
  }

  async set(workspaceId: string, setup: StoredLaunchSetup): Promise<void> {
    const sanitized = parseSetup(setup);
    if (sanitized === null) return;
    await this.enqueue(async () => {
      const file = await this.load();
      file.setups[workspaceId] = sanitized;
      await this.persist(file);
      this.log.info('Configuración de arranque guardada', {
        key: workspaceId,
        file: this.filePath(),
        frontend: sanitized.frontendCommand,
        backend: sanitized.backendCommand,
      });
    }, 'la configuración de arranque');
  }

  async getLastWorkspace(): Promise<string | null> {
    const file = await this.load();
    return file.lastWorkspace;
  }

  async setLastWorkspace(rootPath: string | null): Promise<void> {
    const value = parseLastWorkspace(rootPath);
    await this.enqueue(async () => {
      const file = await this.load();
      if (file.lastWorkspace === value) return;
      file.lastWorkspace = value;
      await this.persist(file);
      this.log.info('Último espacio de trabajo recordado', { root: value });
    }, 'el último espacio de trabajo');
  }
}
