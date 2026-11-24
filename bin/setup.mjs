// One selection, then the existing installation and runtime building blocks, in order.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { ui } from './ui.mjs'
import { Refusal } from './runtime/errors.mjs'
import { loadLocks, resolveSelection, detectPlatform, assertSupported, weakArtifacts } from './runtime/lock.mjs'
import { buildUnits } from './runtime/plan.mjs'
import { managedPythonPath, realDeps, runProvision } from './runtime/provision.mjs'
import { runDoctorRuntime } from './runtime/doctor.mjs'
import { cleanEnv } from './runtime/exec.mjs'
import { childEnv } from './runtime/child-env.mjs'

export const SETUP_PLUGINS = [
  { id: 'character', description: 'Rigged characters, skin conditioning and animation.' },
  { id: 'cs2', description: 'Counter-Strike 2 weapon and glove skins.' },
  { id: 'interior', description: 'Textured interior scenes, Blender/PBR and GLB delivery.' },
  { id: 'jev', description: 'Image-aware routing and bounded decision advice.' },
  { id: 'pixi2d', description: 'Editable 2D reference reconstruction in PixiJS.' },
]
const allIds = () => SETUP_PLUGINS.map(p => p.id)

export function parseSetupSelection(answer) {
  if (answer === null || answer === undefined) throw new Refusal('plugin selection cancelled; nothing was changed', undefined, 3)
  const text = String(answer).trim()
  if (!text) return allIds()
  const requested = text.split(',').map(s => s.trim())
  if (requested.some(id => !allIds().includes(id))) {
    throw new Refusal('invalid plugin selection: ' + text, 'expected comma-separated names: ' + allIds().join(', '))
  }
  return allIds().filter(id => requested.includes(id))
}

async function askSelection(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise(resolve => {
      rl.once('close', () => resolve(null))
      rl.question(question, resolve)
    })
  } finally { rl.close() }
}

export async function selectSetupPlugins(opts, { isTTY = !!process.stdin.isTTY, ask = askSelection } = {}) {
  if (opts.plugins !== null && opts.plugins !== undefined) {
    if (!String(opts.plugins).trim()) throw new Refusal('--plugins needs at least one plugin name')
    return parseSetupSelection(opts.plugins)
  }
  if (opts.minimal) return ['jev']
  if (opts.yes || !isTTY) return allIds()
  return parseSetupSelection(await ask('Install plugins (Enter = all; or comma-separated names): '))
}

// Plugin tools (Jev auth-status, its login hint) use annotations such as `float | int` that need CPython >= 3.10.
export const MIN_TOOL_PYTHON = [3, 10]
const PY_PROBE = 'import sys; print(".".join(map(str, sys.version_info[:3])))'
const versionOk = v => {
  const m = /^(\d+)\.(\d+)/.exec(String(v ?? '').trim())
  return !!m && (Number(m[1]) > MIN_TOOL_PYTHON[0] || (Number(m[1]) === MIN_TOOL_PYTHON[0] && Number(m[2]) >= MIN_TOOL_PYTHON[1]))
}

// The interpreter every plugin tool runs with. The provisioned python-runtime (3.11) when this setup builds it;
// otherwise (python-runtime skipped or unavailable) a PATH python >= 3.10, probed now. Refuses before any
// install or download when neither exists, so a bad PATH costs seconds, not a full provisioning.
export async function resolveToolPython({ selection, locked, home, runtimeDeps }) {
  const managed = selection.deps.find(d => d.id === 'python-runtime')
  if (managed && managed.status !== 'skipped') {
    return { path: managedPythonPath(home, locked.lockDigest), version: managed.entry.version, managed: true }
  }
  const dirs = String((runtimeDeps.env ?? process.env).PATH ?? '').split(path.delimiter).filter(Boolean)
  const checked = []
  const seen = new Set()
  for (const name of ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3']) {
    for (const dir of dirs) {
      const file = path.join(dir, name)
      if (seen.has(file) || !fs.existsSync(file)) continue
      seen.add(file)
      const r = await runtimeDeps.run(file, ['-I', '-c', PY_PROBE], { env: cleanEnv({}, runtimeDeps.env ?? process.env), timeout: 30_000 })
      const version = String(r?.stdout ?? '').trim()
      checked.push(file + ' = ' + (r?.code === 0 && version ? version : 'unusable'))
      if (r?.code === 0 && versionOk(version)) return { path: file, version, managed: false }
    }
  }
  throw new Refusal('setup needs a Python >= ' + MIN_TOOL_PYTHON.join('.') + ' for plugin tools and found none',
    'the managed python-runtime is not part of this selection and no suitable python is on PATH.\nchecked: ' + (checked.join('; ') || 'nothing on PATH') + '\nNothing was changed.')
}

// Probe the installed executable, not this source CLI. Replacement remains an explicit update/install decision.
export async function verifyInstalledHarness(home, deps = realDeps()) {
  const file = path.join(home, 'harness', 'bin', 'img2.mjs')
  const result = await deps.run(process.execPath, [file, '--version', '--json'], { env: cleanEnv({}, deps.env ?? process.env), timeout: 20_000 })
  let info
  try { info = JSON.parse(result.stdout) } catch { /* refused below */ }
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(info?.harness ?? '')
  const current = version && (Number(version[1]) > 0 || Number(version[2]) >= 6)
  if (result.code !== 0 || result.error || result.timedOut || !current || info?.interfaces?.route !== 1
    || !['route', 'core-run', 'setup'].every(command => info?.commands?.includes(command))) {
    throw new Refusal('installed harness is obsolete or lacks the required route interface',
      'Update the clean official checkout explicitly with `img2 update harness --yes` to a reviewed release >= 0.6.0, or move it aside and use `img2 setup --from <reviewed-checkout>`. Setup did not provision runtimes.')
  }
  return info
}

const quote = value => /^[a-zA-Z0-9_./:@=-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'"
const loginCommand = (home, python) => 'IMG2_HOME=' + quote(home) + ' ' + quote(python) + ' ' + quote(path.join(home, 'plugins/jev/tools/jev.py')) + ' login'

// The one supported router invocation (bin/route.mjs): it picks the interpreter, PATH, canonical IMG2_HOME and the
// harness pins itself, so nothing about the managed Python is left for the user to arrange.
const canonical = p => { try { return fs.realpathSync(p) } catch { return p } }
export const routeCommand = home => 'node ' + quote(path.join(canonical(home), 'harness', 'bin', 'img2.mjs')) + ' --home ' + quote(canonical(home))
  + ' route --workspace WORKSPACE --run-id RUN_ID --image IMAGE [--objects OBJECTS.json] [--intent INTENT] [--expected-output 2d|3d]'

// Auth is delegated entirely to Jev. Never print its raw stdout/stderr or read a credential ourselves.
async function checkJevAuth(home, runtimeDeps, python) {
  let result
  try {
    result = await runtimeDeps.run(python, [path.join(home, 'plugins/jev/tools/jev.py'), 'auth-status'], {
      env: { ...childEnv(runtimeDeps.env ?? process.env, { credentials: true }), IMG2_HOME: home, PYTHONNOUSERSITE: '1' }, timeout: 20_000,
    })
  } catch { /* do not expose runner exceptions or credential-storage diagnostics */ }
  let status
  try { status = JSON.parse(result?.stdout) } catch { /* reported without subprocess output below */ }
  if (result && !result.error && !result.timedOut && status?.kind === 'img2.jev-command' && status.version === 1) {
    if (result.code === 0 && status.status === 'present' && status.reasonCode === 'credential-present') return 'present'
    if (result.code === 3 && status.status === 'missing' && status.reasonCode === 'credential-missing') return 'missing'
  }
  throw new Error('Jev auth-status unavailable (interpreter ' + python + '); run its auth-status command in a terminal to diagnose secure storage')
}

function runtimeCounts(id, locked, opts, runtimeDeps, checks) {
  const selection = resolveSelection({ lock: locked.lock, pluginsLock: locked.plugins, profile: 'full', plugins: [id], skip: opts.skip ?? [], platform: runtimeDeps.platform ?? detectPlatform() })
  const units = buildUnits(selection, locked.lock)
  const verified = units.filter(unit => {
    const rows = checks.filter(c => c.unit === unit.name)
    return rows.length > 0 && rows.every(c => c.status === 'pass')
  }).length
  return verified + '/' + units.length + (selection.skipped.length ? ' (' + selection.skipped.length + ' dependencies skipped)' : '')
}

// Command callbacks keep registry/host-link ownership in img2.mjs; runtimeDeps is also the existing
// provision/doctor offline-fixture seam, not a second installer implementation.
export async function runSetup(opts, home, deps) {
  const runtimeDeps = deps.runtimeDeps ?? realDeps()
  const out = deps.out ?? (text => console.log(text))
  const table = deps.table ?? ui.table
  const isTTY = deps.isTTY ?? runtimeDeps.isTTY
  let rows = []
  let stage = 'selection'
  let staticStatus = 'not run', runtimeStatus = 'not run'
  let runtimeChecks = null
  let locked
  const step = async (name, fn) => {
    stage = name
    out('==> ' + name)
    const code = await fn()
    if (code !== 0) throw Object.assign(new Error(name + ' exited ' + code), { code: Number.isInteger(code) ? code : 1 })
  }
  const summary = () => {
    out('Setup summary')
    table(['Plugin', 'Installed ref', 'Runtime units verified', 'Doctor', 'Next step'], rows.map(row => [
      row.id, row.ref ?? 'not installed',
      runtimeChecks ? runtimeCounts(row.id, locked, opts, runtimeDeps, runtimeChecks) : 'not checked',
      'static: ' + staticStatus + '; runtime: ' + runtimeStatus,
      row.next,
    ]))
  }
  try {
    if (isTTY && !opts.yes && !opts.minimal && opts.plugins == null) {
      out('Choose plugins (all selected by default):')
      for (const plugin of SETUP_PLUGINS) out('  [x] ' + plugin.id + ' - ' + plugin.description)
    }
    const selected = await selectSetupPlugins(opts, { isTTY, ask: deps.ask })
    rows = selected.map(id => ({ id, ref: null, next: 'Rerun img2 setup to repair/resume' }))
    stage = 'preflight'
    assertSupported(runtimeDeps.platform ?? detectPlatform())
    locked = loadLocks(runtimeDeps.lockRoot)
    const pins = selected.map(id => {
      const pin = locked.plugins.plugins.find(p => p.id === id && p.selectable)
      if (!pin || !/^[a-f0-9]{40}$/.test(pin.commit ?? '') || !/^https:\/\/github\.com\/img2threejs\/plugin-[a-z0-9-]+(?:\.git)?$/.test(pin.repo ?? '')) {
        throw new Refusal('missing or invalid official lock pin for ' + id)
      }
      return pin
    })
    if (opts.strictHash && opts.allowWeakHash) throw new Refusal('--strict-hash conflicts with --allow-weak-hash')
    const selection = resolveSelection({ lock: locked.lock, pluginsLock: locked.plugins, profile: 'full', plugins: selected, skip: opts.skip ?? [], platform: runtimeDeps.platform ?? detectPlatform() })
    const platform = selection.platform
    const weak = buildUnits(selection, locked.lock).flatMap(unit => unit.deps.flatMap(d => weakArtifacts(d.entry, platform).map(w => ({ ...w, unit: unit.name }))))
    if (weak.length && opts.strictHash) {
      throw new Refusal('--strict-hash: ' + weak.length + ' artifact(s) have no SHA-256 in the lock',
        weak.slice(0, 8).map(w => w.dep + ' ' + w.file + ' [' + w.kind + ']').join('\n') + '\nrerun without --strict-hash to accept them (a locally computed SHA-256 is recorded in the receipt), or --skip them. Nothing was changed.')
    }
    const python = await resolveToolPython({ selection, locked, home, runtimeDeps })
    out('Plugin tools run with Python ' + python.version + ' (' + (python.managed ? 'managed python-runtime, provisioned by this setup' : 'system') + '): ' + python.path)
    if (weak.length) {
      out('Notice: ' + weak.length + ' artifact(s) have no SHA-256 in the lock (browsers, model configs); accepted by default, a locally computed SHA-256 is recorded in ' + path.join(home, 'runtime', 'provision.json') + '. Use --strict-hash to refuse them.')
    }
    const corePin = locked.plugins.core
    const coreState = deps.corePlan ? await deps.corePlan(corePin) : null
    const installNeeded = await deps.installNeeded()
    if (!installNeeded && deps.verifyHarness) await deps.verifyHarness()
    const states = []
    for (const [i, pin] of pins.entries()) {
      const state = await deps.pluginState(pin)
      states.push(state)
      rows[i].ref = state.ref
    }
    if (opts.offline && ((installNeeded && !opts.from) || states.some(s => s.action !== 'keep') || (coreState && coreState.action !== 'keep'))) {
      throw new Refusal('--offline requires an installed harness, the core and every selected plugin at its lock pin (or --from for a local harness); Git downloads are disabled')
    }
    const common = { home, yes: true }
    if (installNeeded) {
      await step('install', () => deps.install({ ...common, from: opts.from }))
      if (deps.verifyHarness) await deps.verifyHarness()
    }
    if (deps.core) {
      out('Core ' + (coreState.action === 'keep' ? 'kept at ' + coreState.ref : 'will be checked out at ' + corePin.commit))
      await step('core', () => deps.core(corePin, { offline: !!opts.offline }))
    }
    for (const [i, pin] of pins.entries()) {
      if (pin.pinState === 'unpushed-local') out('Warning: ' + pin.id + ' lock pin is marked unpushed-local; it must be reachable from its Git source.')
      if (states[i].action === 'keep') {
        out('Kept ' + pin.id + ' at ' + rows[i].ref)
        if (deps.keep) await step('repair ' + pin.id, () => deps.keep(pin))
        continue
      }
      await step('add ' + pin.id, () => deps.add({ ...common, ref: pin.commit, plugin: pin.id, force: states[i].action === 'replace' }, pin.repo))
      rows[i].ref = pin.commit
    }
    await step('sync', () => deps.sync(common))
    await step('provision', () => (deps.provision ?? runProvision)({
      ...common, profile: 'full', minimal: false, plugins: selected.join(','),
      allowWeakHash: !opts.strictHash, skip: opts.skip ?? [], offline: !!opts.offline,
    }, home, runtimeDeps))
    staticStatus = 'failed'
    await step('doctor', () => deps.doctor(common))
    staticStatus = 'pass'
    runtimeStatus = 'failed'
    await step('doctor --runtime', async () => {
      let report
      const code = await (deps.doctorRuntime ?? runDoctorRuntime)({ home, json: true, deps: {
        ...runtimeDeps, out: text => { report = JSON.parse(text) },
      } })
      if (report?.checks) {
        runtimeChecks = report.checks
        table(['Status', 'Probe', 'Dependency', 'Result'], report.checks.map(c => [c.status, c.id, c.dependency, c.actual]))
      }
      if (code === 0 && !Array.isArray(report?.checks)) throw new Error('doctor --runtime returned no probe report')
      return code
    })
    runtimeStatus = 'pass'
    if (deps.writeProvisionRecord) {
      const file = deps.writeProvisionRecord({ python: { path: python.path, version: python.version, managed: python.managed }, lockDigest: locked.lockDigest })
      out('Router inputs recorded: ' + file)
    }
    for (const row of rows) row.next = 'Restart your agent; follow the plugin instructions'
    if (selected.includes('jev')) {
      stage = 'Jev auth-status'
      const jev = rows.find(row => row.id === 'jev')
      jev.next = 'Run ' + quote(python.path) + ' ' + quote(path.join(home, 'plugins/jev/tools/jev.py')) + ' auth-status in your terminal'
      const status = await checkJevAuth(home, runtimeDeps, python.path)
      if (status === 'missing') {
        jev.next = loginCommand(home, python.path)
        summary()
        out('Jev credential missing. Run this exact login command in your own terminal (TTY required; setup never handles the key):')
        out(jev.next)
        if (deps.core) { out('Then route an image (img2 route sets the interpreter, PATH, IMG2_HOME and harness pins; consent is still yours to grant):'); out(routeCommand(home)) }
        return 3
      }
      jev.next = 'Review workspace image-disclosure and paid-call consent before routing'
    }
    summary()
    if (deps.core) { out('Route an image with the core router (img2 route sets the interpreter, PATH, IMG2_HOME and harness pins; consent is still yours to grant):'); out(routeCommand(home)) }
    out('Setup complete. Re-run img2 setup with the same selection to verify and repair.')
    return 0
  } catch (error) {
    const code = Number.isInteger(error.code) && error.code >= 1 && error.code <= 3 ? error.code : 1
    out('Setup stopped at ' + stage + ' (exit ' + code + '): ' + error.message)
    if (error.detail) out(String(error.detail))
    if (rows.length) summary()
    return code
  }
}
