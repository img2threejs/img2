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

const ALLOWED_PLACEHOLDERS = new Set(['{plugin_dir}', '{workspace}', '{image}'])
const SHELL_METACHAR_RE = /[;|&$`><()\n]/

export function commandFinding(command, pluginDir) {
  if (typeof command !== 'string' || !command.trim()) return 'empty "command"'

  const bracePattern = /\{[^{}]*\}/g
  let brace
  while ((brace = bracePattern.exec(command))) {
    if (!ALLOWED_PLACEHOLDERS.has(brace[0])) {
      return 'command uses unrecognised placeholder ' + brace[0] + '; only {plugin_dir}, {workspace} and {image} are permitted'
    }
  }

  const angle = /<[^<>\n]*>/.exec(command)
  if (angle) {
    return 'command uses angle-bracket pseudo-placeholder ' + angle[0] + '; a shell would read this as redirection, not a placeholder'
  }

  const stripped = command.replaceAll('{plugin_dir}', '').replaceAll('{workspace}', '').replaceAll('{image}', '')
  const metachars = stripped.match(new RegExp(SHELL_METACHAR_RE, 'g'))
  if (metachars) {
    return 'command contains shell metacharacter(s) ' + [...new Set(metachars)].join(' ') + '; commands run without a shell and must not need one'
  }

  for (const token of command.split(/\s+/).filter(Boolean)) {
    if (token.includes('{workspace}') || token.includes('{image}')) continue
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

async function resolveRefAndClone(H, spec, opts) {
  const { url, label, defaultOrg } = resolveSource(spec, opts.allowAnySource)
  await confirmOutOfOrgSource(url, defaultOrg, opts)
  const staging = path.join(pluginsDir(H), '.staging-' + process.pid)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(pluginsDir(H), { recursive: true })

  let ref = opts.ref || null
  if (!ref) {
    const tags = git(['ls-remote', '--tags', url])
      .split('\n')
      .map((line) => line.split('refs/tags/')[1])
      .filter((t) => t && !t.endsWith('^{}'))
      .map((t) => ({ tag: t, key: parseSemver(t.replace(/^v/, '')) }))
      .filter((t) => t.key)
      .sort((a, b) => cmpSemver(b.key, a.key))
    if (tags.length) ref = tags[0].tag
  }

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
      const cloned = await resolveRefAndClone(H, spec, opts)
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
    console.log('added ' + id + ' ' + manifest.version + ' (' + row.ref + ' @ ' + String(row.resolvedSha).slice(0, 7) + ')')
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
    console.log(row.id.padEnd(24) + String(version).padEnd(10) + String(row.ref).padEnd(14) + String(row.resolvedSha).slice(0, 7))
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

      let ignored = false
      try {
        git(['check-ignore', '-q', '--', '_img2_local.py'], dir)
        ignored = true
      } catch { /* not ignored, or not a git work tree */ }
      if (!ignored) err(row.id, '.gitignore does not cover _img2_local.py (contract section 4)')

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
            const bad = commandFinding(g.command, dir)
            if (bad) err(row.id, 'gates.json "' + g.id + '": ' + bad)
          }
        } catch (e) {
          err(row.id, e.message)
        }
      }
      const stepsFile = path.join(dir, 'steps.json')
      if (fs.existsSync(stepsFile)) {
        try {
          const rows = readRowsFile(stepsFile)
          for (const s of rows) {
            if (typeof s.title !== 'string' || !s.title) err(row.id, 'steps.json: "' + (s.id || '?') + '" needs a string "title"')
            const bad = commandFinding(s.command, dir)
            if (bad) err(row.id, 'steps.json "' + (s.id || '?') + '": ' + bad)
            allSteps.push(s)
          }
        } catch (e) {
          err(row.id, e.message)
        }
      }
    }

    try {
      topoSort(allSteps, 'steps (all plugins)')
    } catch (e) {
      err(null, e.message)
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

function buildProviderRow(H, dir, row, manifest) {
  const stepsFile = path.join(dir, 'steps.json')
  let steps = []
  if (fs.existsSync(stepsFile)) {
    steps = topoSort(readRowsFile(stepsFile), row.id + '/steps.json').map((s) => ({ id: s.id, argv: stepArgv(s.command, dir) }))
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
    try {
      candidates.push(buildProviderRow(H, dir, row, manifest))
    } catch (e) {
      addProblem(row.id, dir, e.message)
    }
  }

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
  '  img2 add --link <localpath> [--force]',
  '  img2 remove <id>',
  '  img2 list',
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
  '  --allow-any-source   accept a source outside the ' + DEFAULT_ORG + '/* org',
  '  --check              sync: verify generated artifacts without writing',
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
