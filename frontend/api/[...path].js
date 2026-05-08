import http from 'node:http'
import https from 'node:https'
import process from 'node:process'

export const config = {
  api: {
    bodyParser: false,
  },
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])

function getBackendUrl() {
  const backendUrl = process.env.BACKEND_URL?.trim().replace(/\/+$/, '')
  if (!backendUrl) {
    throw new Error('Missing BACKEND_URL')
  }
  return backendUrl
}

function proxyHeaders(headers) {
  const nextHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      nextHeaders[key] = value
    }
  }
  return nextHeaders
}

export default function handler(req, res) {
  let targetUrl
  try {
    targetUrl = new URL(req.url, getBackendUrl())
  } catch (error) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ detail: error.message }))
    return
  }

  const client = targetUrl.protocol === 'https:' ? https : http
  const proxyReq = client.request(
    targetUrl,
    {
      method: req.method,
      headers: proxyHeaders(req.headers),
    },
    proxyRes => {
      res.writeHead(proxyRes.statusCode || 500, proxyHeaders(proxyRes.headers))
      proxyRes.pipe(res)
    },
  )

  proxyReq.on('error', error => {
    if (res.headersSent) {
      res.destroy(error)
      return
    }
    res.statusCode = 502
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ detail: `Backend proxy failed: ${error.message}` }))
  })

  req.pipe(proxyReq)
}
