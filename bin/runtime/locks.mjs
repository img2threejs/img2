// Validators for dependencies.lock.json and plugins.lock.json (schema 1). Data only: nothing here installs.
const HEX64 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const ID_RE = /^[a-z][a-z0-9.-]*$/
const KINDS = new Set(['pip', 'npm', 'runtime-archive', 'binary', 'browser', 'model'])
const STATUSES = new Set(['resolved', 'unresolved'])
const PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'])
const PROFILES = ['full', 'minimal']

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = v => typeof v === 'string' && v.trim().length > 0
const isHttps = v => { try { return new URL(v).protocol === 'https:' } catch { return false } }

function* artifactsOf(entry) {
  for (const a of entry.artifacts ?? []) yield [entry.id, a]
  for (const t of entry.transitive ?? []) for (const a of t.artifacts ?? []) yield [`${entry.id}>${t.name}@${t.version}`, a]
}

export function validateDependenciesLock(lock, { invariants = true } = {}) {
  const errors = []
  const err = m => errors.push(m)
  if (!isObject(lock)) return ['lock must be a JSON object']
  if (lock.schema !== 1) err(`schema must be 1, got ${JSON.stringify(lock.schema)}`)
  if (!(lock.release === null || nonEmpty(lock.release))) err('release must be null or a non-empty string')
  if (!Array.isArray(lock.platforms) || lock.platforms.some(p => !PLATFORMS.has(p))) err('platforms must list known platforms')
  if (!isObject(lock.environments)) err('environments must be an object')
  if (!Array.isArray(lock.dependencies) || lock.dependencies.length === 0) { err('dependencies must be a non-empty array'); return errors }

  const byId = new Map()
  for (const [i, e] of lock.dependencies.entries()) {
    const at = `dependencies[${i}]`
    if (!isObject(e)) { err(`${at} must be an object`); continue }
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) { err(`${at}.id must match ${ID_RE}`); continue }
    if (byId.has(e.id)) { err(`duplicate dependency id ${e.id}`); continue }
    byId.set(e.id, e)
  }

  for (const e of byId.values()) {
    const at = e.id
    if (!isObject(lock.environments) || !isObject(lock.environments[e.environment])) err(`${at}: unknown environment ${JSON.stringify(e.environment)}`)
    if (!KINDS.has(e.kind)) err(`${at}: kind must be one of ${[...KINDS].join(', ')}`)
    if (!nonEmpty(e.version)) err(`${at}: version is required`)
    if (!Array.isArray(e.consumers) || e.consumers.length === 0 || e.consumers.some(c => !nonEmpty(c))) err(`${at}: consumers must be a non-empty string array`)
    if (!nonEmpty(e.probe)) err(`${at}: probe id is required`)
    if (!nonEmpty(e.ownership)) err(`${at}: ownership is required`)
    if (!Array.isArray(e.requires)) err(`${at}: requires must be an array`)
    else for (const r of e.requires) if (!byId.has(r)) err(`${at}: requires unknown id ${r}`)
    if (!isObject(e.constraints)) err(`${at}: constraints is required`)
    else {
      if (e.kind === 'pip' && !(isObject(e.constraints.python) && nonEmpty(e.constraints.python.abi) && nonEmpty(e.constraints.python.range))) err(`${at}: pip entries need constraints.python {abi, range}`)
      if (!Array.isArray(e.constraints.platforms) || e.constraints.platforms.some(p => !PLATFORMS.has(p))) err(`${at}: constraints.platforms must list known platforms`)
    }
    if (!Array.isArray(e.artifacts)) err(`${at}: artifacts must be an array`)
    if (!STATUSES.has(e.status)) { err(`${at}: status must be resolved or unresolved`); continue }

    const arts = [...artifactsOf(e)]
    for (const [where, a] of arts) {
      if (!isObject(a)) { err(`${where}: artifact must be an object`); continue }
      if (!isHttps(a.url)) err(`${where}: artifact url must be https (got ${JSON.stringify(a.url)})`)
      if (a.sha256 != null && !HEX64.test(a.sha256)) err(`${where}: sha256 must be 64 lowercase hex or absent`)
      if (a.platform !== 'any' && a.platform !== undefined && !PLATFORMS.has(a.platform)) err(`${where}: unknown artifact platform ${a.platform}`)
    }
    if (e.status === 'resolved') {
      if (arts.length === 0) err(`${at}: resolved entry has no artifacts`)
      for (const [where, a] of arts) if (isObject(a) && !HEX64.test(a.sha256 ?? '')) err(`${where}: resolved entry needs a 64-hex sha256`)
      if (e.reason !== undefined) err(`${at}: resolved entry must not carry a reason`)
    } else if (!(isObject(e.reason) && nonEmpty(e.reason.code) && nonEmpty(e.reason.reason))) err(`${at}: unresolved entry needs reason {code, reason}`)
  }

  if (!isObject(lock.profiles)) err('profiles must be an object')
  else {
    for (const name of PROFILES) {
      const p = lock.profiles[name]
      if (!isObject(p) || !Array.isArray(p.dependencies)) { err(`profiles.${name}.dependencies is required`); continue }
      const seen = new Set()
      for (const id of p.dependencies) {
        if (!byId.has(id)) err(`profiles.${name} references unknown id ${id}`)
        if (seen.has(id)) err(`profiles.${name} lists ${id} twice`)
        seen.add(id)
      }
      for (const id of seen) for (const r of byId.get(id)?.requires ?? []) if (!seen.has(r)) err(`profiles.${name}: ${id} requires ${r}, which the profile omits`)
    }
    const full = new Set(lock.profiles.full?.dependencies ?? [])
    for (const id of byId.keys()) if (!full.has(id)) err(`profiles.full omits ${id}`)
    for (const id of lock.profiles.minimal?.dependencies ?? []) if (!full.has(id)) err(`profiles.minimal has ${id} outside full`)
  }

  const cycle = findCycle(byId)
  if (cycle) err(`requires cycle: ${cycle.join(' > ')}`)
  if (invariants) errors.push(...invariantErrors(byId))
  return errors
}

function findCycle(byId) {
  const state = new Map()
  const walk = (id, path) => {
    if (state.get(id) === 2) return null
    if (state.get(id) === 1) return [...path.slice(path.indexOf(id)), id]
    state.set(id, 1)
    for (const r of byId.get(id)?.requires ?? []) if (byId.has(r)) { const c = walk(r, [...path, id]); if (c) return c }
    state.set(id, 2)
    return null
  }
  for (const id of byId.keys()) { const c = walk(id, []); if (c) return c }
  return null
}

// Owner decisions the lock must keep: separate bpy environments, Three versions not unified.
function invariantErrors(byId) {
  const errors = []
  const want = (id, name, version) => {
    const e = byId.get(id)
    if (!e) return errors.push(`${id} is required`)
    if (e.name !== name || e.version !== version) errors.push(`${id} must pin ${name}==${version}, got ${e.name}==${e.version}`)
    return e
  }
  const cb = want('character-bpy', 'bpy', '4.5.15')
  const ib = want('interior-bpy', 'bpy', '4.3.0')
  if (cb && ib && cb.environment === ib.environment) errors.push('character-bpy and interior-bpy must live in distinct environments')
  const ct = want('character-three', 'three', '0.186.1')
  const it = want('interior-three', 'three', '0.180.0')
  if (ct && it && ct.environment === it.environment) errors.push('character and interior viewer Three must live in distinct environments')
  want('pixi2d-pixi-js', 'pixi.js', '8.22.0')
  want('pixi2d-playwright', 'playwright', '1.64.0')
  want('interior-vite', 'vite', '6.4.1')
  const node = byId.get('node-runtime')
  if (!node || node.constraints?.node !== '>=22') errors.push('node-runtime must constrain node to >=22')
  return errors
}

export const CORE_REPO = 'https://github.com/img2threejs/img2threejs'

// The core skill (forge/route.py, preflight) is pinned beside the plugins: one exact commit, checked out
// under $IMG2_HOME/core by install/setup and verified by doctor.
export function validateCorePin(core) {
  if (!isObject(core)) return ['core pin is required (plugins.lock.json "core")']
  const errors = []
  if (core.id !== 'core') errors.push('core: id must be "core"')
  if (core.repo !== CORE_REPO) errors.push(`core: repo must be ${CORE_REPO}`)
  if (!COMMIT.test(core.commit ?? '')) errors.push('core: commit must be a 40-hex SHA')
  if (!nonEmpty(core.branch)) errors.push('core: branch is required')
  if (core.pinState !== 'on-origin' && core.pinState !== 'unpushed-local') errors.push('core: pinState must be on-origin or unpushed-local')
  if (!nonEmpty(core.note)) errors.push('core: note is required')
  else if (core.pinState === 'unpushed-local' && !/unpushed/i.test(core.note)) errors.push('core: unpushed-local pin must say so in note')
  return errors
}

const ROUTE_OBSERVATIONS = new Set(['enclosure', 'roomCount', 'articulation', 'flatness', 'multiplicity', 'stylization'])
function validRouteRules(rules) {
  if (!isObject(rules) || Object.keys(rules).some(key => !['roles', 'intent', 'observations'].includes(key))) return false
  for (const key of ['roles', 'intent']) if (rules[key] !== undefined && (!Array.isArray(rules[key])
    || rules[key].some(value => typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,95}$/.test(value)))) return false
  if (rules.observations !== undefined && (!isObject(rules.observations)
    || Object.entries(rules.observations).some(([key, values]) => !ROUTE_OBSERVATIONS.has(key) || !Array.isArray(values)
      || !values.length || values.some(value => !['string', 'boolean', 'number'].includes(typeof value)
        || (typeof value === 'number' && !Number.isFinite(value)))))) return false
  return true
}

function validRoutingSnapshot(snapshot, commit) {
  const card = snapshot?.card
  return isObject(snapshot) && snapshot.schema === 1 && snapshot.commit === commit
    && /^[0-9a-f]{64}$/.test(snapshot.routeCardSha256 ?? '') && isObject(card)
    && card.kind === 'img2.route-card' && card.version === 1
    && ['2d-scene', '3d-scene', '3d-object', 'rigged-3d', 'spec-augmentation'].includes(card.outputKind)
    && ['local', 'heavy', 'licensed', 'paid'].includes(card.costClass)
    && validRouteRules(card.requires ?? {}) && validRouteRules(card.notFor ?? {})
}

export function validatePluginsLock(lock, catalog) {
  const errors = []
  const err = m => errors.push(m)
  if (!isObject(lock)) return ['lock must be a JSON object']
  if (lock.schema !== 1) err(`schema must be 1, got ${JSON.stringify(lock.schema)}`)
  if (lock.defaultInstall !== 'all') err('defaultInstall must be "all"')
  if (!Array.isArray(lock.plugins)) return [...errors, 'plugins must be an array']
  const sources = new Map((catalog?.plugins ?? []).map(p => [p.id, p]))
  const seen = new Set()
  for (const [i, p] of lock.plugins.entries()) {
    const at = `plugins[${i}]`
    if (!isObject(p)) { err(`${at} must be an object`); continue }
    if (seen.has(p.id)) err(`duplicate plugin id ${p.id}`)
    seen.add(p.id)
    const row = sources.get(p.id)
    if (!row) { err(`${at}: plugin id ${JSON.stringify(p.id)} is not in catalog.json`); continue }
    if (!nonEmpty(p.capability)) err(`${p.id}: capability name is required`)
    else if (/plugin[-_ ]|img2threejs\//i.test(p.capability)) err(`${p.id}: capability must not expose a repository name`)
    if (p.repo !== `https://github.com/${row.source}`) err(`${p.id}: repo must be https://github.com/${row.source}`)
    if (!COMMIT.test(p.commit ?? '')) err(`${p.id}: commit must be a 40-hex SHA`)
    if (p.visibility !== row.access) err(`${p.id}: visibility ${p.visibility} must match catalog access ${row.access}`)
    if (typeof p.selectable !== 'boolean') err(`${p.id}: selectable must be boolean`)
    if (p.default !== true) err(`${p.id}: default must be true`)
    if (p.pinState !== 'on-origin' && p.pinState !== 'unpushed-local') err(`${p.id}: pinState must be on-origin or unpushed-local`)
    if (!nonEmpty(p.note)) err(`${p.id}: note is required`)
    else if (p.pinState === 'unpushed-local' && !/unpushed/i.test(p.note)) err(`${p.id}: unpushed-local pin must say so in note`)
    if (p.routing !== undefined && !validRoutingSnapshot(p.routing, p.commit)) err(`${p.id}: invalid or differently pinned routing snapshot`)
  }
  for (const id of sources.keys()) if (!seen.has(id)) err(`catalog plugin ${id} is missing from plugins.lock.json`)
  errors.push(...validateCorePin(lock.core))
  return errors
}
