/**
 * ⬛⬜🛣️ BlackRoad Base Agent - Abstract base class for all agents
 */

import type { Env, AgentMessage, AgentStatus, AgentType } from '../types';
import { Logger } from '../utils/logger';
import { generateId, now } from '../utils/helpers';

export interface BaseAgentState {
  agentId: string;
  agentType: AgentType;
  status: AgentStatus;
  lastHeartbeat: number;
  messageQueue: AgentMessage[];
  taskCount: number;
  errorCount: number;
  startedAt: number;
  metadata: Record<string, unknown>;
}

export abstract class BaseAgent implements DurableObject {
  protected state: DurableObjectState;
  protected env: Env;
  protected logger: Logger;
  protected storage: DurableObjectStorage;
  protected agentState: BaseAgentState;
  protected initialized = false;
  protected heartbeatInterval: number | null = null;

  constructor(
    state: DurableObjectState,
    env: Env,
    agentType: AgentType,
    agentId?: string
  ) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
    this.logger = Logger.fromEnv(env.LOG_LEVEL).withAgentId(agentId || agentType);

    this.agentState = {
      agentId: agentId || generateId(agentType),
      agentType,
      status: 'idle',
      lastHeartbeat: now(),
      messageQueue: [],
      taskCount: 0,
      errorCount: 0,
      startedAt: now(),
      metadata: {},
    };

    // Initialize in background
    this.state.blockConcurrencyWhile(async () => {
      await this.initialize();
    });
  }

  protected async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load persisted state
    const stored = await this.storage.get<BaseAgentState>('agentState');
    if (stored) {
      this.agentState = { ...this.agentState, ...stored };
    }

    // Set up heartbeat alarm
    const currentAlarm = await this.storage.getAlarm();
    if (!currentAlarm) {
      await this.storage.setAlarm(now() + 15000); // 15 second heartbeat
    }

    await this.onInitialize();
    this.initialized = true;
    this.logger.info(`${this.agentState.agentType} agent initialized`);
  }

  protected abstract onInitialize(): Promise<void>;
  protected abstract handleMessage(message: AgentMessage): Promise<void>;
  protected abstract processWork(): Promise<void>;

  protected async persistState(): Promise<void> {
    await this.storage.put('agentState', this.agentState);
  }

  protected async updateStatus(status: AgentStatus, task?: string): Promise<void> {
    this.agentState.status = status;
    this.agentState.lastHeartbeat = now();

    try {
      // Report status to orchestrator
      const orchestratorId = this.env.AGENT_ORCHESTRATOR.idFromName('orchestrator');
      const orchestrator = this.env.AGENT_ORCHESTRATOR.get(orchestratorId);

      await orchestrator.fetch(
        new Request(`http://internal/agent/${this.agentState.agentId}/status`, {
          method: 'PUT',
          body: JSON.stringify({ status, currentTask: task }),
        })
      );
    } catch (error) {
      this.logger.warn('Failed to report status to orchestrator', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    await this.persistState();
  }

  protected async sendHeartbeat(): Promise<void> {
    this.agentState.lastHeartbeat = now();

    try {
      const orchestratorId = this.env.AGENT_ORCHESTRATOR.idFromName('orchestrator');
      const orchestrator = this.env.AGENT_ORCHESTRATOR.get(orchestratorId);

      await orchestrator.fetch(
        new Request(`http://internal/agent/${this.agentState.agentId}/heartbeat`, {
          method: 'POST',
        })
      );
    } catch (error) {
      this.logger.warn('Failed to send heartbeat', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'GET') {
        if (path === '/status') return this.getStatus();
        if (path === '/health') return this.getHealth();
      }

      if (request.method === 'POST') {
        if (path === '/message') return this.receiveMessage(request);
        if (path === '/trigger') return this.triggerWork(request);
      }

      // Delegate to subclass for custom routes
      return this.handleRequest(request);
    } catch (error) {
      this.agentState.errorCount++;
      await this.persistState();

      this.logger.error('Request failed',
        error instanceof Error ? error : new Error(String(error))
      );

      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  protected async handleRequest(request: Request): Promise<Response> {
    return new Response('Not Found', { status: 404 });
  }

  async alarm(): Promise<void> {
    // Send heartbeat
    await this.sendHeartbeat();

    // Process any pending work
    if (this.agentState.status === 'idle' && this.agentState.messageQueue.length > 0) {
      const message = this.agentState.messageQueue.shift();
      if (message) {
        await this.updateStatus('running');
        try {
          await this.handleMessage(message);
          await this.updateStatus('idle');
        } catch (error) {
          this.agentState.errorCount++;
          this.logger.error('Message handling failed',
            error instanceof Error ? error : new Error(String(error))
          );
          await this.updateStatus('error');
        }
      }
    }

    await this.persistState();

    // Schedule next alarm
    await this.storage.setAlarm(now() + 15000);
  }

  private getStatus(): Response {
    return new Response(JSON.stringify({
      agentId: this.agentState.agentId,
      agentType: this.agentState.agentType,
      status: this.agentState.status,
      uptime: now() - this.agentState.startedAt,
      taskCount: this.agentState.taskCount,
      errorCount: this.agentState.errorCount,
      queuedMessages: this.agentState.messageQueue.length,
      lastHeartbeat: this.agentState.lastHeartbeat,
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private getHealth(): Response {
    const timeSinceHeartbeat = now() - this.agentState.lastHeartbeat;
    const isHealthy = timeSinceHeartbeat < 60000 && this.agentState.status !== 'error';

    return new Response(JSON.stringify({
      healthy: isHealthy,
      status: this.agentState.status,
      timeSinceHeartbeat,
      errorCount: this.agentState.errorCount,
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async receiveMessage(request: Request): Promise<Response> {
    const message = await request.json() as AgentMessage;
    message.timestamp = message.timestamp || now();

    this.agentState.messageQueue.push(message);
    await this.persistState();

    this.logger.debug('Message received', {
      from: message.from,
      type: message.type
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async triggerWork(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    if (this.agentState.status !== 'idle') {
      return new Response(JSON.stringify({
        error: 'Agent is busy',
        status: this.agentState.status
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await this.updateStatus('running');
    this.agentState.taskCount++;

    try {
      await this.processWork();
      await this.updateStatus('idle');

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      this.agentState.errorCount++;
      await this.updateStatus('error');

      this.logger.error('Work processing failed',
        error instanceof Error ? error : new Error(String(error))
      );

      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // Utility methods for subclasses
  protected async storeData<T>(key: string, value: T): Promise<void> {
    await this.storage.put(key, value);
  }

  protected async getData<T>(key: string): Promise<T | undefined> {
    return this.storage.get<T>(key);
  }

  protected async deleteData(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  protected async listData(prefix: string): Promise<Map<string, unknown>> {
    return this.storage.list({ prefix });
  }
}
