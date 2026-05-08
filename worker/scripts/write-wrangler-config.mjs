import { mkdirSync, writeFileSync } from 'node:fs'

function requireEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

const d1DatabaseId = requireEnv('CLOUDFLARE_D1_DATABASE_ID')
const encryptionKey = requireEnv('ENCRYPTION_KEY')
const workerName = process.env.WORKER_NAME?.trim() || 'auto-cert-api'
const compatibilityDate = process.env.WORKER_COMPATIBILITY_DATE?.trim() || '2026-05-08'
const d1DatabaseName = process.env.CLOUDFLARE_D1_DATABASE_NAME?.trim() || 'auto-cert'
const r2BucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME?.trim() || 'auto-cert'
const r2KeyPrefix = process.env.R2_KEY_PREFIX?.trim() || 'auto-cert'
const corsOrigins = process.env.CORS_ORIGINS?.trim() || '*'
const r2PublicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim()
const workflowName = process.env.CERTIFICATE_WORKFLOW_NAME?.trim() || 'auto-cert-certificate-workflow'

function tomlString(value) {
  return JSON.stringify(value)
}

const vars = [
  ['R2_KEY_PREFIX', r2KeyPrefix],
  ['CORS_ORIGINS', corsOrigins],
]

if (r2PublicBaseUrl) {
  vars.push(['R2_PUBLIC_BASE_URL', r2PublicBaseUrl])
}

const wrangler = `name = ${tomlString(workerName)}
main = "src/index.ts"
compatibility_date = ${tomlString(compatibilityDate)}
keep_vars = true

[vars]
${vars.map(([key, value]) => `${key} = ${tomlString(value)}`).join('\n')}

[secrets]
required = ["ENCRYPTION_KEY"]

[[d1_databases]]
binding = "DB"
database_name = ${tomlString(d1DatabaseName)}
database_id = ${tomlString(d1DatabaseId)}

[[r2_buckets]]
binding = "CERT_BUCKET"
bucket_name = ${tomlString(r2BucketName)}

[[workflows]]
name = ${tomlString(workflowName)}
binding = "CERTIFICATE_WORKFLOW"
class_name = "CertificateWorkflow"
`

mkdirSync('.wrangler', { recursive: true })
writeFileSync('wrangler.toml', wrangler)
writeFileSync('.wrangler/generated-secrets.json', JSON.stringify({ ENCRYPTION_KEY: encryptionKey }))
console.log('Generated wrangler.toml from environment')
