/**
 * ⬛⬜🛣️ BlackRoad Job Scheduler - Durable Object
 *
 * Manages scheduled jobs, cron triggers, and recurring tasks.
 * Handles job persistence, execution tracking, and failure recovery.
 */

import type { Env, Job, AgentMessage, AgentTask, SyncJob } from '../types';
import { BaseAgent } from '../agents/base';
import { generateId, now, parseMonitoredRepos } from '../utils/helpers';

interface SchedulerState {
  jobs: Map<string, Job>;
  executionHistory: JobExecution[];
  nextExecutions: Map<string, number>;
}

interface JobExecution {
  jobId: string;
  jobName: string;
  startedAt: number;
  completedAt?: number;
  success: boolean;
  error?: string;
  duration?: number;
}

// Cron pattern parser (simplified)
function parseCron(pattern: string): { next: (from: Date) => Date } {
  const parts = pattern.split(' ');

  return {
    next: (from: Date): Date => {
      const next = new Date(from);

      // Simple implementation for common patterns
      if (pattern.startsWith('*/')) {
        // Interval pattern like */5 * * * *
        const interval = parseInt(parts[0]?.slice(2) || '5', 10);
        const unit = parts.filter(p => p !== '*').length;

        if (unit === 0 || parts[1] === '*') {
          // Minutes interval
          next.setMinutes(Math.ceil(next.getMinutes() / interval) * interval);
          next.setSeconds(0);
          next.setMilliseconds(0);
          if (next <= from) {
            next.setMinutes(next.getMinutes() + interval);
          }
        }
      } else if (parts[0] === '0' && parts[1]?.startsWith('*/')) {
        // Hourly interval like 0 */6 * * *
        const interval = parseInt(parts[1].slice(2), 10);
        next.setHours(Math.ceil(next.getHours() / interval) * interval);
        next.setMinutes(0);
        next.setSeconds(0);
        next.setMilliseconds(0);
        if (next <= from) {
          next.setHours(next.getHours() + interval);
        }
      } else if (parts[0] === '0' && parts[1] === '0') {
        // Daily at midnight
        next.setDate(next.getDate() + 1);
        next.setHours(0);
        next.setMinutes(0);
        next.setSeconds(0);
        next.setMilliseconds(0);
      } else {
        // Default: next minute
        next.setMinutes(next.getMinutes() + 1);
        next.setSeconds(0);
        next.setMilliseconds(0);
      }

      return next;
    }
  };
}

export class JobScheduler extends BaseAgent {
  private schedulerState: SchedulerState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env, 'scheduler', 'job-scheduler');

    this.schedulerState = {
      jobs: new Map(),
      executionHistory: [],
      nextExecutions: new Map(),
    };
  }

  protected async onInitialize(): Promise<void> {
    // Load scheduler state
    const stored = await this.storage.get<{
      jobs: Record<string, Job>;
      executionHistory: JobExecution[];
      nextExecutions: Record<string, number>;
    }>('schedulerState');

    if (stored) {
      this.schedulerState = {
        jobs: new Map(Object.entries(stored.jobs || {})),
        executionHistory: stored.executionHistory || [],
        nextExecutions: new Map(Object.entries(stored.nextExecutions || {})),
      };
    }

    // Register default jobs
    await this.registerDefaultJobs();
  }

  private async registerDefaultJobs(): Promise<void> {
    const defaultJobs: Job[] = [
      {
        id: 'health-check',
        name: 'Agent Health Check',
        cron: '*/5 * * * *',
        handler: 'healthCheck',
        enabled: true,
        runCount: 0,
        failCount: 0,
        config: {},
      },
      {
        id: 'repo-sync-incremental',
        name: 'Incremental Repository Sync',
        cron: '*/15 * * * *',
        handler: 'repoSyncIncremental',
        enabled: true,
        runCount: 0,
        failCount: 0,
        config: { syncType: 'incremental' },
      },
      {
        id: 'cohesion-analysis',
        name: 'Cohesion Analysis',
        cron: '0 * * * *',
        handler: 'cohesionAnalysis',
        enabled: true,
        runCount: 0,
        failCount: 0,
        config: {},
      },
      {
        id: 'self-resolution-scan',
        name: 'Self-Resolution Deep Scan',
        cron: '0 */6 * * *',
        handler: 'selfResolutionScan',
        enabled: true,
        runCount: 0,
        failCount: 0,
        config: { deep: true },
      },
      {
        id: 'repo-sync-full',
        name: 'Full Repository Scrape',
        cron: '0 0 * * *',
        handler: 'repoSyncFull',
        enabled: true,
        runCount: 0,
        failCount: 0,
        config: { syncType: 'full' },
      },
    ];

    for (const job of defaultJobs) {
      if (!this.schedulerState.jobs.has(job.id)) {
        this.schedulerState.jobs.set(job.id, job);
        if (job.cron) {
          const cron = parseCron(job.cron);
          job.nextRun = cron.next(new Date()).getTime();
          this.schedulerState.nextExecutions.set(job.id, job.nextRun);
        }
      }
    }

    await this.persistSchedulerState();
    this.logger.info('Default jobs registered', {
      jobCount: this.schedulerState.jobs.size
    });
  }

  private async persistSchedulerState(): Promise<void> {
    const serializable = {
      jobs: Object.fromEntries(this.schedulerState.jobs),
      executionHistory: this.schedulerState.executionHistory.slice(-100), // Keep last 100
      nextExecutions: Object.fromEntries(this.schedulerState.nextExecutions),
    };
    await this.storage.put('schedulerState', serializable);
  }

  protected async handleMessage(message: AgentMessage): Promise<void> {
    this.logger.debug('Processing message', { type: message.type });

    switch (message.type) {
      case 'command':
        await this.handleCommand(message);
        break;
      case 'event':
        await this.handleEvent(message);
        break;
      default:
        this.logger.warn('Unknown message type', { type: message.type });
    }
  }

  private async handleCommand(message: AgentMessage): Promise<void> {
    const payload = message.payload as { action: string; jobId?: string; job?: Job };

    switch (payload.action) {
      case 'scheduleJob':
        if (payload.job) {
          await this.scheduleJob(payload.job);
        }
        break;
      case 'cancelJob':
        if (payload.jobId) {
          await this.cancelJob(payload.jobId);
        }
        break;
      case 'triggerJob':
        if (payload.jobId) {
          await this.triggerJob(payload.jobId);
        }
        break;
    }
  }

  private async handleEvent(message: AgentMessage): Promise<void> {
    const payload = message.payload as { event: string; data?: unknown };

    if (payload.event === 'cronTrigger') {
      await this.processCronTrigger(payload.data as { cron: string; scheduledTime: number });
    }
  }

  protected async processWork(): Promise<void> {
    // Check for jobs that need to be executed
    const currentTime = now();

    for (const [jobId, nextRun] of this.schedulerState.nextExecutions) {
      if (nextRun <= currentTime) {
        const job = this.schedulerState.jobs.get(jobId);
        if (job && job.enabled) {
          await this.executeJob(job);
        }
      }
    }
  }

  async processCronTrigger(trigger: { cron: string; scheduledTime: number }): Promise<void> {
    this.logger.info('Processing cron trigger', { cron: trigger.cron });

    // Find jobs matching this cron pattern
    for (const job of this.schedulerState.jobs.values()) {
      if (job.enabled && job.cron === trigger.cron) {
        await this.executeJob(job);
      }
    }
  }

  private async executeJob(job: Job): Promise<void> {
    this.logger.info('Executing job', { jobId: job.id, jobName: job.name });

    const execution: JobExecution = {
      jobId: job.id,
      jobName: job.name,
      startedAt: now(),
      success: false,
    };

    try {
      await this.runJobHandler(job);
      execution.success = true;
      job.runCount++;
      job.lastRun = now();
    } catch (error) {
      execution.success = false;
      execution.error = error instanceof Error ? error.message : String(error);
      job.failCount++;
      this.logger.error('Job execution failed',
        error instanceof Error ? error : new Error(String(error)),
        { jobId: job.id }
      );
    } finally {
      execution.completedAt = now();
      execution.duration = execution.completedAt - execution.startedAt;

      // Update next run time
      if (job.cron) {
        const cron = parseCron(job.cron);
        job.nextRun = cron.next(new Date()).getTime();
        this.schedulerState.nextExecutions.set(job.id, job.nextRun);
      }

      this.schedulerState.executionHistory.push(execution);
      this.schedulerState.jobs.set(job.id, job);
      await this.persistSchedulerState();
    }
  }

  private async runJobHandler(job: Job): Promise<void> {
    switch (job.handler) {
      case 'healthCheck':
        await this.runHealthCheck();
        break;
      case 'repoSyncIncremental':
        await this.triggerRepoSync('incremental');
        break;
      case 'repoSyncFull':
        await this.triggerRepoSync('full');
        break;
      case 'cohesionAnalysis':
        await this.triggerCohesionAnalysis();
        break;
      case 'selfResolutionScan':
        await this.triggerSelfResolutionScan();
        break;
      default:
        this.logger.warn('Unknown job handler', { handler: job.handler });
    }
  }

  private async runHealthCheck(): Promise<void> {
    // Trigger health check on orchestrator
    const orchestratorId = this.env.AGENT_ORCHESTRATOR.idFromName('orchestrator');
    const orchestrator = this.env.AGENT_ORCHESTRATOR.get(orchestratorId);
    await orchestrator.fetch(new Request('http://internal/health'));
  }

  private async triggerRepoSync(syncType: 'full' | 'incremental'): Promise<void> {
    const repos = parseMonitoredRepos(this.env.MONITORED_REPOS);

    for (const repo of repos) {
      const syncJob: SyncJob = {
        id: generateId('sync'),
        repo,
        syncType,
        triggeredBy: 'cron',
        timestamp: now(),
      };

      await this.env.SYNC_QUEUE.send(syncJob);
      this.logger.info('Queued repo sync', { repo, syncType });
    }
  }

  private async triggerCohesionAnalysis(): Promise<void> {
    const monitorId = this.env.COHESION_MONITOR.idFromName('monitor');
    const monitor = this.env.COHESION_MONITOR.get(monitorId);
    await monitor.fetch(new Request('http://internal/trigger', { method: 'POST' }));
  }

  private async triggerSelfResolutionScan(): Promise<void> {
    const healerId = this.env.SELF_HEALER.idFromName('healer');
    const healer = this.env.SELF_HEALER.get(healerId);
    await healer.fetch(new Request('http://internal/trigger', {
      method: 'POST',
      body: JSON.stringify({ deep: true }),
    }));
  }

  async scheduleJob(job: Job): Promise<void> {
    job.id = job.id || generateId('job');
    job.runCount = job.runCount || 0;
    job.failCount = job.failCount || 0;

    if (job.cron) {
      const cron = parseCron(job.cron);
      job.nextRun = cron.next(new Date()).getTime();
      this.schedulerState.nextExecutions.set(job.id, job.nextRun);
    }

    this.schedulerState.jobs.set(job.id, job);
    await this.persistSchedulerState();

    this.logger.info('Job scheduled', { jobId: job.id, jobName: job.name });
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = this.schedulerState.jobs.get(jobId);
    if (job) {
      job.enabled = false;
      this.schedulerState.jobs.set(jobId, job);
      this.schedulerState.nextExecutions.delete(jobId);
      await this.persistSchedulerState();
      this.logger.info('Job cancelled', { jobId });
    }
  }

  async triggerJob(jobId: string): Promise<void> {
    const job = this.schedulerState.jobs.get(jobId);
    if (job) {
      await this.executeJob(job);
    }
  }

  protected async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET') {
      if (path === '/jobs') {
        return this.listJobs();
      }
      if (path === '/history') {
        return this.getHistory();
      }
      if (path.startsWith('/job/')) {
        const jobId = path.replace('/job/', '');
        return this.getJob(jobId);
      }
    }

    if (request.method === 'POST') {
      if (path === '/jobs') {
        return this.createJob(request);
      }
      if (path === '/cron-trigger') {
        return this.handleCronTrigger(request);
      }
      if (path.startsWith('/job/') && path.endsWith('/trigger')) {
        const jobId = path.replace('/job/', '').replace('/trigger', '');
        await this.triggerJob(jobId);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (request.method === 'DELETE') {
      if (path.startsWith('/job/')) {
        const jobId = path.replace('/job/', '');
        await this.cancelJob(jobId);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }

  private listJobs(): Response {
    const jobs = Array.from(this.schedulerState.jobs.values());
    return new Response(JSON.stringify({ jobs }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private getJob(jobId: string): Response {
    const job = this.schedulerState.jobs.get(jobId);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ job }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private getHistory(): Response {
    return new Response(JSON.stringify({
      history: this.schedulerState.executionHistory.slice(-50)
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async createJob(request: Request): Promise<Response> {
    const job = await request.json() as Job;
    await this.scheduleJob(job);
    return new Response(JSON.stringify({ success: true, jobId: job.id }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleCronTrigger(request: Request): Promise<Response> {
    const trigger = await request.json() as { cron: string; scheduledTime: number };
    await this.processCronTrigger(trigger);
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
