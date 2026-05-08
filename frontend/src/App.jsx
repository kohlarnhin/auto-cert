import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Link2, UserPlus, FileText, Globe, Hourglass, Search,
  KeyRound, Package, CheckCircle2, XCircle, LogOut, Shield, ChevronRight,
  AlertTriangle, Lock, Eye, EyeOff, Copy
} from 'lucide-react'
import { api, apiUrl, createSSE } from './api'

const STEPS = [
  { id: 'init',        label: '初始化',    icon: Link2 },
  { id: 'account',     label: '注册账户',  icon: UserPlus },
  { id: 'order',       label: '创建订单',  icon: FileText },
  { id: 'dns',         label: '配置 DNS',  icon: Globe },
  { id: 'propagation', label: '验证 DNS',  icon: Hourglass },
  { id: 'verify',      label: '验证域名',  icon: Search },
  { id: 'generate',    label: '生成密钥',  icon: KeyRound },
  { id: 'finalize',    label: '签发证书',  icon: Package },
]
const CACHE_KEY = 'autocert_domain'
const CACHE_PWD = 'autocert_pwd'
const spring = { type: 'spring', stiffness: 80, damping: 20 }
const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 1, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, transition: { duration: 0.5 } }
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      /* Fall back for HTTP deployments where Clipboard API is blocked. */
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function certFromStatus(data) {
  if (data.status !== 'valid') return null
  return {
    status: data.status,
    expires_at: data.expires_at,
    fullchain_name: data.fullchain_name || 'fullchain.cer',
    fullchain_url: data.fullchain_url || '',
    privkey_name: data.privkey_name || '',
    privkey_url: data.privkey_url || '',
  }
}

function Landing({ onEnter }) {
  // Phases: 'domain' -> 'login' -> 'setup-pwd' -> 'setup-token'
  const [phase, setPhase] = useState('domain')
  const [val, setVal] = useState('')
  const [cachedLogin] = useState(() => ({
    domain: localStorage.getItem(CACHE_KEY),
    password: localStorage.getItem(CACHE_PWD),
  }))
  const [password, setPassword] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [cfToken, setCfToken] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [busy, setBusy] = useState(() => Boolean(cachedLogin.domain && cachedLogin.password))
  const [err, setErr] = useState('')
  const [domain, setDomain] = useState('')
  const inputRef = useRef(null)
  const pwdRef = useRef(null)
  const confirmRef = useRef(null)
  const tokenRef = useRef(null)

  useEffect(() => {
    const { domain: cachedDomain, password: cachedPassword } = cachedLogin
    if (cachedDomain && cachedPassword) {
      api('GET', `/api/cert/check/${cachedDomain}`, null, cachedPassword)
        .then(d => onEnter({ domain: cachedDomain, password: cachedPassword, ...d }))
        .catch(() => { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(CACHE_PWD); setBusy(false) })
      return
    }
    inputRef.current?.focus()
  }, [cachedLogin, onEnter])

  useEffect(() => {
    if (phase === 'login') setTimeout(() => pwdRef.current?.focus(), 100)
    if (phase === 'setup-pwd') setTimeout(() => pwdRef.current?.focus(), 100)
    if (phase === 'setup-token') setTimeout(() => tokenRef.current?.focus(), 100)
  }, [phase])

  const submitDomain = async (e) => {
    e.preventDefault()
    let d = val.trim().toLowerCase().replace(/^\*\./, '')
    if (!d) return
    if (d.split('.').length < 2 || d.split('.').some(x => !x)) { setErr('域名格式无效'); return }
    setErr(''); setBusy(true)
    try {
      const res = await api('GET', `/api/cert/exists/${d}`)
      setDomain(d)
      if (res.exists) {
        setPhase('login')
      } else {
        setPhase('setup-pwd')
      }
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  const submitLogin = async (e) => {
    e.preventDefault()
    if (!password.trim()) return
    setErr(''); setBusy(true)
    try {
      const data = await api('GET', `/api/cert/check/${domain}`, null, password)
      localStorage.setItem(CACHE_KEY, domain)
      localStorage.setItem(CACHE_PWD, password)
      onEnter({ domain, password, ...data })
    } catch (e) { setErr(e.message); setBusy(false) }
  }

  const finishPasswordSetup = () => {
    if (!password.trim()) { setErr('请设置访问密码'); return }
    if (password !== confirmPwd) { setErr('两次输入的密码不一致'); return }
    setErr('')
    setPhase('setup-token')
  }

  const submitPassword = (e) => {
    e.preventDefault()
    finishPasswordSetup()
  }

  const handlePasswordEnter = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (e.currentTarget === pwdRef.current && !confirmPwd) {
      confirmRef.current?.focus()
      return
    }
    finishPasswordSetup()
  }

  const submitToken = async (e) => {
    e.preventDefault()
    if (!cfToken.trim()) { setErr('请输入 Cloudflare API Token'); return }
    setErr(''); setBusy(true)
    try {
      await api('POST', '/api/cert/register', { domain, password, cf_token: cfToken.trim() })
      localStorage.setItem(CACHE_KEY, domain)
      localStorage.setItem(CACHE_PWD, password)
      onEnter({ domain, password, status: 'not_found', expires_at: null })
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
        <AnimatePresence mode="wait">

          {phase === 'domain' && (
            <motion.form key="domain" onSubmit={submitDomain} className="command-prompt" initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.2, ...spring }}>
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
          )}

          {phase === 'login' && (
            <motion.form key="login" onSubmit={submitLogin} className="command-prompt" {...fade}>
              <div className="prompt-label"><Lock size={16} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '8px' }} />{domain}</div>
              <div className="prompt-input-area" onClick={() => pwdRef.current?.focus()}>
                <input
                  ref={pwdRef}
                  type={showPwd ? 'text' : 'password'}
                  className="invisible-input center-text"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setErr('') }}
                  placeholder="输入访问密码"
                  autoComplete="off"
                  disabled={busy}
                />
                <button type="button" className="pwd-toggle" onClick={() => setShowPwd(!showPwd)}>
                  {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <div className="prompt-hint">
                {err ? <span className="err-msg">{err}</span> :
                 busy ? <span className="pulsing-text">正在验证身份...</span> :
                 password ? <span>按 <span className="kbd">Enter ↵</span> 解锁</span> :
                 <span>该域名已注册，请输入密码进入</span>}
              </div>
              <button type="button" className="btn btn-secondary" style={{ marginTop: '20px' }} onClick={() => { setPhase('domain'); setErr(''); setPassword('') }}>返回</button>
            </motion.form>
          )}

          {phase === 'setup-pwd' && (
            <motion.form key="setup-pwd" onSubmit={submitPassword} className="command-prompt" {...fade}>
              <div className="prompt-label">设置访问密码 · {domain}</div>
              <div className="prompt-input-area" onClick={() => pwdRef.current?.focus()}>
                <input
                  ref={pwdRef}
                  type={showPwd ? 'text' : 'password'}
                  className="invisible-input center-text"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setErr('') }}
                  onKeyDown={handlePasswordEnter}
                  placeholder="输入密码"
                  autoComplete="off"
                />
                <button type="button" className="pwd-toggle" onClick={() => setShowPwd(!showPwd)}>
                  {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <div className="setup-confirm-field">
                <div className="prompt-input-area" onClick={() => confirmRef.current?.focus()}>
                  <input
                    ref={confirmRef}
                    type={showPwd ? 'text' : 'password'}
                    className="invisible-input center-text"
                    value={confirmPwd}
                    onChange={e => { setConfirmPwd(e.target.value); setErr('') }}
                    onKeyDown={handlePasswordEnter}
                    placeholder="再次确认密码"
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="prompt-hint">
                {err ? <span className="err-msg">{err}</span> :
                 (password && confirmPwd) ? <span>按 <span className="kbd">Enter ↵</span> 下一步</span> :
                 <span>该密码将用于后续登录管理此域名</span>}
              </div>
              <button type="button" className="btn btn-secondary" style={{ marginTop: '20px' }} onClick={() => { setPhase('domain'); setErr(''); setPassword(''); setConfirmPwd('') }}>返回</button>
            </motion.form>
          )}

          {phase === 'setup-token' && (
            <motion.form key="setup-token" onSubmit={submitToken} className="command-prompt" {...fade}>
              <div className="prompt-label">授权配置 · {domain}</div>
              <div className="prompt-input-area" onClick={() => tokenRef.current?.focus()}>
                <input
                  ref={tokenRef}
                  type="password"
                  className="invisible-input center-text"
                  value={cfToken}
                  onChange={e => { setCfToken(e.target.value); setErr('') }}
                  placeholder="粘贴 Cloudflare API Token"
                  autoComplete="off"
                  disabled={busy}
                />
              </div>
              <div className="prompt-hint">
                {err ? <span className="err-msg">{err}</span> :
                 busy ? <span className="pulsing-text">正在验证并签发...</span> :
                 cfToken ? <span>按 <span className="kbd">Enter ↵</span> 建立连接并签发</span> :
                 <span>Token 必须包含 Zone.DNS 编辑权限</span>}
              </div>
              <button type="button" className="btn btn-secondary" style={{ marginTop: '20px' }} onClick={() => { setPhase('setup-pwd'); setErr(''); setCfToken('') }}>上一步</button>
            </motion.form>
          )}

        </AnimatePresence>
      </main>

      <footer className="footer-info">
        <div className="f-line"><Shield className="f-icon" /> <span>Let's Encrypt 全自动签发</span></div>
        <div className="f-line"><Globe className="f-icon" /> <span>深度集成 Cloudflare DNS-01</span></div>
      </footer>
    </motion.div>
  )
}

function DomainPage({ data, onLogout }) {
  const { domain, password } = data
  const [phase, setPhase] = useState(() => {
    if (data.status === 'valid') return 'cert'
    if (data.status === 'pending') return 'progress'
    return 'ready'
  })
  const [cert, setCert] = useState(() => certFromStatus(data))
  const [staging] = useState(false)
  const [curStep, setCurStep] = useState('')
  const [curMsg, setCurMsg] = useState('')
  const [doneSteps, setDoneSteps] = useState([])
  const [countdown, setCountdown] = useState(0)
  const [copiedUrlType, setCopiedUrlType] = useState('')
  const sseRef = useRef()
  const completeTimerRef = useRef(null)
  const propagationTimerRef = useRef(null)
  const completedRef = useRef(false)

  const now = new Date()
  const expDate = cert?.expires_at ? new Date(cert.expires_at) : new Date()
  const daysLeft = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24))
  const isExpiring = cert?.status === 'valid' && daysLeft <= 10

  const curIdx = STEPS.findIndex(s => s.id === curStep)
  const CurrentStepIcon = STEPS[curIdx]?.icon || Hourglass

  const refreshCert = useCallback(async () => {
    try {
      const d = await api('GET', `/api/cert/check/${domain}`, null, password)
      setCert(certFromStatus(d))
    } catch {
      /* The progress screen can still settle into cert view after a transient refresh error. */
    }
    setPhase('cert')
  }, [domain, password])

  useEffect(() => {
    const clearPropagationTimer = () => {
      if (propagationTimerRef.current) {
        window.clearInterval(propagationTimerRef.current)
        propagationTimerRef.current = null
      }
    }

    const startPropagationCountdown = () => {
      clearPropagationTimer()
      let c = 30
      setCountdown(c)
      propagationTimerRef.current = window.setInterval(() => {
        c--
        setCountdown(Math.max(0, c))
        if (c <= 0) clearPropagationTimer()
      }, 1000)
    }

    sseRef.current = createSSE(ev => {
      if (!ev.step) return
      if (ev.level === 'debug' && ev.step === 'propagation') {
        const m = ev.message.match(/(\d+)s/)
        if (m) {
          const next = parseInt(m[1])
          setCountdown(current => current > 0 ? Math.min(current, next) : next)
        }
        return
      }
      if (ev.level === 'debug') return
      if (ev.step !== 'propagation') clearPropagationTimer()
      setCurStep(ev.step)
      setCurMsg(ev.message)
      if (ev.step === 'propagation' && ev.level === 'success') {
        clearPropagationTimer()
        setCountdown(0)
      } else if (ev.step === 'propagation') {
        startPropagationCountdown()
      }
      if (ev.level === 'success' && ev.step !== 'complete' && ev.step !== 'cleanup') {
        setDoneSteps(p => p.includes(ev.step) ? p : [...p, ev.step])
      }
      if (ev.step === 'complete') {
        if (completedRef.current) return
        completedRef.current = true
        setDoneSteps(p => p.includes('finalize') ? p : [...p, 'finalize'])
        setCurStep('complete')
        let c = 6
        setCountdown(c)
        if (completeTimerRef.current) {
          window.clearInterval(completeTimerRef.current)
        }
        completeTimerRef.current = window.setInterval(() => {
          c--
          setCountdown(c)
          if (c <= 0) {
            window.clearInterval(completeTimerRef.current)
            completeTimerRef.current = null
            refreshCert()
          }
        }, 1000)
      }
      if (ev.step === 'error') setPhase('failed')
    }, domain)
    return () => {
      sseRef.current?.close()
      if (completeTimerRef.current) {
        window.clearInterval(completeTimerRef.current)
        completeTimerRef.current = null
      }
      clearPropagationTimer()
    }
  }, [refreshCert, domain])

  const startApply = async () => {
    if (completeTimerRef.current) {
      window.clearInterval(completeTimerRef.current)
      completeTimerRef.current = null
    }
    completedRef.current = false
    setDoneSteps([]); setCurStep(''); setCurMsg(''); setCountdown(0)
    try {
      await api('POST', '/api/cert/apply', { domain, password, staging })
      setPhase('progress')
    }
    catch (e) { alert(e.message) }
  }

  const downloadCert = async () => {
    try {
      const r = await fetch(apiUrl(`/api/cert/download/${domain}`), {
        headers: { 'X-Domain-Password': password }
      })
      if (!r.ok) {
        const d = await r.json()
        throw new Error(d.detail || '下载失败')
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `${domain}.zip`; a.click()
      URL.revokeObjectURL(url)
    } catch (e) { alert(e.message) }
  }

  const copyCertUrl = async (type) => {
    try {
      const url = type === 'fullchain' ? cert?.fullchain_url : cert?.privkey_url
      if (!url) {
        alert('证书地址不可用，请刷新页面')
        return
      }
      await writeClipboard(url)
      setCopiedUrlType(type)
      window.setTimeout(() => setCopiedUrlType(''), 1800)
    } catch (e) { alert(e.message) }
  }

  const deleteCert = async () => {
    if (!confirm('确认删除该证书吗？域名账号和配置将保留。')) return
    try {
      await api('DELETE', `/api/cert/${domain}`, null, password)
      setCert(null)
      setPhase('ready')
    }
    catch (e) { alert(e.message) }
  }
  const logout = () => { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(CACHE_PWD); onLogout() }
  const privkeyName = cert?.privkey_name || `${domain}.key`
  const fullchainCopyLabel = copiedUrlType === 'fullchain' ? '已复制 fullchain.cer' : '复制 fullchain.cer 地址'
  const privkeyCopyLabel = copiedUrlType === 'privkey' ? `已复制 ${privkeyName}` : `复制 ${privkeyName} 地址`

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
            onClick={logout}
            title="退出"
            disabled={phase === 'progress'}
            style={{ opacity: phase === 'progress' ? 0.2 : 1, pointerEvents: phase === 'progress' ? 'none' : 'auto' }}
          ><LogOut size={20} /></button>
        </div>
      </header>

      <main className="center-canvas">
        <AnimatePresence mode="wait">

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
                    <button className="btn btn-secondary" onClick={downloadCert}>
                      <Package size={18} /> 下载证书包
                    </button>
                    <button className="btn btn-secondary" onClick={() => copyCertUrl('fullchain')}>
                      <Copy size={18} /> {fullchainCopyLabel}
                    </button>
                    <button className="btn btn-secondary" onClick={() => copyCertUrl('privkey')}>
                      <Copy size={18} /> {privkeyCopyLabel}
                    </button>
                    <button className="btn btn-danger" onClick={deleteCert}>
                      删除证书
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
