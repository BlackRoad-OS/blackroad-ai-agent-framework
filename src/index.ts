/**
 * ⬛⬜🛣️ BlackRoad AI Agent Framework
 *
 * Self-orchestrating agent system with Cloudflare Workers.
 * Features: Auto-healing, repo-syncing, cohesion-monitoring.
 *
 * @version 7.0.0
 * @author BlackRoad OS <blackroad.systems@gmail.com>
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { secureHeaders } from 'hono/secure-headers';

import type { Env, SyncJob, HealthCheck, ApiResponse } from './types';
import { Logger, generateRequestId } from './utils/logger';
import { successResponse, errorResponse, jsonResponse, parseMonitoredRepos, generateId, now } from './utils/helpers';

// Re-export Durable Objects
export { AgentOrchestrator } from './agents/orchestrator';
export { JobScheduler } from './jobs/scheduler';
export { RepoSyncAgent } from './scrapers/repo-sync';
export { SelfHealer } from './resolution/self-healer';
export { CohesionMonitor } from './resolution/cohesion-monitor';

// ============================================================================
// APP INITIALIZATION
// ============================================================================
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', cors());
app.use('*', prettyJSON());
app.use('*', secureHeaders());
app.use('*', honoLogger());

// Request ID middleware
app.use('*', async (c, next) => {
  const requestId = generateRequestId();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  await next();
});

// ============================================================================
// HEALTH & STATUS ROUTES
// ============================================================================
app.get('/', (c) => {
  return c.json({
    name: 'BlackRoad AI Agent Framework',
    version: c.env.BLACKROAD_VERSION || '7.0.0',
    status: 'operational',
    endpoints: {
      health: '/api/health',
      agents: '/api/agents',
      jobs: '/api/jobs',
      repos: '/api/repos',
      cohesion: '/api/cohesion',
      resolution: '/api/resolution',
    },
  });
});

app.get('/api/health', async (c) => {
  const logger = Logger.fromEnv(c.env.LOG_LEVEL);
  const requestId = c.get('requestId') || generateRequestId();

  try {
    // Check orchestrator health
    const orchestratorId = c.env.AGENT_ORCHESTRATOR.idFromName('orchestrator');
    const orchestrator = c.env.AGENT_ORCHESTRATOR.get(orchestratorId);
    const orchestratorResponse = await orchestrator.fetch(
      new Request('http://internal/health')
    );
    const orchestratorHealth = await orchestratorResponse.json() as {
      status: string;
      agents: { healthy: number; unhealthy: number; recovering: number; total: number };
      uptime: number;
    };

    // Check D1
    let d1Available = false;
    let d1RowCount = 0;
    try {
      const result = await c.env.DB.prepare('SELECT COUNT(*) as count FROM sqlite_master').first<{ count: number }>();
      d1Available = true;
      d1RowCount = result?.count || 0;
    } catch {
      d1Available = false;
    }

    // Build health check response
    const health: HealthCheck = {
      status: orchestratorHealth.agents.unhealthy > 0 ? 'degraded' : 'healthy',
      version: c.env.BLACKROAD_VERSION || '7.0.0',
      uptime: orchestratorHealth.uptime,
      agents: [
        {
          id: 'orchestrator',
          type: 'orchestrator',
          status: 'running',
          lastHeartbeat: now(),
          taskCount: 0,
          errorRate: 0,
        },
      ],
      queues: [],
      storage: {
        kv: { available: true },
        d1: { available: d1Available, rowCount: d1RowCount },
        r2: { available: true },
      },
    };

    return jsonResponse(successResponse(health, requestId));
  } catch (error) {
    logger.error('Health check failed', error instanceof Error ? error : new Error(String(error)));
    return jsonResponse(errorResponse('Health check failed', requestId), 500);
  }
});

// ============================================================================
// AGENT ROUTES
// ============================================================================
app.get('/api/agents', async (c) => {
  const orchestratorId = c.env.AGENT_ORCHESTRATOR.idFromName('orchestrator');
  const orchestrator = c.env.AGENT_ORCHESTRATOR.get(orchestratorId);
  const response = await orchestrator.fetch(new Request('http://internal/agents'));
  const data = await response.json();
  return c.json(data);
});

app.get('/api/agents/status', async (c) => {
  const orchestratorId = c.env.AGENT_ORCHESTRATOR.idFromName('orchestrator');
  const orchestrator = c.env.AGENT_ORCHESTRATOR.get(orchestratorId);
  const response = await orchestrator.fetch(new Request('http://internal/status'));
  const data = await response.json();
  return c.json(data);
});

app.post('/api/agents/broadcast', async (c) => {
  const body = await c.req.json();
  const orchestratorId = c.env.AGENT_ORCHESTRATOR.idFromName('orchestrator');
  const orchestrator = c.env.AGENT_ORCHESTRATOR.get(orchestratorId);
  const response = await orchestrator.fetch(new Request('http://internal/broadcast', {
    method: 'POST',
    body: JSON.stringify(body),
  }));
  const data = await response.json();
  return c.json(data);
});

// ============================================================================
// JOB ROUTES
// ============================================================================
app.get('/api/jobs', async (c) => {
  const schedulerId = c.env.JOB_SCHEDULER.idFromName('scheduler');
  const scheduler = c.env.JOB_SCHEDULER.get(schedulerId);
  const response = await scheduler.fetch(new Request('http://internal/jobs'));
  const data = await response.json();
  return c.json(data);
});

app.get('/api/jobs/history', async (c) => {
  const schedulerId = c.env.JOB_SCHEDULER.idFromName('scheduler');
  const scheduler = c.env.JOB_SCHEDULER.get(schedulerId);
  const response = await scheduler.fetch(new Request('http://internal/history'));
  const data = await response.json();
  return c.json(data);
});

app.post('/api/jobs', async (c) => {
  const body = await c.req.json();
  const schedulerId = c.env.JOB_SCHEDULER.idFromName('scheduler');
  const scheduler = c.env.JOB_SCHEDULER.get(schedulerId);
  const response = await scheduler.fetch(new Request('http://internal/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  }));
  const data = await response.json();
  return c.json(data);
});

app.post('/api/jobs/:jobId/trigger', async (c) => {
  const jobId = c.req.param('jobId');
  const schedulerId = c.env.JOB_SCHEDULER.idFromName('scheduler');
  const scheduler = c.env.JOB_SCHEDULER.get(schedulerId);
  const response = await scheduler.fetch(new Request(`http://internal/job/${jobId}/trigger`, {
    method: 'POST',
  }));
  const data = await response.json();
  return c.json(data);
});

// ============================================================================
// REPOSITORY ROUTES
// ============================================================================
app.get('/api/repos', async (c) => {
  const syncId = c.env.REPO_SYNC_AGENT.idFromName('sync');
  const sync = c.env.REPO_SYNC_AGENT.get(syncId);
  const response = await sync.fetch(new Request('http://internal/repositories'));
  const data = await response.json();
  return c.json(data);
});

app.get('/api/repos/monitored', (c) => {
  const repos = parseMonitoredRepos(c.env.MONITORED_REPOS);
  return c.json({ repos });
});

app.get('/api/repos/history', async (c) => {
  const syncId = c.env.REPO_SYNC_AGENT.idFromName('sync');
  const sync = c.env.REPO_SYNC_AGENT.get(syncId);
  const response = await sync.fetch(new Request('http://internal/history'));
  const data = await response.json();
  return c.json(data);
});

app.post('/api/repos/sync', async (c) => {
  const body = await c.req.json() as Partial<SyncJob>;
  const syncId = c.env.REPO_SYNC_AGENT.idFromName('sync');
  const sync = c.env.REPO_SYNC_AGENT.get(syncId);

  const job: SyncJob = {
    id: generateId('sync'),
    repo: body.repo || '',
    syncType: body.syncType || 'incremental',
    triggeredBy: 'manual',
    timestamp: now(),
  };

  const response = await sync.fetch(new Request('http://internal/sync', {
    method: 'POST',
    body: JSON.stringify(job),
  }));
  const data = await response.json();
  return c.json(data);
});

app.post('/api/repos/sync-all', async (c) => {
  const repos = parseMonitoredRepos(c.env.MONITORED_REPOS);
  const body = await c.req.json().catch(() => ({})) as { syncType?: string };
  const results = [];

  for (const repo of repos) {
    const job: SyncJob = {
      id: generateId('sync'),
      repo,
      syncType: (body.syncType as 'full' | 'incremental') || 'incremental',
      triggeredBy: 'manual',
      timestamp: now(),
    };

    await c.env.SYNC_QUEUE.send(job);
    results.push({ repo, queued: true, jobId: job.id });
  }

  return c.json({ success: true, results });
});

// Webhook endpoint for GitHub
app.post('/api/repos/webhook', async (c) => {
  const syncId = c.env.REPO_SYNC_AGENT.idFromName('sync');
  const sync = c.env.REPO_SYNC_AGENT.get(syncId);

  const body = await c.req.text();
  const response = await sync.fetch(new Request('http://internal/webhook', {
    method: 'POST',
    body,
    headers: {
      'X-Hub-Signature-256': c.req.header('X-Hub-Signature-256') || '',
      'X-GitHub-Event': c.req.header('X-GitHub-Event') || '',
    },
  }));

  const data = await response.json();
  return c.json(data);
});

// ============================================================================
// COHESION ROUTES
// ============================================================================
app.get('/api/cohesion', async (c) => {
  const monitorId = c.env.COHESION_MONITOR.idFromName('monitor');
  const monitor = c.env.COHESION_MONITOR.get(monitorId);
  const response = await monitor.fetch(new Request('http://internal/report/latest'));
  const data = await response.json();
  return c.json(data);
});

app.get('/api/cohesion/scores', async (c) => {
  const monitorId = c.env.COHESION_MONITOR.idFromName('monitor');
  const monitor = c.env.COHESION_MONITOR.get(monitorId);
  const response = await monitor.fetch(new Request('http://internal/scores'));
  const data = await response.json();
  return c.json(data);
});

app.get('/api/cohesion/drift', async (c) => {
  const monitorId = c.env.COHESION_MONITOR.idFromName('monitor');
  const monitor = c.env.COHESION_MONITOR.get(monitorId);
  const response = await monitor.fetch(new Request('http://internal/drift'));
  const data = await response.json();
  return c.json(data);
});

app.post('/api/cohesion/analyze', async (c) => {
  const monitorId = c.env.COHESION_MONITOR.idFromName('monitor');
  const monitor = c.env.COHESION_MONITOR.get(monitorId);
  const response = await monitor.fetch(new Request('http://internal/analyze', {
    method: 'POST',
  }));
  const data = await response.json();
  return c.json(data);
});

// ============================================================================
// RESOLUTION ROUTES
// ============================================================================
app.get('/api/resolution/issues', async (c) => {
  const healerId = c.env.SELF_HEALER.idFromName('healer');
  const healer = c.env.SELF_HEALER.get(healerId);
  const response = await healer.fetch(new Request('http://internal/issues'));
  const data = await response.json();
  return c.json(data);
});

app.get('/api/resolution/stats', async (c) => {
  const healerId = c.env.SELF_HEALER.idFromName('healer');
  const healer = c.env.SELF_HEALER.get(healerId);
  const response = await healer.fetch(new Request('http://internal/stats'));
  const data = await response.json();
  return c.json(data);
});

app.get('/api/resolution/escalations', async (c) => {
  const healerId = c.env.SELF_HEALER.idFromName('healer');
  const healer = c.env.SELF_HEALER.get(healerId);
  const response = await healer.fetch(new Request('http://internal/escalations'));
  const data = await response.json();
  return c.json(data);
});

app.post('/api/resolution/scan', async (c) => {
  const healerId = c.env.SELF_HEALER.idFromName('healer');
  const healer = c.env.SELF_HEALER.get(healerId);
  const response = await healer.fetch(new Request('http://internal/scan', {
    method: 'POST',
  }));
  const data = await response.json();
  return c.json(data);
});

app.post('/api/resolution/issue', async (c) => {
  const body = await c.req.json();
  const healerId = c.env.SELF_HEALER.idFromName('healer');
  const healer = c.env.SELF_HEALER.get(healerId);
  const response = await healer.fetch(new Request('http://internal/issue', {
    method: 'POST',
    body: JSON.stringify(body),
  }));
  const data = await response.json();
  return c.json(data);
});

// ============================================================================
// QUEUE CONSUMERS
// ============================================================================
async function handleTaskQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const logger = Logger.fromEnv(env.LOG_LEVEL);

  for (const message of batch.messages) {
    try {
      const task = message.body as { type: string; payload: unknown };
      logger.info('Processing task from queue', { type: task.type });

      // Route to appropriate handler
      const orchestratorId = env.AGENT_ORCHESTRATOR.idFromName('orchestrator');
      const orchestrator = env.AGENT_ORCHESTRATOR.get(orchestratorId);
      await orchestrator.fetch(new Request('http://internal/task', {
        method: 'POST',
        body: JSON.stringify(task),
      }));

      message.ack();
    } catch (error) {
      logger.error('Task processing failed',
        error instanceof Error ? error : new Error(String(error))
      );
      message.retry();
    }
  }
}

async function handleSyncQueue(batch: MessageBatch<SyncJob>, env: Env): Promise<void> {
  const logger = Logger.fromEnv(env.LOG_LEVEL);

  for (const message of batch.messages) {
    try {
      const job = message.body;
      logger.info('Processing sync job from queue', { repo: job.repo, type: job.syncType });

      const syncId = env.REPO_SYNC_AGENT.idFromName('sync');
      const sync = env.REPO_SYNC_AGENT.get(syncId);
      await sync.fetch(new Request('http://internal/sync', {
        method: 'POST',
        body: JSON.stringify(job),
      }));

      message.ack();
    } catch (error) {
      logger.error('Sync job failed',
        error instanceof Error ? error : new Error(String(error))
      );
      message.retry();
    }
  }
}

async function handleResolutionQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const logger = Logger.fromEnv(env.LOG_LEVEL);

  for (const message of batch.messages) {
    try {
      const task = message.body;
      logger.info('Processing resolution task from queue');

      const healerId = env.SELF_HEALER.idFromName('healer');
      const healer = env.SELF_HEALER.get(healerId);
      await healer.fetch(new Request('http://internal/message', {
        method: 'POST',
        body: JSON.stringify({
          id: generateId('msg'),
          from: 'queue',
          to: 'self-healer',
          type: 'event',
          payload: { event: 'resolutionRequest', data: task },
          timestamp: now(),
        }),
      }));

      message.ack();
    } catch (error) {
      logger.error('Resolution task failed',
        error instanceof Error ? error : new Error(String(error))
      );
      message.retry();
    }
  }
}

// ============================================================================
// CRON HANDLERS
// ============================================================================
async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const logger = Logger.fromEnv(env.LOG_LEVEL);
  logger.info('Cron triggered', { cron: event.cron, scheduledTime: event.scheduledTime });

  const schedulerId = env.JOB_SCHEDULER.idFromName('scheduler');
  const scheduler = env.JOB_SCHEDULER.get(schedulerId);

  await scheduler.fetch(new Request('http://internal/cron-trigger', {
    method: 'POST',
    body: JSON.stringify({
      cron: event.cron,
      scheduledTime: event.scheduledTime,
    }),
  }));
}

// ============================================================================
// EXPORTS
// ============================================================================
export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const queueName = batch.queue;

    if (queueName === 'agent-tasks') {
      await handleTaskQueue(batch, env);
    } else if (queueName === 'repo-sync') {
      await handleSyncQueue(batch as MessageBatch<SyncJob>, env);
    } else if (queueName === 'self-resolution') {
      await handleResolutionQueue(batch, env);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(event, env));
  },
};
