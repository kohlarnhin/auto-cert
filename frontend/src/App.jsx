import React, { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  Link2, UserPlus, FileText, Globe, Hourglass, Search, 
  KeyRound, Package, CheckCircle2, XCircle, LogOut, Shield, ChevronRight, Settings,
  AlertTriangle
} from 'lucide-react'
import { api, createSSE } from './api'

const STEPS = [
  { id: 'init',        label: '初始化',        icon: Link2 },
  { id: 'account',     label: '注册账户',  icon: UserPlus },
  { id: 'order',       label: '创建订单',      icon: FileText },
  { id: 'dns',         label: '配置 DNS',     icon: Globe },
  { id: 'propagation', label: '验证 DNS',icon: Hourglass },
  { id: 'verify',      label: '验证域名',   icon: Search },
  { id: 'generate',    label: '生成密钥',     icon: KeyRound },
  { id: 'finalize',    label: '签发证书', icon: Package },
]
const CACHE_KEY = 'autocert_domain'
const spring = { type: 'spring', stiffness: 80, damping: 20 }
const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 1, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, transition: { duration: 0.5 } }
}

function Landing({ onEnter }) {
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    const c = localStorage.getItem(CACHE_KEY)
    if (c) {
      setBusy(true)
      api('GET', `/api/cert/check/${c}`)
        .then(d => onEnter(d))
        .catch(() => { localStorage.removeItem(CACHE_KEY); setBusy(false) })
      return
    }
    inputRef.current?.focus()
  }, [])

  const go = async (e) => {
    e.preventDefault()
    let d = val.trim().toLowerCase().replace(/^\*\./, '')
    if (!d) return
    if (d.split('.').length < 2 || d.split('.').some(x => !x)) { setErr('域名格式无效'); return }
    setErr(''); setBusy(true)
    try {
      const data = await api('GET', `/api/cert/check/${d}`)
      localStorage.setItem(CACHE_KEY, d)
      onEnter(data)
    } catch (e) { setErr(e.message); setBusy(false) }
  }

  return (
    <motion.div className="scene" {...fade}>
      <div className="bg-mesh" />
      
      <header className="header">
        <div className="logo-block">
          <span className="logo-text">AUTOCERT</span>
          <span className="logo-sub">Acme Protocol v2</span>
        </div>
      </header>

      <main className="center-canvas">
        <motion.form onSubmit={go} className="command-prompt" initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.2, ...spring }}>
          <div className="prompt-label">申请通配符证书</div>
          <div className="prompt-input-area" onClick={() => inputRef.current?.focus()}>
            <input 
              ref={inputRef}
              className={`invisible-input ${busy ? 'pulsing-text' : ''}`}
              value={val}
              onChange={e => { setVal(e.target.value.replace(/。/g, '.')); setErr('') }}
              placeholder="example.com"
              autoComplete="off"
              spellCheck="false"
              autoFocus
              disabled={busy}
            />
          </div>
          
          <div className="prompt-hint">
            {err ? <span className="err-msg">{err}</span> : 
             busy ? <span className="pulsing-text">正在建立连接...</span> : 
             val ? <span>按 <span className="kbd">Enter ↵</span> 继续</span> : 
             <span>输入根域名开始申请</span>}
          </div>
        </motion.form>
      </main>

      <footer className="footer-info">
        <div className="f-line"><Shield className="f-icon" /> <span>Let's Encrypt 全自动签发</span></div>
        <div className="f-line"><Globe className="f-icon" /> <span>深度集成 Cloudflare DNS-01</span></div>
      </footer>
    </motion.div>
  )
}

function DomainPage({ data, onLogout }) {
  const { domain, has_token, cert: initCert, is_applying, apply_state } = data
  const [phase, setPhase] = useState(() => {
    if (is_applying) return 'progress'
    if (initCert?.status === 'valid') return 'cert'
    if (!has_token) return 'config'
    return 'ready'
  })
  const [cert, setCert] = useState(initCert)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [staging, setStaging] = useState(true)
  const [curStep, setCurStep] = useState(is_applying ? apply_state.step : '')
  const [curMsg, setCurMsg] = useState(is_applying ? apply_state.message : '')
  const [doneSteps, setDoneSteps] = useState([])
  const [countdown, setCountdown] = useState(0)
  const sseRef = useRef()
  const tokenInputRef = useRef()

  const now = new Date()
  const expDate = cert?.expires_at ? new Date(cert.expires_at) : new Date()
  const daysLeft = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24))
  const isExpiring = cert?.status === 'valid' && daysLeft <= 10

  const curIdx = STEPS.findIndex(s => s.id === curStep)
  const CurrentStepIcon = STEPS[curIdx]?.icon || Hourglass

  useEffect(() => {
    if (phase === 'config') {
      setTimeout(() => tokenInputRef.current?.focus(), 100)
    }
  }, [phase])

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
        setCurStep('complete')
        let c = 6
        setCountdown(c)
        const iv = setInterval(() => {
          c--
          setCountdown(c)
          if (c <= 0) {
            clearInterval(iv)
            refreshCert()
          }
        }, 1000)
      }
      if (ev.step === 'error') setPhase('failed')
    })
    return () => sseRef.current?.close()
  }, [])

  const refreshCert = async () => {
    try { const d = await api('GET', `/api/cert/check/${domain}`); setCert(d.cert) } catch {}
    setPhase('cert')
  }
  const exitConfig = async () => {
    try {
      setSaving(true)
      const d = await api('GET', `/api/cert/check/${domain}`)
      if (d.is_applying) {
        setCurStep(d.apply_state?.step || '')
        setCurMsg(d.apply_state?.message || '')
        setPhase('progress')
      } else if (d.cert?.status === 'valid') {
        setCert(d.cert)
        setPhase('cert')
      } else {
        setPhase('ready')
      }
    } catch {
      setPhase('ready')
    } finally {
      setSaving(false)
    }
  }

  const saveToken = async (e) => {
    e?.preventDefault()
    if (!token.trim()) return; setSaving(true)
    try { 
      await api('POST', '/api/config', { api_token: token.trim() })
      await exitConfig()
    } catch (e) { 
      alert(e.message) 
      setSaving(false)
    }
  }
  const startApply = async () => {
    setDoneSteps([]); setCurStep(''); setCurMsg(''); setCountdown(0)
    try { await api('POST', '/api/cert/apply', { domain, staging }); setPhase('progress') }
    catch (e) { alert(e.message) }
  }
  const deleteCert = async () => {
    if (!confirm('确认注销并删除该证书吗？此操作不可逆。')) return
    try { await api('DELETE', `/api/cert/${domain}`); setCert(null); setPhase('ready') }
    catch (e) { alert(e.message) }
  }
  const logout = () => { localStorage.removeItem(CACHE_KEY); onLogout() }

  return (
    <motion.div className="scene" {...fade}>
      <div className="bg-mesh" />

      <header className="header">
        <div className="logo-block">
          <span className="logo-text">AUTOCERT</span>
          <span className="logo-sub">{domain}</span>
        </div>
        <div style={{ display: 'flex', gap: '16px' }}>
          <button 
            className="btn-icon" 
            onClick={() => setPhase('config')} 
            title="配置 API Token"
            disabled={phase === 'progress'}
            style={{ opacity: phase === 'progress' ? 0.2 : 1, pointerEvents: phase === 'progress' ? 'none' : 'auto' }}
          ><Settings size={20} /></button>
          <button 
            className="btn-icon" 
            onClick={logout} 
            title="退出"
            disabled={phase === 'progress'}
            style={{ opacity: phase === 'progress' ? 0.2 : 1, pointerEvents: phase === 'progress' ? 'none' : 'auto' }}
          ><LogOut size={20} /></button>
        </div>
      </header>

      <main className="center-canvas">
        <AnimatePresence mode="wait">
          
          {phase === 'config' && (
            <motion.form key="cfg" className="command-prompt" onSubmit={saveToken} {...fade}>
              <div className="prompt-label">需要授权</div>
              <div className="prompt-input-area" onClick={() => tokenInputRef.current?.focus()}>
                <input 
                  ref={tokenInputRef}
                  type="password"
                  className="invisible-input center-text"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  placeholder="粘贴 Cloudflare API Token"
                  autoComplete="off"
                  disabled={saving}
                />
              </div>
              <div className="prompt-hint">
                {saving ? <span>正在验证...</span> : 
                 token ? <span>按 <span className="kbd">Enter ↵</span> 验证</span> : 
                 <span>Token 必须包含 Zone.DNS 编辑权限</span>}
              </div>
              {has_token && (
                <button type="button" className="btn btn-secondary" style={{ marginTop: '20px' }} onClick={exitConfig}>取消配置</button>
              )}
            </motion.form>
          )}

          {phase === 'ready' && (
            <motion.div key="rdy" className="massive-step" {...fade}>
              <div className="massive-title">系统就绪</div>
              <div className="massive-desc">
                即将通过全自动 DNS-01 验证，为 <strong>{domain}</strong> 签发 Let's Encrypt 通配符证书。
              </div>
              
              <div className="btn-row">
                <button className="btn-massive-primary" onClick={startApply}>
                  开始签发 <ChevronRight size={24} className="btn-icon-arrow" />
                </button>
              </div>
            </motion.div>
          )}

          {phase === 'progress' && (
            <motion.div key="prg" className="massive-focus-container" {...fade}>
              <AnimatePresence mode="wait">
                <motion.div 
                  key={curStep || 'wait'}
                  initial={{ opacity: 0, y: 100 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -100 }}
                  transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                  className="massive-step"
                >
                  <CurrentStepIcon size={64} className="ms-icon" />
                  <div className="ms-label">{curStep === 'complete' ? '配置生效' : STEPS[curIdx]?.label || '准备中'}</div>
                  <div className="ms-log">
                    {curStep === 'propagation' && countdown > 0 
                      ? `等待 DNS 在全球网络生效 · ${countdown}秒` 
                      : curStep === 'complete' && countdown > 0
                      ? `证书已签发，倒计时自动刷新 · ${countdown}秒`
                      : curMsg || '正在执行...'}
                  </div>
                </motion.div>
              </AnimatePresence>
            </motion.div>
          )}

          {phase === 'cert' && (
            <motion.div key="cert" className="massive-step" {...fade}>
              {isExpiring ? (
                <>
                  <AlertTriangle size={80} style={{ color: 'var(--error)', marginBottom: '-20px' }} />
                  <div className="massive-title" style={{ color: 'var(--error)' }}>
                    {daysLeft < 0 ? '证书已过期' : `证书即将过期 (${daysLeft}天)`}
                  </div>
                </>
              ) : (
                <>
                  <CheckCircle2 size={80} style={{ color: 'var(--fg)', marginBottom: '-20px' }} />
                  <div className="massive-title">证书已签发</div>
                </>
              )}
              
              {cert?.status === 'valid' ? (
                <>
                  <div className="cert-meta-grid">
                    <div className="meta-item"><span className="meta-label">域名</span><span className="meta-val">{domain}</span></div>
                    <div className="meta-item"><span className="meta-label">颁发机构</span><span className="meta-val">Let's Encrypt</span></div>
                    <div className="meta-item"><span className="meta-label">到期时间</span><span className="meta-val">{fmtDate(cert.expires_at)}</span></div>
                  </div>
                  <div className="btn-row">
                    {isExpiring && (
                      <button className="btn-massive-primary" onClick={startApply}>
                        重新签发 <ChevronRight size={24} className="btn-icon-arrow" />
                      </button>
                    )}
                    <a href={`/api/cert/download/${domain}`} className="btn btn-secondary">
                      <Package size={18} /> 下载证书包
                    </a>
                    <button className="btn btn-danger" onClick={deleteCert}>
                      注销并删除
                    </button>
                  </div>
                </>
              ) : (
                <button className="btn btn-secondary" onClick={refreshCert}>刷新状态</button>
              )}
            </motion.div>
          )}

          {phase === 'failed' && (
            <motion.div key="fail" className="massive-step" {...fade}>
              <XCircle size={80} style={{ color: 'var(--error)', marginBottom: '-20px' }} />
              <div className="massive-title">签发失败</div>
              <div className="massive-desc" style={{ color: 'var(--error)', fontFamily: 'var(--font-mono)' }}>
                {curMsg || '执行过程中发生了预期外的错误。'}
              </div>
              <div className="btn-row">
                <button className="btn btn-primary" onClick={() => { setPhase('ready'); setDoneSteps([]); setCurStep('') }}>
                  确认并重试
                </button>
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </main>

      {/* Global Edge Progress Bar */}
      {phase === 'progress' && (
        <div className="global-prog-track">
          <div className="global-prog-fill" style={{ width: `${((doneSteps.length) / STEPS.length) * 100}%` }} />
        </div>
      )}

      {phase !== 'progress' && (
        <footer className="footer-info">
          <div className="f-line">Let's Encrypt Automated PKI</div>
          <div className="f-line">Cloudflare DNS-01 Verification</div>
        </footer>
      )}
    </motion.div>
  )
}

function fmtDate(s) { 
  return s ? new Date(s).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '-' 
}

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
