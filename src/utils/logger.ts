/**
 * ⬛⬜🛣️ BlackRoad Logger - Structured logging for Workers
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
  error?: Error;
  requestId?: string;
  agentId?: string;
  traceId?: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private context: Record<string, unknown> = {};
  private minLevel: LogLevel;
  private requestId?: string;
  private agentId?: string;

  constructor(minLevel: LogLevel = 'info') {
    this.minLevel = minLevel;
  }

  static fromEnv(logLevel?: string): Logger {
    const level = (logLevel?.toLowerCase() as LogLevel) || 'info';
    return new Logger(level);
  }

  withContext(ctx: Record<string, unknown>): Logger {
    const logger = new Logger(this.minLevel);
    logger.context = { ...this.context, ...ctx };
    logger.requestId = this.requestId;
    logger.agentId = this.agentId;
    return logger;
  }

  withRequestId(requestId: string): Logger {
    const logger = this.withContext({});
    logger.requestId = requestId;
    return logger;
  }

  withAgentId(agentId: string): Logger {
    const logger = this.withContext({});
    logger.agentId = agentId;
    return logger;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  private formatEntry(entry: LogEntry): string {
    const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}]`;
    const ids = [
      entry.requestId ? `req:${entry.requestId.slice(0, 8)}` : null,
      entry.agentId ? `agent:${entry.agentId.slice(0, 8)}` : null,
    ]
      .filter(Boolean)
      .join(' ');

    const idPart = ids ? ` [${ids}]` : '';
    const contextPart = entry.context && Object.keys(entry.context).length > 0
      ? ` ${JSON.stringify(entry.context)}`
      : '';

    return `${prefix}${idPart} ${entry.message}${contextPart}`;
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>, error?: Error): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context: { ...this.context, ...context },
      error,
      requestId: this.requestId,
      agentId: this.agentId,
    };

    const formatted = this.formatEntry(entry);

    switch (level) {
      case 'debug':
        console.debug(formatted);
        break;
      case 'info':
        console.info(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'error':
        console.error(formatted);
        if (error) console.error(error.stack);
        break;
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.log('error', message, context, error);
  }

  // Specialized logging methods
  agentEvent(event: string, agentType: string, details?: Record<string, unknown>): void {
    this.info(`Agent Event: ${event}`, { agentType, ...details });
  }

  taskEvent(event: string, taskId: string, details?: Record<string, unknown>): void {
    this.info(`Task Event: ${event}`, { taskId, ...details });
  }

  syncEvent(event: string, repo: string, details?: Record<string, unknown>): void {
    this.info(`Sync Event: ${event}`, { repo, ...details });
  }

  resolutionEvent(event: string, issueId: string, details?: Record<string, unknown>): void {
    this.info(`Resolution Event: ${event}`, { issueId, ...details });
  }

  cohesionEvent(event: string, score: number, details?: Record<string, unknown>): void {
    this.info(`Cohesion Event: ${event}`, { score, ...details });
  }
}

// Global logger instance
export const logger = Logger.fromEnv(
  typeof globalThis !== 'undefined' ? (globalThis as unknown as Record<string, string>).LOG_LEVEL : 'info'
);

// Utility for generating request IDs
export function generateRequestId(): string {
  return crypto.randomUUID();
}

// Utility for generating trace IDs
export function generateTraceId(): string {
  return `trace_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}
