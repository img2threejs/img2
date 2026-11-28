// Checkout configuration is untrusted. Transport takes only explicitly allowed settings from the user's
// global config or invocation environment; inspection never enables hooks, filters or external programs.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const GIT_HARDENING = [
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=',
  '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=user', '-c', 'core.pager=cat',
  '-c', 'core.gitProxy=', '-c', 'core.editor=true', '-c', 'core.askPass=', '-c', 'credential.helper=',
  '-c', 'diff.external=', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false',
]
const TRANSPORT_KEY = /^(?:core\.(?:sshcommand|gitproxy)|credential(?:\..+)?\.(?:helper|username|usehttppath)|http(?:\..+)?\.(?:proxy|sslcainfo|sslcapath|sslcert|sslkey|sslverify)|url\..+\.insteadof)$/
const EXECUTABLE_KEY = /^(?:core\.(?:fsmonitor|hookspath|sshcommand|pager|editor|gitproxy|askpass|worktree)|filter\..+\.(?:clean|smudge|process)|diff\..+\.(?:command|textconv)|credential(?:\..+)?\.helper|include(?:if\..+)?\.path|http\..+|url\..+|remote\..+\.(?:proxy|uploadpack|receivepack|vcs))$/
const TRANSPORT = new Set(['clone', 'fetch', 'ls-remote'])

export function gitEnv(base = process.env, transport = false) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('SSH_ASKPASS')))
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: transport ? 'https:ssh:file' : 'https:file',
  })
  if (transport) for (const key of ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT']) if (base[key] !== undefined) env[key] = base[key]
  return env
}

function trustedTransport(base) {
  const env = gitEnv(base)
  if (base.GIT_CONFIG_GLOBAL === undefined) delete env.GIT_CONFIG_GLOBAL
  else env.GIT_CONFIG_GLOBAL = base.GIT_CONFIG_GLOBAL
  let entries = []
  try {
    entries = execFileSync('git', ['config', '--global', '--no-includes', '--null', '--list'], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0').filter(Boolean).map(entry => {
      const split = entry.indexOf('\n')
      return [entry.slice(0, split), entry.slice(split + 1)]
    })
  } catch (error) {
    if (error.code === 'ENOENT') throw error
    if (!/No such file or directory|unable to read config file/i.test(String(error.stderr))) throw error
  }
  const count = Number(base.GIT_CONFIG_COUNT ?? 0)
  if (!Number.isSafeInteger(count) || count < 0 || count > 1024) throw new Error('invalid invocation Git configuration count')
  for (let i = 0; i < count; i += 1) entries.push([base['GIT_CONFIG_KEY_' + i] ?? '', base['GIT_CONFIG_VALUE_' + i] ?? ''])
  const args = []
  for (const [key, value] of entries) {
    if (!TRANSPORT_KEY.test(key.toLowerCase())) continue
    if (/\.sslverify$/i.test(key) && !/^(true|yes|on|1)$/i.test(value)) throw new Error('trusted Git transport must not disable TLS verification')
    args.push('-c', key + '=' + value)
  }
  return args
}

export class GitError extends Error {
  constructor(args, err) {
    super('git ' + args.join(' ') + ' failed' + (err.status === undefined && !err.code ? ': ' + err.message : ''))
    this.notFound = err.code === 'ENOENT'
    this.status = typeof err.status === 'number' ? err.status : null
    this.stderr = String(err.stderr ?? (err.status === undefined && !err.code ? err.message : '')).trim()
  }
}

export function runGit(args, cwd, { raw = false, transport = TRANSPORT.has(args[0]) } = {}) {
  try {
    if (transport && cwd) {
      const unsafe = executableLocalConfig(cwd)
      if (unsafe.length) throw new Error('untrusted checkout Git configuration: ' + unsafe.join(', '))
    }
    const trusted = transport ? trustedTransport(process.env) : []
    const out = execFileSync('git', [...GIT_HARDENING, ...trusted, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(process.env, transport),
    })
    return raw ? out : out.trim()
  } catch (err) { throw new GitError(args, err) }
}

// Compare the index, committed tree and literal worktree bytes. Refresh/diff plumbing can invoke clean/process
// filters when stat data is stale; hashing ourselves never interprets attributes or executes a filter.
export function isDirty(dir) {
  const head = new Map(runGit(['ls-tree', '-r', '-z', 'HEAD'], dir, { raw: true }).split('\0').filter(Boolean).map(entry => {
    const split = entry.indexOf('\t')
    const [mode, , hash] = entry.slice(0, split).split(' ')
    return [entry.slice(split + 1), { mode, hash }]
  }))
  const index = runGit(['ls-files', '--stage', '-z'], dir, { raw: true }).split('\0').filter(Boolean)
  if (index.length !== head.size) return true
  const algo = runGit(['rev-parse', '--show-object-format'], dir)
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let executable = true
  try { executable = runGit(['config', '--bool', 'core.filemode'], dir) !== 'false' } catch { /* Git's default */ }
  for (const entry of index) {
    const split = entry.indexOf('\t')
    const [mode, hash, stage] = entry.slice(0, split).split(' ')
    const name = entry.slice(split + 1)
    const committed = head.get(name)
    if (stage !== '0' || committed?.mode !== mode || committed?.hash !== hash) return true
    if (mode === '160000') continue // submodules are not entered
    const file = path.join(dir, name)
    let st
    try { st = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return true; throw error }
    const digest = crypto.createHash(algo)
    if (mode === '120000') {
      if (!st.isSymbolicLink()) return true
      const target = fs.readlinkSync(file, { encoding: 'buffer' })
      digest.update('blob ' + target.length + '\0').update(target)
    } else {
      if (!st.isFile() || (executable && !!(st.mode & 0o111) !== (mode === '100755'))) return true
      digest.update('blob ' + st.size + '\0')
      const fd = fs.openSync(file, 'r')
      try {
        for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) digest.update(buffer.subarray(0, n))
      } finally { fs.closeSync(fd) }
    }
    if (digest.digest('hex') !== hash) return true
  }
  return runGit(['ls-files', '--others', '--exclude-standard'], dir) !== ''
}

// Read local and worktree configuration without following includes. Included files are themselves a refusal:
// no checkout-controlled include can import executable settings behind this check.
export function executableLocalConfig(dir) {
  const keys = new Set()
  for (const scope of ['--local', '--worktree']) {
    const out = runGit(['config', scope, '--no-includes', '--list', '-z'], dir)
    for (const entry of out.split('\0').filter(Boolean)) {
      const key = entry.split('\n', 1)[0].toLowerCase()
      if (EXECUTABLE_KEY.test(key)) keys.add(key)
    }
  }
  return [...keys]
}
