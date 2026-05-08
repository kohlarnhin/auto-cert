export type CertStatus = 'none' | 'pending' | 'valid' | 'error'

export interface ApplyParams {
  domain: string
  staging: boolean
}

interface WorkflowBinding<T> {
  create(options?: { id?: string, params?: T }): Promise<{ id: string }>
}

export interface Env {
  DB: D1Database
  CERT_BUCKET: R2Bucket
  CERTIFICATE_WORKFLOW: WorkflowBinding<ApplyParams>
  ENCRYPTION_KEY: string
  R2_KEY_PREFIX?: string
  R2_PUBLIC_BASE_URL?: string
  CORS_ORIGINS?: string
}

export interface CertRow {
  domain: string
  wildcard_domain: string
  password_hash: string
  cf_token: string
  fullchain_key: string | null
  privkey_key: string | null
  metadata_key: string | null
  status: CertStatus
  issued_at: string | null
  expires_at: string | null
  created_at: string
}

export interface AcmeAccountRow {
  domain: string
  account_key_pem: string
  account_url: string | null
  created_at: string
  updated_at: string
}

export interface ApplyEvent {
  id?: number
  domain: string
  step: string
  level: 'debug' | 'info' | 'success' | 'warn' | 'error'
  message: string
  created_at?: string
  time?: string
}

export interface CertificateResult {
  fullchainPem: string
  privkeyPem: string
  metadata: Record<string, unknown>
  issuedAt: string
  expiresAt: string
}
