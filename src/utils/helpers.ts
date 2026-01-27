/**
 * ⬛⬜🛣️ BlackRoad Utilities - Helper functions
 */

import type { Repository, RepoChange, ApiResponse } from '../types';

// ============================================================================
// ID GENERATION
// ============================================================================
export function generateId(prefix?: string): string {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function generateShortId(length = 8): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, length);
}

// ============================================================================
// TIME UTILITIES
// ============================================================================
export function now(): number {
  return Date.now();
}

export function timestamp(): string {
  return new Date().toISOString();
}

export function parseMs(value: string | number): number {
  if (typeof value === 'number') return value;
  const num = parseInt(value, 10);
  return isNaN(num) ? 0 : num;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isExpired(timestamp: number, ttlMs: number): boolean {
  return now() - timestamp > ttlMs;
}

// ============================================================================
// RETRY UTILITIES
// ============================================================================
export interface RetryOptions {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | undefined;
  let delay = opts.baseDelay;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === opts.maxAttempts) {
        throw lastError;
      }

      await sleep(Math.min(delay, opts.maxDelay));
      delay *= opts.backoffMultiplier;
    }
  }

  throw lastError;
}

// ============================================================================
// REPOSITORY UTILITIES
// ============================================================================
export function parseRepoFullName(fullName: string): { owner: string; name: string } {
  const [owner, name] = fullName.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  return { owner, name };
}

export function buildRepoFullName(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function parseMonitoredRepos(reposString: string): string[] {
  return reposString
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

export function categorizeChanges(changes: RepoChange[]): {
  added: RepoChange[];
  modified: RepoChange[];
  deleted: RepoChange[];
  renamed: RepoChange[];
} {
  return {
    added: changes.filter(c => c.type === 'added'),
    modified: changes.filter(c => c.type === 'modified'),
    deleted: changes.filter(c => c.type === 'deleted'),
    renamed: changes.filter(c => c.type === 'renamed'),
  };
}

// ============================================================================
// API RESPONSE UTILITIES
// ============================================================================
export function successResponse<T>(data: T, requestId: string): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: now(),
    requestId,
  };
}

export function errorResponse(error: string, requestId: string): ApiResponse<never> {
  return {
    success: false,
    error,
    timestamp: now(),
    requestId,
  };
}

export function jsonResponse<T>(data: ApiResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': data.requestId,
    },
  });
}

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================
export function isValidUUID(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

export function isValidRepoName(value: string): boolean {
  const repoRegex = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
  return repoRegex.test(value);
}

export function assertDefined<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) {
    throw new Error(`${name} is required but was ${value}`);
  }
  return value;
}

// ============================================================================
// OBJECT UTILITIES
// ============================================================================
export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

export function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result as Omit<T, K>;
}

export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        targetValue as object,
        sourceValue as object
      );
    } else if (sourceValue !== undefined) {
      (result as Record<string, unknown>)[key] = sourceValue;
    }
  }
  return result;
}

// ============================================================================
// HASH UTILITIES
// ============================================================================
export async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifySignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signatureBytes = hexToBytes(signature.replace('sha256=', ''));
  return crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(payload));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ============================================================================
// RATE LIMITING
// ============================================================================
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second

  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokens = maxTokens;
    this.lastRefill = now();
  }

  private refill(): void {
    const currentTime = now();
    const elapsed = (currentTime - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = currentTime;
  }

  tryAcquire(tokens = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  async acquire(tokens = 1): Promise<void> {
    while (!this.tryAcquire(tokens)) {
      await sleep(100);
    }
  }
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half-open',
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private lastFailure = 0;
  private readonly threshold: number;
  private readonly timeout: number;

  constructor(threshold = 5, timeoutMs = 30000) {
    this.threshold = threshold;
    this.timeout = timeoutMs;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (now() - this.lastFailure > this.timeout) {
        this.state = CircuitState.HALF_OPEN;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = CircuitState.CLOSED;
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailure = now();

    if (this.failures >= this.threshold) {
      this.state = CircuitState.OPEN;
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}
