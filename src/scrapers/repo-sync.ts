/**
 * ⬛⬜🛣️ BlackRoad Repository Sync Agent - Durable Object
 *
 * Scrapes and syncs repositories, maintaining cohesion across the ecosystem.
 * Supports full scrapes, incremental diffs, and webhook-triggered updates.
 */

import type {
  Env,
  AgentMessage,
  SyncJob,
  Repository,
  RepoStructure,
  FileNode,
  ScraperResult,
  RepoChange
} from '../types';
import { BaseAgent } from '../agents/base';
import { generateId, now, parseRepoFullName, withRetry } from '../utils/helpers';

interface GitHubFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir';
  url: string;
  download_url?: string;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: { date: string };
  };
}

interface GitHubRepo {
  full_name: string;
  default_branch: string;
  updated_at: string;
  pushed_at: string;
}

interface SyncState {
  repositories: Map<string, Repository>;
  lastFullSync: number;
  syncHistory: SyncHistoryEntry[];
  pendingChanges: Map<string, RepoChange[]>;
}

interface SyncHistoryEntry {
  id: string;
  repo: string;
  type: 'full' | 'incremental' | 'diff';
  timestamp: number;
  success: boolean;
  filesProcessed: number;
  changesDetected: number;
  duration: number;
  error?: string;
}

export class RepoSyncAgent extends BaseAgent {
  private syncState: SyncState;
  private githubApiBase = 'https://api.github.com';

  constructor(state: DurableObjectState, env: Env) {
    super(state, env, 'sync', 'repo-sync-agent');

    this.syncState = {
      repositories: new Map(),
      lastFullSync: 0,
      syncHistory: [],
      pendingChanges: new Map(),
    };
  }

  protected async onInitialize(): Promise<void> {
    const stored = await this.storage.get<{
      repositories: Record<string, Repository>;
      lastFullSync: number;
      syncHistory: SyncHistoryEntry[];
      pendingChanges: Record<string, RepoChange[]>;
    }>('syncState');

    if (stored) {
      this.syncState = {
        repositories: new Map(Object.entries(stored.repositories || {})),
        lastFullSync: stored.lastFullSync || 0,
        syncHistory: stored.syncHistory || [],
        pendingChanges: new Map(Object.entries(stored.pendingChanges || {})),
      };
    }
  }

  private async persistSyncState(): Promise<void> {
    const serializable = {
      repositories: Object.fromEntries(this.syncState.repositories),
      lastFullSync: this.syncState.lastFullSync,
      syncHistory: this.syncState.syncHistory.slice(-100),
      pendingChanges: Object.fromEntries(this.syncState.pendingChanges),
    };
    await this.storage.put('syncState', serializable);
  }

  protected async handleMessage(message: AgentMessage): Promise<void> {
    const payload = message.payload as SyncJob;
    if (payload.repo) {
      await this.syncRepository(payload);
    }
  }

  protected async processWork(): Promise<void> {
    // Process any pending sync jobs from queue
    // This is triggered by the scheduler or manually
  }

  async syncRepository(job: SyncJob): Promise<ScraperResult> {
    const startTime = now();
    this.logger.info('Starting repository sync', {
      repo: job.repo,
      type: job.syncType
    });

    const result: ScraperResult = {
      repo: job.repo,
      timestamp: startTime,
      success: false,
      filesProcessed: 0,
      errors: [],
      changes: [],
    };

    try {
      const { owner, name } = parseRepoFullName(job.repo);

      // Get or create repository record
      let repo = this.syncState.repositories.get(job.repo);
      if (!repo) {
        repo = await this.initializeRepository(owner, name);
        this.syncState.repositories.set(job.repo, repo);
      }

      // Perform sync based on type
      if (job.syncType === 'full') {
        result.changes = await this.fullSync(repo, result);
      } else if (job.syncType === 'incremental') {
        result.changes = await this.incrementalSync(repo, result);
      } else {
        result.changes = await this.diffSync(repo, result);
      }

      // Update repository record
      repo.lastSynced = now();
      repo.cohesionScore = await this.calculateCohesionScore(repo);
      this.syncState.repositories.set(job.repo, repo);

      // Store snapshot in R2 if full sync
      if (job.syncType === 'full' && repo.structure) {
        const snapshotKey = `${job.repo}/${now()}.json`;
        await this.env.REPO_SNAPSHOTS.put(snapshotKey, JSON.stringify(repo.structure));
        result.snapshot = snapshotKey;
      }

      // Cache structure in KV for quick access
      await this.env.REPO_CACHE.put(
        `repo:${job.repo}:structure`,
        JSON.stringify(repo.structure),
        { expirationTtl: 3600 } // 1 hour
      );

      result.success = true;

      // Record history
      this.syncState.syncHistory.push({
        id: generateId('sync-hist'),
        repo: job.repo,
        type: job.syncType,
        timestamp: startTime,
        success: true,
        filesProcessed: result.filesProcessed,
        changesDetected: result.changes.length,
        duration: now() - startTime,
      });

      // If changes detected, queue resolution check
      if (result.changes.length > 0) {
        await this.queueResolutionCheck(job.repo, result.changes);
      }

      this.logger.info('Repository sync completed', {
        repo: job.repo,
        filesProcessed: result.filesProcessed,
        changes: result.changes.length,
        duration: now() - startTime
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMessage);
      result.success = false;

      this.syncState.syncHistory.push({
        id: generateId('sync-hist'),
        repo: job.repo,
        type: job.syncType,
        timestamp: startTime,
        success: false,
        filesProcessed: result.filesProcessed,
        changesDetected: 0,
        duration: now() - startTime,
        error: errorMessage,
      });

      this.logger.error('Repository sync failed',
        error instanceof Error ? error : new Error(errorMessage),
        { repo: job.repo }
      );
    }

    await this.persistSyncState();
    return result;
  }

  private async initializeRepository(owner: string, name: string): Promise<Repository> {
    const repoInfo = await this.fetchGitHubApi<GitHubRepo>(`/repos/${owner}/${name}`);

    return {
      owner,
      name,
      fullName: repoInfo.full_name,
      defaultBranch: repoInfo.default_branch,
    };
  }

  private async fullSync(repo: Repository, result: ScraperResult): Promise<RepoChange[]> {
    const changes: RepoChange[] = [];
    const oldStructure = repo.structure;

    // Fetch complete repository tree
    const tree = await this.fetchRepositoryTree(repo);
    repo.structure = tree;
    result.filesProcessed = tree.totalFiles;

    if (this.syncState.lastFullSync === 0) {
      this.syncState.lastFullSync = now();
    }

    // Compare with old structure to detect changes
    if (oldStructure) {
      changes.push(...this.compareStructures(oldStructure, tree));
    }

    return changes;
  }

  private async incrementalSync(repo: Repository, result: ScraperResult): Promise<RepoChange[]> {
    const changes: RepoChange[] = [];

    // Fetch recent commits since last sync
    const since = repo.lastSynced
      ? new Date(repo.lastSynced).toISOString()
      : new Date(Date.now() - 86400000).toISOString(); // Last 24 hours

    const commits = await this.fetchGitHubApi<GitHubCommit[]>(
      `/repos/${repo.fullName}/commits?since=${since}&per_page=100`
    );

    for (const commit of commits) {
      // Fetch commit details
      const commitDetail = await this.fetchGitHubApi<{
        files?: Array<{
          filename: string;
          status: 'added' | 'modified' | 'removed' | 'renamed';
          previous_filename?: string;
          sha: string;
        }>;
      }>(`/repos/${repo.fullName}/commits/${commit.sha}`);

      if (commitDetail.files) {
        for (const file of commitDetail.files) {
          changes.push({
            type: file.status === 'removed' ? 'deleted' :
              file.status === 'renamed' ? 'renamed' :
                file.status === 'added' ? 'added' : 'modified',
            path: file.filename,
            oldPath: file.previous_filename,
            sha: file.sha,
          });
          result.filesProcessed++;
        }
      }
    }

    // Update structure if we have changes
    if (changes.length > 0 && repo.structure) {
      repo.structure.lastUpdated = now();
    }

    // Update last commit SHA
    if (commits.length > 0 && commits[0]) {
      repo.lastCommitSha = commits[0].sha;
    }

    return changes;
  }

  private async diffSync(repo: Repository, result: ScraperResult): Promise<RepoChange[]> {
    const changes: RepoChange[] = [];

    // Compare current HEAD with stored SHA
    if (!repo.lastCommitSha) {
      // No previous SHA, do full sync instead
      return this.fullSync(repo, result);
    }

    try {
      const comparison = await this.fetchGitHubApi<{
        files?: Array<{
          filename: string;
          status: 'added' | 'modified' | 'removed' | 'renamed';
          previous_filename?: string;
          sha: string;
          patch?: string;
        }>;
      }>(`/repos/${repo.fullName}/compare/${repo.lastCommitSha}...${repo.defaultBranch}`);

      if (comparison.files) {
        for (const file of comparison.files) {
          changes.push({
            type: file.status === 'removed' ? 'deleted' :
              file.status === 'renamed' ? 'renamed' :
                file.status === 'added' ? 'added' : 'modified',
            path: file.filename,
            oldPath: file.previous_filename,
            sha: file.sha,
            diff: file.patch,
          });
          result.filesProcessed++;
        }
      }
    } catch {
      // If comparison fails (e.g., SHA no longer exists), do full sync
      return this.fullSync(repo, result);
    }

    return changes;
  }

  private async fetchRepositoryTree(repo: Repository): Promise<RepoStructure> {
    // Get recursive tree
    const tree = await this.fetchGitHubApi<{
      tree: Array<{
        path: string;
        type: 'blob' | 'tree';
        sha: string;
        size?: number;
      }>;
    }>(`/repos/${repo.fullName}/git/trees/${repo.defaultBranch}?recursive=1`);

    const files: FileNode[] = [];
    const directories: { path: string; name: string; children: string[] }[] = [];
    const languages: Record<string, number> = {};

    for (const item of tree.tree) {
      if (item.type === 'blob') {
        files.push({
          path: item.path,
          name: item.path.split('/').pop() || item.path,
          size: item.size || 0,
          sha: item.sha,
          type: this.getFileType(item.path),
        });

        // Track language by extension
        const ext = item.path.split('.').pop()?.toLowerCase() || 'unknown';
        languages[ext] = (languages[ext] || 0) + (item.size || 0);
      } else {
        const parts = item.path.split('/');
        directories.push({
          path: item.path,
          name: parts.pop() || item.path,
          children: [],
        });
      }
    }

    // Build directory children
    for (const file of files) {
      const dirPath = file.path.split('/').slice(0, -1).join('/');
      const dir = directories.find(d => d.path === dirPath);
      if (dir) {
        dir.children.push(file.path);
      }
    }

    return {
      files,
      directories,
      totalFiles: files.length,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      languages,
      lastUpdated: now(),
    };
  }

  private getFileType(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const typeMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      rs: 'rust',
      go: 'go',
      md: 'markdown',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      toml: 'toml',
      sh: 'shell',
      bash: 'shell',
    };
    return typeMap[ext] || ext;
  }

  private compareStructures(old: RepoStructure, current: RepoStructure): RepoChange[] {
    const changes: RepoChange[] = [];
    const oldPaths = new Set(old.files.map(f => f.path));
    const newPaths = new Set(current.files.map(f => f.path));

    // Find added files
    for (const file of current.files) {
      if (!oldPaths.has(file.path)) {
        changes.push({ type: 'added', path: file.path, sha: file.sha });
      }
    }

    // Find deleted files
    for (const file of old.files) {
      if (!newPaths.has(file.path)) {
        changes.push({ type: 'deleted', path: file.path });
      }
    }

    // Find modified files (same path, different SHA)
    for (const file of current.files) {
      const oldFile = old.files.find(f => f.path === file.path);
      if (oldFile && oldFile.sha !== file.sha) {
        changes.push({ type: 'modified', path: file.path, sha: file.sha });
      }
    }

    return changes;
  }

  private async calculateCohesionScore(repo: Repository): Promise<number> {
    if (!repo.structure) return 0;

    let score = 100;
    const { files, languages } = repo.structure;

    // Check for essential files
    const hasReadme = files.some(f => f.name.toLowerCase().includes('readme'));
    const hasLicense = files.some(f => f.name.toLowerCase().includes('license'));
    const hasPackageJson = files.some(f => f.name === 'package.json');
    const hasConfig = files.some(f =>
      f.name.includes('config') || f.name.includes('.toml') || f.name.includes('.yaml')
    );

    if (!hasReadme) score -= 10;
    if (!hasLicense) score -= 5;
    if (!hasPackageJson) score -= 5;
    if (!hasConfig) score -= 5;

    // Check for consistent naming patterns
    const hasInconsistentNaming = files.some(f =>
      f.name.includes(' ') || f.name !== f.name.toLowerCase().replace(/[A-Z]/g, '-$&').toLowerCase()
    );
    if (hasInconsistentNaming) score -= 10;

    // Check language consistency (primary language should be >60%)
    const totalSize = Object.values(languages).reduce((a, b) => a + b, 0);
    const primaryLanguage = Object.entries(languages)
      .sort((a, b) => b[1] - a[1])[0];
    if (primaryLanguage && (primaryLanguage[1] / totalSize) < 0.6) {
      score -= 10;
    }

    return Math.max(0, score);
  }

  private async queueResolutionCheck(repo: string, changes: RepoChange[]): Promise<void> {
    // Store pending changes
    this.syncState.pendingChanges.set(repo, changes);

    // Notify cohesion monitor
    try {
      const monitorId = this.env.COHESION_MONITOR.idFromName('monitor');
      const monitor = this.env.COHESION_MONITOR.get(monitorId);
      await monitor.fetch(new Request('http://internal/message', {
        method: 'POST',
        body: JSON.stringify({
          id: generateId('msg'),
          from: this.agentState.agentId,
          to: 'cohesion-monitor',
          type: 'event',
          payload: { event: 'repoChanges', repo, changeCount: changes.length },
          timestamp: now(),
        }),
      }));
    } catch (error) {
      this.logger.warn('Failed to notify cohesion monitor', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async fetchGitHubApi<T>(path: string): Promise<T> {
    const url = `${this.githubApiBase}${path}`;
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'BlackRoad-Agent-Framework/7.0',
    };

    if (this.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${this.env.GITHUB_TOKEN}`;
    }

    return withRetry(async () => {
      const response = await fetch(url, { headers });

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      return response.json() as Promise<T>;
    }, { maxAttempts: 3, baseDelay: 1000 });
  }

  protected async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET') {
      if (path === '/repositories') {
        return this.listRepositories();
      }
      if (path === '/history') {
        return this.getSyncHistory();
      }
      if (path.startsWith('/repo/')) {
        const repoName = decodeURIComponent(path.replace('/repo/', ''));
        return this.getRepository(repoName);
      }
    }

    if (request.method === 'POST') {
      if (path === '/sync') {
        return this.handleSyncRequest(request);
      }
      if (path === '/webhook') {
        return this.handleWebhook(request);
      }
    }

    return new Response('Not Found', { status: 404 });
  }

  private listRepositories(): Response {
    const repos = Array.from(this.syncState.repositories.values());
    return new Response(JSON.stringify({ repositories: repos }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private getRepository(repoName: string): Response {
    const repo = this.syncState.repositories.get(repoName);
    if (!repo) {
      return new Response(JSON.stringify({ error: 'Repository not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ repository: repo }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private getSyncHistory(): Response {
    return new Response(JSON.stringify({
      history: this.syncState.syncHistory.slice(-50)
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleSyncRequest(request: Request): Promise<Response> {
    const job = await request.json() as SyncJob;
    job.id = job.id || generateId('sync');
    job.timestamp = now();
    job.triggeredBy = 'manual';

    const result = await this.syncRepository(job);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleWebhook(request: Request): Promise<Response> {
    // Verify webhook signature
    const signature = request.headers.get('X-Hub-Signature-256');
    const body = await request.text();

    if (this.env.WEBHOOK_SECRET && signature) {
      // TODO: Verify signature
    }

    const payload = JSON.parse(body) as {
      repository?: { full_name: string };
      ref?: string;
    };

    if (payload.repository) {
      const job: SyncJob = {
        id: generateId('sync'),
        repo: payload.repository.full_name,
        syncType: 'incremental',
        triggeredBy: 'webhook',
        timestamp: now(),
      };

      await this.env.SYNC_QUEUE.send(job);

      return new Response(JSON.stringify({ success: true, jobId: job.id }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
