import type { Env } from './types'
import { base64ToBytes, base64url, bytesToBase64, fromUtf8, sha256Bytes, utf8 } from './utils'

const ENCRYPTION_PREFIX = 'enc:v1:'

async function encryptionKey(env: Env): Promise<CryptoKey> {
  if (!env.ENCRYPTION_KEY) {
    throw new Error('Missing required Worker secret: ENCRYPTION_KEY')
  }
  const raw = base64ToBytes(env.ENCRYPTION_KEY)
  if (raw.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be a 32-byte base64 or base64url value')
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptText(env: Env, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await encryptionKey(env)
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(value)))
  return `${ENCRYPTION_PREFIX}${base64url(iv)}:${base64url(encrypted)}`
}

export async function decryptText(env: Env, value: string | null): Promise<string> {
  if (!value) return ''
  if (!value.startsWith(ENCRYPTION_PREFIX)) {
    return value
  }
  const [ivPart, cipherPart] = value.slice(ENCRYPTION_PREFIX.length).split(':')
  if (!ivPart || !cipherPart) {
    throw new Error('Encrypted value is malformed')
  }
  const key = await encryptionKey(env)
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivPart) },
    key,
    base64ToBytes(cipherPart),
  ))
  return fromUtf8(plain)
}

export async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>
}

export async function importPrivateKeyFromPem(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
  return crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(body),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['sign'],
  )
}

export async function privateKeyToPem(key: CryptoKey): Promise<string> {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key) as ArrayBuffer)
  const b64 = bytesToBase64(pkcs8)
  const lines = b64.match(/.{1,64}/g) || []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`
}

export async function publicJwkFromPrivateKey(key: CryptoKey): Promise<JsonWebKey> {
  const jwk = await crypto.subtle.exportKey('jwk', key) as JsonWebKey
  if (!jwk.n || !jwk.e) {
    throw new Error('RSA key export did not include public parameters')
  }
  return { e: jwk.e, kty: 'RSA', n: jwk.n }
}

export async function publicJwkFromPublicKey(key: CryptoKey): Promise<JsonWebKey> {
  const jwk = await crypto.subtle.exportKey('jwk', key) as JsonWebKey
  if (!jwk.n || !jwk.e) {
    throw new Error('RSA public key export did not include public parameters')
  }
  return { e: jwk.e, kty: 'RSA', n: jwk.n }
}

export async function signRs256(key: CryptoKey, data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? utf8(data) : data
  return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, bytes))
}

export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  if (!jwk.e || !jwk.n) {
    throw new Error('JWK is missing RSA public parameters')
  }
  const normalized = `{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`
  return base64url(await sha256Bytes(normalized))
}

export async function keyAuthorizationDigest(token: string, jwk: JsonWebKey): Promise<string> {
  const thumbprint = await jwkThumbprint(jwk)
  return base64url(await sha256Bytes(`${token}.${thumbprint}`))
}
