ALTER TABLE price_observations ADD COLUMN source TEXT CHECK(source IS NULL OR json_valid(source));

CREATE TABLE price_provider_usage (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL CHECK(requests > 0)
);
