/**
 * ⬛⬜🛣️ BlackRoad Agent Orchestrator - Durable Object
 *
 * Central coordinator for all agents in the system.
 * Manages agent lifecycle, routing, and coordination.
 */

import type {
  Env,
  Agent,
  AgentMessage,
  AgentTask,
  AgentStatus,
  AgentType,
  SystemEvent
} from '../types';
import { Logger } from '../utils/logger';
import { generateId, now, sleep } from '../utils/helpers';

interface OrchestratorState {
  agents: Map<string, Agent>;
  messageQueue: AgentMessage[];
  pendingTasks: Map<string, AgentTask>;
  events: SystemEvent[];
  startedAt: number;
  lastHealthCheck: number;
}

export class AgentOrchestrator implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private logger: Logger;
  private storage: DurableObjectStorage;
  private orchestratorState: OrchestratorState;
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
    this.logger = Logger.fromEnv(env.LOG_LEVEL).withAgentId('orchestrator');

    this.orchestratorState = {
      agents: new Map(),
      messageQueue: [],
      pendingTasks: new Map(),
      events: [],
      startedAt: now(),
      lastHealthCheck: 0,
    };

    // Schedule alarm for continuous health monitoring
    this.state.blockConcurrencyWhile(async () => {
      await this.initialize();
    });
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load state from storage
    const stored = await this.storage.get<OrchestratorState>('state');
    if (stored) {
      this.orchestratorState = {
        ...stored,
        agents: new Map(Object.entries(stored.agents || {})),
        pendingTasks: new Map(Object.entries(stored.pendingTasks || {})),
      };
    }

    // Register core agents
    await this.registerCoreAgents();

    // Set up recurring alarm
    const currentAlarm = await this.storage.getAlarm();
    if (!currentAlarm) {
      await this.storage.setAlarm(now() + 30000); // 30 second health check
    }

    this.initialized = true;
    this.logger.info('Agent Orchestrator initialized', {
      agentCount: this.orchestratorState.agents.size
    });
  }

  private async registerCoreAgents(): Promise<void> {
    const coreAgents: Array<{ type: AgentType; name: string; capabilities: string[] }> = [
      {
        type: 'scheduler',
        name: 'Job Scheduler',
        capabilities: ['schedule', 'cron', 'recurring', 'delayed']
      },
      {
        type: 'sync',
        name: 'Repository Sync Agent',
        capabilities: ['scrape', 'sync', 'diff', 'fetch', 'cache']
      },
      {
        type: 'healer',
        name: 'Self Healer',
        capabilities: ['diagnose', 'resolve', 'rollback', 'recover']
      },
      {
        type: 'monitor',
        name: 'Cohesion Monitor',
        capabilities: ['analyze', 'compare', 'report', 'alert']
      },
    ];

    for (const agentDef of coreAgents) {
      const existingAgent = Array.from(this.orchestratorState.agents.values())
        .find(a => a.type === agentDef.type);

      if (!existingAgent) {
        const agent: Agent = {
          id: generateId(agentDef.type),
          type: agentDef.type,
          name: agentDef.name,
          status: 'idle',
          lastHeartbeat: now(),
          createdAt: now(),
          metadata: {},
          capabilities: agentDef.capabilities,
          errorCount: 0,
          successCount: 0,
        };
        this.orchestratorState.agents.set(agent.id, agent);
      }
    }

    await this.persistState();
  }

  private async persistState(): Promise<void> {
    const serializable = {
      ...this.orchestratorState,
      agents: Object.fromEntries(this.orchestratorState.agents),
      pendingTasks: Object.fromEntries(this.orchestratorState.pendingTasks),
    };
    await this.storage.put('state', serializable);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Route requests
      if (request.method === 'GET') {
        if (path === '/status') return this.getStatus();
        if (path === '/agents') return this.listAgents();
        if (path === '/health') return this.healthCheck();
        if (path.startsWith('/agent/')) {
          const agentId = path.replace('/agent/', '');
          return this.getAgent(agentId);
        }
      }

      if (request.method === 'POST') {
        if (path === '/message') return this.handleMessage(request);
        if (path === '/task') return this.submitTask(request);
        if (path === '/broadcast') return this.broadcast(request);
        if (path.startsWith('/agent/') && path.endsWith('/heartbeat')) {
          const agentId = path.replace('/agent/', '').replace('/heartbeat', '');
          return this.updateHeartbeat(agentId);
        }
      }

      if (request.method === 'PUT') {
        if (path.startsWith('/agent/') && path.endsWith('/status')) {
          const agentId = path.replace('/agent/', '').replace('/status', '');
          return this.updateAgentStatus(agentId, request);
        }
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      this.logger.error('Request failed', error instanceof Error ? error : new Error(String(error)));
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  async alarm(): Promise<void> {
    this.logger.debug('Running health check alarm');

    // Perform health check on all agents
    const unhealthyAgents: Agent[] = [];
    const staleThreshold = 60000; // 1 minute

    for (const agent of this.orchestratorState.agents.values()) {
      const timeSinceHeartbeat = now() - agent.lastHeartbeat;

      if (timeSinceHeartbeat > staleThreshold && agent.status !== 'stopped') {
        agent.status = 'error';
        unhealthyAgents.push(agent);
        this.logger.warn('Agent unhealthy', {
          agentId: agent.id,
          agentType: agent.type,
          timeSinceHeartbeat
        });
      }
    }

    // Trigger self-healing for unhealthy agents
    if (unhealthyAgents.length > 0 && this.env.AUTO_RESOLUTION_ENABLED === 'true') {
      await this.triggerSelfHealing(unhealthyAgents);
    }

    this.orchestratorState.lastHealthCheck = now();
    await this.persistState();

    // Schedule next alarm
    await this.storage.setAlarm(now() + 30000);
  }

  private async triggerSelfHealing(unhealthyAgents: Agent[]): Promise<void> {
    this.logger.info('Triggering self-healing', {
      unhealthyCount: unhealthyAgents.length
    });

    for (const agent of unhealthyAgents) {
      try {
        // Queue resolution task
        await this.env.RESOLUTION_QUEUE.send({
          id: generateId('resolution'),
          issueId: generateId('issue'),
          type: 'error',
          severity: 'error',
          status: 'detected',
          description: `Agent ${agent.name} (${agent.type}) is unresponsive`,
          affectedRepos: [],
          affectedFiles: [],
          detectedAt: now(),
          attempts: [],
          metadata: { agentId: agent.id, agentType: agent.type },
        });

        // Mark agent as recovering
        agent.status = 'recovering';
        this.orchestratorState.agents.set(agent.id, agent);

        this.logger.info('Self-healing triggered for agent', {
          agentId: agent.id,
          agentType: agent.type
        });
      } catch (error) {
        this.logger.error('Failed to trigger self-healing',
          error instanceof Error ? error : new Error(String(error)),
          { agentId: agent.id }
        );
      }
    }

    await this.persistState();
  }

  private getStatus(): Response {
    const status = {
      status: 'operational',
      startedAt: this.orchestratorState.startedAt,
      uptime: now() - this.orchestratorState.startedAt,
      agentCount: this.orchestratorState.agents.size,
      pendingTasks: this.orchestratorState.pendingTasks.size,
      queuedMessages: this.orchestratorState.messageQueue.length,
      lastHealthCheck: this.orchestratorState.lastHealthCheck,
      version: this.env.BLACKROAD_VERSION,
    };

    return new Response(JSON.stringify(status), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private listAgents(): Response {
    const agents = Array.from(this.orchestratorState.agents.values());
    return new Response(JSON.stringify({ agents }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private getAgent(agentId: string): Response {
    const agent = this.orchestratorState.agents.get(agentId);
    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ agent }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private healthCheck(): Response {
    const agents = Array.from(this.orchestratorState.agents.values());
    const healthyCount = agents.filter(a => a.status === 'idle' || a.status === 'running').length;
    const unhealthyCount = agents.filter(a => a.status === 'error').length;
    const recoveringCount = agents.filter(a => a.status === 'recovering').length;

    const health = {
      status: unhealthyCount > 0 ? 'degraded' : 'healthy',
      agents: {
        total: agents.length,
        healthy: healthyCount,
        unhealthy: unhealthyCount,
        recovering: recoveringCount,
      },
      uptime: now() - this.orchestratorState.startedAt,
      lastCheck: this.orchestratorState.lastHealthCheck,
    };

    return new Response(JSON.stringify(health), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleMessage(request: Request): Promise<Response> {
    const message = await request.json() as AgentMessage;
    message.id = message.id || generateId('msg');
    message.timestamp = now();

    // Route message to target agent
    const targetAgent = this.orchestratorState.agents.get(message.to);
    if (!targetAgent) {
      return new Response(JSON.stringify({ error: 'Target agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get the appropriate Durable Object for the target agent
    const targetDO = this.getDurableObjectForAgent(targetAgent.type);
    if (targetDO) {
      const doId = targetDO.idFromName(targetAgent.type);
      const stub = targetDO.get(doId);
      await stub.fetch(new Request('http://internal/message', {
        method: 'POST',
        body: JSON.stringify(message),
      }));
    }

    this.logger.debug('Message routed', {
      from: message.from,
      to: message.to,
      type: message.type
    });

    return new Response(JSON.stringify({ success: true, messageId: message.id }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private getDurableObjectForAgent(type: AgentType): DurableObjectNamespace | null {
    switch (type) {
      case 'scheduler': return this.env.JOB_SCHEDULER;
      case 'sync': return this.env.REPO_SYNC_AGENT;
      case 'healer': return this.env.SELF_HEALER;
      case 'monitor': return this.env.COHESION_MONITOR;
      default: return null;
    }
  }

  private async submitTask(request: Request): Promise<Response> {
    const task = await request.json() as AgentTask;
    task.id = task.id || generateId('task');
    task.createdAt = now();
    task.status = 'pending';
    task.retryCount = 0;
    task.maxRetries = task.maxRetries || 3;

    this.orchestratorState.pendingTasks.set(task.id, task);

    // Queue the task
    await this.env.TASK_QUEUE.send(task);

    this.logger.info('Task submitted', { taskId: task.id, taskType: task.type });
    await this.persistState();

    return new Response(JSON.stringify({ success: true, taskId: task.id }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async broadcast(request: Request): Promise<Response> {
    const { message, targetTypes } = await request.json() as {
      message: Omit<AgentMessage, 'id' | 'timestamp' | 'to'>;
      targetTypes?: AgentType[];
    };

    const targets = Array.from(this.orchestratorState.agents.values())
      .filter(a => !targetTypes || targetTypes.includes(a.type));

    for (const target of targets) {
      const fullMessage: AgentMessage = {
        ...message,
        id: generateId('msg'),
        timestamp: now(),
        to: target.id,
      };

      const targetDO = this.getDurableObjectForAgent(target.type);
      if (targetDO) {
        const doId = targetDO.idFromName(target.type);
        const stub = targetDO.get(doId);
        await stub.fetch(new Request('http://internal/message', {
          method: 'POST',
          body: JSON.stringify(fullMessage),
        }));
      }
    }

    this.logger.info('Broadcast sent', { targetCount: targets.length });

    return new Response(JSON.stringify({
      success: true,
      recipientCount: targets.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async updateHeartbeat(agentId: string): Promise<Response> {
    const agent = this.orchestratorState.agents.get(agentId);
    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    agent.lastHeartbeat = now();
    if (agent.status === 'recovering' || agent.status === 'error') {
      agent.status = 'idle';
      this.logger.info('Agent recovered', { agentId, agentType: agent.type });
    }

    this.orchestratorState.agents.set(agentId, agent);
    await this.persistState();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async updateAgentStatus(agentId: string, request: Request): Promise<Response> {
    const agent = this.orchestratorState.agents.get(agentId);
    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { status, currentTask, error } = await request.json() as {
      status: AgentStatus;
      currentTask?: string;
      error?: string;
    };

    agent.status = status;
    agent.currentTask = currentTask;
    agent.lastHeartbeat = now();

    if (status === 'error' && error) {
      agent.errorCount++;
      this.logger.error('Agent reported error', new Error(error), { agentId, agentType: agent.type });
    } else if (status === 'idle' && agent.currentTask) {
      agent.successCount++;
      agent.currentTask = undefined;
    }

    this.orchestratorState.agents.set(agentId, agent);
    await this.persistState();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
