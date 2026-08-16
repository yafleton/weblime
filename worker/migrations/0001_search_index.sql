PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS search_files (
  path TEXT PRIMARY KEY,
  etag TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('indexed', 'skipped', 'error')),
  chunks INTEGER NOT NULL DEFAULT 0,
  generation TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS search_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  chunk_no INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  text TEXT NOT NULL,
  UNIQUE(path, chunk_no),
  FOREIGN KEY(path) REFERENCES search_files(path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS search_chunks_path ON search_chunks(path);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  text,
  content='search_chunks',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS search_chunks_ai AFTER INSERT ON search_chunks BEGIN
  INSERT INTO search_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS search_chunks_ad AFTER DELETE ON search_chunks BEGIN
  INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS search_chunks_au AFTER UPDATE ON search_chunks BEGIN
  INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO search_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS search_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO search_meta(key, value) VALUES ('complete', '0');
INSERT OR IGNORE INTO search_meta(key, value) VALUES ('processed', '0');
