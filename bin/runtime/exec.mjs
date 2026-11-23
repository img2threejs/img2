import { spawn } from 'node:child_process'

const STRIP_ENV = [
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'VIRTUAL_ENV', 'NODE_OPTIONS', 'NODE_PATH',
  'PLAYWRIGHT_DOWNLOAD_HOST', 'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
  'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST', 'PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST', 'PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST',
  'DOTNET_ROOT', 'HF_HOME', 'HF_HUB_CACHE', 'TRANSFORMERS_CACHE',
]
const STRIP_PREFIX = ['PIP_', 'npm_config_', 'NPM_CONFIG_', 'UV_']

// A child environment that cannot be steered by ambient interpreter, pip, npm or browser settings.
export function cleanEnv(overrides = {}, base = process.env) {
  const env = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || STRIP_ENV.includes(k) || STRIP_PREFIX.some((p) => k.startsWith(p))) continue
    env[k] = v
  }
  env.PYTHONNOUSERSITE = '1'
  env.PIP_NO_INPUT = '1'
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1'
  env.NO_COLOR = '1'
  return { ...env, ...overrides }
}

const CAP = 4 * 1024 * 1024

// Children run in their own process group so a timeout can take down grandchildren that inherited the pipes.
const groups = new Set()
const killGroup = (child, signal) => {
  try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* already gone */ } }
}
let hooked = false
// Detached children no longer receive the terminal's Ctrl-C: reap them when this process goes away.
function hookExit() {
  if (hooked) return
  hooked = true
  process.on('exit', () => { for (const c of groups) killGroup(c, 'SIGKILL') })
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(sig, () => process.exit(code))
}

// run(file, args, { cwd, env, timeout, input, killGraceMs }) -> { code, signal, stdout, stderr, timedOut, error }.
// Never throws: a missing executable or a timeout is data the caller reports precisely. After a timeout the
// whole group gets SIGTERM, then SIGKILL; the result is returned without waiting for pipes a survivor holds open.
export function realRunner() {
  return (file, args, { cwd, env, timeout = 600_000, input, killGraceMs = 5000 } = {}) => new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { cwd, env: env ?? cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    } catch (e) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: e.message })
      return
    }
    hookExit()
    groups.add(child)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let error = null
    let settled = false
    const take = (cur, chunk) => (cur.length >= CAP ? cur : cur + chunk.toString('utf8'))
    child.stdout.on('data', (c) => { stdout = take(stdout, c) })
    child.stderr.on('data', (c) => { stderr = take(stderr, c) })
    child.on('error', (e) => { error = e.message })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(killer); clearTimeout(giveUp)
      groups.delete(child)
      child.stdout.destroy(); child.stderr.destroy()
      resolve({ code, signal, stdout, stderr, timedOut, error })
    }
    let killer = null
    let giveUp = null
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child, 'SIGTERM')
      killer = setTimeout(() => {
        killGroup(child, 'SIGKILL')
        giveUp = setTimeout(() => finish(null, 'SIGKILL'), 500)
      }, killGraceMs)
    }, timeout)
    child.on('close', (code, signal) => {
      // a clean exit leaves no group behind to worry about; after a timeout make sure nothing survives
      if (timedOut) killGroup(child, 'SIGKILL')
      finish(code, signal)
    })
  })
}

// Minimal MCP stdio client: newline-delimited JSON-RPC. Proves `initialize` (and lists tools).
export function mcpHandshake({ command, args = [], cwd, env, timeout = 30_000 }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { cwd, env: env ?? cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    } catch (e) {
      resolve({ ok: false, error: e.message, stderr: '' })
      return
    }
    hookExit()
    groups.add(child)
    let buf = ''
    let stderr = ''
    let settled = false
    const result = { ok: false, serverInfo: null, toolCount: null, error: null, stderr: '' }
    const done = (patch) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killGroup(child, 'SIGTERM')
      setTimeout(() => { killGroup(child, 'SIGKILL'); groups.delete(child) }, 2000).unref()
      resolve({ ...result, ...patch, stderr: stderr.slice(-2000) })
    }
    const timer = setTimeout(() => done({ error: 'no reply within ' + timeout + ' ms' }), timeout)
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-8000) })
    child.stdin.on('error', () => {})
    child.on('error', (e) => done({ error: e.message }))
    child.on('close', (code) => done({ error: result.ok ? null : 'server exited (code ' + code + ') before answering' }))
    child.stdout.on('data', (c) => {
      buf += c.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1) {
          if (msg.error || !msg.result?.serverInfo) { done({ error: 'initialize reply has no serverInfo: ' + line.slice(0, 300) }); return }
          result.serverInfo = msg.result.serverInfo
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (msg.id === 2) {
          if (msg.error || !Array.isArray(msg.result?.tools)) {
            done({ ok: false, error: 'tools/list failed: ' + (msg.error ? JSON.stringify(msg.error).slice(0, 300) : 'reply has no tools array') })
            return
          }
          result.toolCount = msg.result.tools.length
          done({ ok: true })
        }
      }
    })
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'img2-doctor', version: '1' } },
    })
  })
}
