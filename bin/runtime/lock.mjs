// Lock loading and plan resolution. Pure data: nothing here touches the network or the install tree.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDependenciesLock, validatePluginsLock } from './locks.mjs'
import { Refusal } from './errors.mjs'
import { sha256Hex } from './fsx.mjs'
import { validatePayload } from './catalog-validation.mjs'

export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PROFILES = ['full', 'minimal']
// bpy is the owner's essential capability: no silent platform downgrade.
export const ESSENTIAL = ['character-bpy', 'interior-bpy']
// --skip of these does not disable dependents: a matching, verified system interpreter stands in.
export const SOFT_SKIP = ['python-runtime']
export const PLUGIN_CONSUMERS = ['character', 'cs2', 'interior', 'jev', 'pixi2d']

// An x64 Node under Rosetta reports process.arch x64 on arm64 hardware; provision for the hardware.
export function hostArch(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || arch !== 'x64') return arch
  try {
    const r = spawnSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8', timeout: 5000 })
    if (r.status === 0 && r.stdout.trim() === '1') return 'arm64'
  } catch { /* fall back to process.arch */ }
  return arch
}

export function detectPlatform(platform = process.platform, arch = hostArch(platform)) {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
  if (!os || !cpu) {
    throw new Refusal('unsupported platform ' + platform + '/' + arch,
      'img2 provision supports macOS (arm64, x64) and Linux (x64, arm64). Windows is not supported; nothing was changed.')
  }
  return os + '-' + cpu
}

export function assertSupported(platform) {
  if (!/^(darwin|linux)-(arm64|x64)$/.test(String(platform))) {
    throw new Refusal('unsupported platform ' + platform, 'img2 provision supports macOS (arm64, x64) and Linux (x64, arm64). Windows is not supported; nothing was changed.')
  }
  return platform
}

export function loadLocks(root = HARNESS_ROOT) {
  const read = (name) => {
    let bytes
    try { bytes = fs.readFileSync(path.join(root, name)) } catch (e) { throw new Refusal(name + ' is unreadable', e.message) }
    let json
    try { json = JSON.parse(bytes.toString('utf8')) } catch (e) { throw new Refusal(name + ' is not valid JSON', e.message) }
    return { bytes, json, digest: sha256Hex(bytes) }
  }
  const deps = read('dependencies.lock.json')
  const plugins = read('plugins.lock.json')
  const errors = validateDependenciesLock(deps.json, { invariants: root === HARNESS_ROOT })
  if (errors.length) throw new Refusal('dependencies.lock.json is invalid', errors.slice(0, 10).join('\n'))
  const catalog = read('catalog.json').json
  try { validatePayload(catalog) } catch (error) { throw new Refusal('catalog.json is invalid', error.message) }
  const perrors = validatePluginsLock(plugins.json, catalog)
  if (perrors.length) throw new Refusal('plugins.lock.json is invalid', perrors.slice(0, 10).join('\n'))
  return { lock: deps.json, lockDigest: deps.digest, plugins: plugins.json, pluginsDigest: plugins.digest }
}

// ---------------------------------------------------------------- integrity

const b64hex = (b64) => Buffer.from(b64, 'base64').toString('hex')

// Strong: sha256, sha512 or an SRI sha512/256. Everything else (MD5/CRC32C, git SHA-1, GCS
// generation, nothing) is weak and refused unless --allow-weak-hash.
export function integrityOf(a) {
  if (/^[0-9a-f]{64}$/.test(a.sha256 ?? '')) return { algo: 'sha256', hex: a.sha256 }
  if (/^[0-9a-f]{128}$/.test(a.sha512 ?? '')) return { algo: 'sha512', hex: a.sha512 }
  if (typeof a.integrity === 'string') {
    const tokens = a.integrity.trim().split(/\s+/).map((t) => t.split('-', 2).concat(t.slice(t.indexOf('-') + 1)))
    for (const algo of ['sha512', 'sha256']) {
      const t = tokens.find((x) => x[0] === algo)
      if (t && /^[A-Za-z0-9+/]+={0,2}$/.test(t[2])) return { algo, hex: b64hex(t[2]) }
    }
    return { weak: true, kind: 'SHA-1 SRI' }
  }
  if (a.gitBlobSha1) return { weak: true, kind: 'git SHA-1', sha1: a.gitBlobSha1 }
  if (a.gcsGeneration) return { weak: true, kind: 'GCS generation only' }
  return { weak: true, kind: 'MD5/CRC32C or no published hash' }
}

export const forPlatform = (list, platform) => (list ?? []).filter((a) => a.platform === undefined || a.platform === 'any' || a.platform === platform)

const npmMatches = (t, platform) => {
  const [os, cpu] = platform.split('-')
  return (!t.os || t.os.includes(os)) && (!t.cpu || t.cpu.includes(cpu))
}

// Every downloadable artifact of one dependency on this platform:
// [{ part, name, version, artifact, os?, cpu?, scriptsReviewed? }]. `part` is 'self' or 'transitive'.
export function artifactsOf(entry, platform) {
  const out = []
  for (const a of forPlatform(entry.artifacts, platform)) out.push({ part: 'self', name: entry.name, version: entry.version, artifact: a, scriptsReviewed: entry.scriptsReviewed === true })
  for (const t of entry.transitive ?? []) {
    if (!npmMatches(t, platform) && entry.kind === 'npm') {
      // optional platform packages are listed for the packument but never downloaded
      for (const a of t.artifacts ?? []) out.push({ part: 'transitive', name: t.name, version: t.version, artifact: a, os: t.os, cpu: t.cpu, skipped: true })
      continue
    }
    for (const a of forPlatform(t.artifacts, platform)) out.push({ part: 'transitive', name: t.name, version: t.version, artifact: a, os: t.os, cpu: t.cpu, scriptsReviewed: t.scriptsReviewed === true })
  }
  return out
}

// Browsers are installed by the pinned Playwright CLI, so no artifact can be hashed before use.
export const isBrowser = (e) => e.kind === 'browser'

export function weakArtifacts(entry, platform) {
  if (isBrowser(entry)) {
    return forPlatform(entry.artifacts, platform).map((a) => ({
      dep: entry.id, file: a.filename ?? a.url, kind: 'downloaded by the Playwright CLI; the lock pins no SHA-256 (the CDN publishes only MD5/CRC32C)',
    }))
  }
  return artifactsOf(entry, platform).filter((x) => !x.skipped && integrityOf(x.artifact).weak).map((x) => ({
    dep: entry.id, file: x.artifact.filename ?? x.artifact.url, kind: integrityOf(x.artifact).kind,
  }))
}

// The lock is resolved per platform: a transitive wheel with no artifact for this platform (for example
// the CUDA wheels on macOS) is simply not part of it. Only constraints and the entry's own artifacts decide.
export function isAvailable(entry, platform) {
  if (entry.constraints?.platforms && !entry.constraints.platforms.includes(platform)) return false
  if ((entry.artifacts ?? []).length && forPlatform(entry.artifacts, platform).length === 0) return false
  return true
}

export function sizesOf(entry, platform) {
  const s = { download: 0, downloadUnknown: 0, expanded: 0, expandedUnknown: 0 }
  for (const x of artifactsOf(entry, platform)) {
    if (x.skipped) continue
    if (Number.isFinite(x.artifact.size)) s.download += x.artifact.size; else s.downloadUnknown += 1
    if (Number.isFinite(x.artifact.unpackedSize)) s.expanded += x.artifact.unpackedSize; else s.expandedUnknown += 1
  }
  return s
}

// ---------------------------------------------------------------- plan

export function parseCsv(value, flag) {
  const ids = String(value).split(',').map((s) => s.trim()).filter(Boolean)
  if (!ids.length) throw new Refusal(flag + ' needs at least one id')
  return [...new Set(ids)]
}

export function resolveSelection({ lock, pluginsLock, profile = 'full', plugins = null, skip = [], platform }) {
  if (!PROFILES.includes(profile)) throw new Refusal('unknown profile ' + JSON.stringify(profile), 'expected full or minimal')
  const known = pluginsLock.plugins.filter((p) => p.selectable).map((p) => p.id)
  const selectedPlugins = (plugins ?? known).slice().sort()
  for (const id of selectedPlugins) if (!known.includes(id)) throw new Refusal('unknown plugin ' + JSON.stringify(id), 'expected ' + known.join(', '))
  const byId = new Map(lock.dependencies.map((e) => [e.id, e]))
  for (const id of skip) if (!byId.has(id)) throw new Refusal('unknown dependency id ' + JSON.stringify(id), 'see dependencies.lock.json')

  const inProfile = new Set(lock.profiles[profile].dependencies)
  const needed = (e) => {
    const pluginOnly = e.consumers.every((c) => PLUGIN_CONSUMERS.includes(c))
    return !pluginOnly || e.consumers.some((c) => selectedPlugins.includes(c))
  }
  const wanted = new Set([...inProfile].filter((id) => needed(byId.get(id))))
  const close = (id) => { for (const r of byId.get(id).requires) if (inProfile.has(r) && !wanted.has(r)) { wanted.add(r); close(r) } }
  for (const id of [...wanted]) close(id)

  const state = new Map() // id -> { status, reason, cause }
  const disable = (id, reason, cause) => { if (!state.has(id)) state.set(id, { status: 'skipped', reason, cause }) }
  for (const id of wanted) {
    const e = byId.get(id)
    if (skip.includes(id)) disable(id, 'skipped by --skip ' + id, 'user')
    else if (!isAvailable(e, platform)) {
      const why = Object.entries(e.unavailable ?? {}).filter(([k]) => k.startsWith(platform)).map(([, v]) => v)[0]
      disable(id, 'not available on ' + platform + (why ? ': ' + why : ''), 'platform')
    }
  }
  for (let changed = true; changed;) {
    changed = false
    for (const id of wanted) {
      if (state.has(id)) continue
      const bad = byId.get(id).requires.find((r) => state.has(r) && !(SOFT_SKIP.includes(r) && state.get(r).cause === 'user'))
      if (bad) { disable(id, 'requires ' + bad + ', which is disabled (' + state.get(bad).reason + ')', state.get(bad).cause); changed = true }
    }
  }
  for (const id of ESSENTIAL) {
    const st = state.get(id)
    if (st && st.cause === 'platform') {
      throw new Refusal('essential dependency ' + id + ' cannot be installed on ' + platform, st.reason + '\nbpy is required; pass --skip ' + id + ' to continue without it.')
    }
  }
  const order = topo([...wanted], byId)
  const deps = order.map((id) => ({ id, entry: byId.get(id), ...(state.get(id) ?? { status: 'install' }) }))
  return { platform, profile, selectedPlugins, deps, skipped: deps.filter((d) => d.status === 'skipped') }
}

function topo(ids, byId) {
  const set = new Set(ids)
  const out = []
  const seen = new Set()
  const visit = (id, stack) => {
    if (seen.has(id)) return
    if (stack.includes(id)) throw new Refusal('dependency cycle: ' + [...stack, id].join(' > '))
    for (const r of byId.get(id).requires) if (set.has(r)) visit(r, [...stack, id])
    seen.add(id)
    out.push(id)
  }
  for (const id of ids) visit(id, [])
  return out
}

export const fmtBytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(0) + ' kB' : n + ' B')

export function describeSize(bytes, unknown) {
  if (!bytes && !unknown) return '0 B'
  if (!unknown) return fmtBytes(bytes)
  return (bytes ? '>= ' + fmtBytes(bytes) + ' + ' : '') + unknown + ' unknown'
}
