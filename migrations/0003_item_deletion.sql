CREATE TABLE deleted_items (
  id TEXT PRIMARY KEY,
  file_ids TEXT NOT NULL CHECK(json_valid(file_ids)),
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
