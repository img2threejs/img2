// `img2 provision`: plan -> single confirmation -> per-unit stage / probe / atomic activation -> selectors.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { buildUnit, unitFingerprint, PROVISION_SCHEMA } from './build.mjs'
import { Cache, httpsDownload } from './cache.mjs'
import { EXIT, Refusal, StepError } from './errors.mjs'
import { cleanEnv, mcpHandshake, realRunner } from './exec.mjs'
import { atomicWriteJson, ensureDir, isUnder, liveProcess, rmrf } from './fsx.mjs'
import { artifactsOf, assertSupported, detectPlatform, isBrowser, loadLocks, parseCsv, resolveSelection } from './lock.mjs'
import { makePlan, planLines, buildUnits, playwrightOwner } from './plan.mjs'
import { runProbes } from './probes.mjs'
import { buildSelectors, checkSelectorPath, writeEnvSh, writeSelectors, selectorsPath, envShPath } from './selectors.mjs'

export const runtimeRootOf = (home) => path.join(home, 'runtime')
const OWNED_FILES = ['selectors.json', 'env.sh', 'provision.json', '.provision.lock']
const DIGEST_DIR = /^[0-9a-f]{12}$/

export function realDeps() {
  return {
    run: realRunner(), mcp: mcpHandshake, download: httpsDownload,
    isTTY: !!process.stdin.isTTY, confirm: askYesDefault,
    out: (line) => process.stdout.write(line + '\n'), err: (line) => process.stderr.write(line + '\n'),
    now: () => new Date(), lockRoot: undefined,
  }
}

// The single confirmation defaults to yes: Enter accepts.
export const isAffirmative = (answer) => /^(|y|yes)$/i.test(String(answer ?? '').trim())

async function askYesDefault(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise((resolve) => {
      let settled = false
      rl.once('close', () => { if (!settled) { settled = true; resolve(null) } })
      rl.question('  [?] ' + question + ' [Y/n] ', (a) => { settled = true; resolve(a) })
    })
    if (answer === null) return false
    return isAffirmative(answer)
  } finally { rl.close() }
}

export function parseProvisionOpts(opts) {
  if (opts.remove && (opts.plan || opts.plugins || opts.skip?.length || opts.offline)) throw new Refusal('--remove cannot be combined with --plan, --plugins, --skip or --offline')
  const profile = opts.minimal ? 'minimal' : (opts.profile ?? 'full')
  if (opts.minimal && opts.profile && opts.profile !== 'minimal') throw new Refusal('--minimal conflicts with --profile ' + opts.profile)
  return {
    profile, plugins: opts.plugins ? parseCsv(opts.plugins, '--plugins') : null,
    skip: [...new Set(opts.skip ?? [])], plan: !!opts.plan, yes: !!opts.yes, offline: !!opts.offline,
    allowWeakHash: !!opts.allowWeakHash, remove: !!opts.remove, json: !!opts.json,
  }
}

// ---------------------------------------------------------------- locking

function acquireLock(runtimeRoot) {
  ensureDir(runtimeRoot)
  const file = path.join(runtimeRoot, '.provision.lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return () => rmrf(file)
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let pid = NaN
      try { pid = Number(fs.readFileSync(file, 'utf8')) } catch { /* raced */ }
      if (Number.isInteger(pid) && pid > 0 && liveProcess(pid)) throw new Refusal('another img2 provision is running (pid ' + pid + ')', 'wait for it, or remove ' + file + ' if that process is gone')
      rmrf(file)
    }
  }
  throw new Refusal('cannot take the provision lock at ' + file)
}

// ---------------------------------------------------------------- context

function makeCtx({ deps, rtDir, cacheDir, platform, lock, offline, allowWeak, receipts }) {
  const cache = new Cache({ dir: cacheDir, download: deps.download, offline, allowWeak })
  const tmpDir = path.join(rtDir, '.tmp')
  const ctx = {
    platform, lock, cache, cacheDir, rtDir, tmpDir, offline, run: deps.run, mcp: deps.mcp,
    record: (row) => receipts.push({ at: deps.now().toISOString(), ...row }),
    async step(unit, what, fn) {
      const started = Date.now()
      try {
        const v = await fn()
        ctx.record({ kind: 'step', unit, step: what, ok: true, ms: Date.now() - started })
        return v
      } catch (e) {
        ctx.record({ kind: 'step', unit, step: what, ok: false, ms: Date.now() - started, error: e.message, detail: e.detail })
        throw e
      }
    },
    // tolerateFailure: a non-zero exit is returned ({ ok: false, ... }) instead of thrown, for callers that judge it.
    async exec(unit, what, file, args, { cwd, env, timeout, tolerateFailure = false } = {}) {
      const started = Date.now()
      const r = await deps.run(file, args, { cwd, env: cleanEnv({ TMPDIR: tmpDir, ...(env ?? {}) }), timeout })
      const ok = r.code === 0 && !r.error && !r.timedOut
      ctx.record({ kind: 'exec', unit, step: what, command: [file, ...args].join(' ').slice(0, 400), exitCode: r.code, timedOut: r.timedOut || undefined, ok, ms: Date.now() - started })
      if (!ok && tolerateFailure) return { ...r, ok }
      if (!ok) {
        throw new StepError(what + ' failed' + (r.timedOut ? ' (timeout)' : ' (exit ' + r.code + ')') + ' in ' + unit,
          [r.error, r.stderr.trim().slice(-1500), r.stdout.trim().slice(-500)].filter(Boolean).join('\n'), { exitCode: r.code })
      }
      return { ...r, ok }
    },
  }
  return ctx
}

// ---------------------------------------------------------------- activation

const safeUnitDir = (rtDir, name) => {
  const dir = path.join(rtDir, ...name.split('/'))
  if (!isUnder(rtDir, dir)) throw new Refusal('unit path escapes the runtime tree: ' + name)
  return dir
}

// venv console scripts and activate files carry the staging path; point them at the final location.
function retargetVenv(stage, finalDir) {
  const bin = path.join(finalDir, 'venv', 'bin')
  if (!fs.existsSync(bin)) return
  for (const name of fs.readdirSync(bin)) {
    const p = path.join(bin, name)
    const st = fs.lstatSync(p)
    if (!st.isFile() || st.size > 1024 * 1024) continue
    const text = fs.readFileSync(p)
    if (text.includes(0)) continue // binary
    const s = text.toString('latin1')
    if (s.includes(stage)) fs.writeFileSync(p, Buffer.from(s.split(stage).join(finalDir), 'latin1'), { mode: st.mode & 0o777 })
  }
}

// Units are switched in as they pass (later units probe against earlier ones), but the directory each switch
// replaces is parked under .rollback/ until the WHOLE run has succeeded. Any failure puts every parked unit back.
const rollbackDir = (rtDir) => path.join(rtDir, '.rollback')
const parkedName = (name) => encodeURIComponent(name)

function activate(stage, finalDir, parkedAs) {
  ensureDir(path.dirname(finalDir))
  let parked = null
  if (fs.existsSync(finalDir)) {
    ensureDir(path.dirname(parkedAs))
    rmrf(parkedAs)
    fs.renameSync(finalDir, parkedAs)
    parked = parkedAs
  }
  try {
    fs.renameSync(stage, finalDir)
  } catch (e) {
    if (parked) fs.renameSync(parked, finalDir)
    throw e
  }
  return parked
}

// Restores every parked unit (newest first). Returns the unit names that could not be restored.
function rollBack(rtDir, activated, out) {
  const failed = []
  for (const a of [...activated].reverse()) {
    try {
      rmrf(a.finalDir)
      if (a.parked) fs.renameSync(a.parked, a.finalDir)
    } catch (e) { failed.push(a.name + ' (' + e.message + ')') }
  }
  if (!failed.length) rmrf(rollbackDir(rtDir))
  else out('rollback incomplete; previous units are parked in ' + rollbackDir(rtDir) + ': ' + failed.join('; '))
  return failed
}

// A crashed run can leave parked units behind: put them back before doing anything else.
function recoverParked(rtDir) {
  const dir = rollbackDir(rtDir)
  if (!fs.existsSync(dir)) return
  for (const n of fs.readdirSync(dir)) {
    const finalDir = safeUnitDir(rtDir, decodeURIComponent(n))
    rmrf(finalDir)
    ensureDir(path.dirname(finalDir))
    fs.renameSync(path.join(dir, n), finalDir)
  }
  rmrf(dir)
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

function pctxFor(ctx, unitDir, selection) {
  const browsersFor = (id) => path.join(ctx.rtDir, 'browsers', id, 'browsers')
  const dotnet = path.join(ctx.rtDir, 'cs2', 'cs2-dotnet-runtime')
  return {
    run: ctx.run, mcp: ctx.mcp, rtDir: ctx.rtDir, unitDir, tmpDir: ctx.tmpDir, browsersFor,
    dotnetRoot: fs.existsSync(dotnet) ? dotnet : undefined, selection,
  }
}

export { pctxFor }
// The part of the context probes need (runner, MCP client, scratch dir); doctor builds only this.
export function makeProbeCtx({ deps, rtDir, tmpDir }) {
  ensureDir(tmpDir)
  return { run: deps.run, mcp: deps.mcp, rtDir, tmpDir }
}

export function failedChecks(checks) { return checks.filter((c) => c.status === 'fail') }

// --offline works only from a complete cache: refuse before changing anything when something is missing.
function offlinePrecheck({ units, selection, lock, platform, runtimeRoot, lockDigest, deps }) {
  const cache = new Cache({ dir: path.join(runtimeRoot, 'cache'), download: deps.download, offline: true, allowWeak: true })
  const rtDir = path.join(runtimeRoot, lockDigest.slice(0, 12))
  const missing = []
  for (const unit of units) {
    const cliDep = unit.environment === 'browsers' ? playwrightOwner(unit.deps[0].entry, selection, lock) : null
    const fingerprint = unitFingerprint({ unit, platform, lock, cliDep: cliDep?.id })
    if (readJson(path.join(rtDir, ...unit.name.split('/'), '.img2-unit.json'))?.fingerprint === fingerprint) continue
    // browser bundles are not content-addressed (Playwright downloads them); their tree cache is checked below
    const entries = [...unit.deps.map((d) => d.entry).filter((e) => !isBrowser(e)), ...(cliDep ? [cliDep] : [])]
    for (const entry of entries) {
      for (const x of artifactsOf(entry, platform)) {
        if (!x.skipped && !cache.has(x.artifact)) missing.push(entry.id + ' ' + (x.artifact.filename ?? x.artifact.url))
      }
    }
    for (const d of unit.deps) if (isBrowser(d.entry)) {
      const dirs = path.join(runtimeRoot, 'cache', 'browsers')
      if (!fs.existsSync(dirs) || fs.readdirSync(dirs).length === 0) missing.push(d.id + ' (browser bundle from the Playwright CDN)')
    }
  }
  if (missing.length) throw new Refusal('--offline: the cache is incomplete (' + missing.length + ' missing)', missing.slice(0, 10).join('\n') + (missing.length > 10 ? '\n... and ' + (missing.length - 10) + ' more' : '') + '\nrun once online to fill ' + path.join(runtimeRoot, 'cache') + '. Nothing was changed.')
}

// ---------------------------------------------------------------- main

export async function runProvision(rawOpts, home, deps = realDeps()) {
  const o = parseProvisionOpts(rawOpts)
  const out = deps.out ?? (() => {})
  const platform = assertSupported(deps.platform ?? detectPlatform())
  if (o.remove) return removeRuntime(home, out)

  const { lock, lockDigest, plugins, pluginsDigest } = loadLocks(deps.lockRoot)
  const selection = resolveSelection({ lock, pluginsLock: plugins, profile: o.profile, plugins: o.plugins, skip: o.skip, platform })
  const runtimeRoot = runtimeRootOf(home)
  const plan = makePlan({ selection, lock, platform, root: runtimeRoot, lockDigest, opts: o })

  if (o.plan) {
    if (o.json) out(JSON.stringify(plan, null, 2)); else for (const l of planLines(plan)) out(l)
    return EXIT.OK
  }
  if (!o.yes && !deps.isTTY) throw new Refusal('confirmation needed but stdin is not a terminal', 'pass --yes to accept the plan (use --plan to review it first)')
  if (plan.weak.length && !o.allowWeakHash) {
    throw new Refusal(plan.weak.length + ' artifact(s) have no SHA-256 in the lock', plan.weak.slice(0, 8).map((w) => w.dep + ' ' + w.file + ' [' + w.kind + ']').join('\n')
      + '\nrerun with --allow-weak-hash to accept them (a locally computed SHA-256 is recorded in the receipt), or --skip them. Nothing was changed.')
  }
  if (!o.yes) {
    for (const l of planLines(plan).slice(0, -1)) out(l)
    if (!(await deps.confirm('Install everything above into ' + runtimeRoot + '?'))) {
      out('declined; nothing was changed')
      return EXIT.DECLINED
    }
  }
  if (o.offline) offlinePrecheck({ units: buildUnits(selection, lock), selection, lock, platform, runtimeRoot, lockDigest, deps })
  return execute({ o, plan, selection, lock, lockDigest, plugins, pluginsDigest, platform, home, runtimeRoot, deps, out })
}

async function execute({ o, plan, selection, lock, lockDigest, plugins, pluginsDigest, platform, home, runtimeRoot, deps, out }) {
  ensureDir(runtimeRoot)
  const release = acquireLock(runtimeRoot)
  const rtDir = path.join(runtimeRoot, lockDigest.slice(0, 12))
  const receipts = []
  const started = deps.now()
  const summary = { schema: PROVISION_SCHEMA, status: 'running', startedAt: started.toISOString(), platform, profile: o.profile, selectedPlugins: selection.selectedPlugins, lockDigest, pluginsLockDigest: pluginsDigest, offline: o.offline, allowWeakHash: o.allowWeakHash, skipRequested: o.skip, skipped: selection.skipped.map((d) => ({ id: d.id, reason: d.reason })), units: [], steps: receipts }
  let failure = null
  const activated = []
  let rollbackFailed = []
  try {
    ensureDir(rtDir)
    recoverParked(rtDir)
    const ctx = makeCtx({ deps, rtDir, cacheDir: path.join(runtimeRoot, 'cache'), platform, lock, offline: o.offline, allowWeak: o.allowWeakHash, receipts })
    ensureDir(ctx.tmpDir)
    const units = buildUnits(selection, lock)
    const exportsAll = {}
    const stagingRoot = path.join(rtDir, '.staging')
    rmrf(stagingRoot)
    for (const unit of units) {
      const finalDir = safeUnitDir(rtDir, unit.name)
      const cliDep = unit.environment === 'browsers' ? playwrightOwner(unit.deps[0].entry, selection, lock) : null
      const fingerprint = unitFingerprint({ unit, platform, lock, cliDep: cliDep?.id })
      const row = { name: unit.name, dependencies: unit.deps.map((d) => d.id), path: finalDir, fingerprint, reused: false, probes: [] }
      summary.units.push(row)
      out('==> ' + unit.name)

      const existing = readJson(path.join(finalDir, '.img2-unit.json'))
      if (existing?.fingerprint === fingerprint) {
        const checks = await runProbes(pctxFor(ctx, finalDir, selection), unit.deps)
        if (!failedChecks(checks).length) {
          row.reused = true; row.probes = checks; row.exports = existing.exports
          Object.assign(exportsAll, absExports(finalDir, existing.exports, unit))
          ctx.record({ kind: 'reuse', unit: unit.name, fingerprint })
          out('    reused (verified)')
          continue
        }
        ctx.record({ kind: 'reuse-rejected', unit: unit.name, failing: failedChecks(checks).map((c) => c.id + ': ' + c.actual) })
      }

      const stage = path.join(stagingRoot, unit.name.replace(/\//g, '__'))
      rmrf(stage)
      ensureDir(stage)
      try {
        const { exports, waivers } = await buildUnit(ctx, unit, stage, cliDep)
        if (waivers.length) row.waivers = waivers
        const checks = await runProbes(pctxFor(ctx, stage, selection), unit.deps)
        row.probes = checks
        const bad = failedChecks(checks)
        if (bad.length) throw new StepError('probe failed for ' + unit.name, bad.map((c) => c.id + ' (' + c.dependency + '): expected ' + c.expected + '; actual ' + c.actual + (c.stderr ? '\n' + c.stderr : '')).join('\n'))
        const declared = declaredExports(unit)
        const kept = Object.fromEntries(Object.entries(exports).filter(([k]) => declared.has(k)))
        atomicWriteJson(path.join(stage, '.img2-unit.json'), { schema: PROVISION_SCHEMA, fingerprint, dependencies: row.dependencies, exports: kept, builtAt: deps.now().toISOString() }, 0o644)
        const parked = activate(stage, finalDir, path.join(rollbackDir(rtDir), parkedName(unit.name)))
        activated.push({ name: unit.name, finalDir, parked })
        retargetVenv(stage, finalDir)
        row.exports = kept
        Object.assign(exportsAll, absExports(finalDir, kept, unit))
        ctx.record({ kind: 'activate', unit: unit.name, path: finalDir })
        out('    installed and verified')
      } catch (e) {
        rmrf(stage)
        row.failed = { message: e.message, detail: e.detail }
        throw e
      }
    }
    rmrf(stagingRoot)
    rmrf(ctx.tmpDir)

    const env = {}
    for (const k of ['IMG2_CHARACTER_NODE', 'IMG2_CHARACTER_BROWSER', 'IMG2_CHARACTER_BPY_PYTHON', 'IMG2_CHARACTER_THREE_ROOT', 'IMG2_CHARACTER_THREE_SHA256', 'IMG2_BLENDER_PYTHON', 'IMG2THREEJS_VISION_PYTHON', 'PLAYWRIGHT_BROWSERS_PATH']) {
      if (exportsAll[k] !== undefined) env[k] = exportsAll[k]
    }
    for (const [k, v] of Object.entries(env)) {
      if (k === 'IMG2_CHARACTER_THREE_SHA256') continue
      const why = checkSelectorPath(v, runtimeRoot)
      if (why) throw new StepError('selector ' + k + ' is unusable: ' + why, v)
    }
    const selectors = buildSelectors({ lockDigest, pluginsLockDigest: pluginsDigest, selectedPlugins: selection.selectedPlugins, env, now: deps.now() })
    writeSelectors(runtimeRoot, selectors)
    const extra = {}
    for (const k of ['IMG2_PYTHON', 'SOURCE2VIEWER_CLI', 'DOTNET_ROOT']) if (exportsAll[k] !== undefined) extra[k] = exportsAll[k]
    writeEnvSh(runtimeRoot, selectors, extra)
    rmrf(rollbackDir(rtDir)) // every unit and the selectors are in place: the previous units can go
    summary.status = 'ok'
    summary.selectors = selectorsPath(runtimeRoot)
    out('selectors written: ' + selectorsPath(runtimeRoot))
    out('env script       : ' + envShPath(runtimeRoot))
  } catch (e) {
    failure = e
    rollbackFailed = rollBack(rtDir, activated, out)
    summary.status = 'failed'
    summary.rolledBack = activated.map((a) => a.name)
    summary.error = { message: e.message, detail: e.detail }
  } finally {
    summary.finishedAt = deps.now().toISOString()
    try { atomicWriteJson(path.join(runtimeRoot, 'provision.json'), summary, 0o600) } catch { /* reported below */ }
    release()
  }
  if (failure) {
    if (failure instanceof Refusal) throw failure
    ;(deps.err ?? out)('img2 provision failed: ' + failure.message)
    if (failure.detail) for (const l of String(failure.detail).split('\n')) (deps.err ?? out)('    ' + l)
    ;(deps.err ?? out)(rollbackFailed.length
      ? 'rollback FAILED for ' + rollbackFailed.join('; ') + '; the next `img2 provision` restores the parked units first (receipt: ' + path.join(runtimeRoot, 'provision.json') + ')'
      : 'every unit this run switched in was rolled back; the previous runtime is as it was. Rerun `img2 provision` to resume from the verified cache (receipt: ' + path.join(runtimeRoot, 'provision.json') + ')')
    return EXIT.FAIL
  }
  return EXIT.OK
}

const declaredExports = (unit) => new Set(unit.deps.flatMap((d) => d.entry.exports ?? []).concat(unit.environment === 'browsers' ? ['PLAYWRIGHT_BROWSERS_PATH'] : []))

function absExports(unitDir, rel, unit) {
  const out = {}
  for (const [k, v] of Object.entries(rel ?? {})) {
    if (k === 'IMG2_CHARACTER_THREE_SHA256') out[k] = v
    else out[k] = path.join(unitDir, v)
  }
  // browsers that are not the character browser must not claim the selector
  if (unit.environment === 'browsers' && !unit.deps.some((d) => (d.entry.exports ?? []).includes('IMG2_CHARACTER_BROWSER'))) delete out.PLAYWRIGHT_BROWSERS_PATH
  return out
}

// ---------------------------------------------------------------- remove

// Removes only what provisioning created: digest directories, receipts, selectors, env.sh, the cache.
export function removeRuntime(home, out = () => {}) {
  const runtimeRoot = runtimeRootOf(home)
  if (!fs.existsSync(runtimeRoot)) { out('nothing to remove: ' + runtimeRoot + ' does not exist'); return EXIT.OK }
  const lockFile = path.join(runtimeRoot, '.provision.lock')
  if (fs.existsSync(lockFile)) {
    const pid = Number(fs.readFileSync(lockFile, 'utf8'))
    if (Number.isInteger(pid) && liveProcess(pid)) throw new Refusal('img2 provision is running (pid ' + pid + '); not removing', lockFile)
  }
  const removed = []
  for (const name of fs.readdirSync(runtimeRoot)) {
    const p = path.join(runtimeRoot, name)
    const st = fs.lstatSync(p)
    const owned = (DIGEST_DIR.test(name) && st.isDirectory() && !st.isSymbolicLink()) || (name === 'cache' && st.isDirectory() && !st.isSymbolicLink())
      || (OWNED_FILES.includes(name) && (st.isFile() || st.isSymbolicLink()))
    if (!owned) continue
    rmrf(p)
    removed.push(name)
  }
  try { fs.rmdirSync(runtimeRoot) } catch { /* holds files img2 did not create: leave them */ }
  out('removed: ' + (removed.join(', ') || 'nothing') + (fs.existsSync(runtimeRoot) ? '\nleft in place (not created by img2): ' + fs.readdirSync(runtimeRoot).join(', ') : ''))
  return EXIT.OK
}
