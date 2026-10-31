import { z } from 'zod';

export const IPC_CHANNELS = {
  openWorkspace: 'workspace:open',
  getState: 'workspace:state',
  readFile: 'file:read',
  workspaceChanged: 'workspace:changed',
  detectProjectSetup: 'project:detect-setup',
  browserConfigure: 'browser:configure',
  browserDisconnect: 'browser:disconnect',
  browserReload: 'browser:reload',
  browserBounds: 'browser:bounds',
  browserSnapshot: 'browser:snapshot',
  browserClearRequests: 'browser:clear-requests',
  browserSetInspection: 'browser:set-inspection',
  browserFocus: 'browser:focus',
  browserEvent: 'browser:event',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const NO_PAYLOAD_SCHEMA = z.undefined();

export const READ_FILE_REQUEST_SCHEMA = z.strictObject({
  path: z.string().min(1).max(4096),
});

export type ParsedReadFileRequest = z.infer<typeof READ_FILE_REQUEST_SCHEMA>;

export const WORKSPACE_CHANGED_PAYLOAD_SCHEMA = z.strictObject({});

export const BROWSER_TARGETS_REQUEST_SCHEMA = z.strictObject({
  frontendUrl: z.string().min(1).max(2048),
  backendUrl: z.string().min(1).max(2048),
  mode: z.enum(['window', 'embedded']),
  nodeInspectorPort: z.number().int().min(1).max(65535).nullable(),
  frontendLaunch: z
    .strictObject({
      command: z.string().min(1).max(2048),
      cwd: z.string().max(1024),
    })
    .nullable()
    .optional(),
  backendLaunch: z
    .strictObject({
      command: z.string().min(1).max(2048),
      cwd: z.string().max(1024),
    })
    .nullable(),
});

export type ParsedBrowserTargetsRequest = z.infer<typeof BROWSER_TARGETS_REQUEST_SCHEMA>;

export const BROWSER_SET_INSPECTION_SCHEMA = z.strictObject({
  enabled: z.boolean(),
});

export type ParsedBrowserSetInspection = z.infer<typeof BROWSER_SET_INSPECTION_SCHEMA>;

export const BROWSER_BOUNDS_SCHEMA = z.strictObject({
  x: z.number().int().min(-10000).max(20000),
  y: z.number().int().min(-10000).max(20000),
  width: z.number().int().min(0).max(20000),
  height: z.number().int().min(0).max(20000),
  visible: z.boolean(),
});

export type ParsedBrowserBounds = z.infer<typeof BROWSER_BOUNDS_SCHEMA>;
