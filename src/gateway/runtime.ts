import type { ProtocolId } from '../domain/types.js';

/**
 * In-memory view of requests currently in flight (plus a short tail of recent
 * ones). Powers the dashboard "Active Requests", queue metrics and the
 * real-time SSE feed. Never persisted — the durable record is written on
 * completion by the usage recorder.
 */

export type LivePhase = 'received' | 'queued' | 'upstream' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface LiveAttempt {
  attemptNo: number;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  apiKeyId: string | null;
  apiKeyName: string | null;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'success' | 'failed';
  errorType?: string;
  latencyMs?: number;
  queueWaitMs?: number;
}

export interface LiveRequest {
  requestId: string;
  startedAt: string;
  clientProtocol: ProtocolId;
  requestedModel: string;
  resolvedModel: string | null;
  providerId: string | null;
  providerName: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  phase: LivePhase;
  stream: boolean;
  ttftMs: number | null;
  bytesOut: number;
  fallbackCount: number;
  attempts: LiveAttempt[];
  lastEventAt: string;
  completedAt: string | null;
  errorType: string | null;
}

const RECENT_LIMIT = 100;

export class RequestRuntime {
  private readonly active = new Map<string, LiveRequest>();
  private readonly recent: LiveRequest[] = [];
  private readonly listeners = new Set<(requests: LiveRequest[]) => void>();

  begin(input: {
    requestId: string;
    clientProtocol: ProtocolId;
    requestedModel: string;
    stream: boolean;
  }): LiveRequest {
    const now = new Date().toISOString();
    const live: LiveRequest = {
      requestId: input.requestId,
      startedAt: now,
      clientProtocol: input.clientProtocol,
      requestedModel: input.requestedModel,
      resolvedModel: null,
      providerId: null,
      providerName: null,
      apiKeyId: null,
      apiKeyName: null,
      phase: 'received',
      stream: input.stream,
      ttftMs: null,
      bytesOut: 0,
      fallbackCount: 0,
      attempts: [],
      lastEventAt: now,
      completedAt: null,
      errorType: null,
    };
    this.active.set(input.requestId, live);
    this.notify();
    return live;
  }

  update(requestId: string, patch: Partial<LiveRequest>): void {
    const live = this.active.get(requestId);
    if (!live) return;
    Object.assign(live, patch);
    live.lastEventAt = new Date().toISOString();
    this.notify();
  }

  addAttempt(requestId: string, attempt: LiveAttempt): void {
    const live = this.active.get(requestId);
    if (!live) return;
    live.attempts.push(attempt);
    live.lastEventAt = new Date().toISOString();
    this.notify();
  }

  updateAttempt(requestId: string, attemptNo: number, patch: Partial<LiveAttempt>): void {
    const live = this.active.get(requestId);
    if (!live) return;
    const attempt = live.attempts.find((entry) => entry.attemptNo === attemptNo);
    if (attempt) Object.assign(attempt, patch);
    this.notify();
  }

  addBytes(requestId: string, bytes: number): void {
    const live = this.active.get(requestId);
    if (!live) return;
    live.bytesOut += bytes;
  }

  finish(requestId: string, phase: LivePhase, errorType: string | null = null): void {
    const live = this.active.get(requestId);
    if (!live) return;
    live.phase = phase;
    live.errorType = errorType;
    live.completedAt = new Date().toISOString();
    this.active.delete(requestId);
    this.recent.unshift(live);
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT;
    this.notify();
  }

  activeRequests(): LiveRequest[] {
    return [...this.active.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  recentRequests(limit = 25): LiveRequest[] {
    return this.recent.slice(0, limit);
  }

  counts(): { active: number; queued: number; streaming: number } {
    let queued = 0;
    let streaming = 0;
    for (const live of this.active.values()) {
      if (live.phase === 'queued' || live.phase === 'received') queued += 1;
      if (live.stream) streaming += 1;
    }
    return { active: this.active.size, queued, streaming };
  }

  subscribe(listener: (requests: LiveRequest[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.activeRequests();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* listeners must never break request handling */
      }
    }
  }
}
