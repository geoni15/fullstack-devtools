import type { CapturedBody, CapturedRequest } from '@bdt/protocol';
import { classifyUrl, normalizeOrigin, type ClassificationTargets } from './classify';
import { maskHeaders, maskUrlParts } from './headers';
import { normalizeInitiator, type RawInitiator } from './initiator';

export interface RequestStartInput {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  timestamp: number;
  wallTimestamp?: number;
  initiator?: RawInitiator | null;
  headers?: Record<string, string> | null;
  requestBody?: CapturedBody | null;
}

export interface RequestFinishInput {
  statusCode: number | null;
  mimeType: string | null;
  durationMs: number;
}

const DEFAULT_LIMIT = Number.POSITIVE_INFINITY;
const MAX_METHOD_LENGTH = 16;
const MAX_RESOURCE_TYPE_LENGTH = 32;
const MAX_ERROR_LENGTH = 200;

function normalizeMethod(value: string): string {
  const upper = value.toUpperCase();
  return upper.length === 0 ? 'GET' : upper.slice(0, MAX_METHOD_LENGTH);
}

function normalizeResourceType(value: string): string {
  return value.length === 0 ? 'Other' : value.slice(0, MAX_RESOURCE_TYPE_LENGTH);
}

export class RequestBuffer {
  private readonly entries = new Map<string, CapturedRequest>();
  private readonly order: string[] = [];

  constructor(
    private readonly targets: ClassificationTargets,
    private readonly limit = DEFAULT_LIMIT,
  ) {}

  begin(input: RequestStartInput): CapturedRequest | null {
    const existing = this.entries.get(input.requestId);
    if (existing !== undefined) return existing;

    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    const origin = classifyUrl(input.url, this.targets);
    const masked = maskUrlParts(input.url);
    const request: CapturedRequest = {
      id: input.requestId,
      method: normalizeMethod(input.method),
      url: masked.url,
      host: url.host.slice(0, 255),
      path: masked.path,
      resourceType: normalizeResourceType(input.resourceType),
      origin,
      outcome: 'pending',
      statusCode: null,
      mimeType: null,
      startedAt: Math.round(input.timestamp),
      wallStartedAt: Math.round(input.wallTimestamp ?? Date.now()),
      durationMs: null,
      error: null,
      initiator: normalizeInitiator(input.initiator),
      headers: maskHeaders(input.headers),
      requestBody: input.requestBody ?? null,
      responseBody: null,
    };

    this.entries.set(request.id, request);
    this.order.push(request.id);
    this.evict();
    return request;
  }

  finish(requestId: string, input: RequestFinishInput): CapturedRequest | null {
    const request = this.entries.get(requestId);
    if (request === undefined) return null;
    const updated: CapturedRequest = {
      ...request,
      outcome: 'finished',
      statusCode: input.statusCode,
      mimeType: input.mimeType === null ? null : input.mimeType.slice(0, 128),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      error: null,
    };
    this.entries.set(requestId, updated);
    return updated;
  }

  fail(requestId: string, error: string, durationMs: number): CapturedRequest | null {
    const request = this.entries.get(requestId);
    if (request === undefined) return null;
    const updated: CapturedRequest = {
      ...request,
      outcome: 'failed',
      durationMs: Math.max(0, Math.round(durationMs)),
      error: error.slice(0, MAX_ERROR_LENGTH),
    };
    this.entries.set(requestId, updated);
    return updated;
  }

  setHeaders(
    requestId: string,
    headers: Record<string, string> | null | undefined,
  ): CapturedRequest | null {
    const request = this.entries.get(requestId);
    if (request === undefined) return null;
    const updated: CapturedRequest = { ...request, headers: maskHeaders(headers) };
    this.entries.set(requestId, updated);
    return updated;
  }

  setResponseBody(requestId: string, body: CapturedBody | null): CapturedRequest | null {
    const request = this.entries.get(requestId);
    if (request === undefined || body === null) return null;
    const updated: CapturedRequest = { ...request, responseBody: body };
    this.entries.set(requestId, updated);
    return updated;
  }

  setRequestBody(requestId: string, body: CapturedBody | null): CapturedRequest | null {
    const request = this.entries.get(requestId);
    if (request === undefined || body === null) return null;
    const updated: CapturedRequest = { ...request, requestBody: body };
    this.entries.set(requestId, updated);
    return updated;
  }

  get(requestId: string): CapturedRequest | null {
    return this.entries.get(requestId) ?? null;
  }

  all(): CapturedRequest[] {
    return this.order
      .map((id) => this.entries.get(id))
      .filter((entry): entry is CapturedRequest => entry !== undefined);
  }

  clear(): void {
    this.entries.clear();
    this.order.length = 0;
  }

  get count(): number {
    return this.order.length;
  }

  private evict(): void {
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

export function matchesTargets(
  frontendUrl: string,
  backendUrl: string,
): ClassificationTargets | null {
  const frontendOrigin = normalizeOrigin(frontendUrl);
  const backendOrigin = normalizeOrigin(backendUrl);
  if (frontendOrigin === null || backendOrigin === null) return null;
  if (frontendOrigin === backendOrigin) return null;
  return { frontendOrigin, backendOrigin };
}
