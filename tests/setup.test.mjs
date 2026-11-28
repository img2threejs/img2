// Offline acceptance tests for `img2 setup` (bin/setup.mjs). Every step binding (install, add, sync, doctor,
// provision, runtime doctor, Jev auth probe) is a recording stub, except one scenario that drives the real
// runtime provisioner/doctor through the shared tests/runtime-fixtures.mjs. Nothing touches the network,
// the real registry, git, a keychain or $HOME.
import test from 'node:test'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SETUP_PLUGINS, parseSetupSelection, runSetup, selectSetupPlugins } from '../bin/setup.mjs'
import { loadLocks } from '../bin/runtime/lock.mjs'
import { baseOpts, makeDeps, makeFixture, stubRunner, tmp } from './runtime-fixtures.mjs'

const IDS = ['character', 'cs2', 'interior', 'jev', 'pixi2d']
const DEFAULT_IDS = ['character', 'cs2', 'interior', 'pixi2d']
const COMMIT = Object.fromEntries(IDS.map((id) => [id, crypto.createHash('sha1').update('pin:' + id).digest('hex')]))
const REPO = Object.fromEntries(IDS.map((id) => [id, 'https://github.com/img2threejs/plugin-' + id]))
const SECRET = 'sk-live-SECRETVALUE-0123456789'
const HEADERS = ['Plugin', 'Installed ref', 'Runtime units verified', 'Doctor', 'Next step']
const KIND = 'img2.jev-command'
const CORE_COMMIT = 'c'.repeat(40)

const setupOpts = (o = {}) => ({ yes: true, plugins: null, minimal: false, allowWeakHash: false, skip: [], offline: false, ...o })
const code = (e) => e?.code

// Immutable official pins, validated against the shared fixture catalog.
function pinnedFixture(over = {}) {
  const fx = makeFixture(over)
  fx.pluginsLock.plugins = IDS.map((id) => ({
    id, capability: id, repo: REPO[id], commit: COMMIT[id], visibility: 'public', selectable: true, default: id !== 'jev', pinState: 'on-origin', note: 'fixture',
  }))
  fs.writeFileSync(path.join(fx.root, 'plugins.lock.json'), JSON.stringify(fx.pluginsLock, null, 2))
  return fx
}

const reply = (stdout, c = 0, stderr = '') => ({ code: c, signal: null, stdout, stderr, timedOut: false, error: null })
const jevJson = (status, reasonCode, extra = {}) => JSON.stringify({ kind: KIND, version: 1, status, ...(reasonCode ? { reasonCode } : {}), ...extra })
const PRESENT = () => reply(jevJson('present', 'credential-present'), 0)
const MISSING = () => reply(jevJson('missing', 'credential-missing'), 3)

// Recording harness: `log` holds the exact ordered calls ('install', 'add:<id>', 'sync', 'provision', 'doctor',
// 'doctorRuntime', 'auth'); the detail arrays hold the arguments.
function harness({ fx = pinnedFixture(), states = {}, installNeeded = false, codes = {}, throws = {}, auth = PRESENT, real = [], isTTY = false, ask, rd, keep = false, coreAction = 'keep' } = {}) {
  const log = []
  const out = []
  const tables = []
  const installs = []
  const adds = []
  const syncs = []
  const keeps = []
  const cores = []
  const records = []
  const provisions = []
  const doctors = []
  const runtimeDoctors = []
  const state = Object.fromEntries(IDS.map((id) => [id, states[id] ?? { action: 'keep', ref: COMMIT[id] }]))
  let needInstall = installNeeded
  const authRuns = []
  const run = async (file, args, o = {}) => {
    if (args?.at(-1) === 'auth-status') {
      log.push('auth')
      authRuns.push({ file, args, opts: o })
      return typeof auth === 'function' ? auth(file, args, o) : auth
    }
    return inner(file, args, o)
  }
  const inner = stubRunner()
  const runtimeDeps = rd ?? makeDeps(fx, { run })
  if (rd) { const prev = rd.run; rd.run = async (f, a, o) => (a?.at(-1) === 'auth-status' ? run(f, a, o) : prev(f, a, o)) }
  const step = async (key, record) => {
    log.push(key)
    record()
    if (throws[key]) throw throws[key]
    return codes[key] ?? 0
  }
  const deps = {
    runtimeDeps, isTTY, ask,
    out: (l) => out.push(String(l)), err: (l) => out.push(String(l)),
    table: (headers, rows) => tables.push({ headers, rows }),
    installNeeded: () => needInstall,
    pluginState: (pin) => state[pin.id],
    install: async (opts) => { const c = await step('install', () => installs.push({ opts })); if (!c) needInstall = false; return c },
    add: async (opts, spec) => {
      const c = await step('add:' + opts.plugin, () => adds.push({ opts, spec }))
      if (!c) state[opts.plugin] = { action: 'keep', ref: opts.ref }
      return c
    },
    corePlan: () => ({ action: coreAction, ref: coreAction === 'keep' ? CORE_COMMIT : null }),
    core: (pin, o) => step('core', () => cores.push({ pin, opts: o })),
    writeProvisionRecord: (info) => { log.push('record'); records.push(info); return path.join('/record', 'provision.json') },
    sync: (opts) => step('sync', () => syncs.push({ opts })),
    doctor: (opts) => step('doctor', () => doctors.push({ opts })),
  }
  if (keep) deps.keep = (pin) => step('keep:' + pin.id, () => keeps.push(pin))
  if (!real.includes('provision')) deps.provision = (opts, home, rdeps) => step('provision', () => provisions.push({ opts, home, rdeps }))
  if (!real.includes('doctorRuntime')) {
    deps.doctorRuntime = (args) => step('doctorRuntime', () => {
      runtimeDoctors.push(args)
      // the mocked doctor reports a passing probe through the injected out, like the real one in --json mode
      if (!codes.doctorRuntime && !throws.doctorRuntime) args.deps.out(JSON.stringify({ ok: true, checks: [{ status: 'pass', id: 'stub-probe', dependency: 'stub', actual: 'ok', unit: 'stub' }] }))
    })
  }
  const summaries = () => tables.filter((t) => t.headers[0] === 'Plugin')
  return { deps, fx, log, out, tables, summaries, keeps, cores, records, installs, adds, syncs, provisions, doctors, runtimeDoctors, authRuns, runtimeDeps, state, text: () => out.join('\n') + '\n' + JSON.stringify(tables) }
}

const homeOf = () => tmp('img2-setup-home-')
const managedPython = (fx, home) => path.join(home, 'runtime', loadLocks(fx.root).lockDigest.slice(0, 12), 'runtime', 'python-runtime', 'bin', 'python3')
const FULL = ['install', 'core', ...DEFAULT_IDS.map((i) => 'add:' + i), 'sync', 'provision', 'doctor', 'doctorRuntime', 'record']
const SAFE = /^[a-zA-Z0-9_./:@=-]+$/
const sq = (v) => (SAFE.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'")

// ---------------------------------------------------------------- selection parsing

test('SETUP_PLUGINS lists the five plugins in canonical order with a description each', () => {
  assert.deepEqual(SETUP_PLUGINS.map((p) => p.id), IDS)
  for (const p of SETUP_PLUGINS) assert.ok(typeof p.description === 'string' && p.description.trim().length > 0, p.id)
})

test('parseSetupSelection: Enter and whitespace choose the four domain plugins without Jev', () => {
  for (const answer of ['', '   ', '\t', '\n']) assert.deepEqual(parseSetupSelection(answer), DEFAULT_IDS, JSON.stringify(answer))
  assert.throws(() => parseSetupSelection(null), (e) => code(e) === 3, 'EOF is not Enter')
})

test('parseSetupSelection: comma lists are deduplicated and returned in canonical order', () => {
  assert.deepEqual(parseSetupSelection('jev'), ['jev'])
  assert.deepEqual(parseSetupSelection('jev,character'), ['character', 'jev'])
  assert.deepEqual(parseSetupSelection('pixi2d,cs2,pixi2d,jev,cs2'), ['cs2', 'jev', 'pixi2d'])
  assert.deepEqual(parseSetupSelection('interior, character'), ['character', 'interior'])
  assert.deepEqual(parseSetupSelection(' cs2 '), ['cs2'])
})

test('parseSetupSelection refuses unknown names and empty comma components with code 2', () => {
  for (const bad of ['bogus', 'character,bogus', 'character,,jev', ',', ',cs2', 'cs2,', 'cs2, ,jev', '../etc', 'character;jev']) {
    assert.throws(() => parseSetupSelection(bad), (e) => code(e) === 2, JSON.stringify(bad))
  }
})

// ---------------------------------------------------------------- selectSetupPlugins precedence

const noAsk = () => { throw new Error('ask must not be called') }

test('explicit --plugins beats --minimal and --yes, and never prompts', async () => {
  const all = { isTTY: true, ask: noAsk }
  assert.deepEqual(await selectSetupPlugins({ plugins: 'jev,cs2' }, all), ['cs2', 'jev'])
  assert.deepEqual(await selectSetupPlugins({ plugins: 'jev,cs2', yes: true }, all), ['cs2', 'jev'])
  assert.deepEqual(await selectSetupPlugins({ plugins: 'character', minimal: true }, all), ['character'])
  assert.deepEqual(await selectSetupPlugins({ plugins: 'pixi2d,pixi2d', minimal: true, yes: true }, all), ['pixi2d'])
})

test('--minimal selects the same no-Jev default bundle and beats --yes without prompting', async () => {
  assert.deepEqual(await selectSetupPlugins({ minimal: true }, { isTTY: true, ask: noAsk }), DEFAULT_IDS)
  assert.deepEqual(await selectSetupPlugins({ minimal: true, yes: true }, { isTTY: true, ask: noAsk }), DEFAULT_IDS)
  assert.deepEqual(await selectSetupPlugins({ minimal: true }, { isTTY: false, ask: noAsk }), DEFAULT_IDS)
})

test('--yes selects the four domain plugins without prompting, even on a TTY', async () => {
  assert.deepEqual(await selectSetupPlugins({ yes: true }, { isTTY: true, ask: noAsk }), DEFAULT_IDS)
  assert.deepEqual(await selectSetupPlugins({ yes: true }, { isTTY: false, ask: noAsk }), DEFAULT_IDS)
})

test('a non-TTY without flags selects the four domain plugins and never prompts', async () => {
  assert.deepEqual(await selectSetupPlugins({}, { isTTY: false, ask: noAsk }), DEFAULT_IDS)
  assert.deepEqual(await selectSetupPlugins({ plugins: null, minimal: false, yes: false }, { isTTY: false }), DEFAULT_IDS)
})

test('a TTY without flags asks exactly once: Enter means the default bundle, a list is parsed in canonical order', async () => {
  const enter = []
  assert.deepEqual(await selectSetupPlugins({}, { isTTY: true, ask: async (q) => { enter.push(q); return '' } }), DEFAULT_IDS)
  assert.equal(enter.length, 1)
  assert.ok(typeof enter[0] === 'string' && enter[0].length > 0)

  const picked = []
  assert.deepEqual(await selectSetupPlugins({}, { isTTY: true, ask: async (q) => { picked.push(q); return 'pixi2d,character,pixi2d' } }), ['character', 'pixi2d'])
  assert.equal(picked.length, 1, 'no second prompt')
})

test('a TTY answer that is invalid is refused with code 2 and is not re-asked', async () => {
  for (const bad of ['bogus', 'cs2,,jev', ',']) {
    let asks = 0
    await assert.rejects(selectSetupPlugins({}, { isTTY: true, ask: async () => { asks += 1; return bad } }), (e) => code(e) === 2, bad)
    assert.equal(asks, 1)
  }
})

test('EOF on the prompt exits 3; an empty --plugins is refused with code 2', async () => {
  await assert.rejects(selectSetupPlugins({}, { isTTY: true, ask: async () => null }), (e) => code(e) === 3)
  for (const empty of ['', ' ', ',', ' , ']) {
    await assert.rejects(selectSetupPlugins({ plugins: empty, yes: true }, { isTTY: true, ask: noAsk }), (e) => code(e) === 2, JSON.stringify(empty))
  }
  await assert.rejects(selectSetupPlugins({ plugins: 'cs2,,jev' }, { isTTY: false }), (e) => code(e) === 2)
  await assert.rejects(selectSetupPlugins({ plugins: 'bogus' }, { isTTY: false }), (e) => code(e) === 2)
})

// ---------------------------------------------------------------- runSetup: ordered calls

test('a fresh machine installs the four default domain plugins at immutable pins, then syncs, provisions and doctors without Jev auth', async () => {
  const h = harness({ installNeeded: true, states: Object.fromEntries(IDS.map((id) => [id, { action: 'add', ref: null }])) })
  const home = homeOf()
  assert.equal(await runSetup(setupOpts(), home, h.deps), 0, h.text())
  assert.deepEqual(h.log, FULL)

  assert.equal(h.installs.length, 1)
  assert.equal(h.installs[0].opts.home, home)
  assert.equal(h.installs[0].opts.yes, true)
  assert.equal(h.adds.length, DEFAULT_IDS.length)
  for (const [i, id] of DEFAULT_IDS.entries()) {
    const { opts, spec } = h.adds[i]
    assert.equal(opts.plugin, id)
    assert.equal(opts.ref, COMMIT[id], 'the lock commit, never a branch or tag')
    assert.match(opts.ref, /^[0-9a-f]{40}$/)
    assert.equal(spec, REPO[id])
    assert.equal(opts.yes, true)
    assert.ok(!opts.force, 'a plain add is not forced')
  }
})

test('keep/add/replace: only plugins that need it are added; replace is forced; install is skipped when not needed', async () => {
  const h = harness({
    states: {
      character: { action: 'keep', ref: COMMIT.character },
      cs2: { action: 'add', ref: null },
      interior: { action: 'replace', ref: 'a'.repeat(40) },
      jev: { action: 'add', ref: null },
      pixi2d: { action: 'keep', ref: COMMIT.pixi2d },
    },
  })
  assert.equal(await runSetup(setupOpts({ plugins: IDS.join(',') }), homeOf(), h.deps), 0, h.text())
  assert.deepEqual(h.log, ['core', 'add:cs2', 'add:interior', 'add:jev', 'sync', 'provision', 'doctor', 'doctorRuntime', 'record', 'auth'])
  assert.equal(h.installs.length, 0)
  const byId = Object.fromEntries(h.adds.map((a) => [a.opts.plugin, a]))
  assert.ok(!byId.cs2.opts.force)
  assert.equal(byId.interior.opts.force, true)
  assert.equal(byId.interior.opts.ref, COMMIT.interior, 'the replacement targets the pin, not the old ref')
  assert.equal(byId.interior.spec, REPO.interior)
  assert.equal(byId.jev.opts.ref, COMMIT.jev)
})

test('only selected plugins are added, provisioned and doctored; selection reaches provision as a canonical CSV', async () => {
  const h = harness({ states: { cs2: { action: 'add', ref: null }, character: { action: 'add', ref: null }, pixi2d: { action: 'add', ref: null } } })
  assert.equal(await runSetup(setupOpts({ plugins: 'pixi2d,cs2,pixi2d' }), homeOf(), h.deps), 0, h.text())
  assert.deepEqual(h.log, ['core', 'add:cs2', 'add:pixi2d', 'sync', 'provision', 'doctor', 'doctorRuntime', 'record'])
  assert.equal(h.provisions[0].opts.plugins, 'cs2,pixi2d')
  assert.deepEqual(h.summaries()[0].rows.map((r) => r[0]), ['cs2', 'pixi2d'])
})

test('provision receives profile full, the selection, yes, and the shared runtime deps; runtime doctor gets json and the same home', async () => {
  const h = harness()
  const home = homeOf()
  assert.equal(await runSetup(setupOpts({ plugins: 'jev,character' }), home, h.deps), 0, h.text())
  const p = h.provisions[0]
  assert.equal(p.home, home)
  assert.equal(p.rdeps, h.runtimeDeps)
  assert.equal(p.opts.profile, 'full')
  assert.equal(p.opts.plugins, 'character,jev')
  assert.equal(p.opts.minimal, false)
  assert.equal(p.opts.yes, true)
  assert.equal(h.runtimeDoctors[0].home, home)
  assert.equal(h.runtimeDoctors[0].json, true)
  assert.equal(h.runtimeDoctors[0].deps.lockRoot, h.runtimeDeps.lockRoot)
  assert.equal(h.runtimeDoctors[0].deps.run, h.runtimeDeps.run)
  assert.equal(h.runtimeDoctors[0].deps.home, h.runtimeDeps.home)
})

test('--minimal installs the four default domain plugins and still provisions the full profile', async () => {
  const h = harness({ states: Object.fromEntries(IDS.map(id => [id, { action: 'add', ref: null }])) })
  assert.equal(await runSetup(setupOpts({ minimal: true }), homeOf(), h.deps), 0, h.text())
  assert.deepEqual(h.log, FULL.filter(step => step !== 'install'))
  assert.equal(h.provisions[0].opts.plugins, DEFAULT_IDS.join(','))
  assert.equal(h.provisions[0].opts.profile, 'full')
  assert.equal(h.provisions[0].opts.minimal, false)
})

test('--yes with --plugins or --minimal keeps the explicit narrower choice', async () => {
  const a = harness()
  assert.equal(await runSetup(setupOpts({ yes: true, plugins: 'cs2' }), homeOf(), a.deps), 0, a.text())
  assert.equal(a.provisions[0].opts.plugins, 'cs2')
  const b = harness()
  assert.equal(await runSetup(setupOpts({ yes: true, minimal: true, plugins: null }), homeOf(), b.deps), 0, b.text())
  assert.equal(b.provisions[0].opts.plugins, DEFAULT_IDS.join(','))
  const c = harness()
  assert.equal(await runSetup(setupOpts({ yes: true, minimal: true, plugins: 'interior' }), homeOf(), c.deps), 0, c.text())
  assert.equal(c.provisions[0].opts.plugins, 'interior')
})

test('non-TTY without flags selects the four domain plugins and never asks or checks Jev auth', async () => {
  const h = harness({ ask: noAsk, auth: () => { throw new Error('Jev auth must not run') } })
  assert.equal(await runSetup(setupOpts({ yes: false }), homeOf(), h.deps), 0, h.text())
  assert.equal(h.provisions[0].opts.plugins, DEFAULT_IDS.join(','))
  assert.equal(h.authRuns.length, 0)
  assert.match(h.text(), /host agent\/model \(no Jev account required/)
})

test('a TTY prompts once for the selection and does not ask again', async () => {
  const asked = []
  const h = harness({ isTTY: true, ask: async (q) => { asked.push(q); return 'jev, cs2' }, states: { cs2: { action: 'add', ref: null } } })
  assert.equal(await runSetup(setupOpts({ yes: false }), homeOf(), h.deps), 0, h.text())
  assert.equal(asked.length, 1)
  for (const id of IDS) assert.ok(h.out.some((l) => l.includes(id)), 'the TTY prompt lists ' + id)
  assert.equal(h.provisions[0].opts.plugins, 'cs2,jev')
  assert.deepEqual(h.log, ['core', 'add:cs2', 'sync', 'provision', 'doctor', 'doctorRuntime', 'record', 'auth'])

  const enter = harness({ isTTY: true, ask: async () => '' })
  assert.equal(await runSetup(setupOpts({ yes: false }), homeOf(), enter.deps), 0, enter.text())
  assert.equal(enter.provisions[0].opts.plugins, DEFAULT_IDS.join(','))
  assert.ok(enter.out.some(line => line.startsWith('  [ ] jev - ')), 'Jev is visibly opt-in')
  assert.equal(enter.authRuns.length, 0)

  for (const o of [{ yes: true }, { plugins: 'cs2' }, { minimal: true }]) {
    const quiet = harness({ isTTY: true, ask: noAsk })
    assert.equal(await runSetup(setupOpts({ yes: false, ...o }), homeOf(), quiet.deps), 0, JSON.stringify(o))
  }
})

test('invalid selections return a refusal code and run nothing', async () => {
  for (const [o, ask, want] of [
    [{ plugins: '' }, noAsk, 2], [{ plugins: 'bogus' }, noAsk, 2], [{ plugins: 'cs2,,jev' }, noAsk, 2],
    [{ yes: false }, async () => 'bogus', 2], [{ yes: false }, async () => null, 3],
  ]) {
    const h = harness({ isTTY: true, ask })
    assert.equal(await runSetup(setupOpts(o), homeOf(), h.deps), want, JSON.stringify(o))
    assert.deepEqual(h.log, [], JSON.stringify(o))
  }
})

test('--skip and --offline are forwarded to provision; weak hashes are accepted by default, --strict-hash refuses', async () => {
  const on = harness()
  assert.equal(await runSetup(setupOpts({ skip: ['character-bpy', 'vision-torch'], offline: true }), homeOf(), on.deps), 0, on.text())
  assert.equal(on.provisions[0].opts.allowWeakHash, true)
  assert.deepEqual(on.provisions[0].opts.skip, ['character-bpy', 'vision-torch'])
  assert.equal(on.provisions[0].opts.offline, true)

  const off = harness()
  assert.equal(await runSetup(setupOpts(), homeOf(), off.deps), 0, off.text())
  assert.equal(off.provisions[0].opts.allowWeakHash, true, 'one-command setup proceeds with weak-integrity artifacts')
  const notice = off.out.filter((l) => l.startsWith('Notice: '))
  assert.equal(notice.length, 1)
  assert.match(notice[0], /^Notice: 1 artifact\(s\) have no SHA-256 in the lock/)
  assert.match(notice[0], /--strict-hash/)
  assert.deepEqual(off.provisions[0].opts.skip ?? [], [])
  assert.equal(off.provisions[0].opts.offline, false)
})

test('--strict-hash refuses weak-integrity artifacts before anything runs; it conflicts with --allow-weak-hash', async () => {
  const strict = harness()
  assert.equal(await runSetup(setupOpts({ strictHash: true }), homeOf(), strict.deps), 2, strict.text())
  assert.deepEqual(strict.log, [], 'refused in preflight, before install, core, add or provision')
  assert.match(strict.text(), /--strict-hash: 1 artifact\(s\) have no SHA-256 in the lock/)
  assert.match(strict.text(), /Nothing was changed/)
  // skipping the one weak dependency (and what needs it) leaves nothing to refuse
  const skipped = harness()
  const code = await runSetup(setupOpts({ strictHash: true, skip: ['browser-chromium-1.64.0'] }), homeOf(), skipped.deps)
  assert.equal(code, 0, skipped.text())
  assert.equal(skipped.provisions[0].opts.allowWeakHash, false)
  const both = harness()
  assert.equal(await runSetup(setupOpts({ strictHash: true, allowWeakHash: true }), homeOf(), both.deps), 2, both.text())
  assert.deepEqual(both.log, [])
})

test('--offline refuses before any network git install of a missing harness or plugin', async () => {
  const noHarness = harness({ installNeeded: true })
  assert.equal(await runSetup(setupOpts({ offline: true }), homeOf(), noHarness.deps), 2, noHarness.text())
  for (const k of ['install', 'sync', 'provision', 'doctor', 'doctorRuntime']) assert.ok(!noHarness.log.includes(k), k)
  assert.ok(!noHarness.log.some((k) => k.startsWith('add:')))

  for (const action of ['add', 'replace']) {
    const noPlugin = harness({ states: { cs2: { action, ref: action === 'add' ? null : 'b'.repeat(40) } } })
    assert.equal(await runSetup(setupOpts({ offline: true }), homeOf(), noPlugin.deps), 2, action + '\n' + noPlugin.text())
    assert.ok(!noPlugin.log.some((k) => k.startsWith('add:') || k === 'install' || k === 'provision'), action)
  }

  const ready = harness()
  assert.equal(await runSetup(setupOpts({ offline: true }), homeOf(), ready.deps), 0, ready.text())
  assert.equal(ready.provisions[0].opts.offline, true)

  const local = harness({ installNeeded: true })
  assert.equal(await runSetup(setupOpts({ offline: true, from: '/local/harness' }), homeOf(), local.deps), 0, local.text())
  assert.equal(local.installs[0].opts.from, '/local/harness', 'a local harness source is not a network install')
})

test('an invalid or foreign lock pin is refused before any step runs; an unpushed-local pin only warns', async () => {
  const bad = [
    { commit: 'main' }, { commit: 'abc123' }, { commit: 'A'.repeat(40).toUpperCase() + '0' },
    { repo: 'https://example.com/evil/plugin-cs2' }, { repo: 'file:///tmp/plugin-cs2' }, { repo: 'https://github.com/img2threejs/plugin-cs2; rm -rf /' },
  ]
  for (const patch of bad) {
    const fx = pinnedFixture()
    Object.assign(fx.pluginsLock.plugins.find((p) => p.id === 'cs2'), patch)
    fs.writeFileSync(path.join(fx.root, 'plugins.lock.json'), JSON.stringify(fx.pluginsLock))
    const h = harness({ fx })
    assert.equal(await runSetup(setupOpts({ plugins: 'cs2' }), homeOf(), h.deps), 2, JSON.stringify(patch) + '\n' + h.text())
    assert.deepEqual(h.log, [], JSON.stringify(patch))
  }
  const fx = pinnedFixture()
  Object.assign(fx.pluginsLock.plugins.find((p) => p.id === 'cs2'), { pinState: 'unpushed-local', note: 'fixture commit is unpushed-local' })
  fs.writeFileSync(path.join(fx.root, 'plugins.lock.json'), JSON.stringify(fx.pluginsLock))
  const h = harness({ fx, states: { cs2: { action: 'add', ref: null } } })
  assert.equal(await runSetup(setupOpts({ plugins: 'cs2' }), homeOf(), h.deps), 0, h.text())
  assert.ok(h.out.some((l) => /cs2/.test(l) && /unpushed-local/.test(l)), 'warns about the unpushed pin')
  assert.equal(h.adds[0].opts.ref, COMMIT.cs2)
})

test('a keep state calls the optional repair seam in order and a failing repair stops setup', async () => {
  const h = harness({ keep: true })
  assert.equal(await runSetup(setupOpts({ plugins: 'cs2,jev' }), homeOf(), h.deps), 0, h.text())
  assert.deepEqual(h.log, ['core', 'keep:cs2', 'keep:jev', 'sync', 'provision', 'doctor', 'doctorRuntime', 'record', 'auth'])
  const bad = harness({ keep: true, codes: { 'keep:cs2': 1 } })
  assert.equal(await runSetup(setupOpts({ plugins: 'cs2,jev' }), homeOf(), bad.deps), 1, bad.text())
  assert.deepEqual(bad.log, ['core', 'keep:cs2'])
  assert.match(bad.text(), /repair cs2/)
})

test('a plugin registered locally, dirty or by a foreign source is refused, not overwritten', async () => {
  const h = harness({ states: {}, installNeeded: false })
  h.deps.pluginState = (pin) => {
    if (pin.id === 'interior') throw Object.assign(new Error('interior is registered from a local checkout'), { code: 2 })
    return { action: 'keep', ref: COMMIT[pin.id] }
  }
  assert.equal(await runSetup(setupOpts(), homeOf(), h.deps), 2, h.text())
  assert.ok(!h.log.includes('add:interior'))
  for (const k of ['sync', 'provision', 'doctor', 'doctorRuntime']) assert.ok(!h.log.includes(k), k)
  assert.match(h.text(), /interior/)
})

// ---------------------------------------------------------------- failure handling

const STEP_TEXT = {
  install: /install/i, 'add:cs2': /add[\s\S]*cs2|cs2[\s\S]*add/i, sync: /sync/i, provision: /provision/i, doctor: /doctor/i, doctorRuntime: /runtime/i,
}

for (const [key, c] of [['install', 1], ['add:cs2', 1], ['sync', 2], ['provision', 3], ['doctor', 1], ['doctorRuntime', 1]]) {
  const states = Object.fromEntries(IDS.map((id) => [id, { action: 'add', ref: null }]))

  test('a ' + key + ' step that returns ' + c + ' stops later work and reports the step, its code and the summary', async () => {
    const h = harness({ installNeeded: true, states, codes: { [key]: c } })
    assert.equal(await runSetup(setupOpts(), homeOf(), h.deps), c, h.text())
    assert.deepEqual(h.log, FULL.slice(0, FULL.indexOf(key) + 1))
    const text = h.text()
    assert.match(text, STEP_TEXT[key])
    assert.match(text, new RegExp('Setup stopped at [^\\n]*\\(exit ' + c + '\\)'))
    assert.equal(h.summaries().length, 1, 'the summary is printed even on partial failure')
    assert.deepEqual(h.summaries()[0].headers, HEADERS)
    assert.deepEqual(h.summaries()[0].rows.map((r) => r[0]), DEFAULT_IDS)
    assert.equal(h.authRuns.length, 0, 'no auth probe when an earlier step failed')
  })

  test('a ' + key + ' step that throws stops later work, returns nonzero and reports the step', async () => {
    const h = harness({ installNeeded: true, states, throws: { [key]: new Error('boom ' + key) } })
    const got = await runSetup(setupOpts(), homeOf(), h.deps)
    assert.notEqual(got, 0, h.text())
    assert.deepEqual(h.log, FULL.slice(0, FULL.indexOf(key) + 1))
    assert.match(h.text(), STEP_TEXT[key])
    assert.match(h.text(), new RegExp('boom ' + key))
    assert.equal(h.summaries().length, 1)
    assert.equal(h.authRuns.length, 0)
  })
}

// ---------------------------------------------------------------- idempotence

test('repeating setup keeps the pins: the second run adds nothing but still syncs, provisions and doctors', async () => {
  const h = harness({ installNeeded: true, states: Object.fromEntries(IDS.map((id) => [id, { action: 'add', ref: null }])) })
  const home = homeOf()
  assert.equal(await runSetup(setupOpts(), home, h.deps), 0, h.text())
  assert.equal(h.adds.length, DEFAULT_IDS.length)
  const refs = Object.fromEntries(h.adds.map((a) => [a.opts.plugin, a.opts.ref]))
  h.log.length = 0
  h.out.length = 0
  h.tables.length = 0
  assert.equal(await runSetup(setupOpts(), home, h.deps), 0, h.text())
  assert.deepEqual(h.log, ['core', 'sync', 'provision', 'doctor', 'doctorRuntime', 'record'])
  assert.equal(h.adds.length, DEFAULT_IDS.length, 'no second add')
  assert.equal(h.installs.length, 1)
  assert.deepEqual(refs, Object.fromEntries(DEFAULT_IDS.map(id => [id, COMMIT[id]])))
  assert.equal(h.summaries().length, 1)
  assert.deepEqual(h.summaries()[0].rows.map((r) => r[0]), DEFAULT_IDS)
  for (const row of h.summaries()[0].rows) assert.ok(String(row[1]).includes(COMMIT[row[0]].slice(0, 7)), row[0] + ' reports its pinned ref')
})

test('summary table has the agreed columns, one row per selected plugin and the installed ref', async () => {
  const h = harness()
  assert.equal(await runSetup(setupOpts({ plugins: 'cs2,jev' }), homeOf(), h.deps), 0, h.text())
  assert.equal(h.summaries().length, 1)
  assert.deepEqual(h.summaries()[0].headers, HEADERS)
  assert.deepEqual(h.summaries()[0].rows.map((r) => r[0]), ['cs2', 'jev'])
  for (const row of h.summaries()[0].rows) {
    assert.equal(row.length, HEADERS.length)
    assert.ok(String(row[1]).includes(COMMIT[row[0]].slice(0, 7)))
  }
})

// ---------------------------------------------------------------- Jev auth

test('missing optional Jev auth prints the shell-safe login hint and host-model route command while setup succeeds', async () => {
  const h = harness({ auth: MISSING })
  const home = homeOf()
  assert.equal(await runSetup(setupOpts({ plugins: 'jev' }), home, h.deps), 0, h.text())
  const script = path.join(home, 'plugins/jev/tools/jev.py')
  assert.equal(h.authRuns.length, 1)
  const call = h.authRuns[0]
  assert.equal(call.file, managedPython(h.fx, home), 'Jev runs with the provisioned python-runtime, never the ambient python3')
  assert.deepEqual(call.args, [script, 'auth-status'])
  assert.equal(call.opts.env.IMG2_HOME, home)
  assert.ok(Number.isFinite(call.opts.timeout) && call.opts.timeout > 0 && call.opts.timeout <= 300_000, 'bounded timeout')
  assert.ok(h.out.some((l) => l.includes(`IMG2_HOME=${sq(home)} ${sq(managedPython(h.fx, home))} ${sq(script)} login`)), h.text())
  assert.deepEqual(h.log.slice(-4), ['doctor', 'doctorRuntime', 'record', 'auth'])
  const route = h.out.findIndex((l) => l.startsWith('node ' + path.join(home, 'harness/bin/img2.mjs') + ' --home ' + home + ' route '))
  const login = h.out.findIndex((l) => l.includes(' login'))
  assert.ok(login >= 0 && route > login, 'the login command, then the img2 route command: ' + h.text())
  assert.match(h.text(), /To opt in to Jev routing/)
  assert.match(h.text(), /host agent\/model \(no Jev account required/)
  assert.match(h.text(), /Setup complete/)
})

test('the login command quotes spaces and apostrophes with POSIX escaping and only when needed', async () => {
  const base = homeOf()
  const home = path.join(base, "o'brien home")
  fs.mkdirSync(home)
  const h = harness({ auth: MISSING })
  assert.equal(await runSetup(setupOpts({ plugins: 'jev' }), home, h.deps), 0, h.text())
  const script = path.join(home, 'plugins/jev/tools/jev.py')
  const want = `IMG2_HOME=${sq(home)} ${sq(managedPython(h.fx, home))} ${sq(script)} login`
  assert.ok(want.includes("'\\''"), 'fixture exercises the apostrophe escape')
  assert.ok(h.out.some((l) => l.includes(want)), h.text())

  const plain = harness({ auth: MISSING })
  const safe = homeOf()
  assert.equal(await runSetup(setupOpts({ plugins: 'jev' }), safe, plain.deps), 0)
  const line = plain.out.find((l) => l.startsWith('IMG2_HOME='))
  assert.ok(line.includes(`IMG2_HOME=${safe} ${managedPython(plain.fx, safe)} ${path.join(safe, 'plugins/jev/tools/jev.py')} login`), 'safe tokens are not quoted')
})

test('present Jev auth returns 0 and prints no login command', async () => {
  const h = harness({ auth: PRESENT })
  assert.equal(await runSetup(setupOpts({ plugins: 'jev' }), homeOf(), h.deps), 0, h.text())
  assert.equal(h.authRuns.length, 1)
  assert.ok(!/ login(\s|$)/.test(h.out.join('\n')), 'no login hint')
})

test('Jev auth storage errors and malformed output return 1 without echoing raw output or secrets', async () => {
  const cases = {
    storage: reply(jevJson('error', 'storage-error', { detail: SECRET }), 1, 'Traceback (most recent call last)\n  token=' + SECRET),
    'storage exit 3': reply(jevJson('missing', 'storage-error', { detail: SECRET }), 3, SECRET),
    'not json': reply('definitely not json ' + SECRET, 0, SECRET),
    'not json exit 3': reply('login required ' + SECRET, 3, SECRET),
    'empty': reply('', 0, ''),
    'wrong version': reply(jevJson('present', 'credential-present').replace('"version":1', '"version":2'), 0),
    'present with exit 3': reply(jevJson('present', 'credential-present'), 3),
    'missing with exit 0': reply(jevJson('missing', 'credential-missing'), 0),
    'wrong reason': reply(jevJson('missing', 'something-else', { detail: SECRET }), 3),
    'wrong kind': reply(JSON.stringify({ kind: 'something-else', status: 'missing', reasonCode: 'credential-missing', detail: SECRET }), 3),
    'truncated json': reply('{"kind":"' + KIND + '","status":"present","token":"' + SECRET, 0),
    'spawn error': { code: null, signal: null, stdout: '', stderr: SECRET, timedOut: false, error: new Error('ENOENT ' + SECRET) },
    'timed out': { code: null, signal: 'SIGKILL', stdout: SECRET, stderr: SECRET, timedOut: true, error: null },
  }
  for (const [name, r] of Object.entries(cases)) {
    const h = harness({ auth: r })
    const home = homeOf()
    assert.equal(await runSetup(setupOpts({ plugins: 'jev' }), home, h.deps), 1, name + '\n' + h.text())
    const text = h.text()
    assert.ok(!text.includes(SECRET), name + ' leaked a secret')
    assert.ok(!text.includes('credential-missing') || name === 'missing with exit 0', name)
    assert.ok(!text.includes('Traceback'), name + ' dumped raw stderr')
    assert.ok(!text.includes('definitely not json'), name + ' dumped raw stdout')
    assert.ok(!/ [^\n]*\/python3 [^\n]* login/.test(text), name + ' must not suggest login for a non-missing failure')
    assert.match(text, /Setup stopped at Jev auth-status \(exit 1\)/)
  }
})

test('without Jev selected there is no auth probe and no login invocation', async () => {
  const h = harness({ auth: MISSING })
  assert.equal(await runSetup(setupOpts({ plugins: 'character,cs2' }), homeOf(), h.deps), 0, h.text())
  assert.equal(h.authRuns.length, 0)
  assert.ok(!h.log.includes('auth'))
  assert.ok(!h.out.some((l) => /jev\.py|IMG2_HOME=/.test(l)))
})

test('setup never runs a Jev login: every runtime command is auth-status', async () => {
  const seen = []
  const h = harness({ auth: (file, args) => { seen.push([file, ...args]); return MISSING() } })
  assert.equal(await runSetup(setupOpts({ plugins: 'jev' }), homeOf(), h.deps), 0)
  assert.equal(seen.length, 1)
  assert.ok(seen.every((c) => c.includes('auth-status') && !c.includes('login') && !c.some((a) => String(a).startsWith('--'))))
})

// ---------------------------------------------------------------- real runtime orchestration

const runtimeReport = (h) => h.tables.filter((t) => t.headers[0] === 'Status').at(-1)

test('real runtime: setup provisions, a repeat reuses verified units, a damaged unit is rebuilt, and the real runtime doctor passes each time', async () => {
  const fx = pinnedFixture()
  const rd = makeDeps(fx, { run: stubRunner() })
  const h = harness({ fx, rd, real: ['provision', 'doctorRuntime'], auth: PRESENT })
  const rt = path.join(rd.home, 'runtime')
  const receipt = () => JSON.parse(fs.readFileSync(path.join(rt, 'provision.json'), 'utf8'))
  const opts = setupOpts({ allowWeakHash: true })
  const reset = () => { h.log.length = 0; h.out.length = 0; h.tables.length = 0 }
  const passing = () => {
    const report = runtimeReport(h)
    assert.ok(report && report.rows.length > 3, 'the real runtime doctor reported its checks')
    assert.ok(report.rows.every((r) => r[0] !== 'fail'), JSON.stringify(report.rows.filter((r) => r[0] === 'fail')))
    assert.ok(report.rows.some((r) => r[0] === 'pass'))
    for (const row of h.summaries().at(-1).rows) {
      const [, verified, total] = /^(\d+)\/(\d+)/.exec(row[2]) ?? assert.fail(row[0] + ': ' + row[2])
      assert.ok(Number(total) > 0 && verified === total, row[0] + ' verifies every runtime unit it needs (incl. grouped vision probes): ' + row[2])
    }
  }

  assert.equal(await runSetup(opts, rd.home, h.deps), 0, h.text() + '\n' + rd.errs.join('\n'))
  assert.deepEqual(h.log, ['core', 'sync', 'doctor', 'record'], 'real provision and runtime doctor are not recorded by the stubs')
  const first = receipt()
  assert.equal(first.status, 'ok')
  assert.ok(first.units.length > 3)
  assert.ok(first.units.every((u) => u.reused === false), 'a clean home builds every unit')
  assert.deepEqual(first.selectedPlugins, DEFAULT_IDS)
  assert.ok(fs.existsSync(path.join(rt, 'selectors.json')))
  passing()

  // second pass: nothing changed, every verified unit is reused, nothing is downloaded or re-added
  const fetched = rd.download.calls.length
  assert.ok(fetched > 0)
  reset()
  assert.equal(await runSetup(opts, rd.home, h.deps), 0, h.text())
  assert.deepEqual(h.log, ['core', 'sync', 'doctor', 'record'])
  assert.equal(h.adds.length, 0)
  assert.equal(rd.download.calls.length, fetched, 'no new downloads')
  const second = receipt()
  assert.equal(second.status, 'ok')
  assert.ok(second.units.every((u) => u.reused === true), 'repeat run reuses all verified units')
  passing()

  // damage one unit; the next setup repairs only that unit and the runtime doctor passes again
  const target = second.units.find((u) => u.name === 'interior')
  assert.ok(target, 'fixture has an interior unit')
  assert.equal(path.dirname(target.path), path.join(rt, loadLocks(fx.root).lockDigest.slice(0, 12)))
  fs.rmSync(target.path, { recursive: true, force: true })
  reset()
  assert.equal(await runSetup(opts, rd.home, h.deps), 0, h.text() + '\n' + rd.errs.join('\n'))
  const third = receipt()
  assert.equal(third.status, 'ok')
  assert.equal(third.units.find((u) => u.name === 'interior').reused, false, 'the damaged unit is rebuilt')
  assert.ok(third.units.filter((u) => u.name !== 'interior').every((u) => u.reused === true), 'healthy units stay reused')
  assert.ok(fs.existsSync(path.join(target.path, '.img2-unit.json')))
  passing()
})

test('a real runtime doctor failure stops setup before the Jev auth probe and reports the runtime step', async () => {
  const fx = pinnedFixture()
  const rd = makeDeps(fx, { run: stubRunner() })
  // the stubbed provision "succeeds" without building, so the real runtime doctor finds no completed provision
  const h = harness({ fx, rd, real: ['doctorRuntime'], auth: PRESENT })
  assert.equal(await runSetup(setupOpts({ plugins: IDS.join(','), allowWeakHash: true }), rd.home, h.deps), 1, h.text())
  assert.deepEqual(h.log, ['core', 'sync', 'provision', 'doctor'])
  assert.equal(h.authRuns.length, 0)
  assert.match(h.text(), /Setup stopped at doctor --runtime \(exit 1\)/)
  assert.ok(runtimeReport(h).rows.some((r) => r[0] === 'fail'))
  assert.equal(h.summaries().length, 1)
})

test('a real runtime provision failure surfaces exit 1 and stops before the doctors and the Jev probe', async () => {
  const fx = pinnedFixture()
  const rd = makeDeps(fx, { run: stubRunner({ failOn: ['venv'] }) })
  const h = harness({ fx, rd, real: ['provision', 'doctorRuntime'], auth: PRESENT })
  assert.equal(await runSetup(setupOpts({ plugins: IDS.join(','), allowWeakHash: true }), rd.home, h.deps), 1, h.text())
  assert.deepEqual(h.log, ['core', 'sync'])
  assert.equal(h.authRuns.length, 0)
  assert.match(h.text(), /Setup stopped at provision \(exit 1\)/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(rd.home, 'runtime', 'provision.json'), 'utf8')).status, 'failed')
  assert.equal(h.summaries().length, 1)
})

test('real runtime with --offline and an unprimed cache refuses before building anything', async () => {
  const fx = pinnedFixture()
  const rd = makeDeps(fx, { run: stubRunner() })
  const h = harness({ fx, rd, real: ['provision', 'doctorRuntime'], auth: PRESENT })
  const code2 = await runSetup(setupOpts({ allowWeakHash: true, offline: true }), rd.home, h.deps)
  assert.notEqual(code2, 0, h.text())
  assert.equal(rd.download.calls.length, 0, 'offline never downloads')
  assert.equal(h.authRuns.length, 0)
})

// ---------------------------------------------------------------- tool python, core, router inputs

test('the Python for plugin tools is printed and is the managed 3.11, even when the ambient python3 is 3.9', async () => {
  const h = harness()
  const home = homeOf()
  h.runtimeDeps.env = { PATH: '/usr/bin:/bin' }
  const probed = []
  const prev = h.runtimeDeps.run
  h.runtimeDeps.run = async (f, a, o) => { probed.push(f); return prev(f, a, o) }
  assert.equal(await runSetup(setupOpts({ plugins: 'jev' }), home, h.deps), 0, h.text())
  const line = h.out.find((l) => l.startsWith('Plugin tools run with Python '))
  assert.equal(line, 'Plugin tools run with Python 3.11.18 (managed python-runtime, provisioned by this setup): ' + managedPython(h.fx, home))
  assert.deepEqual(probed, [managedPython(h.fx, home)], 'only the managed interpreter ran (the Jev auth probe); no ambient python was consulted')
  assert.equal(h.authRuns[0].file, managedPython(h.fx, home))
})

test('without the managed runtime setup needs a PATH python >= 3.10 and fails before install/provision when there is none', async () => {
  const bin = tmp('img2-pybin-')
  const fake = (name) => { fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 }) }
  fake('python3')
  const versions = { [path.join(bin, 'python3')]: '3.9.6' }
  const run = async (f, a) => ({ code: 0, signal: null, stdout: a.includes('-c') ? versions[f] + '\n' : '', stderr: '', timedOut: false, error: null })
  const h = harness({ rd: makeDeps(pinnedFixture(), { run }) })
  h.runtimeDeps.env = { PATH: bin }
  const code3 = await runSetup(setupOpts({ plugins: 'jev', skip: ['python-runtime'] }), homeOf(), h.deps)
  assert.equal(code3, 2, h.text())
  assert.deepEqual(h.log, [], 'nothing ran: no install, no download, no provision')
  assert.match(h.text(), /needs a Python >= 3\.10/)
  assert.match(h.text(), new RegExp(path.join(bin, 'python3').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' = 3\\.9\\.6'))

  fake('python3.12')
  versions[path.join(bin, 'python3.12')] = '3.12.4'
  const ok = harness({ rd: makeDeps(pinnedFixture(), { run }) })
  ok.runtimeDeps.env = { PATH: bin }
  assert.equal(await runSetup(setupOpts({ plugins: 'jev', skip: ['python-runtime'] }), homeOf(), ok.deps), 0, ok.text())
  assert.ok(ok.out.includes('Plugin tools run with Python 3.12.4 (system): ' + path.join(bin, 'python3.12')))
  assert.equal(ok.authRuns[0].file, path.join(bin, 'python3.12'))
})

test('the core is planned in preflight, checked out right after install, and its absence offline is refused early', async () => {
  const h = harness({ installNeeded: true, coreAction: 'add', states: { cs2: { action: 'add', ref: null } } })
  assert.equal(await runSetup(setupOpts({ plugins: 'cs2' }), homeOf(), h.deps), 0, h.text())
  assert.deepEqual(h.log.slice(0, 3), ['install', 'core', 'add:cs2'])
  assert.equal(h.cores[0].pin.commit, CORE_COMMIT)
  assert.equal(h.cores[0].opts.offline, false)
  assert.ok(h.out.some((l) => l === 'Core will be checked out at ' + CORE_COMMIT))

  const off = harness({ coreAction: 'update' })
  assert.equal(await runSetup(setupOpts({ plugins: 'cs2', offline: true }), homeOf(), off.deps), 2, off.text())
  assert.deepEqual(off.log, [])
  assert.match(off.text(), /--offline requires an installed harness, the core/)

  const refused = harness()
  refused.deps.corePlan = () => { throw Object.assign(new Error('core link is occupied by a foreign symlink'), { code: 2 }) }
  assert.equal(await runSetup(setupOpts({ plugins: 'cs2' }), homeOf(), refused.deps), 2, refused.text())
  assert.deepEqual(refused.log, [], 'a foreign host link stops setup before any mutation')
})

test('setup records the router inputs after the runtime doctor and names the router command', async () => {
  const h = harness()
  const home = homeOf()
  assert.equal(await runSetup(setupOpts({ plugins: 'jev' }), home, h.deps), 0, h.text())
  assert.equal(h.records.length, 1)
  assert.deepEqual(h.records[0].python, { path: managedPython(h.fx, home), version: '3.11.18', managed: true })
  assert.equal(h.records[0].lockDigest, loadLocks(h.fx.root).lockDigest)
  assert.ok(h.log.indexOf('record') > h.log.indexOf('doctorRuntime'))
  assert.ok(h.out.some((l) => l === 'node ' + path.join(home, 'harness/bin/img2.mjs') + ' --home ' + home + ' route --workspace WORKSPACE --run-id RUN_ID --image IMAGE [--objects OBJECTS.json] [--intent INTENT] [--expected-output 2d|3d]'), h.text())
  assert.ok(!h.out.some((l) => l.includes('Core router:')), 'the bare router path is no longer advertised: it cannot run without the interpreter, PATH and pins')
  const failing = harness({ codes: { doctorRuntime: 1 } })
  assert.equal(await runSetup(setupOpts({ plugins: 'jev' }), homeOf(), failing.deps), 1)
  assert.equal(failing.records.length, 0, 'no record when the runtime did not verify')
})
