export async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(path, opts)
  const text = await r.text()
  let d
  try { d = JSON.parse(text) } catch { throw new Error('服务器返回异常') }
  if (!r.ok) throw new Error(d.detail || '请求失败')
  return d
}

export function createSSE(onMsg) {
  const es = new EventSource('/api/logs')
  es.onmessage = e => { try { onMsg(JSON.parse(e.data)) } catch {} }
  es.onerror = () => { es.close(); setTimeout(() => createSSE(onMsg), 3000) }
  return es
}
