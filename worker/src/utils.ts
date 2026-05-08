import type { Env } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function utf8(value: string): Uint8Array {
  return encoder.encode(value)
}

export function fromUtf8(value: Uint8Array): string {
  return decoder.decode(value)
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=')
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function base64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? utf8(data) : data
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export async function sha256Bytes(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? utf8(data) : data
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

export async function sha256Hex(value: string): Promise<string> {
  const hash = await sha256Bytes(value)
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function normalizeDomain(domain: string): string {
  return decodeURIComponent(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '')
    .replace(/\.+$/g, '')
}

export function validateRootDomain(domain: string): string {
  const normalized = normalizeDomain(domain)
  const labels = normalized.split('.')
  const valid = labels.length >= 2 && labels.every(label => {
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  })
  if (!valid || normalized.length > 253) {
    throw httpError(400, '域名格式无效')
  }
  return normalized
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function httpError(status: number, message: string): ApiError {
  return new ApiError(status, message)
}

function allowedOrigin(request: Request, env: Env): string {
  const origin = request.headers.get('Origin') || '*'
  const configured = (env.CORS_ORIGINS || '*').split(',').map(item => item.trim()).filter(Boolean)
  if (configured.includes('*')) return '*'
  if (configured.includes(origin)) return origin
  return configured[0] || origin
}

export function corsHeaders(request: Request, env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': allowedOrigin(request, env),
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Domain-Password,Last-Event-ID',
    'Access-Control-Expose-Headers': 'Content-Disposition',
    'Vary': 'Origin',
  }
}

export function jsonResponse(request: Request, env: Env, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request, env),
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}

export function errorResponse(request: Request, env: Env, error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonResponse(request, env, { detail: error.message }, error.status)
  }
  const message = error instanceof Error ? error.message : '请求失败'
  return jsonResponse(request, env, { detail: message }, 500)
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T
  } catch {
    throw httpError(400, '请求体必须是 JSON')
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
