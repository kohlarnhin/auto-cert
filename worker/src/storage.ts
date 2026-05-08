import type { Env } from './types'

export function objectKey(env: Env, key: string): string {
  const cleanKey = key.replace(/^\/+/, '')
  const prefix = (env.R2_KEY_PREFIX || '').trim().replace(/^\/+|\/+$/g, '')
  return prefix ? `${prefix}/${cleanKey}` : cleanKey
}

export function certificateKeys(domain: string): Record<'fullchain_key' | 'privkey_key' | 'metadata_key', string> {
  const base = `certificates/${domain}`
  return {
    fullchain_key: `${base}/fullchain.cer`,
    privkey_key: `${base}/${domain}.key`,
    metadata_key: `${base}/metadata.json`,
  }
}

export function publicUrl(env: Env, key: string): string {
  const base = (env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/+$/g, '')
  const path = objectKey(env, key).split('/').map(encodeURIComponent).join('/')
  return base ? `${base}/${path}` : path
}

export function certUrlPayload(env: Env, domain: string, fullchainKey: string, privkeyKey: string) {
  return {
    fullchain_name: 'fullchain.cer',
    privkey_name: `${domain}.key`,
    fullchain_url: publicUrl(env, fullchainKey),
    privkey_url: publicUrl(env, privkeyKey),
  }
}

export async function saveCertificate(
  env: Env,
  domain: string,
  fullchainPem: string,
  privkeyPem: string,
  metadata: Record<string, unknown>,
): Promise<Record<'fullchain_key' | 'privkey_key' | 'metadata_key', string>> {
  const keys = certificateKeys(domain)
  await Promise.all([
    env.CERT_BUCKET.put(objectKey(env, keys.fullchain_key), fullchainPem, {
      httpMetadata: { contentType: 'application/x-pem-file' },
    }),
    env.CERT_BUCKET.put(objectKey(env, keys.privkey_key), privkeyPem, {
      httpMetadata: { contentType: 'application/x-pem-file' },
    }),
    env.CERT_BUCKET.put(objectKey(env, keys.metadata_key), JSON.stringify(metadata, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    }),
  ])
  return keys
}

export async function getCertificateFiles(
  env: Env,
  fullchainKey: string,
  privkeyKey: string,
): Promise<{ fullchainPem: string, privkeyPem: string } | null> {
  const [fullchainObj, privkeyObj] = await Promise.all([
    env.CERT_BUCKET.get(objectKey(env, fullchainKey)),
    env.CERT_BUCKET.get(objectKey(env, privkeyKey)),
  ])
  if (!fullchainObj || !privkeyObj) return null
  const [fullchainPem, privkeyPem] = await Promise.all([
    fullchainObj.text(),
    privkeyObj.text(),
  ])
  return { fullchainPem, privkeyPem }
}

export async function deleteCertificateFiles(env: Env, ...keys: Array<string | null | undefined>): Promise<void> {
  const objectKeys = keys.filter((key): key is string => Boolean(key)).map(key => objectKey(env, key))
  if (objectKeys.length) {
    await env.CERT_BUCKET.delete(objectKeys)
  }
}
