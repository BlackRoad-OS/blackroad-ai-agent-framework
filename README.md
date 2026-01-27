# ⬛⬜🛣️ BlackRoad AI Agent Framework

Self-orchestrating AI agent framework built on Cloudflare Workers. Features autonomous agents with auto-healing, repository syncing, cohesion monitoring, and intelligent self-resolution capabilities.

## Features

- **Agent Orchestration** - Centralized coordination of autonomous agents via Durable Objects
- **Self-Healing** - Automatic issue detection and resolution with AI-powered diagnostics
- **Repository Sync** - Continuous scraping and syncing of GitHub repositories
- **Cohesion Monitoring** - Ecosystem-wide consistency and drift detection
- **Scheduled Jobs** - Cron-triggered tasks with reliable execution
- **Auto-Update** - Self-maintaining system that resolves issues autonomously

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    BlackRoad AI Agent Framework                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    Cloudflare Workers Edge                         │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │  │
│  │  │   Hono API  │  │   Queues    │  │    Cron     │               │  │
│  │  │   Router    │  │  Consumers  │  │  Triggers   │               │  │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘               │  │
│  └─────────┼────────────────┼────────────────┼──────────────────────┘  │
│            │                │                │                          │
│  ┌─────────▼────────────────▼────────────────▼──────────────────────┐  │
│  │                    Durable Objects                                 │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │  │
│  │  │   Agent     │  │    Job      │  │  Repo Sync  │               │  │
│  │  │ Orchestrator│  │  Scheduler  │  │    Agent    │               │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘               │  │
│  │  ┌─────────────┐  ┌─────────────┐                                 │  │
│  │  │    Self     │  │  Cohesion   │                                 │  │
│  │  │   Healer    │  │   Monitor   │                                 │  │
│  │  └─────────────┘  └─────────────┘                                 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                        Storage Layer                               │  │
│  │  ┌───────┐  ┌────────┐  ┌────────┐  ┌────────┐                   │  │
│  │  │  KV   │  │   D1   │  │   R2   │  │ Queues │                   │  │
│  │  │ State │  │Database│  │Snapshots│ │Messages│                   │  │
│  │  └───────┘  └────────┘  └────────┘  └────────┘                   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Agents

### Agent Orchestrator
Central coordinator managing all agents - handles lifecycle, routing, and health monitoring.

### Job Scheduler
Manages scheduled jobs with cron triggers. Built-in jobs:
- Health Check (every 5 min)
- Incremental Repo Sync (every 15 min)
- Cohesion Analysis (hourly)
- Deep Resolution Scan (every 6 hours)
- Full Repo Scrape (daily)

### Repo Sync Agent
Scrapes and syncs GitHub repositories:
- Full sync with complete tree fetching
- Incremental sync via commit history
- Diff sync comparing HEAD to stored SHA
- Webhook support for instant updates

### Self Healer
Autonomous issue resolution:
- Agent restart strategy
- Repository resync strategy
- Conflict resolution strategy
- AI-powered resolution via Claude API

### Cohesion Monitor
Ecosystem-wide consistency tracking:
- Pattern-based structure analysis
- Language consistency scoring
- Cross-repo cohesion comparison
- Drift detection and alerting

## Quick Start

```bash
# Install dependencies
npm install

# Configure Cloudflare (login first: wrangler login)
./blackroad-ai-agent-framework.sh setup

# Set secrets
wrangler secret put GITHUB_TOKEN
wrangler secret put ANTHROPIC_API_KEY

# Start development server
./blackroad-ai-agent-framework.sh dev

# Deploy to production
./blackroad-ai-agent-framework.sh deploy
```

## CLI Commands

```bash
./blackroad-ai-agent-framework.sh <command>

Commands:
  dev           Start local development server
  deploy        Deploy to Cloudflare Workers
  setup         Initialize Cloudflare resources
  health        Check system health
  status        Show agent status
  agents        List all agents
  jobs          List scheduled jobs
  repos         List monitored repositories
  sync          Trigger repository sync
  cohesion      Get cohesion report
  issues        List detected issues
  resolve       Trigger resolution scan
  logs          Tail worker logs
```

## API Endpoints

### Health & Status
- `GET /` - Framework info
- `GET /api/health` - System health check

### Agents
- `GET /api/agents` - List all agents
- `GET /api/agents/status` - Agent orchestrator status
- `POST /api/agents/broadcast` - Broadcast message to agents

### Jobs
- `GET /api/jobs` - List scheduled jobs
- `GET /api/jobs/history` - Job execution history
- `POST /api/jobs` - Create new job
- `POST /api/jobs/:jobId/trigger` - Manually trigger job

### Repositories
- `GET /api/repos` - List synced repositories
- `GET /api/repos/monitored` - List monitored repos
- `POST /api/repos/sync` - Trigger sync for one repo
- `POST /api/repos/sync-all` - Trigger sync for all repos
- `POST /api/repos/webhook` - GitHub webhook endpoint

### Cohesion
- `GET /api/cohesion` - Latest cohesion report
- `GET /api/cohesion/scores` - Repository scores
- `GET /api/cohesion/drift` - Drift history
- `POST /api/cohesion/analyze` - Run analysis

### Resolution
- `GET /api/resolution/issues` - List detected issues
- `GET /api/resolution/stats` - Resolution statistics
- `GET /api/resolution/escalations` - Escalated issues
- `POST /api/resolution/scan` - Trigger resolution scan

## Configuration

### Environment Variables

```toml
# wrangler.toml
[vars]
ENVIRONMENT = "production"
LOG_LEVEL = "info"
BLACKROAD_VERSION = "7.0.0"

# Monitored repositories
MONITORED_REPOS = """
BlackRoad-OS/blackroad-prism-console
BlackRoad-OS/blackroad-ai-agent-framework
BlackRoad-OS/blackroad-core
BlackRoad-OS/blackroad-memory
"""

# Auto-resolution
AUTO_RESOLUTION_ENABLED = "true"
MAX_RESOLUTION_ATTEMPTS = "5"
RESOLUTION_COOLDOWN_MS = "30000"

# Cohesion thresholds
COHESION_THRESHOLD = "0.85"
DRIFT_ALERT_THRESHOLD = "0.15"
```

### Secrets

```bash
wrangler secret put GITHUB_TOKEN        # GitHub API access
wrangler secret put ANTHROPIC_API_KEY   # Claude for AI resolution
wrangler secret put WEBHOOK_SECRET      # GitHub webhook verification
```

## Monitored Repositories

Configure repositories in `wrangler.toml`:

```toml
MONITORED_REPOS = """
BlackRoad-OS/blackroad-prism-console
BlackRoad-OS/blackroad-ai-agent-framework
BlackRoad-OS/blackroad-core
"""
```

The framework will:
1. Scrape each repository structure daily
2. Sync changes incrementally every 15 minutes
3. Monitor cohesion across all repos
4. Auto-resolve drift and inconsistencies

## Self-Resolution

When issues are detected:

1. **Detection** - Agents monitor for errors, drift, staleness
2. **Analysis** - Self Healer evaluates issue severity and type
3. **Resolution** - Applies strategies in order of priority:
   - Agent restart
   - Repository resync
   - Conflict resolution
   - AI-powered diagnosis (Claude API)
4. **Escalation** - If all strategies fail, issue is escalated

## Design System

Built with BlackRoad brand identity:
- **Hot Pink:** #FF1D6C
- **Amber:** #F5A623
- **Electric Blue:** #2979FF
- **Violet:** #9C27B0

## Part of BlackRoad Empire

400+ products across 52 categories. Built with infinite vision.

## License

Copyright (c) 2026 BlackRoad OS, Inc. All rights reserved.

Proprietary software. For licensing inquiries: blackroad.systems@gmail.com
