export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'importing')`,
  `CREATE TABLE IF NOT EXISTS source_chunks (snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(snapshot_id, ordinal))`,
  `CREATE TABLE IF NOT EXISTS senses (id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, lemma TEXT NOT NULL, gloss TEXT NOT NULL, row_index INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS senses_snapshot ON senses(snapshot_id, row_index)`,
  `CREATE INDEX IF NOT EXISTS senses_lemma ON senses(snapshot_id, lemma)`,
  `CREATE TABLE IF NOT EXISTS examples (id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, sense_id TEXT NOT NULL REFERENCES senses(id), sentence TEXT NOT NULL, grac TEXT NOT NULL, row_index INTEGER NOT NULL, example_index INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS examples_snapshot ON examples(snapshot_id, row_index, example_index)`,
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES snapshots(id), name TEXT NOT NULL, reviewer TEXT NOT NULL, seed TEXT NOT NULL, sample_size INTEGER NOT NULL, sampler TEXT NOT NULL, created_at TEXT NOT NULL, last_position INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS samples (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, position INTEGER NOT NULL, example_id TEXT NOT NULL REFERENCES examples(id), option_ids TEXT NOT NULL, blind_choice TEXT, revealed_at TEXT, verdict TEXT CHECK(verdict IN ('correct','incorrect','unresolved')), reason TEXT NOT NULL DEFAULT '', replacement_sense_id TEXT, notes TEXT NOT NULL DEFAULT '', updated_at TEXT, version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id, example_id), UNIQUE(project_id,position))`,
  `CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, example_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS history_sample ON history(project_id, example_id, id)`,
  `CREATE TRIGGER IF NOT EXISTS sample_history AFTER UPDATE OF blind_choice, verdict, reason, replacement_sense_id, notes ON samples BEGIN INSERT INTO history (project_id,example_id,type,data,at) VALUES (NEW.project_id,NEW.example_id,CASE WHEN OLD.revealed_at IS NULL THEN 'reveal' ELSE 'assessment' END,json_object('version',NEW.version,'blindChoice',NEW.blind_choice,'revealedAt',NEW.revealed_at,'verdict',NEW.verdict,'reason',NEW.reason,'replacementSenseId',NEW.replacement_sense_id,'notes',NEW.notes),NEW.updated_at); END`,
];
