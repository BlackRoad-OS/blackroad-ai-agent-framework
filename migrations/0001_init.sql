-- ⬛⬜🛣️ BlackRoad AI Agent Framework - D1 Database Schema
-- Initial migration: Core tables for agent state and history

-- Agent registry
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_heartbeat INTEGER,
    error_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    metadata TEXT, -- JSON
    UNIQUE(type)
);

-- Agent events/audit log
CREATE TABLE IF NOT EXISTS agent_events (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    payload TEXT, -- JSON
    correlation_id TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX idx_agent_events_agent ON agent_events(agent_id);
CREATE INDEX idx_agent_events_timestamp ON agent_events(timestamp);
CREATE INDEX idx_agent_events_type ON agent_events(event_type);

-- Job definitions
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cron TEXT,
    interval_ms INTEGER,
    handler TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    config TEXT, -- JSON
    UNIQUE(name)
);

-- Job execution history
CREATE TABLE IF NOT EXISTS job_executions (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    success INTEGER,
    error TEXT,
    duration_ms INTEGER,
    result TEXT, -- JSON
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX idx_job_executions_job ON job_executions(job_id);
CREATE INDEX idx_job_executions_started ON job_executions(started_at);

-- Repository tracking
CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL UNIQUE,
    default_branch TEXT DEFAULT 'main',
    last_synced INTEGER,
    last_commit_sha TEXT,
    cohesion_score REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata TEXT -- JSON
);

CREATE INDEX idx_repositories_full_name ON repositories(full_name);

-- Sync history
CREATE TABLE IF NOT EXISTS sync_history (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    sync_type TEXT NOT NULL,
    triggered_by TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    success INTEGER,
    files_processed INTEGER DEFAULT 0,
    changes_detected INTEGER DEFAULT 0,
    error TEXT,
    snapshot_key TEXT, -- R2 key
    FOREIGN KEY (repo_id) REFERENCES repositories(id)
);

CREATE INDEX idx_sync_history_repo ON sync_history(repo_id);
CREATE INDEX idx_sync_history_started ON sync_history(started_at);

-- Issues detected
CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'detected',
    detected_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution_task_id TEXT,
    affected_repos TEXT, -- JSON array
    affected_files TEXT, -- JSON array
    metadata TEXT -- JSON
);

CREATE INDEX idx_issues_status ON issues(status);
CREATE INDEX idx_issues_type ON issues(type);
CREATE INDEX idx_issues_severity ON issues(severity);

-- Resolution tasks
CREATE TABLE IF NOT EXISTS resolution_tasks (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'detected',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    resolved_at INTEGER,
    attempts INTEGER DEFAULT 0,
    last_strategy TEXT,
    resolution TEXT, -- JSON
    FOREIGN KEY (issue_id) REFERENCES issues(id)
);

CREATE INDEX idx_resolution_tasks_issue ON resolution_tasks(issue_id);
CREATE INDEX idx_resolution_tasks_status ON resolution_tasks(status);

-- Resolution attempts
CREATE TABLE IF NOT EXISTS resolution_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    success INTEGER NOT NULL,
    duration_ms INTEGER,
    error TEXT,
    changes TEXT, -- JSON
    FOREIGN KEY (task_id) REFERENCES resolution_tasks(id)
);

CREATE INDEX idx_resolution_attempts_task ON resolution_attempts(task_id);

-- Cohesion reports
CREATE TABLE IF NOT EXISTS cohesion_reports (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    overall_score REAL NOT NULL,
    repo_count INTEGER NOT NULL,
    issue_count INTEGER NOT NULL,
    report_data TEXT NOT NULL, -- JSON
    recommendations TEXT -- JSON array
);

CREATE INDEX idx_cohesion_reports_timestamp ON cohesion_reports(timestamp);

-- Drift history
CREATE TABLE IF NOT EXISTS drift_history (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    repo_id TEXT,
    factor TEXT NOT NULL,
    previous_score REAL NOT NULL,
    current_score REAL NOT NULL,
    delta REAL NOT NULL,
    FOREIGN KEY (repo_id) REFERENCES repositories(id)
);

CREATE INDEX idx_drift_history_timestamp ON drift_history(timestamp);
CREATE INDEX idx_drift_history_repo ON drift_history(repo_id);

-- Escalations
CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    reason TEXT NOT NULL,
    notified INTEGER DEFAULT 0,
    notification_sent_at INTEGER,
    acknowledged INTEGER DEFAULT 0,
    acknowledged_at INTEGER,
    acknowledged_by TEXT,
    FOREIGN KEY (issue_id) REFERENCES issues(id)
);

CREATE INDEX idx_escalations_issue ON escalations(issue_id);
CREATE INDEX idx_escalations_timestamp ON escalations(timestamp);

-- System configuration
CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    description TEXT
);

-- Insert default configuration
INSERT OR IGNORE INTO system_config (key, value, updated_at, description) VALUES
    ('auto_resolution_enabled', 'true', strftime('%s', 'now') * 1000, 'Enable automatic issue resolution'),
    ('cohesion_threshold', '0.85', strftime('%s', 'now') * 1000, 'Minimum acceptable cohesion score'),
    ('drift_alert_threshold', '0.15', strftime('%s', 'now') * 1000, 'Drift threshold for alerts'),
    ('max_resolution_attempts', '5', strftime('%s', 'now') * 1000, 'Maximum auto-resolution attempts'),
    ('sync_interval_minutes', '15', strftime('%s', 'now') * 1000, 'Repository sync interval');
