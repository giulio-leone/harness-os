CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json)),
  policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  campaign_id TEXT,
  session_type TEXT NOT NULL,
  host TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  notes TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'in_progress', 'blocked', 'done', 'failed')),
  depends_on TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(depends_on)),
  deadline_at TEXT,
  recipients_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recipients_json)),
  approvals_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(approvals_json)),
  external_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(external_refs_json)),
  blocked_reason TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  campaign_id TEXT,
  milestone_id TEXT,
  task TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'in_progress', 'blocked', 'needs_recovery', 'done', 'failed')),
  size TEXT NOT NULL CHECK (size IN ('S', 'M', 'L', 'XL')),
  depends_on TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(depends_on)),
  deadline_at TEXT,
  recipients_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recipients_json)),
  approvals_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(approvals_json)),
  external_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(external_refs_json)),
  policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy_json)),
  next_best_action TEXT,
  blocked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
  FOREIGN KEY (milestone_id) REFERENCES milestones(id)
);

CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  campaign_id TEXT,
  issue_id TEXT,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'needs_recovery', 'recovered')),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  released_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
  FOREIGN KEY (issue_id) REFERENCES issues(id)
);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  issue_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  task_status TEXT NOT NULL CHECK (task_status IN ('pending', 'ready', 'in_progress', 'blocked', 'needs_recovery', 'done', 'failed')),
  next_step TEXT NOT NULL,
  artifact_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifact_ids_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (issue_id) REFERENCES issues(id)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  issue_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (issue_id) REFERENCES issues(id)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  campaign_id TEXT,
  issue_id TEXT,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
  FOREIGN KEY (issue_id) REFERENCES issues(id)
);

CREATE TABLE memory_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  campaign_id TEXT,
  issue_id TEXT,
  memory_kind TEXT NOT NULL,
  memory_ref TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
  FOREIGN KEY (issue_id) REFERENCES issues(id)
);

CREATE TABLE active_sessions (
  token TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  campaign_id TEXT,
  issue_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  begin_input_json TEXT NOT NULL CHECK (json_valid(begin_input_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
  FOREIGN KEY (issue_id) REFERENCES issues(id),
  FOREIGN KEY (lease_id) REFERENCES leases(id)
);

CREATE TABLE sync_state (
  family TEXT PRIMARY KEY,
  last_source TEXT,
  last_runtime_sync_at TEXT,
  status TEXT NOT NULL,
  notes TEXT
);

CREATE INDEX idx_issues_project_campaign_status_priority
  ON issues(project_id, campaign_id, status, priority);
CREATE INDEX idx_leases_project_status_issue_expires
  ON leases(project_id, status, issue_id, expires_at);
CREATE INDEX idx_checkpoints_issue_created_at
  ON checkpoints(issue_id, created_at);
CREATE INDEX idx_events_issue_created_at
  ON events(issue_id, created_at);
CREATE INDEX idx_active_sessions_project_status_issue
  ON active_sessions(project_id, status, issue_id);
CREATE UNIQUE INDEX idx_leases_unique_active_issue
  ON leases(issue_id)
  WHERE status = 'active'
    AND released_at IS NULL
    AND issue_id IS NOT NULL;
