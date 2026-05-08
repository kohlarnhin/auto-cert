import { readFileSync, writeFileSync } from 'node:fs'

function requireEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

const d1DatabaseId = requireEnv('CLOUDFLARE_D1_DATABASE_ID')
const encryptionKey = requireEnv('ENCRYPTION_KEY')
const r2BucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME?.trim() || 'auto-cert'
const r2PublicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim() || ''

const wrangler = readFileSync('wrangler.toml.example', 'utf8')
  .replaceAll('__D1_DATABASE_ID__', d1DatabaseId)
  .replaceAll('__R2_BUCKET_NAME__', r2BucketName)
  .replaceAll('__R2_PUBLIC_BASE_URL__', r2PublicBaseUrl)

writeFileSync('wrangler.toml', wrangler)
writeFileSync('.secrets.json', JSON.stringify({ ENCRYPTION_KEY: encryptionKey }))

console.log('Generated wrangler.toml and .secrets.json for Cloudflare deploy')
