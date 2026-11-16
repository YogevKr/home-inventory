CREATE TABLE price_observations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  product_url TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK(price_minor > 0 AND price_minor <= 1000000000000),
  currency TEXT NOT NULL CHECK(currency IN ('ILS','USD','EUR','GBP')),
  method TEXT NOT NULL CHECK(method IN ('page','recorded')),
  actor TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX price_observations_item ON price_observations(item_id,product_url,currency,sequence DESC);

CREATE TABLE price_checks (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL,
  product_url TEXT NOT NULL,
  currency TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  error TEXT
);
