import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { api, createSSE } from './api'

const STEPS = [
  { id: 'init',        label: '初始化',   icon: '🔗' },
  { id: 'account',     label: '注册账户', icon: '👤' },
  { id: 'order',       label: '创建订单', icon: '📋' },
  { id: 'dns',         label: 'DNS 配置', icon: '🌐' },
  { id: 'propagation', label: 'DNS 传播', icon: '⏳' },
  { id: 'verify',      label: '域名验证', icon: '🔍' },
  { id: 'generate',    label: '生成密钥', icon: '🔐' },
  { id: 'finalize',    label: '签发证书', icon: '📦' },
]
const CACHE_KEY = 'autocert_domain'
const ease = [0.22, 1, 0.36, 1]

/* ═══════════════════════
   Landing — 全屏沉浸
   ═══════════════════════ */
function Landing({ onEnter }) {
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const ref = useRef()

  useEffect(() => {
    const c = localStorage.getItem(CACHE_KEY)
    if (c) {
      setBusy(true)
      api('GET', `/api/cert/check/${c}`)
        .then(d => onEnter(d))
        .catch(() => { localStorage.removeItem(CACHE_KEY); setBusy(false) })
      return
    }
    ref.current?.focus()
  }, [])

  const go = async () => {
    let d = val.trim().toLowerCase().replace(/^\*\./, '')
    if (!d) return
    if (d.split('.').length < 2 || d.split('.').some(x => !x)) { setErr('请输入正确域名'); return }
    setErr(''); setBusy(true)
    try {
      const data = await api('GET', `/api/cert/check/${d}`)
      localStorage.setItem(CACHE_KEY, d)
      onEnter(data)
    } catch (e) { setErr(e.message); setBusy(false) }
  }

  return (
    <motion.div className="scene" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="grid-bg" /><div className="glow g1" /><div className="glow g2" />
      <div className="scene-center">
        <motion.p className="eyebrow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          ⚡ AutoCert
        </motion.p>
        <motion.h1 className="hero" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.7, ease }}>
          申请你的<br /><span className="grad">通配符证书</span>
        </motion.h1>
        <motion.div className="input-line" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}
          onClick={() => ref.current?.focus()}>
          <span className="il-pre">*.</span>
          <input ref={ref} value={val} onChange={e => { setVal(e.target.value); setErr('') }}
            onKeyDown={e => e.key === 'Enter' && go()} placeholder="输入域名"
            spellCheck={false} autoComplete="off" disabled={busy} />
          {val.trim() && !busy && <span className="il-hint">Enter ↵</span>}
          {busy && <span className="spin" />}
        </motion.div>
        <AnimatePresence>
          {err && <motion.p className="input-err" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>{err}</motion.p>}
        </AnimatePresence>
      </div>
      <motion.div className="scene-bottom" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7 }}>
        <span>🔒 通配符</span><span className="dot-sep">·</span>
        <span>⚡ 全自动</span><span className="dot-sep">·</span>
        <span>☁️ Cloudflare</span><span className="dot-sep">·</span>
        <span>📦 一键下载</span>
      </motion.div>
    </motion.div>
  )
}

/* ═══════════════════════
   Domain — 全屏各状态
   ═══════════════════════ */
function DomainPage({ data, onLogout }) {
  const { domain, has_token, cert: initCert } = data
  const [phase, setPhase] = useState(() => {
    if (initCert?.status === 'valid') return 'cert'
    if (!has_token) return 'config'
    return 'ready'
  })
  const [cert, setCert] = useState(initCert)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [staging, setStaging] = useState(false)
  const [curStep, setCurStep] = useState('')
  const [curMsg, setCurMsg] = useState('')
  const [doneSteps, setDoneSteps] = useState([])
  const [countdown, setCountdown] = useState(0)
  const sseRef = useRef()

  const curIdx = STEPS.findIndex(s => s.id === curStep)

  useEffect(() => {
    sseRef.current = createSSE(ev => {
      if (!ev.step) return
      if (ev.level === 'debug' && ev.step === 'propagation') {
        const m = ev.message.match(/(\d+)s/)
        if (m) setCountdown(parseInt(m[1]))
        return
      }
      if (ev.level === 'debug') return
      setCurStep(ev.step)
      setCurMsg(ev.message)
      if (ev.level === 'success' && ev.step !== 'complete' && ev.step !== 'cleanup') {
        setDoneSteps(p => p.includes(ev.step) ? p : [...p, ev.step])
      }
      if (ev.step === 'complete') {
        setDoneSteps(p => [...p, 'finalize'])
        setTimeout(refreshCert, 800)
      }
      if (ev.step === 'error') setPhase('failed')
    })
    return () => sseRef.current?.close()
  }, [])

  const refreshCert = async () => {
    try { const d = await api('GET', `/api/cert/check/${domain}`); setCert(d.cert) } catch {}
    setPhase('cert')
  }
  const saveToken = async () => {
    if (!token.trim()) return; setSaving(true)
    try { await api('POST', '/api/config', { api_token: token.trim() }); setPhase('ready') }
    catch (e) { alert(e.message) } finally { setSaving(false) }
  }
  const startApply = async () => {
    setDoneSteps([]); setCurStep(''); setCurMsg(''); setCountdown(0)
    try { await api('POST', '/api/cert/apply', { domain, staging }); setPhase('progress') }
    catch (e) { alert(e.message) }
  }
  const deleteCert = async () => {
    if (!confirm('确认删除？')) return
    try { await api('DELETE', `/api/cert/${domain}`); setCert(null); setPhase('ready') }
    catch (e) { alert(e.message) }
  }
  const logout = () => { localStorage.removeItem(CACHE_KEY); onLogout() }

  return (
    <motion.div className="scene" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="grid-bg" /><div className="glow g1" />

      {/* Top bar — always visible */}
      <div className="topbar">
        <div className="topbar-l">
          <span className="tb-domain"><span className="tb-w">*.</span>{domain}</span>
          {phase === 'cert' && <span className="tb-tag ok">已签发</span>}
          {phase === 'progress' && <span className="tb-tag ing">申请中</span>}
          {phase === 'failed' && <span className="tb-tag fail">失败</span>}
        </div>
        <button className="tb-exit" onClick={logout}>退出</button>
      </div>

      {/* Content — full screen, no cards */}
      <AnimatePresence mode="wait">

        {/* ── Config ── */}
        {phase === 'config' && (
          <motion.div key="cfg" className="scene-center" {...sceneAnim}>
            <p className="eyebrow">🔑 配置</p>
            <h1 className="title-lg">Cloudflare Token</h1>
            <p className="sub">输入具有 DNS 编辑权限的 API Token</p>
            <input className="cinput" type="password" value={token}
              onChange={e => setToken(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveToken()}
              placeholder="输入 API Token" autoFocus />
            <motion.button className="cbtn" onClick={saveToken} disabled={saving} whileTap={{ scale: 0.97 }}>
              {saving ? <span className="spin dark" /> : '验证并继续'}
            </motion.button>
          </motion.div>
        )}

        {/* ── Ready ── */}
        {phase === 'ready' && (
          <motion.div key="rdy" className="scene-center" {...sceneAnim}>
            <p className="eyebrow">📜 准备就绪</p>
            <h1 className="title-lg">*.{domain}</h1>
            <p className="sub">通过 Cloudflare DNS-01 验证签发 Let's Encrypt 通配符证书</p>
            <motion.button className="cbtn" onClick={startApply} whileTap={{ scale: 0.97 }}>
              开始申请
            </motion.button>
            <label className="ctgl">
              <input type="checkbox" checked={staging} onChange={e => setStaging(e.target.checked)} />
              <span className="ctgl-t"><span className="ctgl-k" /></span>
              <span>测试模式</span>
            </label>
          </motion.div>
        )}

        {/* ── Progress — cinematic ── */}
        {phase === 'progress' && (
          <motion.div key="prg" className="scene-center prog" {...sceneAnim}>
            <AnimatePresence mode="wait">
              <motion.div key={curStep || 'wait'} className="prog-hero"
                initial={{ opacity: 0, y: 40, filter: 'blur(8px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -40, filter: 'blur(8px)' }}
                transition={{ duration: 0.5, ease }}
              >
                <div className="prog-emoji">{STEPS[curIdx]?.icon || '⏳'}</div>
                <h1 className="prog-name">{STEPS[curIdx]?.label || '准备中'}</h1>
                <p className="prog-log">
                  {curStep === 'propagation' && countdown > 0
                    ? `等待 DNS 记录生效 · ${countdown}s`
                    : curMsg || '等待服务响应...'
                  }
                </p>
              </motion.div>
            </AnimatePresence>

            {/* Bottom progress bar */}
            <div className="prog-bar-wrap">
              <motion.div className="prog-bar"
                animate={{ width: `${((doneSteps.length) / STEPS.length) * 100}%` }}
                transition={{ duration: 0.4, ease }}
              />
            </div>
            <p className="prog-counter">{doneSteps.length} / {STEPS.length}</p>
          </motion.div>
        )}

        {/* ── Cert ── */}
        {phase === 'cert' && (
          <motion.div key="cert" className="scene-center" {...sceneAnim}>
            <motion.div className="cert-mark"
              initial={{ scale: 0, rotate: -15 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: 'spring', damping: 10, delay: 0.15 }}
            >✓</motion.div>
            <h1 className="title-lg">证书已签发</h1>
            {cert?.status === 'valid' ? (
              <>
                <div className="meta-line">
                  <span>*.{domain}</span>
                  <span className="meta-sep">·</span>
                  <span>{fmtDate(cert.expires_at)} 到期</span>
                </div>
                <div className="cbtns">
                  <motion.a href={`/api/cert/download/${domain}`} className="cbtn" whileTap={{ scale: 0.97 }}>
                    ↓ 下载证书
                  </motion.a>
                  <motion.button className="cbtn ghost" onClick={deleteCert} whileTap={{ scale: 0.97 }}>
                    删除
                  </motion.button>
                </div>
              </>
            ) : (
              <motion.button className="cbtn" onClick={refreshCert} whileTap={{ scale: 0.97 }}>刷新</motion.button>
            )}
          </motion.div>
        )}

        {/* ── Failed ── */}
        {phase === 'failed' && (
          <motion.div key="fail" className="scene-center" {...sceneAnim}>
            <div className="fail-mark">✕</div>
            <h1 className="title-lg">申请失败</h1>
            <p className="sub">{curMsg || '请检查配置后重试'}</p>
            <motion.button className="cbtn" onClick={() => { setPhase('ready'); setDoneSteps([]); setCurStep('') }} whileTap={{ scale: 0.97 }}>
              重新申请
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

const sceneAnim = {
  initial: { opacity: 0, y: 30, filter: 'blur(6px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -20, filter: 'blur(6px)', transition: { duration: 0.3 } },
}

function fmtDate(s) { return s ? new Date(s).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '-' }

export default function App() {
  const [v, setV] = useState('landing')
  const [d, setD] = useState(null)
  return (
    <AnimatePresence mode="wait">
      {v === 'landing'
        ? <Landing key="l" onEnter={d => { setD(d); setV('d') }} />
        : <DomainPage key="d" data={d} onLogout={() => { setV('landing'); setD(null) }} />
      }
    </AnimatePresence>
  )
}
