#!/usr/bin/env node
// Every subprocess call goes through execFileSync with an argv array -- no shell, so no path or ref
// can be interpolated into a command line.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

export const EXIT = { OK: 0, FAIL: 1, REFUSED: 2, NEEDS_INPUT: 3 }
export const MAX_PLUGIN_SCHEMA = 1
export const CORE_API = 1
// The schema version of a step row's "provides" object (PLUGIN_CONTRACT.md §5's documented upgrade
// path). Same discipline as MAX_PLUGIN_SCHEMA: a higher value is refused, never best-effort parsed --
// a version nothing refuses on is decorative.
export const MAX_PROVIDES_SCHEMA = 1
// Asserted against the highest "## N." heading in docs/PLUGIN_CONTRACT.md by a test, so this
// cannot silently drift from the document it advertises.
export const CONTRACT_REVISION = 14
export const DEFAULT_ORG = 'img2threejs'
const MIN_NODE = 18
const LOCK_STALE_MS = 60 * 60 * 1000
const HARNESS_REPO_URL = 'https://github.com/img2threejs/img2'
const LINK_PREFIX = 'img2-'
const LEGACY_LINK_NAME = 'img2threejs'
const NAME_RE = /^[a-z][a-z0-9-]*$/
// The fields `cmdAdd` itself writes on a registry row; anything else on an existing row is
// someone else's data and MUST survive a `--force` replace (contract section 6, rule 4).
const ROW_KEYS = ['id', 'repo', 'ref', 'resolvedSha', 'addedAt']

export class CliError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

// os.homedir() honours $HOME, so tests can inject a sandbox home; os.userInfo().homedir does not.
const home = () => os.homedir()
const xdgConfig = () => process.env.XDG_CONFIG_HOME || path.join(home(), '.config')

export const HOSTS = {
  claude: {
    label: 'Claude Code',
    configRoot: () => path.join(home(), '.claude'),
    skills: () => path.join(home(), '.claude', 'skills'),
    settings: () => path.join(home(), '.claude', 'settings.json'),
  },
  codex: {
    label: 'Codex',
    configRoot: () => path.join(home(), '.codex'),
    skills: () => path.join(home(), '.codex', 'skills'),
  },
  opencode: {
    label: 'OpenCode',
    configRoot: () => path.join(xdgConfig(), 'opencode'),
    skills: () => path.join(xdgConfig(), 'opencode', 'skills'),
  },
}

const detectedHosts = () => Object.keys(HOSTS).filter((k) => fs.existsSync(HOSTS[k].configRoot()))

// ---------------------------------------------------------------- home & layout

export function resolveImg2Home(flagHome, warn = (m) => console.error(m)) {
  const validated = (raw, label) => {
    if (raw.startsWith('~')) {
      throw new CliError(EXIT.REFUSED, label + ' must not begin with "~" -- the shell expands it, the CLI does not', raw)
    }
    if (!path.isAbsolute(raw)) throw new CliError(EXIT.REFUSED, label + ' must be an absolute path', raw)
    return raw
  }
  if (flagHome) return validated(flagHome, '--home')
  if (process.env.IMG2_HOME) return validated(process.env.IMG2_HOME, 'IMG2_HOME')
  if (process.env.IMG2THREEJS_HOME) {
    warn('img2: IMG2THREEJS_HOME is deprecated and honoured for one release; set IMG2_HOME instead')
    return validated(process.env.IMG2THREEJS_HOME, 'IMG2THREEJS_HOME')
  }
  return path.join(home(), '.img2')
}

const harnessDir = (H) => path.join(H, 'harness')
const pluginsDir = (H) => path.join(H, 'plugins')
const generatedDir = (H) => path.join(H, 'generated')
const backupsDir = (H) => path.join(H, 'backups')
const registryPath = (H) => path.join(H, 'plugins.json')
const receiptsPath = (H) => path.join(H, 'receipts.json')
const lockPath = (H) => path.join(H, '.lock')
const cloneDir = (H, id) => path.join(pluginsDir(H), id)
const linkName = (id) => LINK_PREFIX + id
const localStanza = (H) => 'CORE = ' + JSON.stringify(harnessDir(H)) + '\n'

export function harnessVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

// ---------------------------------------------------------------- git

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim()
  } catch (err) {
    if (err.code === 'ENOENT') throw new CliError(EXIT.FAIL, 'git is not on PATH; install git first')
    throw new CliError(EXIT.FAIL, 'git ' + args.join(' ') + ' failed', String(err.stderr || '').trim())
  }
}

function isGitRepo(dir) {
  try {
    git(['rev-parse', '--git-dir'], dir)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- npm & tar

// npm and tar warn on stderr for reasons that have nothing to do with success (e.g. a machine-wide
// NODE_TLS_REJECT_UNAUTHORIZED=0 makes npm print a TLS warning) -- only a non-zero exit is a failure,
// stderr content on its own is not, same as `git` above.
function npm(args) {
  try {
    return execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    if (err.code === 'ENOENT') throw new CliError(EXIT.FAIL, 'npm is not on PATH; install npm first')
    throw new CliError(EXIT.FAIL, 'npm ' + args.join(' ') + ' failed', String(err.stderr || '').trim())
  }
}

function tar(args) {
  try {
    execFileSync('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    if (err.code === 'ENOENT') throw new CliError(EXIT.FAIL, 'tar is not on PATH; install tar first')
    throw new CliError(EXIT.FAIL, 'tar ' + args.join(' ') + ' failed', String(err.stderr || '').trim())
  }
}

// ---------------------------------------------------------------- semver

export function parseSemver(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(s).trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function cmpSemver(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export function rangeSatisfied(range, version) {
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(range).trim())
  if (!m) {
    throw new CliError(
      EXIT.FAIL,
      'unsupported requires.harness range "' + range + '"',
      'this harness understands only ">=X.Y.Z" (missing minor/patch default to 0); rewrite the range or update the harness',
    )
  }
  const min = [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)]
  const v = parseSemver(version)
  if (!v) throw new CliError(EXIT.FAIL, 'unparseable harness version: ' + version)
  return cmpSemver(v, min) >= 0
}

// ---------------------------------------------------------------- source trust

export function resolveSource(spec, allowAny) {
  const refuse = (what) => {
    throw new CliError(
      EXIT.REFUSED,
      'source ' + what + ' is outside the default ' + DEFAULT_ORG + '/* org',
      'pass --allow-any-source to accept ' + spec,
    )
  }
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(spec)
  if (shorthand) {
    if (shorthand[1] !== DEFAULT_ORG && !allowAny) refuse('org "' + shorthand[1] + '"')
    return { url: 'https://github.com/' + spec + '.git', label: spec, defaultOrg: shorthand[1] === DEFAULT_ORG }
  }
  const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(spec)
  const defaultOrg = Boolean(gh && gh[1] === DEFAULT_ORG)
  if (!defaultOrg && !allowAny) refuse('"' + spec + '"')
  return { url: spec, label: spec, defaultOrg }
}

// An `npm:` spec is `npm:<name>` or `npm:<name>@<version>`; `<name>` may itself start with a
// scope ("@scope/pkg"), so the version separator is the first "@" AFTER that leading one, not the
// first "@" in the string.
export function parseNpmSpec(spec) {
  const rest = spec.slice('npm:'.length)
  const at = rest.startsWith('@') ? rest.indexOf('@', 1) : rest.indexOf('@')
  const name = at === -1 ? rest : rest.slice(0, at)
  const version = at === -1 ? null : rest.slice(at + 1)
  if (!name) throw new CliError(EXIT.REFUSED, 'npm: source needs a package name', spec)
  if (version === '') throw new CliError(EXIT.REFUSED, 'npm: source has an empty version after "@"', spec)
  return { name, version }
}

// The npm equivalent of `resolveSource`'s org check: the default-trusted scope is "@<DEFAULT_ORG>",
// matching the "@img2threejs/plugin-*" packages this harness's own plugins are published as.
// Unscoped packages are never default-trusted, same as a bare non-shorthand git URL.
export function resolveNpmSource(name, allowAny) {
  const scoped = /^@([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(name)
  const defaultOrg = Boolean(scoped && scoped[1] === DEFAULT_ORG)
  if (!defaultOrg && !allowAny) {
    throw new CliError(
      EXIT.REFUSED,
      'source npm package "' + name + '" is outside the default @' + DEFAULT_ORG + ' scope',
      'pass --allow-any-source to accept npm:' + name,
    )
  }
  return { defaultOrg }
}

// ---------------------------------------------------------------- manifest

export function validateManifest(manifest, where) {
  const at = where ? ' at ' + where : ''
  const fail = (msg) => {
    throw new CliError(EXIT.FAIL, 'invalid plugin manifest' + at + ': ' + msg)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('not a JSON object')
  if (!Number.isInteger(manifest.schema) || manifest.schema < 1) fail('"schema" must be an integer >= 1')
  if (manifest.schema > MAX_PLUGIN_SCHEMA) {
    throw new CliError(
      EXIT.FAIL,
      'plugin manifest schema ' + manifest.schema + ' is newer than this harness reads (MAX_PLUGIN_SCHEMA=' + MAX_PLUGIN_SCHEMA + ')' + at,
      'refusing to best-effort parse; update the harness',
    )
  }
  if (typeof manifest.name !== 'string' || !NAME_RE.test(manifest.name)) fail('"name" must match [a-z][a-z0-9-]*')
  if (typeof manifest.version !== 'string' || !parseSemver(manifest.version)) fail('"version" must be X.Y.Z')
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) fail('"description" must be a non-empty string')
  if (!Array.isArray(manifest.capabilities)) fail('"capabilities" must be an array of {from, to}')
  for (const cap of manifest.capabilities) {
    if (!cap || typeof cap !== 'object' || typeof cap.from !== 'string' || !cap.from || typeof cap.to !== 'string' || !cap.to) {
      fail('every capability needs non-empty string "from" and "to"')
    }
  }
  if ('overrides' in manifest) {
    fail('"overrides" is reserved for user-authored pipeline overrides in plugins.json; a plugin manifest MUST NOT declare it (contract section 6)')
  }
  const req = manifest.requires
  if (!req || typeof req !== 'object' || Array.isArray(req)) fail('"requires" must be an object with "harness" and "coreApi"')
  if (typeof req.harness !== 'string') fail('"requires.harness" must be a semver range string')
  if (!rangeSatisfied(req.harness, harnessVersion())) {
    throw new CliError(
      EXIT.FAIL,
      'plugin "' + manifest.name + '" requires harness "' + req.harness + '" but this harness is ' + harnessVersion(),
      'blocked: a version mismatch can emit wrong geometry that passes visual gates by luck',
    )
  }
  if (!Number.isInteger(req.coreApi)) fail('"requires.coreApi" must be an integer')
  if (req.coreApi !== CORE_API) {
    throw new CliError(
      EXIT.FAIL,
      'plugin "' + manifest.name + '" requires coreApi ' + req.coreApi + ' but this harness provides coreApi ' + CORE_API,
    )
  }
  return manifest
}

function readManifest(dir) {
  const p = path.join(dir, 'plugin.json')
  if (!fs.existsSync(p)) throw new CliError(EXIT.FAIL, 'no plugin.json in ' + dir)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    throw new CliError(EXIT.FAIL, p + ' is not valid JSON: ' + err.message)
  }
  const manifest = validateManifest(parsed, p)
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
    throw new CliError(EXIT.FAIL, 'plugin "' + manifest.name + '" has no SKILL.md (required by the contract, section 4)')
  }
  return manifest
}

// ---------------------------------------------------------------- registry

export const emptyRegistry = () => ({ version: 1, plugins: [] })

export function readRegistry(H) {
  const p = registryPath(H)
  if (!fs.existsSync(p)) return emptyRegistry()
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    throw new CliError(EXIT.FAIL, p + ' is not valid JSON: ' + err.message)
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.plugins)) {
    throw new CliError(EXIT.FAIL, p + ' is not a version-1 registry ({version:1, plugins:[]})')
  }
  return parsed
}

export function writeRegistry(H, reg) {
  fs.mkdirSync(H, { recursive: true })
  fs.writeFileSync(registryPath(H), JSON.stringify(reg, null, 2) + '\n')
}

export const findRow = (reg, id) => reg.plugins.find((r) => r.id === id)

export function addRow(reg, row) {
  const existing = findRow(reg, row.id)
  if (existing) {
    throw new CliError(
      EXIT.FAIL,
      'plugin "' + row.id + '" is already registered',
      'row: ' + JSON.stringify(existing) + ' -- pass --force to replace it',
    )
  }
  reg.plugins.push(row)
  return reg
}

export function removeRow(reg, id) {
  const row = findRow(reg, id)
  if (!row) {
    throw new CliError(EXIT.FAIL, 'no registered plugin "' + id + '"', 'registered: ' + (reg.plugins.map((r) => r.id).join(', ') || '(none)'))
  }
  reg.plugins = reg.plugins.filter((r) => r.id !== id)
  return row
}

// ---------------------------------------------------------------- receipts

function readReceipts(H) {
  try {
    const parsed = JSON.parse(fs.readFileSync(receiptsPath(H), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeReceipts(H, entries) {
  fs.mkdirSync(H, { recursive: true })
  fs.writeFileSync(receiptsPath(H), JSON.stringify(entries, null, 2) + '\n')
}

function recordReceipt(H, entry) {
  const entries = readReceipts(H).filter((e) => e.target !== entry.target)
  entries.push({ ...entry, createdAt: new Date().toISOString(), cliVersion: harnessVersion() })
  writeReceipts(H, entries)
}

// ---------------------------------------------------------------- lock

let heldLock = null

function acquireLock(H) {
  const p = lockPath(H)
  fs.mkdirSync(H, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(p, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), at: new Date().toISOString() }))
      fs.closeSync(fd)
      heldLock = p
      return
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (Date.now() - fs.statSync(p).mtimeMs < LOCK_STALE_MS) {
        let holder = '(unreadable)'
        try {
          const h = JSON.parse(fs.readFileSync(p, 'utf8'))
          holder = 'pid ' + h.pid + ' on ' + h.hostname + ' since ' + h.at
        } catch { /* keep the placeholder */ }
        throw new CliError(EXIT.FAIL, 'another img2 run holds the lock at ' + p, holder)
      }
      fs.rmSync(p, { force: true })
    }
  }
}

function releaseLock() {
  if (heldLock) {
    fs.rmSync(heldLock, { force: true })
    heldLock = null
  }
}

// ---------------------------------------------------------------- links

function samePath(a, b) {
  const norm = (p) => {
    let r
    try {
      r = fs.realpathSync(p)
    } catch {
      r = path.resolve(p)
    }
    return process.platform === 'darwin' || process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

// lstat, never stat: stat follows symlinks and would misclassify a symlink-to-directory.
export function classifyTarget(target) {
  let st
  try {
    st = fs.lstatSync(target)
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'absent' }
    throw err
  }
  if (st.isSymbolicLink()) {
    const raw = fs.readlinkSync(target)
    const resolved = path.resolve(path.dirname(target), raw)
    return { state: 'symlink', raw, resolved, dangling: !fs.existsSync(target) }
  }
  return { state: st.isDirectory() ? 'directory' : 'file' }
}

// Ownership is judged on the literal link target, not realpath: a --link plugin's realpath lives in
// the user's checkout, but the host link still points inside $IMG2_HOME.
export function underHome(p, H) {
  const candidates = new Set([path.resolve(H)])
  try {
    candidates.add(fs.realpathSync(H))
  } catch { /* H may not exist yet */ }
  const probes = [path.resolve(p)]
  try {
    probes.push(path.join(fs.realpathSync(path.dirname(p)), path.basename(p)))
  } catch { /* parent may not exist */ }
  for (const c of candidates) {
    for (const probe of probes) {
      if (probe === c || probe.startsWith(c + path.sep)) return true
    }
  }
  return false
}

function assertClaimable(target, H) {
  const c = classifyTarget(target)
  if (c.state === 'absent') return c
  if (c.state === 'symlink' && underHome(c.resolved, H)) return c
  const what = c.state === 'symlink' ? 'symlink -> ' + c.resolved : c.state
  throw new CliError(
    EXIT.REFUSED,
    target + ' is occupied by a foreign ' + what,
    'img2 refuses to touch a path it does not own; move it aside yourself',
  )
}

function ensureLink(target, dest, H) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const c = assertClaimable(target, H)
  if (c.state === 'symlink') {
    if (!c.dangling && samePath(c.resolved, dest)) return 'already linked'
    fs.unlinkSync(target)
  }
  fs.symlinkSync(dest, target, 'junction')
  return c.state === 'absent' ? 'linked' : 'relinked'
}

// A git resolvedSha is a 40-hex commit SHA, where the first 7 chars are the conventional short
// form. An npm resolvedSha is `sha512-<base64>` (dist.integrity) -- slicing the first 7 chars of
// THAT would just print "sha512-", so this shows the first 7 chars of whichever part actually
// varies between installs.
function shortSha(resolvedSha) {
  const s = String(resolvedSha)
  return s.startsWith('sha512-') ? s.slice(7, 14) : s.slice(0, 7)
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid

function moveToBackups(H, src, label) {
  const dest = path.join(backupsDir(H), label + '-' + stamp())
  fs.mkdirSync(backupsDir(H), { recursive: true })
  if (fs.existsSync(dest)) throw new CliError(EXIT.FAIL, 'backup destination already exists: ' + dest)
  fs.renameSync(src, dest)
  return dest
}

// ---------------------------------------------------------------- settings merge

export function mergeAdditionalDirectories(settings, dir) {
  if (settings === undefined || settings === null) settings = {}
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    throw new CliError(EXIT.FAIL, 'settings root must be a JSON object; refusing to guess')
  }
  if (settings.permissions === undefined) settings.permissions = {}
  const perms = settings.permissions
  if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) {
    throw new CliError(EXIT.FAIL, '"permissions" in settings is not an object; refusing to guess')
  }
  if (perms.additionalDirectories === undefined) perms.additionalDirectories = []
  if (!Array.isArray(perms.additionalDirectories)) {
    throw new CliError(EXIT.FAIL, '"permissions.additionalDirectories" in settings is not an array; refusing to guess')
  }
  if (perms.additionalDirectories.includes(dir)) return { settings, changed: false }
  perms.additionalDirectories.push(dir)
  return { settings, changed: true }
}

function mergeSettingsFile(file, dir) {
  let current
  if (fs.existsSync(file)) {
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      throw new CliError(EXIT.FAIL, file + ' is not valid JSON; fix it before img2 edits it', err.message)
    }
  }
  const { settings, changed } = mergeAdditionalDirectories(current, dir)
  if (changed || !fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
  }
  return changed
}

// ---------------------------------------------------------------- launcher

export function launcherCandidates(envPath, homeDir) {
  const onPath = new Set(String(envPath || '').split(path.delimiter).filter(Boolean))
  return [path.join(homeDir, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter((d) => onPath.has(d))
}

function ensureLauncher(H) {
  const target = path.join(harnessDir(H), 'bin', 'img2.mjs')
  try {
    fs.chmodSync(target, 0o755)
  } catch {}
  const mineSuffix = path.join('harness', 'bin', 'img2.mjs')
  for (const dir of launcherCandidates(process.env.PATH, home())) {
    const link = path.join(dir, 'img2')
    let st = null
    try {
      st = fs.lstatSync(link)
    } catch {}
    if (st && !(st.isSymbolicLink() && fs.readlinkSync(link).endsWith(mineSuffix))) {
      console.log('  launcher  ' + link + ' exists and is not ours; skipped')
      continue
    }
    try {
      if (st) fs.unlinkSync(link)
      fs.symlinkSync(target, link)
      console.log('  launcher  ' + link + ' -> ' + target)
      return
    } catch {
      continue
    }
  }
  console.log('  launcher  no writable dir on PATH among ~/.local/bin, /opt/homebrew/bin, /usr/local/bin;')
  console.log('            add one, or use: alias img2="node ' + target + '"')
  console.log('            (every command also works as: npx github:img2threejs/img2 <command>)')
}

// ---------------------------------------------------------------- rows files (steps/gates)

function readRowsFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(path.basename(file) + ' must be a top-level JSON array of rows')
  return parsed
}

export function topoSort(rows, label) {
  const ids = new Set()
  for (const r of rows) {
    if (!r || typeof r.id !== 'string' || !r.id) throw new Error(label + ': every row needs a string "id"')
    if (ids.has(r.id)) throw new Error(label + ': duplicate id "' + r.id + '"')
    ids.add(r.id)
  }
  for (const r of rows) {
    const after = r.after || []
    if (!Array.isArray(after) || after.some((a) => typeof a !== 'string')) {
      throw new Error(label + ': "' + r.id + '" has a non-array "after"')
    }
    for (const dep of after) {
      if (!ids.has(dep)) throw new Error(label + ': "' + r.id + '" comes after unknown id "' + dep + '"')
    }
  }
  const remaining = new Map(rows.map((r) => [r.id, new Set(r.after || [])]))
  const order = []
  while (remaining.size) {
    const ready = rows.filter((r) => remaining.has(r.id) && ![...remaining.get(r.id)].some((d) => remaining.has(d)))
    if (!ready.length) throw new Error(label + ': dependency cycle among ' + [...remaining.keys()].join(', '))
    for (const r of ready) {
      order.push(r)
      remaining.delete(r.id)
    }
  }
  return order
}

// ---------------------------------------------------------------- generated artifacts

function computeGenerated(H, reg) {
  const rows = [...reg.plugins].sort((a, b) => a.id.localeCompare(b.id))
  const routes = []
  const lines = ['# img2 plugins', '', 'Generated by `img2 sync`; do not edit, edits are overwritten.', '']
  if (!rows.length) {
    lines.push('(no plugins registered)')
  } else {
    lines.push('| plugin | version | capability | description | skill link |')
    lines.push('| --- | --- | --- | --- | --- |')
    const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
    for (const row of rows) {
      const manifest = readManifest(cloneDir(H, row.id))
      const caps = manifest.capabilities.length ? manifest.capabilities : [null]
      for (const cap of caps) {
        const edge = cap ? cell(cap.from) + ' -> ' + cell(cap.to) : '(none)'
        lines.push('| ' + [row.id, manifest.version, edge, cell(manifest.description), linkName(row.id)].join(' | ') + ' |')
        if (cap) routes.push({ from: cap.from, to: cap.to, plugin: row.id })
      }
    }
  }
  routes.sort((a, b) => (a.from + ' ' + a.to + ' ' + a.plugin).localeCompare(b.from + ' ' + b.to + ' ' + b.plugin))
  return {
    index: lines.join('\n') + '\n',
    routes: JSON.stringify({ version: 1, routes }, null, 2) + '\n',
    local: localStanza(H),
  }
}

// python3 tools/x.py puts tools/, not the clone root, at sys.path[0], so the fallback module must
// also sit next to the scripts (contract section 8).
function localFiles(dir) {
  const files = [path.join(dir, '_img2_local.py')]
  const tools = path.join(dir, 'tools')
  if (fs.existsSync(tools)) files.push(path.join(tools, '_img2_local.py'))
  return files
}

// Scoped to the two files img2 capabilities (§13) is allowed to refuse on -- a stale per-clone
// _img2_local.py must never deny an unrelated query.
function generatedIndexTargets(H, expected) {
  return [
    { file: path.join(generatedDir(H), 'index.md'), want: expected.index },
    { file: path.join(generatedDir(H), 'routes.json'), want: expected.routes },
  ]
}

function syncTargets(H, reg) {
  const expected = computeGenerated(H, reg)
  const targets = generatedIndexTargets(H, expected)
  for (const row of reg.plugins) {
    for (const file of localFiles(cloneDir(H, row.id))) targets.push({ file, want: expected.local })
  }
  return targets
}

function syncAll(H, check) {
  if (!fs.existsSync(harnessDir(H))) {
    throw new CliError(EXIT.FAIL, 'no harness checkout at ' + harnessDir(H), 'run `img2 install` first')
  }
  const reg = readRegistry(H)
  const targets = syncTargets(H, reg)
  const drift = targets.filter((t) => {
    try {
      return fs.readFileSync(t.file, 'utf8') !== t.want
    } catch {
      return true
    }
  })
  if (check) {
    for (const t of drift) console.log('drift: ' + t.file)
    if (drift.length) {
      throw new CliError(EXIT.FAIL, 'generated artifacts are out of sync (' + drift.length + ' file(s)); run `img2 sync`')
    }
    console.log('sync check: clean (' + reg.plugins.length + ' plugin(s))')
    return
  }
  fs.mkdirSync(generatedDir(H), { recursive: true })
  for (const t of drift) fs.writeFileSync(t.file, t.want)
  console.log('synced ' + reg.plugins.length + ' plugin(s); ' + drift.length + ' file(s) updated')
}

// ---------------------------------------------------------------- static checks

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

function* walkPy(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walkPy(p)
    else if (entry.name.endsWith('.py')) yield p
  }
}

export function staticToolFindings(pluginDir, id, allIds) {
  const out = []
  const toolsDir = path.join(pluginDir, 'tools')
  if (!fs.existsSync(toolsDir)) return out
  const others = allIds.filter((x) => x !== id)
  for (const file of walkPy(toolsDir)) {
    const text = fs.readFileSync(file, 'utf8')
    const rel = path.relative(pluginDir, file)
    if (/\.parents\[/.test(text)) {
      out.push(rel + ' computes a repo root via Path(...).parents[N]; take --workspace and use img2_core.paths instead')
    }
    if (/^\s*(from\s+forge[.\s]|import\s+forge\b)/m.test(text)) {
      out.push(rel + ' imports forge.* (a host-checkout path); plugins must not import the old checkout')
    }
    for (const other of others) {
      const mods = new Set([other, other.replace(/-/g, '_')])
      let hit = false
      for (const mod of mods) {
        const re = new RegExp('^\\s*(import\\s+' + escapeRe(mod) + '\\b|from\\s+' + escapeRe(mod) + '\\b)', 'm')
        if (re.test(text)) {
          hit = true
          break
        }
      }
      if (hit) {
        out.push(rel + ' imports another registered plugin ("' + other + '"); cross-plugin handoff is files in <workspace>/.img2/artifacts/')
      }
    }
  }
  return out
}

const ALLOWED_PLACEHOLDERS = new Set(['{plugin_dir}', '{workspace}', '{image}', '{spec}'])
const SHELL_METACHAR_RE = /[;|&$`><()\n]/

// Who carries out a row. Only a "program" row is handed back as argv; "agent" and "human" rows are
// handed back as an instruction string, which is how a prose step is expressed legally.
export const ROW_ACTORS = new Set(['program', 'agent', 'human'])

// A caller executes argv[0] directly, so a bare word that merely happens to sit on PATH is the
// dangerous case -- not a typo. Measured on a stock macOS box: "Read" resolves to /usr/bin/Read
// (case-insensitive APFS) and "Analyze" resolves to a real ImageMagick binary, so the prose row
// `Analyze the reference image` would run ImageMagick with the prose as its arguments and exit 0.
// No static check can tell prose from a command, so a program row's argv[0] must be a path form --
// which cannot collide with an English word by accident -- or one of these interpreters. Anything
// else must either be wrapped in a script under {plugin_dir} or declare a non-program actor.
const INTERPRETERS = new Set(['python3', 'python', 'node', 'bash', 'sh'])

// Validates a whole row: the actor it declares, then its command under that actor's rules. Doctor
// and the capability query both come through here, so they cannot drift apart.
export function rowFinding(row, pluginDir, isGate = false) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'row is not a JSON object'
  if ('actor' in row) {
    if (!ROW_ACTORS.has(row.actor)) {
      return '"actor" must be one of ' + [...ROW_ACTORS].join(', ') + ' (got ' + JSON.stringify(row.actor) + ')'
    }
    if (isGate && row.actor !== 'program') {
      return 'a gate must be executable: "actor" must be "program", not ' + JSON.stringify(row.actor) + ', because a gate has to produce a verdict'
    }
  }
  return commandFinding(row.command, pluginDir, row.actor || 'program')
}

// Split out so a caller can apply metacharacter hardening without the executable-form (argv0) rule --
// exactly the "instruction row" case: a row nothing ever execs as argv still needs its placeholders
// and metacharacters checked, per plugin-declaration-validation's "one rule keyed on execution
// semantics" requirement, but not a leading-token/interpreter check that presumes something runs it.
// `placeholders` defaults to the harness-side vocabulary (steps.json/gates.json); a caller whose
// declaration file has its own closed set (domain.json) passes that set instead, so a placeholder
// legal only in the OTHER vocabulary is not mistaken for literal text a metacharacter could hide in.
export function shellMetacharFinding(command, placeholders = ALLOWED_PLACEHOLDERS) {
  let stripped = command
  for (const p of placeholders) stripped = stripped.replaceAll(p, '')
  const metachars = stripped.match(new RegExp(SHELL_METACHAR_RE, 'g'))
  if (metachars) {
    return 'command contains shell metacharacter(s) ' + [...new Set(metachars)].join(' ') + '; commands run without a shell and must not need one'
  }
  return null
}

export function commandFinding(command, pluginDir, actor = 'program') {
  if (typeof command !== 'string' || !command.trim()) return 'empty "command"'

  const bracePattern = /\{[^{}]*\}/g
  let brace
  while ((brace = bracePattern.exec(command))) {
    if (!ALLOWED_PLACEHOLDERS.has(brace[0])) {
      return 'command uses unrecognised placeholder ' + brace[0] + '; only {plugin_dir}, {workspace}, {image} and {spec} are permitted'
    }
  }

  const angle = /<[^<>\n]*>/.exec(command)
  if (angle) {
    return 'command uses angle-bracket pseudo-placeholder ' + angle[0] + '; a shell would read this as redirection, not a placeholder'
  }

  // Everything below concerns executing the command as argv. A row carried out by the agent or a
  // human is never executed that way, so the leading-token/interpreter rule does not apply there --
  // this preserves the existing steps.json "actor": "agent" carve-out (which also skips metachar
  // hardening today; a pre-existing behaviour this rework does not change -- see the report).
  if (actor !== 'program') return null

  const metaBad = shellMetacharFinding(command)
  if (metaBad) return metaBad

  const argv0 = (shlexSplit(command)[0] || '').replaceAll('{plugin_dir}', pluginDir)
  if (argv0.includes(path.sep)) {
    if (!fs.existsSync(path.resolve(pluginDir, argv0))) return 'argv[0] "' + argv0 + '" does not exist'
  } else if (!INTERPRETERS.has(argv0)) {
    return (
      'argv[0] "' +
      argv0 +
      '" is a bare word, not a path and not a known interpreter (' +
      [...INTERPRETERS].join(', ') +
      '); a bare word can silently resolve to an unrelated program on PATH. Wrap it in a script under {plugin_dir}, or if this row is prose for the agent to carry out, declare "actor": "agent"'
    )
  }

  for (const token of command.split(/\s+/).filter(Boolean)) {
    if (token.includes('{workspace}') || token.includes('{image}') || token.includes('{spec}')) continue
    const sub = token.replaceAll('{plugin_dir}', pluginDir)
    if (!/\.(py|mjs|js|sh)$/.test(sub)) continue
    const p = path.isAbsolute(sub) ? sub : path.join(pluginDir, sub)
    if (!fs.existsSync(p)) return 'command references a missing file: ' + token
  }
  return null
}

// ---------------------------------------------------------------- argv tokenisation

// shlex-equivalent splitting -- the same algorithm img2_core/gate_runner.py:90-93 already runs
// before substituting values, so there is one tokenisation algorithm for the project, not two.
export function shlexSplit(command) {
  const tokens = []
  let current = ''
  let quote = null
  let started = false
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

// {workspace} and {image} are deliberately left untouched: the caller replaces each by value,
// per D-D, and the argv shape then guarantees a space-containing value survives as one argument.
export function stepArgv(command, pluginDir) {
  return shlexSplit(command).map((token) => token.replaceAll('{plugin_dir}', pluginDir))
}

function gateRunnerArgv(H, dir) {
  return ['python3', path.join(harnessDir(H), 'img2_core', 'gate_runner.py'), '--plugin-dir', dir, '--workspace', '{workspace}']
}

// ---------------------------------------------------------------- provides (emission target contract)

// A declared artifact path must resolve under this plugin's own subtree of the workspace artifacts
// area -- never escape it via an absolute path or a ".." segment, and never land in another plugin's
// subtree. Checked here (statically, at doctor) and again at runtime by the socket that writes the
// file (PLUGIN_CONTRACT.md's "provides.artifact.path" rule).
export function artifactPathEscapes(declaredPath, pluginId) {
  if (typeof declaredPath !== 'string' || !declaredPath) return true
  if (path.isAbsolute(declaredPath) || declaredPath.startsWith('~')) return true
  const prefix = path.posix.join('.img2', 'artifacts', pluginId) + '/'
  const normalized = path.posix.normalize(declaredPath)
  if (normalized === '..' || normalized.startsWith('../')) return true
  return !normalized.startsWith(prefix)
}

// Validates a step row's "provides" object in isolation -- schema shape and the artifact-path escape
// rule. Cross-plugin consistency (manifest edge <-> step, duplicate providers, terminal ordering) needs
// the full registry and is checked only by `cmdDoctor`, which has it; this is the part `capabilities`
// (via `unsafeRowFinding`) can and must also check so the two never disagree on a malformed row.
export function providesFinding(provides, pluginId) {
  if (!provides || typeof provides !== 'object' || Array.isArray(provides)) return '"provides" must be an object'
  if (!Number.isInteger(provides.version) || provides.version < 1) return '"provides.version" must be an integer >= 1'
  if (provides.version > MAX_PROVIDES_SCHEMA) {
    return 'provides.version ' + provides.version + ' is newer than this harness reads (MAX_PROVIDES_SCHEMA=' + MAX_PROVIDES_SCHEMA + ')'
  }
  if (typeof provides.from !== 'string' || !provides.from) return '"provides.from" must be a non-empty string'
  if (typeof provides.to !== 'string' || !provides.to) return '"provides.to" must be a non-empty string'
  const artifact = provides.artifact
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return '"provides.artifact" must be an object'
  if (typeof artifact.kind !== 'string' || !artifact.kind) return '"provides.artifact.kind" must be a non-empty string'
  if (typeof artifact.path !== 'string' || !artifact.path) return '"provides.artifact.path" must be a non-empty string'
  if (artifactPathEscapes(artifact.path, pluginId)) {
    return (
      '"provides.artifact.path" ' +
      JSON.stringify(artifact.path) +
      ' must resolve under .img2/artifacts/' +
      pluginId +
      '/'
    )
  }
  return null
}

// Mirrors forge/_shared/targets.py's _plugin_targets() exactly -- the base's own authority for these
// two fields, since it is the base that actually resolves and invokes a target. Read directly before
// writing this (2026-08-31): `deterministic` is required as a boolean sibling of `provides` on the
// step row (D7), never nested inside it; `timeoutSeconds` is optional, and when present must be a
// positive integer. Scoped to actual target-providing steps (provides.from === "sculpt-spec") because
// that is exactly targets.py's own scope -- a provides row for any other edge is never resolved as a
// target, so the base never looks at these siblings for it either, and doctor should not invent a
// stricter rule than the base actually enforces.
export function targetSiblingFinding(step) {
  if (typeof step.deterministic !== 'boolean') {
    return '"deterministic" must be declared as a boolean beside "provides" (D7)'
  }
  if (step.timeoutSeconds !== undefined && step.timeoutSeconds !== null) {
    if (!Number.isInteger(step.timeoutSeconds) || step.timeoutSeconds <= 0) {
      return '"timeoutSeconds" must be a positive integer'
    }
  }
  return null
}

// ---------------------------------------------------------------- domain.json / spec_search_profile.json

// Mirrors forge/_shared/domains/__init__.py's `_ALLOWED` exactly -- an unknown key there is a base
// refusal (DomainRegistryError), so it must be a harness refusal too, or a typo'd key would pass
// `doctor` clean and only fail once the base actually loads it.
const DOMAIN_JSON_ALLOWED_KEYS = new Set(['id', 'setupSteps', 'setupAnchorBefore', 'passSteps', 'passAnchorBefore', 'specCollection', 'rigSteps'])

// `domain.json` steps arrive as `[stepId, command]` pairs (not `{id, command}` rows) and carry no
// `actor` field -- the base splices them straight into a checklist (forge/_shared/domains/__init__.py,
// workflow_state.py), never executing them as argv. So every row here needs classifying by its OWN
// leading token, the same way steps.json's actor field would classify it if the schema had one:
// a path form or a known interpreter (the same `INTERPRETERS` set the argv0 rule recognises) names a
// COMMAND ROW -- something a real caller (the plugin's own tool, invoked by the base or by hand) runs,
// so shell-metacharacter hardening applies; anything else is a PROSE INSTRUCTION ROW nothing ever execs
// as argv, so metacharacters in it are just English punctuation, not a shell hazard. The executable-
// form (argv0) rule itself never applies to EITHER kind here -- domain.json has no actor key to let a
// command row declare itself executable the way a steps.json "program" row does, so there is no
// "bare word resolves to an unrelated program" hazard this file's schema can even express, and no
// message here may suggest `"actor": "agent"` as the fix. The house's own documented domain profile
// (plugin-wiki's interiors cookbook, `docs/plugin-wiki/03-cookbook.md:78-81`) ships exactly this mix:
// two prose setupSteps (one with parentheses -- a shell metacharacter) and two python3-led ones. A
// metachar rule applied to every row, or an argv0 rule applied to any row, would each invalidate that
// published example one way or the other.
//
// domain.json's placeholder vocabulary is NOT the harness's steps.json/gates.json set -- it is its own
// two consumers' set, verified directly: `{plugin_dir}` is resolved by a plain string `.replace()` at
// splice time (domains/__init__.py:137-141), and `{reference}`, `{spec}`, `{pass_id}` are resolved by
// Python `str.format()` at render time (workflow_state.py:239-243, `_format_command`). `.format()`
// raises `KeyError` on any other `{...}` name, including the harness's own `{workspace}`/`{image}` --
// so a domain.json command using either of those would crash at runtime, not just fail doctor.
const DOMAIN_JSON_ALLOWED_PLACEHOLDERS = new Set(['{plugin_dir}', '{reference}', '{spec}', '{pass_id}'])

// A path form (contains a path separator once {plugin_dir} is resolved) or a known interpreter marks a
// row a caller actually runs; anything else is prose. No file-existence check here (unlike commandFinding's
// program-row check) -- classification only decides whether metachar hardening applies, not whether the
// row is safe to execute, since nothing here is ever handed back as argv for a caller to execute.
function isDomainCommandRow(command, pluginDir) {
  const leading = (shlexSplit(command)[0] || '').replaceAll('{plugin_dir}', pluginDir)
  return leading.includes(path.sep) || INTERPRETERS.has(leading)
}

function domainPlaceholderFinding(command) {
  const bracePattern = /\{[^{}]*\}/g
  let brace
  while ((brace = bracePattern.exec(command))) {
    if (!DOMAIN_JSON_ALLOWED_PLACEHOLDERS.has(brace[0])) {
      return (
        'command uses unrecognised placeholder ' +
        brace[0] +
        '; only {plugin_dir}, {reference}, {spec} and {pass_id} are permitted in domain.json (its own ' +
        'vocabulary, resolved by forge/_shared/domains/__init__.py and workflow_state.py -- not the ' +
        'harness steps.json/gates.json set)'
      )
    }
  }
  const angle = /<[^<>\n]*>/.exec(command)
  if (angle) {
    return 'command uses angle-bracket pseudo-placeholder ' + angle[0] + '; a shell would read this as redirection, not a placeholder'
  }
  return null
}

export function domainJsonFindings(dir, pluginId) {
  const out = []
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'domain.json'), 'utf8'))
  } catch (e) {
    return ['domain.json is not valid JSON: ' + e.message]
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['domain.json must be a JSON object']
  const unknown = Object.keys(raw).filter((k) => !DOMAIN_JSON_ALLOWED_KEYS.has(k))
  if (unknown.length) out.push('domain.json has unknown key(s): ' + unknown.join(', '))
  if (typeof raw.id !== 'string' || !raw.id) out.push('domain.json: "id" must be a non-empty string')

  const checkSteps = (key, anchorKey) => {
    const steps = raw[key]
    if (steps === undefined) return
    if (!Array.isArray(steps)) {
      out.push('domain.json: "' + key + '" must be an array')
      return
    }
    for (const entry of steps) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || typeof entry[1] !== 'string' || !entry[1]) {
        out.push('domain.json: "' + key + '" entries must be [stepId, command] pairs of non-empty strings')
        continue
      }
      const [stepId, command] = entry
      // domain.json's own placeholder set (not the harness's); metachar hardening only on command rows
      // (a path form or known interpreter leads them); never the argv0 rule -- see the comment above.
      const bad =
        domainPlaceholderFinding(command) ||
        (isDomainCommandRow(command, dir) ? shellMetacharFinding(command, DOMAIN_JSON_ALLOWED_PLACEHOLDERS) : null)
      if (bad) out.push('domain.json "' + stepId + '": ' + bad)
    }
    if (anchorKey && steps.length && (typeof raw[anchorKey] !== 'string' || !raw[anchorKey])) {
      out.push('domain.json: "' + key + '" is non-empty but "' + anchorKey + '" is missing')
    }
  }
  checkSteps('setupSteps', 'setupAnchorBefore')
  checkSteps('passSteps', 'passAnchorBefore')
  // rigSteps are appended after the FINAL steps as the rig track; there is no anchor by design
  // (forge/_shared/domains/__init__.py documents the same), so no anchor is demanded -- but every
  // row still gets the placeholder, angle-bracket and command-row metachar checks above.
  checkSteps('rigSteps', null)
  if ('specCollection' in raw && (typeof raw.specCollection !== 'string' || !raw.specCollection)) {
    out.push('domain.json: "specCollection" must be a non-empty string')
  }
  return out
}

// A `spec_search_profile.json` path resolves against the contributing plugin's own directory
// (forge/_shared/spec_search.py's `content_root`), never the workspace -- so containment is judged
// against the plugin dir, not `.img2/artifacts/<plugin-id>/` as `provides.artifact.path` is.
function pathEscapesPluginDir(p) {
  if (typeof p !== 'string' || !p) return true
  if (path.isAbsolute(p) || p.startsWith('~')) return true
  const normalized = path.posix.normalize(p)
  return normalized === '..' || normalized.startsWith('../')
}

export function specSearchProfileFindings(dir, pluginId) {
  const out = []
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'spec_search_profile.json'), 'utf8'))
  } catch (e) {
    return ['spec_search_profile.json is not valid JSON: ' + e.message]
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['spec_search_profile.json must be a JSON object']
  const collections = raw.collections
  if (!collections || typeof collections !== 'object' || Array.isArray(collections)) {
    return ['spec_search_profile.json: "collections" must be an object']
  }

  const checkPathList = (colName, field, value) => {
    if (value === undefined) return
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) {
      out.push('spec_search_profile.json: collections.' + colName + '.' + field + ' must be an array of non-empty strings')
      return
    }
    for (const p of value) {
      if (pathEscapesPluginDir(p)) {
        out.push('spec_search_profile.json: collections.' + colName + '.' + field + ' path ' + JSON.stringify(p) + ' must stay inside the plugin directory')
      }
    }
  }
  const checkPath = (colName, field, value) => {
    if (value === undefined) return
    if (typeof value !== 'string' || !value) {
      out.push('spec_search_profile.json: collections.' + colName + '.' + field + ' must be a non-empty string')
    } else if (pathEscapesPluginDir(value)) {
      out.push('spec_search_profile.json: collections.' + colName + '.' + field + ' path ' + JSON.stringify(value) + ' must stay inside the plugin directory')
    }
  }

  for (const [colName, col] of Object.entries(collections)) {
    if (!col || typeof col !== 'object' || Array.isArray(col)) {
      out.push('spec_search_profile.json: collections.' + colName + ' must be an object')
      continue
    }
    checkPathList(colName, 'source_roots', col.source_roots)
    checkPathList(colName, 'optional_source_roots', col.optional_source_roots)
    checkPathList(colName, 'distilled_records', col.distilled_records)
    checkPath(colName, 'documentation', col.documentation)
    checkPath(colName, 'cache', col.cache)
    if (col.term_aliases !== undefined) {
      if (!col.term_aliases || typeof col.term_aliases !== 'object' || Array.isArray(col.term_aliases)) {
        out.push('spec_search_profile.json: collections.' + colName + '.term_aliases must be an object')
      } else {
        for (const [term, aliases] of Object.entries(col.term_aliases)) {
          if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== 'string' || !a)) {
            out.push('spec_search_profile.json: collections.' + colName + '.term_aliases.' + term + ' must be an array of non-empty strings')
          }
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- prompts

async function confirmOrThrow(prompt) {
  if (!process.stdin.isTTY) {
    throw new CliError(EXIT.NEEDS_INPUT, 'confirmation needed but stdin is not a terminal', 'pass --yes')
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise((resolve) => {
      let settled = false
      // readline's answer callback never fires on EOF -- only 'close' does.
      rl.once('close', () => {
        if (!settled) {
          settled = true
          resolve(null)
        }
      })
      rl.question(prompt + ' [y/N] ', (a) => {
        settled = true
        resolve(a)
      })
    })
    if (answer === null || !/^(y|yes)$/i.test(String(answer).trim())) {
      throw new CliError(EXIT.REFUSED, 'cancelled; nothing was changed')
    }
  } finally {
    rl.close()
  }
}

export async function confirmOutOfOrgSource(url, defaultOrg, opts) {
  if (defaultOrg) return
  console.log('about to clone and link a non-' + DEFAULT_ORG + ' source: ' + url)
  if (opts.yes) return
  await confirmOrThrow('Proceed?')
}

// ---------------------------------------------------------------- commands

async function cmdInstall(opts) {
  const H = resolveImg2Home(opts.home)
  const legacyHome = path.join(home(), '.img2threejs')
  const legacyRepo = path.join(legacyHome, 'repo')
  const legacyExists = fs.existsSync(legacyRepo)
  if (legacyExists && !opts.migrateLegacy) {
    throw new CliError(
      EXIT.REFUSED,
      'legacy install detected at ' + legacyRepo,
      [
        'the img2 harness replaces the old img2threejs installer layout.',
        'run `img2 install --migrate-legacy` to move the old checkout into ' + backupsDir(H) + ' and continue,',
        'or move ' + legacyHome + ' aside yourself first.',
      ].join('\n'),
    )
  }

  console.log('img2 home : ' + H)
  console.log('harness   : ' + (opts.from ? path.resolve(opts.from) : HARNESS_REPO_URL))
  if (!opts.yes) await confirmOrThrow('Proceed?')

  fs.mkdirSync(H, { recursive: true })
  acquireLock(H)
  try {
    for (const d of [pluginsDir(H), generatedDir(H), backupsDir(H)]) fs.mkdirSync(d, { recursive: true })
    if (!fs.existsSync(registryPath(H))) writeRegistry(H, emptyRegistry())
    if (!fs.existsSync(receiptsPath(H))) writeReceipts(H, [])

    if (legacyExists) {
      const dest = moveToBackups(H, legacyRepo, 'legacy-img2threejs-repo')
      console.log('  migrated  ' + legacyRepo + ' -> ' + dest)
      for (const key of Object.keys(HOSTS)) {
        const t = path.join(HOSTS[key].skills(), LEGACY_LINK_NAME)
        const c = classifyTarget(t)
        if (c.state === 'symlink' && c.dangling && (c.resolved === legacyHome || c.resolved.startsWith(legacyHome + path.sep))) {
          fs.unlinkSync(t)
          console.log('  removed dangling legacy link ' + t)
        }
      }
    }

    const hd = harnessDir(H)
    if (fs.existsSync(hd)) {
      if (!isGitRepo(hd)) {
        throw new CliError(EXIT.REFUSED, hd + ' exists but is not a git checkout; move it aside')
      }
      console.log('  kept      existing harness checkout at ' + hd)
    } else {
      const src = opts.from ? path.resolve(opts.from) : HARNESS_REPO_URL
      if (opts.from && !fs.existsSync(src)) throw new CliError(EXIT.FAIL, '--from path does not exist: ' + src)
      git(['clone', '-q', src, hd])
      console.log('  cloned    ' + src + ' -> ' + hd)
    }

    ensureLauncher(H)

    if (fs.existsSync(HOSTS.claude.configRoot())) {
      const changed = mergeSettingsFile(HOSTS.claude.settings(), H)
      console.log('  settings  ' + HOSTS.claude.settings() + (changed ? ' (added ' + H + ' to permissions.additionalDirectories)' : ' (already covers ' + H + ')'))
    } else {
      console.log('  settings  claude not detected; nothing merged')
    }
    console.log('install: ok')
    return EXIT.OK
  } finally {
    releaseLock()
  }
}

// Newest reachable semver tag on a remote, or null if it has none (untagged, or tags that don't
// parse as semver). Shared by `add` (pick a ref when none is pinned) and `update` (decide whether a
// newer tag exists).
function latestTagFor(url) {
  const tags = git(['ls-remote', '--tags', url])
    .split('\n')
    .map((line) => line.split('refs/tags/')[1])
    .filter((t) => t && !t.endsWith('^{}'))
    .map((t) => ({ tag: t, key: parseSemver(t.replace(/^v/, '')) }))
    .filter((t) => t.key)
    .sort((a, b) => cmpSemver(b.key, a.key))
  return tags.length ? tags[0].tag : null
}

async function resolveRefAndClone(H, spec, opts) {
  const { url, label, defaultOrg } = resolveSource(spec, opts.allowAnySource)
  await confirmOutOfOrgSource(url, defaultOrg, opts)
  const staging = path.join(pluginsDir(H), '.staging-' + process.pid)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(pluginsDir(H), { recursive: true })

  let ref = opts.ref || latestTagFor(url)

  git(['clone', '-q', url, staging])
  if (ref) {
    try {
      git(['checkout', '-q', '--detach', ref], staging)
    } catch {
      git(['checkout', '-q', '--detach', 'origin/' + ref], staging)
    }
  } else {
    ref = git(['rev-parse', '--abbrev-ref', 'HEAD'], staging)
    console.error('img2: warning: no semver tag reachable at ' + url + '; using HEAD of default branch "' + ref + '"')
  }
  const resolvedSha = git(['rev-parse', 'HEAD'], staging)
  return { staging, label, ref, resolvedSha }
}

// npm's counterpart to resolveRefAndClone: same return shape ({staging, label, ref, resolvedSha}),
// so `cmdAdd` and `cmdUpdate` need only pick which of the two to call, never branch afterwards.
// `ref` is the resolved version; `resolvedSha` is npm's own `dist.integrity` (a `sha512-...` string,
// not a git SHA -- this harness has no other notion of "pinned content hash" for a package it did
// not clone, and integrity is exactly that for a tarball).
async function resolveNpmAndFetch(H, spec, opts) {
  const { name, version: wantVersion } = parseNpmSpec(spec)
  const { defaultOrg } = resolveNpmSource(name, opts.allowAnySource)
  const label = 'npm:' + name
  await confirmOutOfOrgSource(label, defaultOrg, opts)

  const nameAtSpec = wantVersion ? name + '@' + wantVersion : name
  const viewed = npm(['view', nameAtSpec, 'version', 'dist.integrity', '--json'])
  let info
  try {
    info = JSON.parse(viewed)
  } catch (err) {
    throw new CliError(EXIT.FAIL, 'npm view ' + nameAtSpec + ' did not return JSON', viewed)
  }
  // A version range matching more than one release comes back as an array; a concrete version or
  // the default "latest" tag (our only two spec forms) always resolves to exactly one, but take the
  // newest rather than crash if npm's own resolution ever disagrees.
  if (Array.isArray(info)) info = info[info.length - 1]
  if (!info || typeof info.version !== 'string' || !info.dist || typeof info.dist.integrity !== 'string') {
    throw new CliError(EXIT.FAIL, 'npm view ' + nameAtSpec + ' did not return a version and dist.integrity', viewed)
  }

  const staging = path.join(pluginsDir(H), '.staging-' + process.pid)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(pluginsDir(H), { recursive: true })

  const packStaging = path.join(pluginsDir(H), '.staging-pack-' + process.pid)
  fs.rmSync(packStaging, { recursive: true, force: true })
  fs.mkdirSync(packStaging, { recursive: true })
  try {
    npm(['pack', name + '@' + info.version, '--pack-destination', packStaging])
    const tarballs = fs.readdirSync(packStaging).filter((f) => f.endsWith('.tgz'))
    if (tarballs.length !== 1) {
      throw new CliError(
        EXIT.FAIL,
        'npm pack ' + name + '@' + info.version + ' produced ' + tarballs.length + ' tarball(s) in ' + packStaging + ', expected 1',
      )
    }
    fs.mkdirSync(staging, { recursive: true })
    // A published tarball's content sits under a "package/" prefix; strip it so `staging` mirrors
    // exactly what a git checkout of the plugin repo root would put there.
    tar(['-xzf', path.join(packStaging, tarballs[0]), '-C', staging, '--strip-components=1'])
  } finally {
    fs.rmSync(packStaging, { recursive: true, force: true })
  }

  return { staging, label, ref: info.version, resolvedSha: info.dist.integrity }
}

async function cmdAdd(opts, spec) {
  if (!spec && !opts.link) throw new CliError(EXIT.REFUSED, 'add needs <org/repo>, a URL, or --link <localpath>')
  if (spec && opts.link) throw new CliError(EXIT.REFUSED, 'add takes either a source spec or --link, not both')
  const H = resolveImg2Home(opts.home)
  if (!fs.existsSync(harnessDir(H))) {
    throw new CliError(EXIT.FAIL, 'no harness checkout at ' + harnessDir(H), 'run `img2 install` first')
  }

  acquireLock(H)
  let staging = null
  try {
    let manifest, row, source
    if (opts.link) {
      source = path.resolve(opts.link)
      if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
        throw new CliError(EXIT.FAIL, '--link must name an existing directory', source)
      }
      manifest = readManifest(source)
      row = { id: manifest.name, repo: 'link:' + source, ref: 'local', resolvedSha: 'local', addedAt: new Date().toISOString() }
    } else {
      const cloned = spec.startsWith('npm:') ? await resolveNpmAndFetch(H, spec, opts) : await resolveRefAndClone(H, spec, opts)
      staging = cloned.staging
      manifest = readManifest(staging)
      row = { id: manifest.name, repo: cloned.label, ref: cloned.ref, resolvedSha: cloned.resolvedSha, addedAt: new Date().toISOString() }
    }
    const id = row.id

    const reg = readRegistry(H)
    const existing = findRow(reg, id)
    if (existing && !opts.force) {
      throw new CliError(
        EXIT.FAIL,
        'plugin "' + id + '" is already registered',
        'row: ' + JSON.stringify(existing) + ' -- pass --force to replace it',
      )
    }
    // `--force` replaces the row wholesale, but a hand-authored key on the old row (added
    // outside img2, e.g. a future per-row override) is not img2's to discard.
    if (existing) {
      for (const k of Object.keys(existing)) {
        if (!ROW_KEYS.includes(k)) row[k] = existing[k]
      }
    }

    const hosts = detectedHosts()
    for (const key of hosts) {
      assertClaimable(path.join(HOSTS[key].skills(), linkName(id)), H)
    }

    const dest = cloneDir(H, id)
    if (existing) {
      reg.plugins = reg.plugins.filter((r) => r.id !== id)
      if (classifyTarget(dest).state !== 'absent') {
        console.log('  backed up ' + dest + ' -> ' + moveToBackups(H, dest, id))
      }
    } else if (classifyTarget(dest).state !== 'absent') {
      if (!opts.force) {
        throw new CliError(EXIT.REFUSED, dest + ' exists on disk but is not registered', 'pass --force to back it up and replace it')
      }
      console.log('  backed up ' + dest + ' -> ' + moveToBackups(H, dest, id))
    }

    if (opts.link) {
      fs.symlinkSync(source, dest, 'junction')
    } else {
      fs.renameSync(staging, dest)
      staging = null
    }

    addRow(reg, row)
    writeRegistry(H, reg)

    if (!hosts.length) {
      console.error('img2: warning: no agent host detected (' + Object.keys(HOSTS).join(', ') + '); no skill links created')
    }
    for (const key of hosts) {
      const target = path.join(HOSTS[key].skills(), linkName(id))
      const outcome = ensureLink(target, dest, H)
      recordReceipt(H, { host: key, plugin: id, target, canonical: dest })
      console.log('  ' + outcome.padEnd(14) + target)
    }

    syncAll(H, false)
    console.log('added ' + id + ' ' + manifest.version + ' (' + row.ref + ' @ ' + shortSha(row.resolvedSha) + ')')
    return EXIT.OK
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true })
    releaseLock()
  }
}

async function cmdRemove(opts, id) {
  if (!id) throw new CliError(EXIT.REFUSED, 'remove needs a plugin id')
  const H = resolveImg2Home(opts.home)
  acquireLock(H)
  try {
    const reg = readRegistry(H)
    removeRow(reg, id)

    for (const key of Object.keys(HOSTS)) {
      const target = path.join(HOSTS[key].skills(), linkName(id))
      const c = classifyTarget(target)
      if (c.state === 'absent') continue
      if (c.state !== 'symlink' || !underHome(c.resolved, H)) {
        console.error('img2: leaving ' + target + ' in place (not owned by img2)')
        continue
      }
      fs.unlinkSync(target)
      console.log('  unlinked  ' + target)
    }
    writeReceipts(H, readReceipts(H).filter((e) => e.plugin !== id))

    const dest = cloneDir(H, id)
    if (classifyTarget(dest).state !== 'absent') {
      console.log('  backed up ' + dest + ' -> ' + moveToBackups(H, dest, id))
    }

    writeRegistry(H, reg)
    syncAll(H, false)
    console.log('removed ' + id)
    return EXIT.OK
  } finally {
    releaseLock()
  }
}

async function cmdList(opts) {
  const H = resolveImg2Home(opts.home)
  const reg = readRegistry(H)
  if (!reg.plugins.length) {
    console.log('(no plugins registered)')
    return EXIT.OK
  }
  console.log('id'.padEnd(24) + 'version'.padEnd(10) + 'ref'.padEnd(14) + 'sha')
  for (const row of [...reg.plugins].sort((a, b) => a.id.localeCompare(b.id))) {
    let version = '?'
    try {
      version = JSON.parse(fs.readFileSync(path.join(cloneDir(H, row.id), 'plugin.json'), 'utf8')).version || '?'
    } catch { /* listed anyway; doctor reports the cause */ }
    console.log(row.id.padEnd(24) + String(version).padEnd(10) + String(row.ref).padEnd(14) + shortSha(row.resolvedSha))
  }
  return EXIT.OK
}

async function cmdDoctor(opts) {
  const H = resolveImg2Home(opts.home)
  const findings = []
  const err = (plugin, msg) => findings.push({ level: 'FAIL', plugin, msg })
  const warn = (plugin, msg) => findings.push({ level: 'WARN', plugin, msg })
  const info = (plugin, msg) => findings.push({ level: 'INFO', plugin, msg })

  let reg = null
  try {
    reg = readRegistry(H)
  } catch (e) {
    err(null, e.message)
  }
  if (!fs.existsSync(harnessDir(H))) err(null, 'no harness checkout at ' + harnessDir(H) + '; run `img2 install`')

  // The base skill's own link is not harness-owned (it is not a row in plugins.json), so doctor
  // cannot judge it -- it can only report the target, which is what makes a wrong-working-copy
  // install visible instead of silently invisible.
  for (const key of detectedHosts()) {
    const baseLink = path.join(HOSTS[key].skills(), LEGACY_LINK_NAME)
    const c = classifyTarget(baseLink)
    if (c.state === 'symlink') {
      info(null, key + ': base skill "' + LEGACY_LINK_NAME + '" -> ' + c.resolved + (c.dangling ? ' (dangling)' : ''))
    } else if (c.state !== 'absent') {
      info(null, key + ': base skill "' + LEGACY_LINK_NAME + '" at ' + baseLink + ' is a ' + c.state + ', not a symlink')
    }
  }

  const manifests = new Map()
  if (reg) {
    const seen = new Set()
    const allIds = reg.plugins.map((r) => r.id)
    const allSteps = []
    // Every step across every plugin that carries a valid `provides` -- collected here so the
    // terminal-ordering check (which needs the fully merged `after` graph) can run once, after every
    // plugin's own steps.json has been read.
    const allProvidingSteps = []
    for (const row of reg.plugins) {
      if (seen.has(row.id)) {
        err(row.id, 'duplicate registry row')
        continue
      }
      seen.add(row.id)
      const dir = cloneDir(H, row.id)
      if (!fs.existsSync(dir)) {
        err(row.id, 'registered but no clone at ' + dir)
        continue
      }
      let manifest
      try {
        manifest = readManifest(dir)
        manifests.set(row.id, manifest)
      } catch (e) {
        err(row.id, e.message)
        continue
      }
      if (manifest.name !== row.id) err(row.id, 'manifest name "' + manifest.name + '" does not match the registry id')
      if (manifest.capabilities.length > 1) {
        warn(
          row.id,
          'multi-capability provider: declares ' + manifest.capabilities.length + ' capabilities; each edge resolves independently via `img2 capabilities`',
        )
      }

      // Only meaningful for a git checkout: the rule guards against _img2_local.py landing in a
      // commit, which cannot happen in an npm-fetched or bare --link'd directory that has no .git
      // at all. Requiring a .gitignore entry there would be a git assumption failing a plugin for a
      // hazard that does not exist for it.
      if (isGitRepo(dir)) {
        let ignored = false
        try {
          git(['check-ignore', '-q', '--', '_img2_local.py'], dir)
          ignored = true
        } catch { /* not ignored */ }
        if (!ignored) err(row.id, '.gitignore does not cover _img2_local.py (contract section 4)')
      }

      for (const localFile of localFiles(dir)) {
        const rel = path.relative(dir, localFile)
        if (!fs.existsSync(localFile)) err(row.id, rel + ' is missing; run `img2 sync`')
        else if (fs.readFileSync(localFile, 'utf8') !== localStanza(H)) err(row.id, rel + ' is stale; run `img2 sync`')
      }

      for (const finding of staticToolFindings(dir, row.id, allIds)) err(row.id, finding)

      for (const key of detectedHosts()) {
        const target = path.join(HOSTS[key].skills(), linkName(row.id))
        const c = classifyTarget(target)
        if (c.state === 'absent') err(row.id, key + ' link missing at ' + target + '; re-run `img2 add ... --force`')
        else if (c.state !== 'symlink') err(row.id, key + ': ' + target + ' is a ' + c.state + ', not an img2-owned symlink; refusing to touch it')
        else if (!underHome(c.resolved, H)) err(row.id, key + ': ' + target + ' -> ' + c.resolved + ' is outside ' + H + '; refusing to touch it')
        else if (c.dangling) err(row.id, key + ': ' + target + ' dangles (-> ' + c.resolved + ')')
        else if (!samePath(c.resolved, dir)) err(row.id, key + ': ' + target + ' points at ' + c.resolved + ', not at ' + dir)
      }

      const gatesFile = path.join(dir, 'gates.json')
      if (fs.existsSync(gatesFile)) {
        try {
          const rows = readRowsFile(gatesFile)
          for (const g of topoSort(rows, row.id + '/gates.json')) {
            if ('blocking' in g && typeof g.blocking !== 'boolean') err(row.id, 'gates.json: "' + g.id + '" has a non-boolean "blocking"')
            const bad = rowFinding(g, dir, true)
            if (bad) err(row.id, 'gates.json "' + g.id + '": ' + bad)
          }
        } catch (e) {
          err(row.id, e.message)
        }
      }
      const domainFile = path.join(dir, 'domain.json')
      if (fs.existsSync(domainFile)) {
        try {
          for (const finding of domainJsonFindings(dir, row.id)) err(row.id, finding)
        } catch (e) {
          err(row.id, 'domain.json: ' + e.message)
        }
      }
      const specSearchProfileFile = path.join(dir, 'spec_search_profile.json')
      if (fs.existsSync(specSearchProfileFile)) {
        try {
          for (const finding of specSearchProfileFindings(dir, row.id)) err(row.id, finding)
        } catch (e) {
          err(row.id, 'spec_search_profile.json: ' + e.message)
        }
      }

      const stepsFile = path.join(dir, 'steps.json')
      // provides.{from,to} declared by this plugin's own steps -- gathered while reading steps.json so
      // the manifest<->step cross-validation below (scoped to this one plugin) can run right after.
      const providesByPlugin = []
      if (fs.existsSync(stepsFile)) {
        try {
          const rows = readRowsFile(stepsFile)
          for (const s of rows) {
            if (typeof s.title !== 'string' || !s.title) err(row.id, 'steps.json: "' + (s.id || '?') + '" needs a string "title"')
            const bad = rowFinding(s, dir, false)
            if (bad) err(row.id, 'steps.json "' + (s.id || '?') + '": ' + bad)
            if ('provides' in s) {
              const pbad = providesFinding(s.provides, row.id)
              if (pbad) err(row.id, 'steps.json "' + (s.id || '?') + '" provides: ' + pbad)
              else {
                if (s.provides.from === 'sculpt-spec') {
                  const tbad = targetSiblingFinding(s)
                  if (tbad) err(row.id, 'steps.json "' + (s.id || '?') + '": ' + tbad)
                }
                providesByPlugin.push({ stepId: s.id, from: s.provides.from, to: s.provides.to })
                allProvidingSteps.push({ pluginId: row.id, stepId: s.id })
              }
            }
            allSteps.push(s)
          }
        } catch (e) {
          err(row.id, e.message)
        }
      }

      // Manifest <-> step cross-validation (emission-target-contract §D1). A "target edge" is a
      // manifest capability whose "from" is "sculpt-spec" -- the terminal, whole-artifact transform
      // this contract governs; every other capability edge (e.g. "image" -> ...) is an ordinary domain
      // capability, untouched by `provides` and unaffected by this check, which is why every shipped
      // plugin today (none declares "sculpt-spec" or "provides") sees zero doctor change here.
      if (manifest) {
        for (const cap of manifest.capabilities) {
          if (cap.from !== 'sculpt-spec') continue
          const hasStep = providesByPlugin.some((p) => p.from === cap.from && p.to === cap.to)
          if (!hasStep) {
            err(row.id, 'manifest capability ' + cap.from + ' -> ' + cap.to + ' has no providing step in steps.json')
          }
        }
        for (const p of providesByPlugin) {
          const hasEdge = manifest.capabilities.some((cap) => cap.from === p.from && cap.to === p.to)
          if (!hasEdge) {
            err(row.id, 'steps.json "' + p.stepId + '" provides ' + p.from + ' -> ' + p.to + ' but no manifest capability edge declares it')
          }
        }
        const byTo = new Map()
        for (const p of providesByPlugin) {
          if (!byTo.has(p.to)) byTo.set(p.to, [])
          byTo.get(p.to).push(p.stepId)
        }
        for (const [to, ids] of byTo) {
          if (ids.length > 1) {
            err(row.id, 'two steps provide kind "' + to + '": ' + ids.join(', ') + ' -- a kind must have exactly one providing step per plugin')
          }
        }
      }
    }

    try {
      topoSort(allSteps, 'steps (all plugins)')
    } catch (e) {
      err(null, e.message)
    }

    // A providing step must be terminal: nothing else in the merged step graph -- from any plugin --
    // may run after it (emission-target-contract: "a providing step ordered after a non-terminal step
    // is refused"). Runs regardless of whether topoSort above found a cycle: a cycle is reported on its
    // own, and this check still names any concrete non-terminal provider it can see.
    for (const entry of allProvidingSteps) {
      const dependents = allSteps.filter((s) => Array.isArray(s.after) && s.after.includes(entry.stepId)).map((s) => s.id)
      if (dependents.length) {
        err(entry.pluginId, 'steps.json "' + entry.stepId + '" provides an artifact but is not terminal -- ' + dependents.join(', ') + ' run(s) after it')
      }
    }

    const byEdge = new Map()
    for (const [id, m] of manifests) {
      for (const cap of m.capabilities) {
        const k = cap.from + ' -> ' + cap.to
        if (!byEdge.has(k)) byEdge.set(k, [])
        byEdge.get(k).push(id)
      }
    }
    for (const [k, ids] of byEdge) {
      if (ids.length > 1) warn(null, 'capability ' + k + ' is claimed by ' + ids.join(', ') + '; `img2 capabilities` refuses to resolve this edge -- pass --plugin <id> to disambiguate')
    }

    if (!findings.some((f) => f.level === 'FAIL')) {
      try {
        const targets = syncTargets(H, reg)
        // Same pre-sync rule cmdCapabilities applies: `img2 install` creates generated/ but only
        // add/remove/sync populate it, so a fresh install must not be reported as drifted.
        const neverSynced = generatedIndexTargets(H, computeGenerated(H, reg)).every((t) => !fs.existsSync(t.file))
        const drift = neverSynced
          ? []
          : targets.filter((t) => {
              try {
                return fs.readFileSync(t.file, 'utf8') !== t.want
              } catch {
                return true
              }
            })
        if (drift.length) err(null, 'generated artifacts are out of sync (' + drift.map((t) => t.file).join(', ') + '); run `img2 sync`')
      } catch (e) {
        err(null, e.message)
      }
    }
  }

  const fails = findings.filter((f) => f.level === 'FAIL').length
  const warns = findings.filter((f) => f.level === 'WARN').length

  if (opts.json) {
    console.log(JSON.stringify({ fails, warns, findings: findings.map((f) => ({ level: f.level, plugin: f.plugin, message: f.msg })) }))
    return fails ? EXIT.FAIL : EXIT.OK
  }

  for (const f of findings) console.log(f.level + '  ' + (f.plugin || '-').padEnd(20) + ' ' + f.msg)
  if (fails) {
    console.log('doctor: ' + fails + ' failure(s), ' + warns + ' warning(s)')
    return EXIT.FAIL
  }
  console.log('doctor: ok (' + (reg ? reg.plugins.length : 0) + ' plugin(s), ' + warns + ' warning(s))')
  return EXIT.OK
}

async function cmdSync(opts) {
  const H = resolveImg2Home(opts.home)
  if (opts.check) {
    syncAll(H, true)
    return EXIT.OK
  }
  acquireLock(H)
  try {
    syncAll(H, false)
    return EXIT.OK
  } finally {
    releaseLock()
  }
}

// ---------------------------------------------------------------- update

// A `link:` row is a symlink to a local dev checkout -- nothing to fetch, the working tree IS the
// current version. An `npm:` row's newest version comes from `npm view`; everything else is a git
// remote, whose newest reachable semver tag comes from `latestTagFor` (same helper `add` uses).
// Re-confirming an already-registered non-default-org source on every update, rather than trusting
// it forever once accepted, matches the existing trust boundary: `add --force` re-confirms too.
async function cmdUpdate(opts, args) {
  const H = resolveImg2Home(opts.home)
  const onlyId = args[0] || null
  acquireLock(H)
  let staging = null
  try {
    const reg = readRegistry(H)
    const rows = (onlyId ? reg.plugins.filter((r) => r.id === onlyId) : [...reg.plugins]).sort((a, b) => a.id.localeCompare(b.id))
    if (onlyId && !rows.length) throw new CliError(EXIT.FAIL, 'no registered plugin "' + onlyId + '"')

    let updated = 0
    let pending = 0
    for (const row of rows) {
      if (row.repo.startsWith('link:')) {
        console.log('  local         ' + row.id + ' (' + row.repo + '); nothing to update')
        continue
      }

      let latest, fetch
      if (row.repo.startsWith('npm:')) {
        const name = row.repo.slice('npm:'.length)
        latest = npm(['view', name, 'version'])
        fetch = () => resolveNpmAndFetch(H, 'npm:' + name + '@' + latest, { ...opts, allowAnySource: true })
      } else {
        const { url } = resolveSource(row.repo, true)
        latest = latestTagFor(url)
        if (!latest) {
          console.log('  no tag        ' + row.id + ' (' + row.repo + '); nothing to compare against')
          continue
        }
        fetch = () => resolveRefAndClone(H, row.repo, { ...opts, ref: latest, allowAnySource: true })
      }

      if (latest === row.ref) {
        console.log('  up to date    ' + row.id + ' ' + row.ref)
        continue
      }
      pending += 1
      if (opts.check) {
        console.log('  update avail  ' + row.id + ' ' + row.ref + ' -> ' + latest)
        continue
      }

      const cloned = await fetch()
      staging = cloned.staging
      const manifest = readManifest(staging)
      if (manifest.name !== row.id) {
        const bad = staging
        staging = null
        fs.rmSync(bad, { recursive: true, force: true })
        throw new CliError(EXIT.FAIL, row.id + ': updated manifest name "' + manifest.name + '" no longer matches the registered id')
      }
      const dest = cloneDir(H, row.id)
      console.log('  backed up ' + dest + ' -> ' + moveToBackups(H, dest, row.id))
      fs.renameSync(staging, dest)
      staging = null
      row.ref = cloned.ref
      row.resolvedSha = cloned.resolvedSha
      updated += 1
      console.log('  updated       ' + row.id + ' -> ' + row.ref + ' @ ' + shortSha(row.resolvedSha))
    }

    if (updated) {
      writeRegistry(H, reg)
      syncAll(H, false)
    }
    if (opts.check) {
      console.log('update --check: ' + pending + ' pending')
      return pending ? EXIT.FAIL : EXIT.OK
    }
    console.log('update: ' + updated + ' updated')
    return EXIT.OK
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true })
    releaseLock()
  }
}

// ---------------------------------------------------------------- capability resolution (§13)

// A manifest that fails full validation (e.g. schema too new) may still be legible enough to see
// whether it claims the queried edge -- read the raw JSON ourselves rather than trusting readManifest,
// which throws before it ever looks at "capabilities" for exactly the cases this needs to see through.
function rawCapabilitiesClaim(manifestPath, from, to) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return Array.isArray(raw.capabilities) && raw.capabilities.some((c) => c && c.from === from && c.to === to)
  } catch {
    return false
  }
}

// One source of truth for "is this plugin's declared work safe to hand to a caller". Doctor reports
// it as a finding; the query refuses on it. Both call commandFinding so they cannot drift apart.
//
// A malformed `provides` shape (bad version, missing artifact fields, an escaping artifact path) is
// checked here too, for the same reason: an artifact-path escape is a write-location safety issue, not
// merely a data-integrity one, so `capabilities` must refuse it exactly as `doctor` does. The
// manifest<->step cross-validation (edge-no-step, step-no-edge, duplicate providers, terminal
// ordering) is NOT re-derived here -- it needs the full registry and every plugin's steps, which
// `cmdDoctor` alone has; a plugin failing only one of those checks may still answer other edges via
// `capabilities` unaffected by this narrower gate. Recorded as a known scope limit, not a drift.
export function unsafeRowFinding(dir) {
  const pluginId = path.basename(dir)
  for (const name of ['steps.json', 'gates.json']) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) continue
    let rows
    try {
      rows = readRowsFile(file)
    } catch (e) {
      return { file, reason: e.message }
    }
    for (const r of rows) {
      const bad = rowFinding(r, dir, name === 'gates.json')
      if (bad) return { file, reason: name + ' "' + (r && r.id) + '": ' + bad }
      if (name === 'steps.json' && r && 'provides' in r) {
        const pbad = providesFinding(r.provides, pluginId)
        if (pbad) return { file, reason: name + ' "' + r.id + '" provides: ' + pbad }
        if (r.provides.from === 'sculpt-spec') {
          const tbad = targetSiblingFinding(r)
          if (tbad) return { file, reason: name + ' "' + r.id + '": ' + tbad }
        }
      }
    }
  }
  return null
}

function buildProviderRow(H, dir, row, manifest) {
  const stepsFile = path.join(dir, 'steps.json')
  let steps = []
  if (fs.existsSync(stepsFile)) {
    // A non-program row is handed back as an instruction, never as argv -- there is nothing for the
    // caller to execute, so there is nothing for it to execute by accident.
    steps = topoSort(readRowsFile(stepsFile), row.id + '/steps.json').map((s) => {
      const actor = s.actor || 'program'
      const out =
        actor === 'program'
          ? { id: s.id, actor, argv: stepArgv(s.command, dir) }
          : // {plugin_dir} is resolved for an instruction too. A reader cannot expand it -- handing back
            // "Read {plugin_dir}/grimoire/..." tells an agent to read a path that does not exist.
            // {workspace} and {image} are deliberately left for the caller to fill by value, as in argv.
            { id: s.id, actor, instruction: s.command.replaceAll('{plugin_dir}', dir) }
      // Surfaced verbatim (no placeholder in provides.artifact.path to resolve): a caller resolving a
      // target edge needs the artifact kind and its workspace-relative path, not just that a step exists.
      if (s.provides) out.provides = s.provides
      return out
    })
  }
  const gatesFile = path.join(dir, 'gates.json')
  const gateRunner = fs.existsSync(gatesFile) ? { argv: gateRunnerArgv(H, dir) } : null
  return { plugin: row.id, version: manifest.version, resolvedSha: row.resolvedSha, dir, steps, gateRunner }
}

async function cmdCapabilities(opts) {
  const H = resolveImg2Home(opts.home)
  const from = opts.fromKind || null
  const to = opts.toKind || null
  const query = { from, to }
  const problems = []
  const addProblem = (plugin, p, reason) => problems.push({ plugin, path: p, reason })

  const finish = (status, providers) => {
    // `version` is the envelope's own schema version, not the harness version -- a consumer branches
    // on it. The harness version is advertised by `--version --json`.
    console.log(JSON.stringify({ version: 1, contract: CONTRACT_REVISION, query, status, providers, problems }))
    if (status === 'answered') return EXIT.OK
    if (status === 'ambiguous') return EXIT.NEEDS_INPUT
    return EXIT.FAIL
  }

  let reg
  try {
    reg = readRegistry(H)
  } catch (e) {
    addProblem(null, registryPath(H), e.message)
    return finish('data-fault', [])
  }

  // Registry insertion order is mutated by `img2 add --force`; sort by id so result order is stable.
  const rows = [...reg.plugins].sort((a, b) => a.id.localeCompare(b.id))
  const manifests = new Map()
  let claimedEdgeBroken = false

  for (const row of rows) {
    const dir = cloneDir(H, row.id)
    try {
      manifests.set(row.id, readManifest(dir))
    } catch (e) {
      const manifestPath = path.join(dir, 'plugin.json')
      addProblem(row.id, manifestPath, e.message)
      if (rawCapabilitiesClaim(manifestPath, from, to)) claimedEdgeBroken = true
    }
  }

  // A row that claims the queried edge but cannot be read makes the answer untrustworthy; a row
  // that is broken but irrelevant to this edge stays in problems[] while the answer still returns.
  if (claimedEdgeBroken) return finish('data-fault', [])

  const candidates = []
  for (const row of rows) {
    const manifest = manifests.get(row.id)
    if (!manifest) continue
    const matches = manifest.capabilities.filter((c) => c.from === from && c.to === to)
    if (matches.length === 0) continue
    const dir = cloneDir(H, row.id)
    if (matches.length > 1) {
      addProblem(
        row.id,
        path.join(dir, 'plugin.json'),
        'declares ' + from + ' -> ' + to + ' ' + matches.length + ' times; a provider is unresolvable for an edge it declares more than once',
      )
      continue
    }
    // The query must refuse exactly what doctor refuses. Without this the two disagree, and a caller
    // told to branch on `status` executes a command doctor had already failed -- on a
    // case-insensitive filesystem `Read foo.md` even resolves to /usr/bin/read and exits 0, so the
    // caller reads silent success. A provider with any unsafe row is not a usable answer for the
    // edge; it belongs in problems[], never in providers[].
    const unsafe = unsafeRowFinding(dir)
    if (unsafe) {
      addProblem(row.id, unsafe.file, unsafe.reason)
      claimedEdgeBroken = true
      continue
    }
    try {
      candidates.push(buildProviderRow(H, dir, row, manifest))
    } catch (e) {
      addProblem(row.id, dir, e.message)
      claimedEdgeBroken = true
    }
  }

  // Re-check after the row scan: a provider filtered out above claimed this edge, so an empty answer
  // here is a configuration fault, not absence.
  if (claimedEdgeBroken && !candidates.length) return finish('data-fault', [])

  let status, providers
  if (opts.plugin) {
    const named = candidates.find((c) => c.plugin === opts.plugin)
    if (!named) {
      if (!problems.some((p) => p.plugin === opts.plugin)) {
        addProblem(opts.plugin, cloneDir(H, opts.plugin), 'named --plugin does not claim ' + from + ' -> ' + to)
      }
      return finish('data-fault', [])
    }
    status = 'answered'
    providers = [named]
  } else if (candidates.length === 0) {
    status = 'answered'
    providers = []
  } else if (candidates.length === 1) {
    status = 'answered'
    providers = candidates
  } else {
    status = 'ambiguous'
    providers = candidates
  }

  // Drift is checked last (D-F order: registry -> manifests -> edge filter -> drift) and only when
  // every manifest read cleanly -- computeGenerated re-reads every manifest and throws on the first
  // bad one, so attempting it while problems[] is non-empty would reintroduce the exact hazard D-F
  // rejects reusing computeGenerated unguarded for.
  if (problems.length === 0) {
    let expected
    try {
      expected = computeGenerated(H, reg)
    } catch (e) {
      addProblem(null, harnessDir(H), e.message)
      return finish('data-fault', [])
    }
    const targets = generatedIndexTargets(H, expected)
    // `img2 install` creates generated/ but never populates it -- only `add`/`remove`/`sync` do. A
    // query must answer immediately after install without first requiring a mutating `sync`, so
    // "neither file exists yet" is the expected pre-sync state, not drift.
    const neverSynced = targets.every((t) => !fs.existsSync(t.file))
    const drift = neverSynced
      ? []
      : targets.filter((t) => {
          try {
            return fs.readFileSync(t.file, 'utf8') !== t.want
          } catch {
            return true
          }
        })
    if (drift.length) {
      for (const t of drift) addProblem(null, t.file, 'generated artifact drift; run `img2 sync`')
      return finish('data-fault', [])
    }
  }

  return finish(status, providers)
}

// ---------------------------------------------------------------- entry

const HELP = [
  'img2 -- plugin harness for the img2 ecosystem',
  '',
  'Usage',
  '  img2 install [--from <localpath>] [--home <dir>] [--yes] [--migrate-legacy]',
  '  img2 add <org/repo | url> [--ref <tag|branch>] [--force] [--allow-any-source]',
  '  img2 add npm:<name>[@<version>] [--force] [--allow-any-source]',
  '  img2 add --link <localpath> [--force]',
  '  img2 remove <id>',
  '  img2 list',
  '  img2 update [<id>] [--check] [--yes] [--allow-any-source]',
  '  img2 doctor [--json]',
  '  img2 sync [--check]',
  '  img2 capabilities [--from-kind <kind>] [--to-kind <kind>] [--plugin <id>] [--json]',
  '',
  'Options',
  '  --from <path>        clone the harness from a local checkout instead of GitHub',
  '  --home <dir>         use this $IMG2_HOME (absolute path)',
  '  --yes                never prompt',
  '  --migrate-legacy     move a legacy ~/.img2threejs/repo checkout to backups and continue',
  '  --ref <ref>          pin a plugin to a tag or branch (default: newest semver tag)',
  '  --link <path>        register a local plugin checkout via symlink (no clone)',
  '  --force              replace an existing registered plugin',
  '  --allow-any-source   accept a source outside the ' + DEFAULT_ORG + '/* org (or @' + DEFAULT_ORG + ' npm scope)',
  '  --check              sync: verify generated artifacts without writing; update: report pending updates without fetching',
  '  --from-kind <kind>   capabilities: the edge\'s source kind',
  '  --to-kind <kind>     capabilities: the edge\'s destination kind',
  '  --plugin <id>        capabilities: disambiguate to one named provider',
  '  --json               version/doctor: emit machine-readable output; capabilities: implied',
  '',
  'Environment',
  '  IMG2_HOME            harness home (default ~/.img2)',
  '  IMG2THREEJS_HOME     deprecated alias, honoured one release with a warning',
  '',
  'Exit codes',
  '  0 success   1 failure   2 refused   3 interactive input required',
].join('\n')

export function parseArgs(argv) {
  const opts = {
    home: null,
    from: null,
    ref: null,
    link: null,
    yes: false,
    force: false,
    migrateLegacy: false,
    allowAnySource: false,
    check: false,
    fromKind: null,
    toKind: null,
    plugin: null,
    json: false,
    help: false,
    showVersion: false,
  }
  const args = []
  let command = null
  const take = (name, v) => {
    if (v === undefined) throw new CliError(EXIT.REFUSED, name + ' needs a value')
    return v
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--version' || a === '-v') opts.showVersion = true
    else if (a === '--yes' || a === '-y') opts.yes = true
    else if (a === '--force') opts.force = true
    else if (a === '--migrate-legacy') opts.migrateLegacy = true
    else if (a === '--allow-any-source') opts.allowAnySource = true
    else if (a === '--check') opts.check = true
    else if (a === '--json') opts.json = true
    else if (a === '--home') opts.home = take(a, argv[++i])
    else if (a === '--from') opts.from = take(a, argv[++i])
    else if (a === '--ref') opts.ref = take(a, argv[++i])
    else if (a === '--link') opts.link = take(a, argv[++i])
    else if (a === '--from-kind') opts.fromKind = take(a, argv[++i])
    else if (a === '--to-kind') opts.toKind = take(a, argv[++i])
    else if (a === '--plugin') opts.plugin = take(a, argv[++i])
    else if (a.startsWith('-')) throw new CliError(EXIT.REFUSED, 'unknown option: ' + a, 'run --help for the flag list')
    else if (!command) command = a
    else args.push(a)
  }
  return { command, opts, args }
}

// The version probe's `commands` list (§13, D-B) is derived from this table, not hand-written,
// so it cannot list a command the dispatcher does not actually have.
const COMMANDS = {
  install: (opts) => cmdInstall(opts),
  add: (opts, args) => cmdAdd(opts, args[0]),
  remove: (opts, args) => cmdRemove(opts, args[0]),
  list: (opts) => cmdList(opts),
  update: (opts, args) => cmdUpdate(opts, args),
  doctor: (opts) => cmdDoctor(opts),
  sync: (opts) => cmdSync(opts),
  capabilities: (opts) => cmdCapabilities(opts),
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE) {
    console.error('img2: needs Node ' + MIN_NODE + ' or newer, found ' + process.versions.node)
    return EXIT.FAIL
  }
  const { command, opts, args } = parseArgs(process.argv.slice(2))
  if (opts.showVersion) {
    if (opts.json) {
      console.log(JSON.stringify({
        harness: harnessVersion(),
        maxPluginSchema: MAX_PLUGIN_SCHEMA,
        coreApi: CORE_API,
        contract: CONTRACT_REVISION,
        commands: Object.keys(COMMANDS),
      }))
      return EXIT.OK
    }
    console.log('img2 ' + harnessVersion() + ' (MAX_PLUGIN_SCHEMA=' + MAX_PLUGIN_SCHEMA + ', coreApi=' + CORE_API + ')')
    return EXIT.OK
  }
  if (opts.help || !command) {
    console.log(HELP)
    return opts.help ? EXIT.OK : EXIT.REFUSED
  }
  const handler = COMMANDS[command]
  if (!handler) {
    throw new CliError(EXIT.REFUSED, 'unknown command: ' + command, 'expected ' + Object.keys(COMMANDS).join(', '))
  }
  return handler(opts, args)
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  process.on('SIGINT', () => {
    releaseLock()
    process.exit(EXIT.FAIL)
  })
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      releaseLock()
      console.error('img2: ' + err.message)
      if (err.detail) console.error(err.detail)
      process.exit(err instanceof CliError ? err.code : EXIT.FAIL)
    })
}
