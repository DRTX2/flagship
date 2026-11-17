CREATE TABLE environments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL UNIQUE,
  name           text NOT NULL,
  sdk_key_hash   text UNIQUE,     -- sha256; the raw key is shown once on creation/rotation
  sdk_key_hint   text,            -- last 4 chars, for display
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  kind        text NOT NULL CHECK (kind IN ('boolean', 'string', 'number', 'json')),
  variations  jsonb NOT NULL,     -- immutable after creation: rules reference variations by index
  salt        text NOT NULL,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flag_configs (
  flag_id       uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  env_id        uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT false,
  off_variation int NOT NULL,
  fallthrough   jsonb NOT NULL,
  rules         jsonb NOT NULL DEFAULT '[]',
  version       int NOT NULL DEFAULT 1,  -- optimistic concurrency + SDK change ordering
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flag_id, env_id)
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  flag_key   text NOT NULL,
  env_key    text,
  actor      text NOT NULL,
  action     text NOT NULL,
  before     jsonb,
  after      jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_flag_idx ON audit_log(flag_key, created_at DESC);

INSERT INTO environments (key, name) VALUES ('development', 'Development'), ('production', 'Production');
