CREATE TABLE collection_shares (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  revoked_at TEXT
);
CREATE TABLE collection_share_items (
  collection_id TEXT NOT NULL REFERENCES collection_shares(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  photo_key TEXT,
  source_photo_id TEXT REFERENCES attachments(id),
  PRIMARY KEY(collection_id, position),
  UNIQUE(collection_id, item_id)
);
CREATE INDEX collection_share_item ON collection_share_items(item_id);
