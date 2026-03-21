CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  repo_context TEXT,
  notes TEXT
);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL,
  task TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  size TEXT NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (milestone_id) REFERENCES milestones(id)
);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE sync_state (
  family TEXT PRIMARY KEY,
  last_source TEXT,
  last_runtime_sync_at TEXT,
  status TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
