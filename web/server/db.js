'use strict';
// One tiny interface over two Postgres drivers:
//   - production / any DATABASE_URL: node-postgres pool
//   - local dev and tests (no DATABASE_URL): PGlite, an in-process Postgres
// Both speak the same SQL, so the app has a single code path.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hash text NOT NULL,
  ip text NOT NULL DEFAULT '',
  attempts int NOT NULL DEFAULT 0,
  used boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otps_email_created ON otps (email, created_at DESC);
CREATE INDEX IF NOT EXISTS otps_ip_created ON otps (ip, created_at DESC);
CREATE TABLE IF NOT EXISTS orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user ON memberships (user_id);
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_org_id uuid REFERENCES orgs(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','member','viewer')),
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);
CREATE INDEX IF NOT EXISTS invites_email ON invites (email);
CREATE TABLE IF NOT EXISTS briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title text NOT NULL,
  agent text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS briefs_org ON briefs (org_id, created_at DESC);
CREATE TABLE IF NOT EXISTS audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_org ON audit (org_id, created_at DESC);
`;

async function createDb({ url, dataDir } = {}) {
  let db;
  if (url) {
    const { Pool } = require('pg');
    const local = /(@|\/\/)(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(url);
    const ssl = process.env.PGSSL === 'disable' || local ? false : { rejectUnauthorized: false };
    const pool = new Pool({ connectionString: url, ssl, max: Number(process.env.PG_POOL_MAX || 10) });
    pool.on('error', (e) => console.error('[db] idle client error', e.message));
    db = {
      kind: 'pg',
      query: async (text, params) => (await pool.query(text, params)).rows,
      exec: (sql) => pool.query(sql),
      close: () => pool.end(),
    };
  } else {
    let PGlite;
    try {
      ({ PGlite } = await import('@electric-sql/pglite'));
    } catch {
      throw new Error('DATABASE_URL is not set and the local dev database (@electric-sql/pglite) is not installed.');
    }
    const pg = new PGlite(dataDir || 'memory://');
    await pg.waitReady;
    db = {
      kind: 'pglite',
      query: async (text, params) => (await pg.query(text, params)).rows,
      exec: (sql) => pg.exec(sql),
      close: () => pg.close(),
    };
  }
  await db.exec(SCHEMA);
  return db;
}

module.exports = { createDb };
