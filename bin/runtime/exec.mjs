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

// run(file, args, { cwd, env, timeout, input }) -> { code, signal, stdout, stderr, timedOut, error }.
// Never throws: a missing executable or a timeout is data the caller reports precisely.
export function realRunner() {
  return (file, args, { cwd, env, timeout = 600_000, input } = {}) => new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { cwd, env: env ?? cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: e.message })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let error = null
    const take = (cur, chunk) => (cur.length >= CAP ? cur : cur + chunk.toString('utf8'))
    child.stdout.on('data', (c) => { stdout = take(stdout, c) })
    child.stderr.on('data', (c) => { stderr = take(stderr, c) })
    child.on('error', (e) => { error = e.message })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, timeout)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut, error })
    })
  })
}

// Minimal MCP stdio client: newline-delimited JSON-RPC. Proves `initialize` (and lists tools).
export function mcpHandshake({ command, args = [], cwd, env, timeout = 30_000 }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { cwd, env: env ?? cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, error: e.message, stderr: '' })
      return
    }
    let buf = ''
    let stderr = ''
    let settled = false
    const result = { ok: false, serverInfo: null, toolCount: null, error: null, stderr: '' }
    const done = (patch) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
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
          if (!msg.result?.serverInfo) { done({ error: 'initialize reply has no serverInfo: ' + line.slice(0, 300) }); return }
          result.ok = true
          result.serverInfo = msg.result.serverInfo
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (msg.id === 2) {
          result.toolCount = Array.isArray(msg.result?.tools) ? msg.result.tools.length : null
          done({})
        }
      }
    })
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'img2-doctor', version: '1' } },
    })
  })
}
