-- Initial schema for Cloudflare D1 (Task T3: Teacher Cabinet)

CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_students_teacher ON students(teacher_id, archived, created_at);

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  student_id TEXT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_backup_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_boards_teacher ON boards(teacher_id, deleted_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_boards_student ON boards(student_id, deleted_at);
