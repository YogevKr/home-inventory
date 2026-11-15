CREATE TABLE item_shares (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  photo_key TEXT,
  source_photo_id TEXT REFERENCES attachments(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX item_share_active ON item_shares(item_id) WHERE revoked_at IS NULL;
