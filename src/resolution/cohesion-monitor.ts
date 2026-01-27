/**
 * ⬛⬜🛣️ BlackRoad Cohesion Monitor - Durable Object
 *
 * Monitors cohesiveness across repositories, detecting drift,
 * inconsistencies, and ensuring the ecosystem stays aligned.
 */

import type {
  Env,
  AgentMessage,
  CohesionReport,
  RepoCohesion,
  CohesionFactor,
  CohesionIssue,
  IssueSeverity,
  Repository,
  RepoStructure
} from '../types';
import { BaseAgent } from '../agents/base';
import { generateId, now, parseMonitoredRepos } from '../utils/helpers';

interface MonitorState {
  reports: CohesionReport[];
  lastAnalysis: number;
  repoScores: Map<string, RepoCohesion>;
  knownPatterns: PatternDefinition[];
  driftHistory: DriftRecord[];
}

interface PatternDefinition {
  id: string;
  name: string;
  pattern: string | RegExp;
  category: 'file' | 'structure' | 'naming' | 'config';
  required: boolean;
  weight: number;
}

interface DriftRecord {
  id: string;
  timestamp: number;
  repos: string[];
  factor: string;
  previousScore: number;
  currentScore: number;
  delta: number;
}

export class CohesionMonitor extends BaseAgent {
  private monitorState: MonitorState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env, 'monitor', 'cohesion-monitor');

    this.monitorState = {
      reports: [],
      lastAnalysis: 0,
      repoScores: new Map(),
      knownPatterns: [],
      driftHistory: [],
    };
  }

  protected async onInitialize(): Promise<void> {
    const stored = await this.storage.get<{
      reports: CohesionReport[];
      lastAnalysis: number;
      repoScores: Record<string, RepoCohesion>;
      driftHistory: DriftRecord[];
    }>('monitorState');

    if (stored) {
      this.monitorState = {
        reports: stored.reports || [],
        lastAnalysis: stored.lastAnalysis || 0,
        repoScores: new Map(Object.entries(stored.repoScores || {})),
        knownPatterns: this.getDefaultPatterns(),
        driftHistory: stored.driftHistory || [],
      };
    } else {
      this.monitorState.knownPatterns = this.getDefaultPatterns();
    }
  }

  private getDefaultPatterns(): PatternDefinition[] {
    return [
      // Required files
      { id: 'readme', name: 'README', pattern: /readme\.md/i, category: 'file', required: true, weight: 15 },
      { id: 'license', name: 'LICENSE', pattern: /license/i, category: 'file', required: true, weight: 10 },
      { id: 'package-json', name: 'package.json', pattern: 'package.json', category: 'file', required: false, weight: 10 },
      { id: 'gitignore', name: '.gitignore', pattern: '.gitignore', category: 'file', required: true, weight: 5 },

      // Structure patterns
      { id: 'src-dir', name: 'src directory', pattern: /^src\//i, category: 'structure', required: false, weight: 10 },
      { id: 'tests', name: 'tests directory', pattern: /^(tests?|__tests__)\//i, category: 'structure', required: false, weight: 10 },
      { id: 'docs', name: 'docs directory', pattern: /^docs?\//i, category: 'structure', required: false, weight: 5 },

      // Naming conventions
      { id: 'kebab-case', name: 'kebab-case files', pattern: /^[a-z0-9-]+\.[a-z]+$/i, category: 'naming', required: false, weight: 10 },
      { id: 'no-spaces', name: 'no spaces in names', pattern: /\s/, category: 'naming', required: true, weight: 10 },

      // Config patterns
      { id: 'tsconfig', name: 'TypeScript config', pattern: 'tsconfig.json', category: 'config', required: false, weight: 5 },
      { id: 'eslint', name: 'ESLint config', pattern: /\.eslint/i, category: 'config', required: false, weight: 5 },
      { id: 'prettier', name: 'Prettier config', pattern: /\.prettier/i, category: 'config', required: false, weight: 5 },
    ];
  }

  private async persistMonitorState(): Promise<void> {
    const serializable = {
      reports: this.monitorState.reports.slice(-50),
      lastAnalysis: this.monitorState.lastAnalysis,
      repoScores: Object.fromEntries(this.monitorState.repoScores),
      driftHistory: this.monitorState.driftHistory.slice(-200),
    };
    await this.storage.put('monitorState', serializable);
  }

  protected async handleMessage(message: AgentMessage): Promise<void> {
    if (message.type === 'event') {
      const payload = message.payload as { event: string; repo?: string; changeCount?: number };

      if (payload.event === 'repoChanges' && payload.repo) {
        // Re-analyze affected repository
        await this.analyzeRepository(payload.repo);
      }
    }
  }

  protected async processWork(): Promise<void> {
    await this.runFullAnalysis();
  }

  async runFullAnalysis(): Promise<CohesionReport> {
    this.logger.info('Starting full cohesion analysis');
    const startTime = now();

    const repos = parseMonitoredRepos(this.env.MONITORED_REPOS);
    const repoCohesions: RepoCohesion[] = [];
    const issues: CohesionIssue[] = [];

    for (const repoName of repos) {
      try {
        const cohesion = await this.analyzeRepository(repoName);
        repoCohesions.push(cohesion);

        // Detect drift
        const previousCohesion = this.monitorState.repoScores.get(repoName);
        if (previousCohesion) {
          const drift = previousCohesion.score - cohesion.score;
          const threshold = parseFloat(this.env.DRIFT_ALERT_THRESHOLD || '0.15') * 100;

          if (Math.abs(drift) > threshold) {
            this.monitorState.driftHistory.push({
              id: generateId('drift'),
              timestamp: now(),
              repos: [repoName],
              factor: 'overall',
              previousScore: previousCohesion.score,
              currentScore: cohesion.score,
              delta: drift,
            });

            issues.push({
              id: generateId('issue'),
              type: 'structure',
              severity: Math.abs(drift) > threshold * 2 ? 'error' : 'warning',
              repos: [repoName],
              description: `Cohesion drift detected: ${drift.toFixed(1)} points`,
              suggestion: drift < 0
                ? 'Repository cohesion has degraded. Review recent changes.'
                : 'Repository cohesion has improved.',
            });
          }
        }

        this.monitorState.repoScores.set(repoName, cohesion);

        // Collect repo-specific issues
        issues.push(...this.detectIssues(cohesion));

      } catch (error) {
        this.logger.error('Failed to analyze repository',
          error instanceof Error ? error : new Error(String(error)),
          { repo: repoName }
        );
      }
    }

    // Cross-repo analysis
    const crossRepoIssues = this.analyzeCrossRepoCohesion(repoCohesions);
    issues.push(...crossRepoIssues);

    // Calculate overall score
    const overallScore = repoCohesions.length > 0
      ? repoCohesions.reduce((sum, r) => sum + r.score, 0) / repoCohesions.length
      : 0;

    // Generate recommendations
    const recommendations = this.generateRecommendations(repoCohesions, issues);

    const report: CohesionReport = {
      id: generateId('report'),
      timestamp: now(),
      overallScore,
      repos: repoCohesions,
      issues,
      recommendations,
    };

    this.monitorState.reports.push(report);
    this.monitorState.lastAnalysis = now();

    // Cache report
    await this.env.REPO_CACHE.put(
      'cohesion:latest-report',
      JSON.stringify(report),
      { expirationTtl: 3600 }
    );

    // Alert if score is below threshold
    const threshold = parseFloat(this.env.COHESION_THRESHOLD || '0.85') * 100;
    if (overallScore < threshold) {
      await this.alertLowCohesion(report);
    }

    await this.persistMonitorState();

    this.logger.info('Cohesion analysis completed', {
      overallScore: overallScore.toFixed(1),
      repoCount: repoCohesions.length,
      issueCount: issues.length,
      duration: now() - startTime
    });

    return report;
  }

  private async analyzeRepository(repoName: string): Promise<RepoCohesion> {
    // Fetch repository structure from cache or sync agent
    let structure: RepoStructure | null = null;

    const cached = await this.env.REPO_CACHE.get(`repo:${repoName}:structure`);
    if (cached) {
      structure = JSON.parse(cached) as RepoStructure;
    } else {
      // Request fresh sync
      const syncAgent = this.env.REPO_SYNC_AGENT.idFromName('sync');
      const sync = this.env.REPO_SYNC_AGENT.get(syncAgent);
      const response = await sync.fetch(
        new Request(`http://internal/repo/${encodeURIComponent(repoName)}`)
      );

      if (response.ok) {
        const { repository } = await response.json() as { repository: Repository };
        structure = repository.structure || null;
      }
    }

    if (!structure) {
      return {
        repo: repoName,
        score: 0,
        factors: [],
        driftScore: 0,
        lastUpdated: now(),
      };
    }

    const factors: CohesionFactor[] = [];

    // Analyze patterns
    for (const pattern of this.monitorState.knownPatterns) {
      const factor = this.evaluatePattern(pattern, structure);
      factors.push(factor);
    }

    // Additional analysis factors
    factors.push(this.analyzeLanguageConsistency(structure));
    factors.push(this.analyzeDirectoryStructure(structure));
    factors.push(this.analyzeFileNaming(structure));

    // Calculate overall score
    const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
    const weightedScore = factors.reduce((sum, f) => sum + (f.score * f.weight), 0);
    const score = totalWeight > 0 ? (weightedScore / totalWeight) : 0;

    // Calculate drift
    const previousCohesion = this.monitorState.repoScores.get(repoName);
    const driftScore = previousCohesion ? score - previousCohesion.score : 0;

    // Cache cohesion score
    await this.env.REPO_CACHE.put(
      `repo:${repoName}:cohesion`,
      score.toString(),
      { expirationTtl: 3600 }
    );

    return {
      repo: repoName,
      score,
      factors,
      driftScore,
      lastUpdated: now(),
    };
  }

  private evaluatePattern(pattern: PatternDefinition, structure: RepoStructure): CohesionFactor {
    let matches = 0;
    let violations = 0;

    for (const file of structure.files) {
      const path = file.path.toLowerCase();
      const name = file.name.toLowerCase();

      if (pattern.pattern instanceof RegExp) {
        if (pattern.category === 'naming' && pattern.id === 'no-spaces') {
          // Check for violations (spaces)
          if (pattern.pattern.test(file.name)) {
            violations++;
          }
        } else {
          if (pattern.pattern.test(path) || pattern.pattern.test(name)) {
            matches++;
          }
        }
      } else {
        if (path === pattern.pattern.toLowerCase() || name === pattern.pattern.toLowerCase()) {
          matches++;
        }
      }
    }

    let score: number;
    let details: string;

    if (pattern.id === 'no-spaces') {
      score = violations === 0 ? 100 : Math.max(0, 100 - (violations * 20));
      details = violations === 0 ? 'No spaces in filenames' : `${violations} files with spaces`;
    } else if (pattern.required) {
      score = matches > 0 ? 100 : 0;
      details = matches > 0 ? `Found ${pattern.name}` : `Missing ${pattern.name}`;
    } else {
      score = matches > 0 ? 100 : 50; // Optional patterns get partial score
      details = matches > 0 ? `Found ${matches} ${pattern.name} matches` : `No ${pattern.name} found`;
    }

    return {
      name: pattern.name,
      weight: pattern.weight,
      score,
      details,
    };
  }

  private analyzeLanguageConsistency(structure: RepoStructure): CohesionFactor {
    const { languages } = structure;
    const entries = Object.entries(languages);

    if (entries.length === 0) {
      return { name: 'Language Consistency', weight: 15, score: 50, details: 'No language data' };
    }

    const total = entries.reduce((sum, [, size]) => sum + size, 0);
    const sorted = entries.sort((a, b) => b[1] - a[1]);
    const primary = sorted[0];

    if (!primary) {
      return { name: 'Language Consistency', weight: 15, score: 50, details: 'No primary language' };
    }

    const primaryRatio = primary[1] / total;

    let score: number;
    let details: string;

    if (primaryRatio > 0.8) {
      score = 100;
      details = `Highly consistent: ${(primaryRatio * 100).toFixed(0)}% ${primary[0]}`;
    } else if (primaryRatio > 0.6) {
      score = 80;
      details = `Moderately consistent: ${(primaryRatio * 100).toFixed(0)}% ${primary[0]}`;
    } else if (primaryRatio > 0.4) {
      score = 60;
      details = `Mixed languages: ${(primaryRatio * 100).toFixed(0)}% ${primary[0]}`;
    } else {
      score = 40;
      details = `Fragmented: ${entries.length} languages, no clear primary`;
    }

    return { name: 'Language Consistency', weight: 15, score, details };
  }

  private analyzeDirectoryStructure(structure: RepoStructure): CohesionFactor {
    const { directories, files } = structure;

    // Check for standard structure
    const hasStandardDirs = [
      directories.some(d => d.path === 'src' || d.path === 'lib'),
      directories.some(d => d.path === 'tests' || d.path === 'test' || d.path === '__tests__'),
      files.some(f => f.path === 'package.json' || f.path === 'Cargo.toml' || f.path === 'go.mod'),
    ];

    const standardScore = hasStandardDirs.filter(Boolean).length / 3;

    // Check depth consistency
    const depths = files.map(f => f.path.split('/').length);
    const avgDepth = depths.reduce((a, b) => a + b, 0) / depths.length;
    const maxDepth = Math.max(...depths);

    let depthScore = 1;
    if (maxDepth > 10) depthScore -= 0.3;
    if (avgDepth > 5) depthScore -= 0.2;

    const score = (standardScore * 0.6 + depthScore * 0.4) * 100;
    const details = `${hasStandardDirs.filter(Boolean).length}/3 standard dirs, avg depth ${avgDepth.toFixed(1)}`;

    return { name: 'Directory Structure', weight: 10, score, details };
  }

  private analyzeFileNaming(structure: RepoStructure): CohesionFactor {
    const { files } = structure;

    let kebabCase = 0;
    let camelCase = 0;
    let snakeCase = 0;
    let pascalCase = 0;

    for (const file of files) {
      const name = file.name.replace(/\.[^.]+$/, ''); // Remove extension

      if (/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) kebabCase++;
      else if (/^[a-z][a-zA-Z0-9]*$/.test(name)) camelCase++;
      else if (/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name)) snakeCase++;
      else if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) pascalCase++;
    }

    const total = files.length;
    const dominant = Math.max(kebabCase, camelCase, snakeCase, pascalCase);
    const consistency = total > 0 ? dominant / total : 0;

    let style = 'mixed';
    if (dominant === kebabCase) style = 'kebab-case';
    else if (dominant === camelCase) style = 'camelCase';
    else if (dominant === snakeCase) style = 'snake_case';
    else if (dominant === pascalCase) style = 'PascalCase';

    const score = consistency * 100;
    const details = `${(consistency * 100).toFixed(0)}% ${style} consistency`;

    return { name: 'File Naming', weight: 10, score, details };
  }

  private detectIssues(cohesion: RepoCohesion): CohesionIssue[] {
    const issues: CohesionIssue[] = [];

    for (const factor of cohesion.factors) {
      if (factor.score < 50) {
        const severity: IssueSeverity = factor.score < 25 ? 'error' : 'warning';

        issues.push({
          id: generateId('issue'),
          type: this.factorToIssueType(factor.name),
          severity,
          repos: [cohesion.repo],
          description: `${factor.name}: ${factor.details}`,
          suggestion: this.getSuggestionForFactor(factor),
        });
      }
    }

    return issues;
  }

  private factorToIssueType(factorName: string): CohesionIssue['type'] {
    if (factorName.includes('Naming')) return 'naming';
    if (factorName.includes('Structure') || factorName.includes('Directory')) return 'structure';
    if (factorName.includes('Language')) return 'style';
    if (factorName.includes('Config') || factorName.includes('config')) return 'config';
    return 'structure';
  }

  private getSuggestionForFactor(factor: CohesionFactor): string {
    const suggestions: Record<string, string> = {
      'README': 'Add a README.md file with project documentation',
      'LICENSE': 'Add a LICENSE file to specify project licensing',
      '.gitignore': 'Add a .gitignore file to exclude build artifacts',
      'Language Consistency': 'Consider consolidating to fewer programming languages',
      'Directory Structure': 'Organize code into standard directories (src/, tests/, docs/)',
      'File Naming': 'Adopt a consistent file naming convention across the project',
    };

    return suggestions[factor.name] || `Improve ${factor.name} score`;
  }

  private analyzeCrossRepoCohesion(repos: RepoCohesion[]): CohesionIssue[] {
    const issues: CohesionIssue[] = [];

    if (repos.length < 2) return issues;

    // Check for score variance
    const scores = repos.map(r => r.score);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((sum, s) => sum + Math.pow(s - avgScore, 2), 0) / scores.length;

    if (variance > 400) { // High variance (>20 point spread)
      const lowRepos = repos.filter(r => r.score < avgScore - 10);
      if (lowRepos.length > 0) {
        issues.push({
          id: generateId('issue'),
          type: 'structure',
          severity: 'warning',
          repos: lowRepos.map(r => r.repo),
          description: `Cross-repo cohesion variance is high (${Math.sqrt(variance).toFixed(1)} points)`,
          suggestion: 'Align repository structures and conventions for better ecosystem cohesion',
        });
      }
    }

    // Check for naming convention consistency across repos
    const namingFactors = repos.map(r =>
      r.factors.find(f => f.name === 'File Naming')
    ).filter(Boolean) as CohesionFactor[];

    if (namingFactors.length >= 2) {
      const namingScores = namingFactors.map(f => f.score);
      const namingVariance = namingScores.reduce((sum, s) =>
        sum + Math.pow(s - (namingScores.reduce((a, b) => a + b, 0) / namingScores.length), 2), 0
      ) / namingScores.length;

      if (namingVariance > 625) { // >25 point spread
        issues.push({
          id: generateId('issue'),
          type: 'naming',
          severity: 'info',
          repos: repos.map(r => r.repo),
          description: 'Naming conventions vary significantly across repositories',
          suggestion: 'Establish and document shared naming conventions',
        });
      }
    }

    return issues;
  }

  private generateRecommendations(repos: RepoCohesion[], issues: CohesionIssue[]): string[] {
    const recommendations: string[] = [];

    // Based on overall score
    const avgScore = repos.reduce((sum, r) => sum + r.score, 0) / repos.length;
    if (avgScore < 70) {
      recommendations.push('Consider a focused effort to improve repository standards');
    }

    // Based on issue types
    const issueTypes = new Set(issues.map(i => i.type));
    if (issueTypes.has('naming')) {
      recommendations.push('Implement consistent file naming conventions across all repositories');
    }
    if (issueTypes.has('structure')) {
      recommendations.push('Standardize directory structures (src/, tests/, docs/)');
    }
    if (issueTypes.has('config')) {
      recommendations.push('Share configuration files (eslint, prettier, tsconfig) across repositories');
    }

    // Based on specific factors
    for (const repo of repos) {
      for (const factor of repo.factors) {
        if (factor.name === 'README' && factor.score === 0) {
          recommendations.push(`Add README.md to ${repo.repo}`);
        }
      }
    }

    return [...new Set(recommendations)].slice(0, 5);
  }

  private async alertLowCohesion(report: CohesionReport): Promise<void> {
    // Notify self-healer about low cohesion
    try {
      const healerId = this.env.SELF_HEALER.idFromName('healer');
      const healer = this.env.SELF_HEALER.get(healerId);

      await healer.fetch(new Request('http://internal/message', {
        method: 'POST',
        body: JSON.stringify({
          id: generateId('msg'),
          from: this.agentState.agentId,
          to: 'self-healer',
          type: 'event',
          payload: {
            event: 'issueDetected',
            data: {
              type: 'drift',
              severity: report.overallScore < 50 ? 'error' : 'warning',
              title: 'Low Ecosystem Cohesion Score',
              description: `Overall cohesion score (${report.overallScore.toFixed(1)}) is below threshold`,
              repos: report.repos.map(r => r.repo),
              files: [],
            },
          },
          timestamp: now(),
        }),
      }));
    } catch (error) {
      this.logger.error('Failed to alert self-healer',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  protected async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET') {
      if (path === '/report' || path === '/report/latest') {
        return this.getLatestReport();
      }
      if (path === '/reports') {
        return this.listReports();
      }
      if (path === '/scores') {
        return this.getScores();
      }
      if (path === '/drift') {
        return this.getDriftHistory();
      }
      if (path.startsWith('/repo/')) {
        const repoName = decodeURIComponent(path.replace('/repo/', ''));
        return this.getRepoScore(repoName);
      }
    }

    if (request.method === 'POST') {
      if (path === '/analyze') {
        const report = await this.runFullAnalysis();
        return new Response(JSON.stringify({ report }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }

  private getLatestReport(): Response {
    const latest = this.monitorState.reports[this.monitorState.reports.length - 1];
    if (!latest) {
      return new Response(JSON.stringify({ error: 'No reports available' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ report: latest }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private listReports(): Response {
    return new Response(JSON.stringify({
      reports: this.monitorState.reports.slice(-10)
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private getScores(): Response {
    const scores = Object.fromEntries(this.monitorState.repoScores);
    return new Response(JSON.stringify({ scores }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private getDriftHistory(): Response {
    return new Response(JSON.stringify({
      history: this.monitorState.driftHistory.slice(-50)
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private getRepoScore(repoName: string): Response {
    const score = this.monitorState.repoScores.get(repoName);
    if (!score) {
      return new Response(JSON.stringify({ error: 'Repository not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ cohesion: score }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
