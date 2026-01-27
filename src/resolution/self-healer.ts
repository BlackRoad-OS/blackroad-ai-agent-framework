/**
 * ⬛⬜🛣️ BlackRoad Self-Healer Agent - Durable Object
 *
 * Autonomous self-resolution system that detects issues,
 * diagnoses problems, and applies fixes automatically.
 * When automated resolution fails, it escalates appropriately.
 */

import type {
  Env,
  AgentMessage,
  ResolutionTask,
  ResolutionAttempt,
  Resolution,
  Issue,
  IssueType,
  IssueSeverity,
  ResolutionStatus,
  RepoChange
} from '../types';
import { BaseAgent } from '../agents/base';
import { generateId, now, sleep, withRetry } from '../utils/helpers';

interface HealerState {
  issues: Map<string, Issue>;
  resolutions: Map<string, ResolutionTask>;
  strategies: ResolutionStrategy[];
  cooldowns: Map<string, number>; // Issue ID -> cooldown until timestamp
  escalations: EscalationRecord[];
  stats: HealerStats;
}

interface ResolutionStrategy {
  id: string;
  name: string;
  issueTypes: IssueType[];
  priority: number;
  handler: string;
  maxAttempts: number;
  cooldownMs: number;
}

interface EscalationRecord {
  id: string;
  issueId: string;
  timestamp: number;
  reason: string;
  notified: boolean;
}

interface HealerStats {
  issuesDetected: number;
  issuesResolved: number;
  issuesFailed: number;
  issuesEscalated: number;
  averageResolutionTime: number;
  successRate: number;
}

interface AIResolutionRequest {
  issue: Issue;
  context: {
    affectedFiles: string[];
    recentChanges: RepoChange[];
    relatedIssues: Issue[];
    previousAttempts: ResolutionAttempt[];
  };
}

interface AIResolutionResponse {
  diagnosis: string;
  suggestedFix: string;
  confidence: number;
  steps: string[];
  autoApply: boolean;
}

export class SelfHealer extends BaseAgent {
  private healerState: HealerState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env, 'healer', 'self-healer');

    this.healerState = {
      issues: new Map(),
      resolutions: new Map(),
      strategies: [],
      cooldowns: new Map(),
      escalations: [],
      stats: {
        issuesDetected: 0,
        issuesResolved: 0,
        issuesFailed: 0,
        issuesEscalated: 0,
        averageResolutionTime: 0,
        successRate: 0,
      },
    };
  }

  protected async onInitialize(): Promise<void> {
    const stored = await this.storage.get<{
      issues: Record<string, Issue>;
      resolutions: Record<string, ResolutionTask>;
      cooldowns: Record<string, number>;
      escalations: EscalationRecord[];
      stats: HealerStats;
    }>('healerState');

    if (stored) {
      this.healerState = {
        issues: new Map(Object.entries(stored.issues || {})),
        resolutions: new Map(Object.entries(stored.resolutions || {})),
        strategies: this.getDefaultStrategies(),
        cooldowns: new Map(Object.entries(stored.cooldowns || {})),
        escalations: stored.escalations || [],
        stats: stored.stats || this.healerState.stats,
      };
    } else {
      this.healerState.strategies = this.getDefaultStrategies();
    }
  }

  private getDefaultStrategies(): ResolutionStrategy[] {
    return [
      {
        id: 'restart-agent',
        name: 'Agent Restart',
        issueTypes: ['error'],
        priority: 1,
        handler: 'restartAgent',
        maxAttempts: 3,
        cooldownMs: 30000,
      },
      {
        id: 'resync-repo',
        name: 'Repository Resync',
        issueTypes: ['drift', 'outdated', 'missing'],
        priority: 2,
        handler: 'resyncRepository',
        maxAttempts: 2,
        cooldownMs: 60000,
      },
      {
        id: 'resolve-conflict',
        name: 'Conflict Resolution',
        issueTypes: ['conflict', 'inconsistency'],
        priority: 3,
        handler: 'resolveConflict',
        maxAttempts: 2,
        cooldownMs: 120000,
      },
      {
        id: 'ai-resolution',
        name: 'AI-Powered Resolution',
        issueTypes: ['drift', 'inconsistency', 'missing', 'outdated', 'conflict', 'error'],
        priority: 10, // Last resort
        handler: 'aiResolution',
        maxAttempts: 1,
        cooldownMs: 300000,
      },
    ];
  }

  private async persistHealerState(): Promise<void> {
    const serializable = {
      issues: Object.fromEntries(this.healerState.issues),
      resolutions: Object.fromEntries(this.healerState.resolutions),
      cooldowns: Object.fromEntries(this.healerState.cooldowns),
      escalations: this.healerState.escalations.slice(-100),
      stats: this.healerState.stats,
    };
    await this.storage.put('healerState', serializable);
  }

  protected async handleMessage(message: AgentMessage): Promise<void> {
    if (message.type === 'event') {
      const payload = message.payload as { event: string; data?: unknown };

      switch (payload.event) {
        case 'issueDetected':
          await this.handleIssueDetected(payload.data as Issue);
          break;
        case 'resolutionRequest':
          await this.processResolutionTask(payload.data as ResolutionTask);
          break;
      }
    }
  }

  protected async processWork(): Promise<void> {
    // Scan for issues that need resolution
    await this.scanForIssues();

    // Process pending resolutions
    for (const [id, task] of this.healerState.resolutions) {
      if (task.status === 'detected' || task.status === 'analyzing') {
        await this.processResolutionTask(task);
      }
    }
  }

  private async scanForIssues(): Promise<void> {
    this.logger.debug('Scanning for issues');

    // Check agent health
    await this.checkAgentHealth();

    // Check repository cohesion
    await this.checkRepositoryCohesion();

    // Check for stale data
    await this.checkForStaleData();
  }

  private async checkAgentHealth(): Promise<void> {
    try {
      const orchestratorId = this.env.AGENT_ORCHESTRATOR.idFromName('orchestrator');
      const orchestrator = this.env.AGENT_ORCHESTRATOR.get(orchestratorId);
      const response = await orchestrator.fetch(new Request('http://internal/health'));
      const health = await response.json() as {
        status: string;
        agents: { healthy: number; unhealthy: number; recovering: number };
      };

      if (health.agents.unhealthy > 0) {
        await this.createIssue({
          type: 'error',
          severity: 'error',
          title: 'Unhealthy Agents Detected',
          description: `${health.agents.unhealthy} agent(s) are in error state`,
          repos: [],
          files: [],
        });
      }
    } catch (error) {
      this.logger.error('Failed to check agent health',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private async checkRepositoryCohesion(): Promise<void> {
    try {
      const threshold = parseFloat(this.env.COHESION_THRESHOLD || '0.85');

      // Check cached cohesion scores
      const repoKeys = await this.env.REPO_CACHE.list({ prefix: 'repo:' });

      for (const key of repoKeys.keys) {
        if (key.name.endsWith(':structure')) {
          const repoName = key.name.replace('repo:', '').replace(':structure', '');
          const cached = await this.env.REPO_CACHE.get(`repo:${repoName}:cohesion`);

          if (cached) {
            const score = parseFloat(cached);
            if (score < threshold * 100) {
              await this.createIssue({
                type: 'drift',
                severity: score < threshold * 50 ? 'error' : 'warning',
                title: `Low Cohesion Score: ${repoName}`,
                description: `Repository cohesion score (${score}) is below threshold (${threshold * 100})`,
                repos: [repoName],
                files: [],
              });
            }
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to check repository cohesion',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private async checkForStaleData(): Promise<void> {
    const staleThreshold = 86400000; // 24 hours

    try {
      const syncAgent = this.env.REPO_SYNC_AGENT.idFromName('sync');
      const sync = this.env.REPO_SYNC_AGENT.get(syncAgent);
      const response = await sync.fetch(new Request('http://internal/repositories'));
      const { repositories } = await response.json() as {
        repositories: Array<{ fullName: string; lastSynced?: number }>;
      };

      for (const repo of repositories) {
        if (repo.lastSynced && (now() - repo.lastSynced) > staleThreshold) {
          await this.createIssue({
            type: 'outdated',
            severity: 'warning',
            title: `Stale Repository: ${repo.fullName}`,
            description: `Repository has not been synced in over 24 hours`,
            repos: [repo.fullName],
            files: [],
          });
        }
      }
    } catch (error) {
      this.logger.error('Failed to check for stale data',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private async createIssue(issueData: Omit<Issue, 'id' | 'detectedAt' | 'status'>): Promise<Issue> {
    // Check for duplicate
    for (const existing of this.healerState.issues.values()) {
      if (
        existing.type === issueData.type &&
        existing.title === issueData.title &&
        existing.status !== 'resolved'
      ) {
        return existing;
      }
    }

    const issue: Issue = {
      ...issueData,
      id: generateId('issue'),
      detectedAt: now(),
      status: 'detected',
    };

    this.healerState.issues.set(issue.id, issue);
    this.healerState.stats.issuesDetected++;

    // Create resolution task
    const task: ResolutionTask = {
      id: generateId('resolution'),
      issueId: issue.id,
      type: issue.type,
      severity: issue.severity,
      status: 'detected',
      description: issue.description,
      affectedRepos: issue.repos,
      affectedFiles: issue.files,
      detectedAt: now(),
      attempts: [],
      metadata: {},
    };

    this.healerState.resolutions.set(task.id, task);
    issue.resolutionTaskId = task.id;

    // Log to resolution log
    await this.env.RESOLUTION_LOG.put(
      `issue:${issue.id}`,
      JSON.stringify(issue),
      { expirationTtl: 604800 } // 7 days
    );

    await this.persistHealerState();

    this.logger.info('Issue created', {
      issueId: issue.id,
      type: issue.type,
      severity: issue.severity,
      title: issue.title
    });

    // Auto-start resolution if enabled
    if (this.env.AUTO_RESOLUTION_ENABLED === 'true') {
      await this.processResolutionTask(task);
    }

    return issue;
  }

  private async handleIssueDetected(issue: Issue): Promise<void> {
    await this.createIssue(issue);
  }

  private async processResolutionTask(task: ResolutionTask): Promise<void> {
    // Check cooldown
    const cooldownUntil = this.healerState.cooldowns.get(task.issueId);
    if (cooldownUntil && now() < cooldownUntil) {
      this.logger.debug('Issue in cooldown', {
        issueId: task.issueId,
        remainingMs: cooldownUntil - now()
      });
      return;
    }

    // Check max attempts
    const maxAttempts = parseInt(this.env.MAX_RESOLUTION_ATTEMPTS || '5', 10);
    if (task.attempts.length >= maxAttempts) {
      await this.escalateIssue(task, 'Maximum resolution attempts exceeded');
      return;
    }

    task.status = 'analyzing';
    await this.persistHealerState();

    // Find applicable strategies
    const strategies = this.healerState.strategies
      .filter(s => s.issueTypes.includes(task.type))
      .sort((a, b) => a.priority - b.priority);

    for (const strategy of strategies) {
      // Skip if we've already tried this strategy enough times
      const strategyAttempts = task.attempts.filter(a => a.strategy === strategy.id);
      if (strategyAttempts.length >= strategy.maxAttempts) {
        continue;
      }

      this.logger.info('Attempting resolution strategy', {
        taskId: task.id,
        strategy: strategy.name
      });

      const attempt = await this.executeStrategy(task, strategy);
      task.attempts.push(attempt);

      if (attempt.success) {
        task.status = 'resolved';
        task.resolvedAt = now();
        task.resolution = {
          strategy: strategy.name,
          description: `Resolved using ${strategy.name}`,
          changes: attempt.changes || [],
          verified: true,
          autoApplied: true,
        };

        // Update issue status
        const issue = this.healerState.issues.get(task.issueId);
        if (issue) {
          issue.status = 'resolved';
        }

        this.healerState.stats.issuesResolved++;
        this.updateSuccessRate();

        this.logger.info('Issue resolved', {
          taskId: task.id,
          issueId: task.issueId,
          strategy: strategy.name,
          attempts: task.attempts.length
        });

        await this.persistHealerState();
        return;
      }

      // Set cooldown
      this.healerState.cooldowns.set(
        task.issueId,
        now() + strategy.cooldownMs
      );
    }

    // All strategies failed
    task.status = 'failed';
    this.healerState.stats.issuesFailed++;
    await this.escalateIssue(task, 'All resolution strategies failed');
    await this.persistHealerState();
  }

  private async executeStrategy(
    task: ResolutionTask,
    strategy: ResolutionStrategy
  ): Promise<ResolutionAttempt> {
    const attempt: ResolutionAttempt = {
      id: generateId('attempt'),
      timestamp: now(),
      strategy: strategy.id,
      success: false,
      duration: 0,
    };

    const startTime = now();

    try {
      switch (strategy.handler) {
        case 'restartAgent':
          await this.strategyRestartAgent(task);
          break;
        case 'resyncRepository':
          attempt.changes = await this.strategyResyncRepository(task);
          break;
        case 'resolveConflict':
          attempt.changes = await this.strategyResolveConflict(task);
          break;
        case 'aiResolution':
          attempt.changes = await this.strategyAIResolution(task);
          break;
        default:
          throw new Error(`Unknown strategy handler: ${strategy.handler}`);
      }

      attempt.success = true;
    } catch (error) {
      attempt.success = false;
      attempt.error = error instanceof Error ? error.message : String(error);
      this.logger.error('Resolution strategy failed',
        error instanceof Error ? error : new Error(String(error)),
        { taskId: task.id, strategy: strategy.id }
      );
    }

    attempt.duration = now() - startTime;
    return attempt;
  }

  private async strategyRestartAgent(task: ResolutionTask): Promise<void> {
    // Get the affected agent from metadata
    const agentId = task.metadata.agentId as string | undefined;
    const agentType = task.metadata.agentType as string | undefined;

    if (!agentType) {
      throw new Error('No agent type specified in task metadata');
    }

    // Send restart signal to orchestrator
    const orchestratorId = this.env.AGENT_ORCHESTRATOR.idFromName('orchestrator');
    const orchestrator = this.env.AGENT_ORCHESTRATOR.get(orchestratorId);

    await orchestrator.fetch(new Request('http://internal/message', {
      method: 'POST',
      body: JSON.stringify({
        id: generateId('msg'),
        from: this.agentState.agentId,
        to: agentId || 'orchestrator',
        type: 'command',
        payload: { action: 'restart' },
        timestamp: now(),
      }),
    }));

    // Wait for agent to recover
    await sleep(5000);

    // Verify recovery
    const healthResponse = await orchestrator.fetch(new Request('http://internal/health'));
    const health = await healthResponse.json() as {
      agents: { unhealthy: number };
    };

    if (health.agents.unhealthy > 0) {
      throw new Error('Agent restart did not resolve the issue');
    }
  }

  private async strategyResyncRepository(task: ResolutionTask): Promise<RepoChange[]> {
    const changes: RepoChange[] = [];

    for (const repo of task.affectedRepos) {
      const syncAgent = this.env.REPO_SYNC_AGENT.idFromName('sync');
      const sync = this.env.REPO_SYNC_AGENT.get(syncAgent);

      const response = await sync.fetch(new Request('http://internal/sync', {
        method: 'POST',
        body: JSON.stringify({
          repo,
          syncType: 'full',
          triggeredBy: 'auto-resolution',
        }),
      }));

      const result = await response.json() as { changes: RepoChange[] };
      changes.push(...result.changes);
    }

    return changes;
  }

  private async strategyResolveConflict(task: ResolutionTask): Promise<RepoChange[]> {
    // For now, this triggers a full resync
    // In the future, this could use more sophisticated merge strategies
    return this.strategyResyncRepository(task);
  }

  private async strategyAIResolution(task: ResolutionTask): Promise<RepoChange[]> {
    if (!this.env.ANTHROPIC_API_KEY) {
      throw new Error('AI resolution requires ANTHROPIC_API_KEY');
    }

    const issue = this.healerState.issues.get(task.issueId);
    if (!issue) {
      throw new Error('Issue not found');
    }

    // Prepare context for AI
    const request: AIResolutionRequest = {
      issue,
      context: {
        affectedFiles: task.affectedFiles,
        recentChanges: [], // Would fetch from sync agent
        relatedIssues: Array.from(this.healerState.issues.values())
          .filter(i => i.type === issue.type && i.id !== issue.id)
          .slice(0, 5),
        previousAttempts: task.attempts,
      },
    };

    // Call Claude API for intelligent resolution
    const aiResponse = await this.callClaudeAPI(request);

    if (!aiResponse.autoApply || aiResponse.confidence < 0.8) {
      throw new Error(`AI resolution confidence too low: ${aiResponse.confidence}`);
    }

    this.logger.info('AI resolution suggested', {
      diagnosis: aiResponse.diagnosis,
      confidence: aiResponse.confidence,
      steps: aiResponse.steps.length
    });

    // For now, we just log the suggestion and trigger a resync
    // In a full implementation, this would apply the suggested changes
    return this.strategyResyncRepository(task);
  }

  private async callClaudeAPI(request: AIResolutionRequest): Promise<AIResolutionResponse> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `You are an expert DevOps engineer analyzing a system issue. Provide a diagnosis and resolution steps.

Issue: ${request.issue.title}
Type: ${request.issue.type}
Severity: ${request.issue.severity}
Description: ${request.issue.description}
Affected Repos: ${request.issue.repos.join(', ')}
Affected Files: ${request.context.affectedFiles.join(', ')}
Previous Attempts: ${request.context.previousAttempts.map(a => `${a.strategy}: ${a.success ? 'success' : 'failed'}`).join(', ')}

Respond in JSON format:
{
  "diagnosis": "brief diagnosis",
  "suggestedFix": "suggested fix description",
  "confidence": 0.0-1.0,
  "steps": ["step 1", "step 2"],
  "autoApply": true/false
}`,
        }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
    };

    const text = data.content.find(c => c.type === 'text')?.text || '{}';
    return JSON.parse(text) as AIResolutionResponse;
  }

  private async escalateIssue(task: ResolutionTask, reason: string): Promise<void> {
    task.status = 'escalated';

    const escalation: EscalationRecord = {
      id: generateId('escalation'),
      issueId: task.issueId,
      timestamp: now(),
      reason,
      notified: false,
    };

    this.healerState.escalations.push(escalation);
    this.healerState.stats.issuesEscalated++;

    // Update issue status
    const issue = this.healerState.issues.get(task.issueId);
    if (issue) {
      issue.status = 'escalated';
    }

    // Log escalation
    await this.env.RESOLUTION_LOG.put(
      `escalation:${escalation.id}`,
      JSON.stringify({ escalation, task, issue }),
      { expirationTtl: 2592000 } // 30 days
    );

    this.logger.warn('Issue escalated', {
      issueId: task.issueId,
      reason,
      attempts: task.attempts.length
    });

    // TODO: Send notification (webhook, email, etc.)
  }

  private updateSuccessRate(): void {
    const total = this.healerState.stats.issuesResolved + this.healerState.stats.issuesFailed;
    if (total > 0) {
      this.healerState.stats.successRate =
        this.healerState.stats.issuesResolved / total;
    }
  }

  protected async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET') {
      if (path === '/issues') {
        return this.listIssues();
      }
      if (path === '/resolutions') {
        return this.listResolutions();
      }
      if (path === '/stats') {
        return this.getStats();
      }
      if (path === '/escalations') {
        return this.listEscalations();
      }
    }

    if (request.method === 'POST') {
      if (path === '/scan') {
        await this.scanForIssues();
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (path === '/issue') {
        const issueData = await request.json() as Omit<Issue, 'id' | 'detectedAt' | 'status'>;
        const issue = await this.createIssue(issueData);
        return new Response(JSON.stringify({ issue }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }

  private listIssues(): Response {
    const issues = Array.from(this.healerState.issues.values());
    return new Response(JSON.stringify({ issues }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private listResolutions(): Response {
    const resolutions = Array.from(this.healerState.resolutions.values());
    return new Response(JSON.stringify({ resolutions }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private getStats(): Response {
    return new Response(JSON.stringify({ stats: this.healerState.stats }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private listEscalations(): Response {
    return new Response(JSON.stringify({
      escalations: this.healerState.escalations.slice(-20)
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
