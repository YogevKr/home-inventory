CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  parent_id TEXT REFERENCES locations(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX locations_parent ON locations(parent_id);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data)),
  name TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) STORED,
  location_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.locationId')) STORED REFERENCES locations(id),
  status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) STORED,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX items_location ON items(location_id);
CREATE INDEX items_status_updated ON items(status, updated_at DESC);
CREATE INDEX items_name ON items(name COLLATE NOCASE);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  before_data TEXT,
  after_data TEXT,
  revision INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX activity_item ON activity(item_id, id DESC);

CREATE TRIGGER items_created AFTER INSERT ON items BEGIN
  INSERT INTO activity(item_id,actor,action,after_data,revision)
  VALUES(NEW.id,NEW.updated_by,NEW.action,NEW.data,NEW.revision);
END;
CREATE TRIGGER items_updated AFTER UPDATE ON items BEGIN
  INSERT INTO activity(item_id,actor,action,before_data,after_data,revision)
  VALUES(NEW.id,NEW.updated_by,NEW.action,OLD.data,NEW.data,NEW.revision);
END;

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
  author TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX comments_item ON comments(item_id,created_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('photo','receipt','manual','document')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX attachments_item ON attachments(item_id,created_at);

INSERT INTO locations(id,name) VALUES('00000000-0000-4000-8000-000000000001','Home');
