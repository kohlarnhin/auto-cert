import { WorkflowEntrypoint } from 'cloudflare:workers'
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers'
import type { ApplyEvent, ApplyParams, CertRow, Env } from './types'
import { applyCertificate, verifyCloudflareToken } from './acme'
import {
  createCertRecord,
  getCert,
  getCertWithToken,
  getEventsAfter,
  getMaxEventId,
  getPendingDomain,
  initDb,
  saveEvent,
  updateCert,
  verifyDomainAuth,
} from './db'
import {
  certUrlPayload,
  deleteCertificateFiles,
  getCertificateFiles,
  saveCertificate,
} from './storage'
import {
  corsHeaders,
  errorResponse,
  httpError,
  jsonResponse,
  normalizeDomain,
  readJson,
  sha256Hex,
  sleep,
  validateRootDomain,
} from './utils'
import { createZip } from './zip'

type RegisterRequest = {
  domain?: string
  password?: string
  cf_token?: string
}

type ApplyRequest = RegisterRequest & {
  staging?: boolean
}

export class CertificateWorkflow extends WorkflowEntrypoint<Env, ApplyParams> {
  async run(event: WorkflowEvent<ApplyParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload
    const domain = validateRootDomain(params.domain)
    const staging = Boolean(params.staging)
    await initDb(this.env)

    try {
      await step.do('load-domain-config', async () => {
        const cert = await getCertWithToken(this.env, domain)
        if (!cert) throw new Error(`Domain is not registered: ${domain}`)
      })

      const cert = await getCertWithToken(this.env, domain)
      if (!cert) throw new Error(`Domain is not registered: ${domain}`)

      const result = await applyCertificate(
        this.env,
        domain,
        cert.cf_token,
        staging,
        {
          sleepDns: () => step.sleep('wait-dns-propagation', '30 seconds'),
          sleepPoll: (name: string) => step.sleep(name, '3 seconds'),
        },
      )

      const keys = await step.do('save-certificate-to-r2-and-d1', async () => {
        const savedKeys = await saveCertificate(
          this.env,
          domain,
          result.fullchainPem,
          result.privkeyPem,
          result.metadata,
        )
        await updateCert(this.env, domain, {
          fullchain_key: savedKeys.fullchain_key,
          privkey_key: savedKeys.privkey_key,
          metadata_key: savedKeys.metadata_key,
          status: 'valid',
          issued_at: result.issuedAt,
          expires_at: result.expiresAt,
        })
        return savedKeys
      })

      if (!keys.fullchain_key || !keys.privkey_key) {
        throw new Error('Certificate object keys were not saved')
      }

      await saveEvent(
        this.env,
        domain,
        'complete',
        'success',
        `证书申请成功！有效期至 ${result.expiresAt.slice(0, 10)}`,
      )
    } catch (error) {
      await updateCert(this.env, domain, { status: 'error' })
      const message = error instanceof Error ? error.message : String(error)
      await saveEvent(this.env, domain, 'error', 'error', `申请失败: ${message}`)
      throw error
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) })
    }

    try {
      await initDb(env)
      return await routeRequest(request, env)
    } catch (error) {
      return errorResponse(request, env, error)
    }
  },
}

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname

  if (request.method === 'GET' && path === '/api/status') {
    return handleStatus(request, env)
  }

  if (request.method === 'GET' && path === '/api/logs') {
    return handleLogs(request, env)
  }

  if (request.method === 'GET' && path.startsWith('/api/cert/exists/')) {
    return handleExists(request, env, rest(path, '/api/cert/exists/'))
  }

  if (request.method === 'POST' && path === '/api/cert/register') {
    return handleRegister(request, env)
  }

  if (request.method === 'POST' && path === '/api/cert/apply') {
    return handleApply(request, env)
  }

  if (request.method === 'GET' && path.startsWith('/api/cert/check/')) {
    return handleCheck(request, env, rest(path, '/api/cert/check/'))
  }

  if (request.method === 'GET' && path.startsWith('/api/cert/download/')) {
    return handleDownload(request, env, rest(path, '/api/cert/download/'))
  }

  if (request.method === 'POST' && path.startsWith('/api/cert/urls/')) {
    return handleUrls(request, env, rest(path, '/api/cert/urls/'))
  }

  if (request.method === 'DELETE' && path.startsWith('/api/cert/')) {
    return handleDelete(request, env, rest(path, '/api/cert/'))
  }

  throw httpError(404, '接口不存在')
}

function rest(path: string, prefix: string): string {
  return decodeURIComponent(path.slice(prefix.length))
}

function passwordFromHeader(request: Request): string {
  return request.headers.get('X-Domain-Password') || ''
}

async function handleStatus(request: Request, env: Env): Promise<Response> {
  return jsonResponse(request, env, { applying: Boolean(await getPendingDomain(env)) })
}

async function handleExists(request: Request, env: Env, rawDomain: string): Promise<Response> {
  const domain = validateRootDomain(rawDomain)
  return jsonResponse(request, env, { exists: Boolean(await getCert(env, domain)) })
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await readJson<RegisterRequest>(request)
  const domain = validateRootDomain(body.domain || '')
  const password = body.password || ''
  const cfToken = body.cf_token || ''
  if (!password) throw httpError(400, '需要提供访问密码')
  if (!cfToken) throw httpError(400, '需要提供 Cloudflare API Token')
  if (await getCert(env, domain)) throw httpError(409, '该域名已注册')

  await ensureCloudflareToken(cfToken)

  await createCertRecord(env, domain, password, cfToken)
  return jsonResponse(request, env, { success: true, message: `${domain} 已注册，可以开始签发` })
}

async function handleApply(request: Request, env: Env): Promise<Response> {
  const body = await readJson<ApplyRequest>(request)
  const domain = validateRootDomain(body.domain || '')
  const password = body.password || ''
  const staging = Boolean(body.staging)

  const pending = await getPendingDomain(env)
  if (pending && pending !== domain) {
    throw httpError(409, '正在申请中，请等待当前任务完成')
  }

  let cert = await getCertWithToken(env, domain)
  if (cert) {
    const authed = await verifyDomainAuth(env, domain, password)
    cert = { ...cert, password_hash: authed.password_hash }
    if (cert.status === 'pending') {
      throw httpError(409, '该域名正在申请中，请等待当前任务完成')
    }
    if (cert.status === 'valid' && cert.expires_at) {
      const daysLeft = Math.floor((new Date(cert.expires_at).getTime() - Date.now()) / 86400000)
      if (daysLeft > 10) {
        throw httpError(409, `*.${domain} 已有有效证书（还剩 ${daysLeft} 天过期），无需重新申请`)
      }
    }
  } else {
    const cfToken = body.cf_token || ''
    if (!password) throw httpError(400, '新域名注册需要提供访问密码')
    if (!cfToken) throw httpError(400, '新域名注册需要提供 Cloudflare API Token')
    await ensureCloudflareToken(cfToken)
    await createCertRecord(env, domain, password, cfToken)
    cert = await getCertWithToken(env, domain)
  }

  if (!cert) {
    throw httpError(404, '域名未注册')
  }

  await updateCert(env, domain, { status: 'pending', created_at: new Date().toISOString() })
  await saveEvent(env, domain, 'init', 'info', '任务已提交，等待 Cloudflare Workflow 执行')

  try {
    const id = `cert-${(await sha256Hex(`${domain}:${Date.now()}`)).slice(0, 18)}`
    await env.CERTIFICATE_WORKFLOW.create({
      id,
      params: { domain, staging },
    })
  } catch (error) {
    await updateCert(env, domain, { status: 'error' })
    throw error
  }

  return jsonResponse(request, env, { success: true, message: `已开始申请 *.${domain} 证书` })
}

async function ensureCloudflareToken(token: string): Promise<void> {
  try {
    if (!await verifyCloudflareToken(token)) {
      throw httpError(400, 'Cloudflare API Token 无效')
    }
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw httpError(400, `Token 验证失败: ${message}`)
  }
}

async function handleCheck(request: Request, env: Env, rawDomain: string): Promise<Response> {
  const domain = normalizeDomain(rawDomain)
  const cert = await verifyDomainAuth(env, domain, passwordFromHeader(request))
  return jsonResponse(request, env, certPayload(env, domain, cert))
}

async function handleUrls(request: Request, env: Env, rawDomain: string): Promise<Response> {
  const domain = normalizeDomain(rawDomain)
  const cert = await verifyDomainAuth(env, domain, passwordFromHeader(request))
  if (cert.status !== 'valid' || !cert.fullchain_key || !cert.privkey_key) {
    throw httpError(404, '证书不存在或尚未签发')
  }
  return jsonResponse(request, env, certUrlPayload(env, domain, cert.fullchain_key, cert.privkey_key))
}

async function handleDelete(request: Request, env: Env, rawDomain: string): Promise<Response> {
  const domain = normalizeDomain(rawDomain)
  const cert = await verifyDomainAuth(env, domain, passwordFromHeader(request))
  await deleteCertificateFiles(env, cert.fullchain_key, cert.privkey_key, cert.metadata_key)
  await updateCert(env, domain, {
    fullchain_key: null,
    privkey_key: null,
    metadata_key: null,
    status: 'none',
    issued_at: null,
    expires_at: null,
  })
  return jsonResponse(request, env, { success: true, message: '证书已删除' })
}

async function handleDownload(request: Request, env: Env, rawDomain: string): Promise<Response> {
  const domain = normalizeDomain(rawDomain)
  const cert = await verifyDomainAuth(env, domain, passwordFromHeader(request))
  if (cert.status !== 'valid' || !cert.fullchain_key || !cert.privkey_key) {
    throw httpError(404, '证书不存在或尚未签发')
  }

  const files = await getCertificateFiles(env, cert.fullchain_key, cert.privkey_key)
  if (!files) {
    throw httpError(404, '证书文件不存在')
  }

  const chainParts = files.fullchainPem
    .split('-----END CERTIFICATE-----')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => `${part}\n-----END CERTIFICATE-----\n`)

  const zip = createZip([
    { name: `${domain}/fullchain.cer`, data: files.fullchainPem },
    { name: `${domain}/${domain}.key`, data: files.privkeyPem },
    ...(chainParts[0] ? [{ name: `${domain}/${domain}.cer`, data: chainParts[0] }] : []),
    ...(chainParts.length > 1 ? [{ name: `${domain}/ca.cer`, data: chainParts.slice(1).join('') }] : []),
  ])

  return new Response(zip, {
    headers: {
      ...corsHeaders(request, env),
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${domain}.zip"`,
    },
  })
}

function certPayload(env: Env, domain: string, cert: CertRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    status: cert.status,
    expires_at: cert.expires_at,
  }
  if (cert.status === 'valid' && cert.fullchain_key && cert.privkey_key) {
    Object.assign(payload, certUrlPayload(env, domain, cert.fullchain_key, cert.privkey_key))
  }
  return payload
}

async function handleLogs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const domain = url.searchParams.get('domain')
    ? validateRootDomain(url.searchParams.get('domain') || '')
    : undefined
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let lastId = Number(request.headers.get('Last-Event-ID') || 0)
      if (!lastId) {
        lastId = await getMaxEventId(env, domain)
      }

      let closed = false
      request.signal?.addEventListener('abort', () => {
        closed = true
        try {
          controller.close()
        } catch {
          /* Already closed. */
        }
      })

      for (let i = 0; i < 55 && !closed; i++) {
        const events = await getEventsAfter(env, lastId, domain)
        for (const event of events) {
          if (typeof event.id === 'number') lastId = event.id
          controller.enqueue(encoder.encode(formatSseEvent(event)))
        }
        if (!events.length) {
          controller.enqueue(encoder.encode(': keepalive\n\n'))
        }
        await sleep(1000)
      }

      if (!closed) {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      ...corsHeaders(request, env),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  })
}

function formatSseEvent(event: ApplyEvent): string {
  const created = event.created_at ? new Date(event.created_at) : new Date()
  const payload = {
    domain: event.domain,
    step: event.step,
    level: event.level,
    message: event.message,
    time: created.toISOString().slice(11, 19),
  }
  const id = typeof event.id === 'number' ? `id: ${event.id}\n` : ''
  return `${id}data: ${JSON.stringify(payload)}\n\n`
}
