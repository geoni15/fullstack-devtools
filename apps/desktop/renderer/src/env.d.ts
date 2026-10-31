/// <reference types="vite/client" />

import type { BdtApi } from '@bdt/protocol';

declare global {
  interface Window {
    bdt: BdtApi;
  }
}

export {};
