export async function api(method, path, body, password) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (password) opts.headers['X-Domain-Password'] = password
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(path, opts)
  const text = await r.text()
  let d
  try { d = JSON.parse(text) } catch { throw new Error('服务器返回异常') }
  if (!r.ok) throw new Error(d.detail || '请求失败')
  return d
}

export function createSSE(onMsg) {
  let source = null
  let reconnectTimer = null
  let closed = false

  const connect = () => {
    if (closed) return
    source = new EventSource('/api/logs')
    source.onmessage = e => {
      try { onMsg(JSON.parse(e.data)) } catch { /* Ignore malformed keepalive payloads. */ }
    }
    source.onerror = () => {
      source?.close()
      source = null
      if (!closed && !reconnectTimer) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null
          connect()
        }, 3000)
      }
    }
  }

  connect()

  return {
    close() {
      closed = true
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      source?.close()
      source = null
    },
  }
}
