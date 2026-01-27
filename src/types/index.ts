/**
 * ⬛⬜🛣️ BlackRoad AI Agent Framework - Type Definitions
 */

// ============================================================================
// ENVIRONMENT BINDINGS
// ============================================================================
export interface Env {
  // Durable Objects
  AGENT_ORCHESTRATOR: DurableObjectNamespace;
  JOB_SCHEDULER: DurableObjectNamespace;
  REPO_SYNC_AGENT: DurableObjectNamespace;
  SELF_HEALER: DurableObjectNamespace;
  COHESION_MONITOR: DurableObjectNamespace;

  // KV Namespaces
  AGENT_STATE: KVNamespace;
  JOB_QUEUE: KVNamespace;
  REPO_CACHE: KVNamespace;
  RESOLUTION_LOG: KVNamespace;

  // D1 Database
  DB: D1Database;

  // Queues
  TASK_QUEUE: Queue<AgentTask>;
  SYNC_QUEUE: Queue<SyncJob>;
  RESOLUTION_QUEUE: Queue<ResolutionTask>;

  // R2 Buckets
  REPO_SNAPSHOTS: R2Bucket;
  AGENT_ARTIFACTS: R2Bucket;

  // Environment Variables
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  BLACKROAD_VERSION: string;
  MONITORED_REPOS: string;
  AUTO_RESOLUTION_ENABLED: string;
  MAX_RESOLUTION_ATTEMPTS: string;
  RESOLUTION_COOLDOWN_MS: string;
  COHESION_THRESHOLD: string;
  DRIFT_ALERT_THRESHOLD: string;

  // Secrets
  GITHUB_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  WEBHOOK_SECRET?: string;
}

// ============================================================================
// AGENT TYPES
// ============================================================================
export type AgentStatus = 'idle' | 'running' | 'error' | 'recovering' | 'stopped';
export type AgentType = 'orchestrator' | 'scheduler' | 'sync' | 'healer' | 'monitor';

export interface Agent {
  id: string;
  type: AgentType;
  name: string;
  status: AgentStatus;
  lastHeartbeat: number;
  createdAt: number;
  metadata: Record<string, unknown>;
  capabilities: string[];
  currentTask?: string;
  errorCount: number;
  successCount: number;
}

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  type: 'command' | 'event' | 'query' | 'response';
  payload: unknown;
  timestamp: number;
  correlationId?: string;
  replyTo?: string;
}

// ============================================================================
// TASK & JOB TYPES
// ============================================================================
export type TaskStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'retrying';
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export interface AgentTask {
  id: string;
  type: string;
  payload: unknown;
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: number;
  scheduledFor?: number;
  startedAt?: number;
  completedAt?: number;
  retryCount: number;
  maxRetries: number;
  assignedAgent?: string;
  result?: unknown;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface Job {
  id: string;
  name: string;
  cron?: string;
  interval?: number;
  handler: string;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
  runCount: number;
  failCount: number;
  config: Record<string, unknown>;
}

export interface SyncJob {
  id: string;
  repo: string;
  branch?: string;
  syncType: 'full' | 'incremental' | 'diff';
  triggeredBy: 'cron' | 'webhook' | 'manual' | 'auto-resolution';
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// REPOSITORY & SCRAPER TYPES
// ============================================================================
export interface Repository {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  lastSynced?: number;
  lastCommitSha?: string;
  structure?: RepoStructure;
  cohesionScore?: number;
}

export interface RepoStructure {
  files: FileNode[];
  directories: DirectoryNode[];
  totalFiles: number;
  totalSize: number;
  languages: Record<string, number>;
  lastUpdated: number;
}

export interface FileNode {
  path: string;
  name: string;
  size: number;
  sha: string;
  type: string;
  lastModified?: number;
}

export interface DirectoryNode {
  path: string;
  name: string;
  children: string[];
}

export interface ScraperResult {
  repo: string;
  timestamp: number;
  success: boolean;
  filesProcessed: number;
  errors: string[];
  changes: RepoChange[];
  snapshot?: string; // R2 key for full snapshot
}

export interface RepoChange {
  type: 'added' | 'modified' | 'deleted' | 'renamed';
  path: string;
  oldPath?: string;
  sha?: string;
  diff?: string;
}

// ============================================================================
// SELF-RESOLUTION TYPES
// ============================================================================
export type ResolutionStatus = 'detected' | 'analyzing' | 'resolving' | 'resolved' | 'failed' | 'escalated';
export type IssueType = 'drift' | 'inconsistency' | 'missing' | 'outdated' | 'conflict' | 'error';
export type IssueSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface ResolutionTask {
  id: string;
  issueId: string;
  type: IssueType;
  severity: IssueSeverity;
  status: ResolutionStatus;
  description: string;
  affectedRepos: string[];
  affectedFiles: string[];
  detectedAt: number;
  resolvedAt?: number;
  attempts: ResolutionAttempt[];
  resolution?: Resolution;
  metadata: Record<string, unknown>;
}

export interface ResolutionAttempt {
  id: string;
  timestamp: number;
  strategy: string;
  success: boolean;
  error?: string;
  changes?: RepoChange[];
  duration: number;
}

export interface Resolution {
  strategy: string;
  description: string;
  changes: RepoChange[];
  verified: boolean;
  autoApplied: boolean;
}

export interface Issue {
  id: string;
  type: IssueType;
  severity: IssueSeverity;
  title: string;
  description: string;
  repos: string[];
  files: string[];
  detectedAt: number;
  status: ResolutionStatus;
  resolutionTaskId?: string;
}

// ============================================================================
// COHESION TYPES
// ============================================================================
export interface CohesionReport {
  id: string;
  timestamp: number;
  overallScore: number;
  repos: RepoCohesion[];
  issues: CohesionIssue[];
  recommendations: string[];
}

export interface RepoCohesion {
  repo: string;
  score: number;
  factors: CohesionFactor[];
  driftScore: number;
  lastUpdated: number;
}

export interface CohesionFactor {
  name: string;
  weight: number;
  score: number;
  details: string;
}

export interface CohesionIssue {
  id: string;
  type: 'style' | 'structure' | 'dependency' | 'naming' | 'version' | 'config';
  severity: IssueSeverity;
  repos: string[];
  description: string;
  suggestion: string;
}

// ============================================================================
// API TYPES
// ============================================================================
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
  requestId: string;
}

export interface HealthCheck {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  agents: AgentHealth[];
  queues: QueueHealth[];
  storage: StorageHealth;
}

export interface AgentHealth {
  id: string;
  type: AgentType;
  status: AgentStatus;
  lastHeartbeat: number;
  taskCount: number;
  errorRate: number;
}

export interface QueueHealth {
  name: string;
  pending: number;
  processing: number;
  failed: number;
  dlq: number;
}

export interface StorageHealth {
  kv: { available: boolean };
  d1: { available: boolean; rowCount?: number };
  r2: { available: boolean; objectCount?: number };
}

// ============================================================================
// EVENT TYPES
// ============================================================================
export type EventType =
  | 'agent.started'
  | 'agent.stopped'
  | 'agent.error'
  | 'agent.recovered'
  | 'task.created'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'job.scheduled'
  | 'job.started'
  | 'job.completed'
  | 'job.failed'
  | 'sync.started'
  | 'sync.completed'
  | 'sync.failed'
  | 'issue.detected'
  | 'issue.resolved'
  | 'issue.escalated'
  | 'cohesion.report'
  | 'cohesion.drift';

export interface SystemEvent {
  id: string;
  type: EventType;
  source: string;
  timestamp: number;
  payload: unknown;
  correlationId?: string;
}

// ============================================================================
// CRON HANDLER TYPES
// ============================================================================
export interface CronContext {
  scheduledTime: number;
  cron: string;
  env: Env;
}

export type CronHandler = (ctx: CronContext) => Promise<void>;

export interface CronJob {
  pattern: string;
  name: string;
  handler: CronHandler;
  description: string;
}
