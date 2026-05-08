import type { CertificateResult, Env } from './types'
import {
  generateRsaKeyPair,
  importPrivateKeyFromPem,
  keyAuthorizationDigest,
  privateKeyToPem,
  publicJwkFromPrivateKey,
  signRs256,
} from './crypto'
import { createCsr, csrToAcmeBase64, parseCertificateExpiresAt } from './asn1'
import { getAcmeAccount, saveAcmeAccount, saveEvent } from './db'
import { base64url, nowIso } from './utils'

const ACME_PROD_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory'
const ACME_STAGING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/directory'
const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

interface AcmeDirectory {
  newNonce: string
  newAccount: string
  newOrder: string
}

interface AcmeOrder {
  status: string
  authorizations: string[]
  finalize: string
  certificate?: string
  _url: string
}

interface AcmeAuthorization {
  status: string
  identifier: { type: string, value: string }
  challenges: Array<{ type: string, token: string, url: string, status?: string }>
}

interface CloudflareResponse<T> {
  success: boolean
  result: T
  errors?: unknown[]
}

interface AcmeClientState {
  directory: AcmeDirectory
  nonce: string
  accountKey: CryptoKey
  accountJwk: JsonWebKey
  accountUrl: string | null
}

interface ApplyRuntime {
  sleepDns(): Promise<void>
  sleepPoll(name: string): Promise<void>
}

type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error'

async function log(env: Env, domain: string, message: string, level: LogLevel = 'info', step = ''): Promise<void> {
  await saveEvent(env, domain, step, level, message)
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ data: T, response: Response }> {
  const response = await fetch(url, init)
  const text = await response.text()
  let data: T
  try {
    data = text ? JSON.parse(text) as T : {} as T
  } catch {
    throw new Error(`HTTP ${response.status}: ${text || 'empty response'}`)
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`)
  }
  return { data, response }
}

async function getDirectory(staging: boolean): Promise<AcmeDirectory> {
  const { data } = await fetchJson<AcmeDirectory>(staging ? ACME_STAGING_DIRECTORY : ACME_PROD_DIRECTORY)
  return data
}

async function getNonce(directory: AcmeDirectory): Promise<string> {
  const response = await fetch(directory.newNonce, { method: 'HEAD' })
  const nonce = response.headers.get('Replay-Nonce')
  if (!nonce) throw new Error('ACME server did not return a Replay-Nonce')
  return nonce
}

async function loadOrCreateAccountKey(env: Env, domain: string): Promise<{
  key: CryptoKey
  jwk: JsonWebKey
  keyPem: string
  accountUrl: string | null
}> {
  const account = await getAcmeAccount(env, domain)
  if (account?.account_key_pem) {
    const key = await importPrivateKeyFromPem(account.account_key_pem)
    return {
      key,
      jwk: await publicJwkFromPrivateKey(key),
      keyPem: account.account_key_pem,
      accountUrl: account.account_url,
    }
  }

  const keyPair = await generateRsaKeyPair()
  const keyPem = await privateKeyToPem(keyPair.privateKey)
  return {
    key: keyPair.privateKey,
    jwk: await publicJwkFromPrivateKey(keyPair.privateKey),
    keyPem,
    accountUrl: null,
  }
}

async function createAcmeState(env: Env, domain: string, staging: boolean): Promise<AcmeClientState & { keyPem: string }> {
  const directory = await getDirectory(staging)
  const nonce = await getNonce(directory)
  const account = await loadOrCreateAccountKey(env, domain)
  return {
    directory,
    nonce,
    accountKey: account.key,
    accountJwk: account.jwk,
    accountUrl: account.accountUrl,
    keyPem: account.keyPem,
  }
}

async function signJws(state: AcmeClientState, url: string, payload: unknown): Promise<Record<string, string>> {
  const header: Record<string, unknown> = {
    alg: 'RS256',
    nonce: state.nonce,
    url,
  }
  if (state.accountUrl) {
    header.kid = state.accountUrl
  } else {
    header.jwk = state.accountJwk
  }

  const protected64 = base64url(JSON.stringify(header))
  const payload64 = payload === null ? '' : base64url(JSON.stringify(payload))
  const signature = await signRs256(state.accountKey, `${protected64}.${payload64}`)
  return {
    protected: protected64,
    payload: payload64,
    signature: base64url(signature),
  }
}

async function acmePost<T>(state: AcmeClientState, url: string, payload: unknown): Promise<{ data: T, response: Response }> {
  const body = await signJws(state, url, payload)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/jose+json' },
    body: JSON.stringify(body),
  })
  const nonce = response.headers.get('Replay-Nonce')
  if (nonce) state.nonce = nonce
  const text = await response.text()
  let data: T
  try {
    data = text ? JSON.parse(text) as T : {} as T
  } catch {
    data = text as T
  }
  if (!response.ok) {
    throw new Error(`ACME HTTP ${response.status}: ${text}`)
  }
  return { data, response }
}

async function acmePostAsText(state: AcmeClientState, url: string, payload: unknown): Promise<string> {
  const body = await signJws(state, url, payload)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/jose+json' },
    body: JSON.stringify(body),
  })
  const nonce = response.headers.get('Replay-Nonce')
  if (nonce) state.nonce = nonce
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`ACME HTTP ${response.status}: ${text}`)
  }
  return text
}

async function ensureAccount(env: Env, domain: string, state: AcmeClientState & { keyPem: string }): Promise<void> {
  if (state.accountUrl) return
  const { response } = await acmePost(state, state.directory.newAccount, { termsOfServiceAgreed: true })
  state.accountUrl = response.headers.get('Location')
  if (!state.accountUrl) {
    throw new Error('ACME account registration did not return Location header')
  }
  await saveAcmeAccount(env, domain, state.keyPem, state.accountUrl)
}

async function createOrder(state: AcmeClientState, domains: string[]): Promise<AcmeOrder> {
  const identifiers = domains.map(value => ({ type: 'dns', value }))
  const { data, response } = await acmePost<Omit<AcmeOrder, '_url'>>(state, state.directory.newOrder, { identifiers })
  const orderUrl = response.headers.get('Location')
  if (!orderUrl) throw new Error('ACME order did not return Location header')
  return { ...data, _url: orderUrl }
}

async function getAuthorization(state: AcmeClientState, url: string): Promise<AcmeAuthorization> {
  const { data } = await acmePost<AcmeAuthorization>(state, url, null)
  return data
}

async function respondChallenge(state: AcmeClientState, url: string): Promise<void> {
  await acmePost(state, url, {})
}

async function pollStatus<T extends { status?: string }>(
  state: AcmeClientState,
  url: string,
  target: string,
  runtime: ApplyRuntime,
  label: string,
  maxTries = 30,
): Promise<T> {
  for (let i = 0; i < maxTries; i++) {
    const { data } = await acmePost<T>(state, url, null)
    if (data.status === target) return data
    if (data.status && ['invalid', 'expired', 'revoked'].includes(data.status)) {
      throw new Error(`状态异常: ${data.status} - ${JSON.stringify(data)}`)
    }
    await runtime.sleepPoll(`${label}-${i + 1}`)
  }
  throw new Error('轮询超时')
}

async function finalizeOrder(state: AcmeClientState, url: string, csrDer: Uint8Array): Promise<AcmeOrder> {
  const { data } = await acmePost<AcmeOrder>(state, url, { csr: csrToAcmeBase64(csrDer) })
  return data
}

async function downloadCertificate(state: AcmeClientState, url: string): Promise<string> {
  return acmePostAsText(state, url, null)
}

function cfHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

export async function verifyCloudflareToken(token: string): Promise<boolean> {
  const { data } = await fetchJson<CloudflareResponse<unknown>>(`${CF_API_BASE}/user/tokens/verify`, {
    headers: cfHeaders(token),
  })
  return data.success
}

async function getZoneId(domain: string, token: string): Promise<string> {
  const url = new URL(`${CF_API_BASE}/zones`)
  url.searchParams.set('name', domain)
  const { data } = await fetchJson<CloudflareResponse<Array<{ id: string }>>>(url.toString(), {
    headers: cfHeaders(token),
  })
  if (!data.success || !data.result?.length) {
    throw new Error(`未找到域名 ${domain} 的 Zone，请确认域名已添加到 Cloudflare`)
  }
  return data.result[0].id
}

async function createTxtRecord(zoneId: string, name: string, content: string, token: string): Promise<string> {
  const { data } = await fetchJson<CloudflareResponse<{ id: string }>>(`${CF_API_BASE}/zones/${zoneId}/dns_records`, {
    method: 'POST',
    headers: cfHeaders(token),
    body: JSON.stringify({ type: 'TXT', name, content, ttl: 120 }),
  })
  if (!data.success) {
    throw new Error(`创建 DNS 记录失败: ${JSON.stringify(data.errors || data)}`)
  }
  return data.result.id
}

async function deleteTxtRecord(zoneId: string, recordId: string, token: string): Promise<void> {
  await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'DELETE',
    headers: cfHeaders(token),
  })
}

export async function applyCertificate(
  env: Env,
  domain: string,
  cfToken: string,
  staging: boolean,
  runtime: ApplyRuntime,
): Promise<CertificateResult> {
  const domains = [domain, `*.${domain}`]
  const dnsRecords: Array<{ zoneId: string, recordId: string }> = []

  try {
    await log(env, domain, `开始申请证书: ${domains.join(', ')}`, 'info', 'init')

    await log(env, domain, "连接 Let's Encrypt...", 'info', 'init')
    const state = await createAcmeState(env, domain, staging)
    await log(env, domain, '连接成功', 'success', 'init')

    await log(env, domain, '准备 ACME 账户...', 'info', 'account')
    await ensureAccount(env, domain, state)
    await log(env, domain, '账户就绪', 'success', 'account')

    await log(env, domain, '创建证书订单...', 'info', 'order')
    const order = await createOrder(state, domains)
    await log(env, domain, `订单已创建，需验证 ${order.authorizations.length} 个授权`, 'success', 'order')

    await log(env, domain, `查询 Cloudflare Zone: ${domain}`, 'info', 'dns')
    const zoneId = await getZoneId(domain, cfToken)
    await log(env, domain, 'Zone 已找到', 'success', 'dns')

    const challenges: Array<{ authUrl: string, challengeUrl: string, authDomain: string }> = []
    for (const authUrl of order.authorizations) {
      const auth = await getAuthorization(state, authUrl)
      const authDomain = auth.identifier.value.replace(/^\*\./, '')
      const challenge = auth.challenges.find(item => item.type === 'dns-01')
      if (!challenge) {
        throw new Error(`未找到 ${authDomain} 的 dns-01 验证`)
      }

      const txtValue = await keyAuthorizationDigest(challenge.token, state.accountJwk)
      const recordName = `_acme-challenge.${authDomain}`
      await log(env, domain, `添加 DNS 记录: ${recordName}`, 'info', 'dns')
      const recordId = await createTxtRecord(zoneId, recordName, txtValue, cfToken)
      dnsRecords.push({ zoneId, recordId })
      challenges.push({ authUrl, challengeUrl: challenge.url, authDomain })
      await log(env, domain, 'DNS 记录已添加', 'success', 'dns')
    }

    await log(env, domain, '等待 DNS 传播...', 'info', 'propagation')
    await runtime.sleepDns()
    await log(env, domain, 'DNS 传播完成', 'success', 'propagation')

    for (const challenge of challenges) {
      await log(env, domain, `提交验证: ${challenge.authDomain}`, 'info', 'verify')
      await respondChallenge(state, challenge.challengeUrl)
    }

    for (const challenge of challenges) {
      await log(env, domain, `等待验证: ${challenge.authDomain}...`, 'info', 'verify')
      await pollStatus<AcmeAuthorization>(
        state,
        challenge.authUrl,
        'valid',
        runtime,
        `poll-auth-${challenge.authDomain}`,
      )
      await log(env, domain, `${challenge.authDomain} 验证通过`, 'success', 'verify')
    }

    await log(env, domain, '生成证书密钥和 CSR...', 'info', 'generate')
    const { csrDer, keyPem } = await createCsr(domains)
    await log(env, domain, 'CSR 已生成', 'success', 'generate')

    await log(env, domain, '提交订单完成请求...', 'info', 'finalize')
    let result = await finalizeOrder(state, order.finalize, csrDer)
    if (result.status !== 'valid') {
      result = await pollStatus<AcmeOrder>(state, order._url, 'valid', runtime, 'poll-order')
    }
    if (!result.certificate) {
      throw new Error('ACME 订单没有返回证书下载地址')
    }

    await log(env, domain, '下载证书...', 'info', 'finalize')
    const fullchainPem = await downloadCertificate(state, result.certificate)
    await log(env, domain, '证书已下载', 'success', 'finalize')

    const issuedAt = nowIso()
    const expiresAt = parseCertificateExpiresAt(fullchainPem)
      || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    const metadata = {
      domain,
      domains,
      issued_at: issuedAt,
      expires_at: expiresAt,
      acme_directory: staging ? ACME_STAGING_DIRECTORY : ACME_PROD_DIRECTORY,
    }

    return {
      fullchainPem,
      privkeyPem: keyPem,
      metadata,
      issuedAt,
      expiresAt,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await log(env, domain, `申请失败: ${message}`, 'error', 'error')
    throw error
  } finally {
    if (dnsRecords.length) {
      await log(env, domain, '清理 DNS 记录...', 'info', 'cleanup')
      for (const record of dnsRecords) {
        try {
          await deleteTxtRecord(record.zoneId, record.recordId, cfToken)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await log(env, domain, `清理失败: ${message}`, 'warn', 'cleanup')
        }
      }
      await log(env, domain, 'DNS 记录已清理', 'success', 'cleanup')
    }
  }
}
