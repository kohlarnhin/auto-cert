import type { AcmeAccountRow, ApplyEvent, CertRow, CertStatus, Env } from './types'
import { decryptText, encryptText } from './crypto'
import { httpError, nowIso, sha256Hex } from './utils'

const SCHEMA_STATEMENTS = [
  `
CREATE TABLE IF NOT EXISTS certificates (
  domain          TEXT PRIMARY KEY,
  wildcard_domain TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  cf_token        TEXT NOT NULL,
  fullchain_key   TEXT,
  privkey_key     TEXT,
  metadata_key    TEXT,
  status          TEXT NOT NULL DEFAULT 'none',
  issued_at       TEXT,
  expires_at      TEXT,
  created_at      TEXT NOT NULL
)
`,
  `
CREATE TABLE IF NOT EXISTS acme_accounts (
  domain          TEXT PRIMARY KEY,
  account_key_pem TEXT NOT NULL,
  account_url     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
)
`,
  `
CREATE TABLE IF NOT EXISTS apply_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  domain     TEXT NOT NULL,
  step       TEXT NOT NULL,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
)
`,
  'CREATE INDEX IF NOT EXISTS idx_certificates_status ON certificates(status)',
  'CREATE INDEX IF NOT EXISTS idx_apply_events_domain_id ON apply_events(domain, id)',
]

let initPromise: Promise<void> | null = null

export function initDb(env: Env): Promise<void> {
  if (!initPromise) {
    initPromise = createSchema(env).catch((error) => {
      initPromise = null
      throw error
    })
  }
  return initPromise
}

async function createSchema(env: Env): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await env.DB.prepare(statement).run()
  }
}

export async function hashPassword(password: string): Promise<string> {
  return sha256Hex(password)
}

export async function getCert(env: Env, domain: string): Promise<CertRow | null> {
  return env.DB.prepare('SELECT * FROM certificates WHERE domain = ?')
    .bind(domain)
    .first<CertRow>()
}

export async function getCertWithToken(env: Env, domain: string): Promise<CertRow | null> {
  const cert = await getCert(env, domain)
  if (!cert) return null
  return { ...cert, cf_token: await decryptText(env, cert.cf_token) }
}

export async function verifyDomainAuth(env: Env, domain: string, password: string): Promise<CertRow> {
  const cert = await getCert(env, domain)
  if (!cert) {
    throw httpError(404, '域名未注册')
  }
  const expected = await hashPassword(password || '')
  if (cert.password_hash !== expected) {
    throw httpError(401, '访问密码错误')
  }
  return cert
}

export async function createCertRecord(
  env: Env,
  domain: string,
  password: string,
  cfToken: string,
): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO certificates (
        domain, wildcard_domain, password_hash, cf_token, status, created_at
      ) VALUES (?, ?, ?, ?, 'none', ?)
    `)
      .bind(
        domain,
        `*.${domain}`,
        await hashPassword(password),
        await encryptText(env, cfToken),
        nowIso(),
      )
      .run()
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (message.includes('unique') || message.includes('constraint')) {
      throw httpError(409, '该域名已注册')
    }
    throw error
  }
}

const CERT_COLUMNS = new Set([
  'wildcard_domain',
  'password_hash',
  'cf_token',
  'fullchain_key',
  'privkey_key',
  'metadata_key',
  'status',
  'issued_at',
  'expires_at',
  'created_at',
])

export async function updateCert(
  env: Env,
  domain: string,
  values: Partial<Omit<CertRow, 'domain'>>,
): Promise<void> {
  const entries = Object.entries(values)
  if (!entries.length) return
  for (const [key] of entries) {
    if (!CERT_COLUMNS.has(key)) {
      throw new Error(`Unsupported certificate column: ${key}`)
    }
  }

  const sets: string[] = []
  const params: unknown[] = []
  for (const [key, rawValue] of entries) {
    if (rawValue === null || typeof rawValue === 'undefined') {
      sets.push(`${key} = NULL`)
    } else {
      sets.push(`${key} = ?`)
      params.push(key === 'cf_token' ? await encryptText(env, String(rawValue)) : rawValue)
    }
  }
  params.push(domain)
  await env.DB.prepare(`UPDATE certificates SET ${sets.join(', ')} WHERE domain = ?`)
    .bind(...params)
    .run()
}

export async function getPendingDomain(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT domain FROM certificates WHERE status = 'pending' LIMIT 1")
    .first<{ domain: string }>()
  return row?.domain || null
}

export async function getAcmeAccount(env: Env, domain: string): Promise<AcmeAccountRow | null> {
  const row = await env.DB.prepare(`
    SELECT domain, account_key_pem, account_url, created_at, updated_at
    FROM acme_accounts
    WHERE domain = ?
  `)
    .bind(domain)
    .first<AcmeAccountRow>()
  if (!row) return null
  return { ...row, account_key_pem: await decryptText(env, row.account_key_pem) }
}

export async function saveAcmeAccount(
  env: Env,
  domain: string,
  accountKeyPem: string,
  accountUrl: string | null,
): Promise<void> {
  const now = nowIso()
  await env.DB.prepare(`
    INSERT INTO acme_accounts (
      domain, account_key_pem, account_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET
      account_key_pem = excluded.account_key_pem,
      account_url = excluded.account_url,
      updated_at = excluded.updated_at
  `)
    .bind(domain, await encryptText(env, accountKeyPem), accountUrl, now, now)
    .run()
}

export async function saveEvent(
  env: Env,
  domain: string,
  step: string,
  level: ApplyEvent['level'],
  message: string,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO apply_events (domain, step, level, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
    .bind(domain, step, level, message, nowIso())
    .run()
}

export async function getMaxEventId(env: Env, domain?: string): Promise<number> {
  const query = domain
    ? env.DB.prepare('SELECT MAX(id) AS id FROM apply_events WHERE domain = ?').bind(domain)
    : env.DB.prepare('SELECT MAX(id) AS id FROM apply_events')
  const row = await query.first<{ id: number | null }>()
  return Number(row?.id || 0)
}

export async function getEventsAfter(
  env: Env,
  afterId: number,
  domain?: string,
): Promise<ApplyEvent[]> {
  const query = domain
    ? env.DB.prepare(`
        SELECT id, domain, step, level, message, created_at
        FROM apply_events
        WHERE domain = ? AND id > ?
        ORDER BY id ASC
        LIMIT 100
      `).bind(domain, afterId)
    : env.DB.prepare(`
        SELECT id, domain, step, level, message, created_at
        FROM apply_events
        WHERE id > ?
        ORDER BY id ASC
        LIMIT 100
      `).bind(afterId)
  const rows = await query.all<ApplyEvent>()
  return rows.results || []
}

export function isValidStatus(value: string | null | undefined): value is CertStatus {
  return value === 'none' || value === 'pending' || value === 'valid' || value === 'error'
}
