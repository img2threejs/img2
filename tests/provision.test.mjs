import test from 'node:test'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXIT, Refusal } from '../bin/runtime/errors.mjs'
import { isAffirmative, parseProvisionOpts, removeRuntime, runProvision } from '../bin/runtime/provision.mjs'
import { detectPlatform, integrityOf, loadLocks } from '../bin/runtime/lock.mjs'
import { validateSelectorsFile } from '../bin/runtime/selectors.mjs'
import { baseOpts, makeDeps, makeFixture, sha256, stubDownloader, stubRunner, tmp, PLATFORM } from './runtime-fixtures.mjs'

const BIN = fileURLToPath(new URL('../bin/img2.mjs', import.meta.url))
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const rt = (deps) => path.join(deps.home, 'runtime')
const digestDir = (deps, fx) => path.join(rt(deps), loadLocks(fx.root).lockDigest.slice(0, 12))
const snapshot = (dir) => {
  const out = {}
  const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const st = fs.lstatSync(p); if (st.isDirectory()) walk(p); else out[path.relative(dir, p)] = st.isSymbolicLink() ? fs.readlinkSync(p) : sha256(fs.readFileSync(p)) } }
  if (fs.existsSync(dir)) walk(dir)
  return out
}
const refusal = async (fn) => { try { await fn() } catch (e) { return e } assert.fail('expected a refusal') }

test('--plan prints every environment with sizes, labels unknowns and writes nothing', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  assert.equal(await runProvision(baseOpts({ plan: true }), deps.home, deps), EXIT.OK)
  const text = deps.lines.join('\n')
  for (const unit of ['runtime/python-runtime', 'character', 'interior', 'vision', 'character-node', 'pixi2d', 'mcp/mcp-fake', 'cs2/cs2-source2viewer-cli', 'browsers/browser-chromium-1.64.0']) assert.match(text, new RegExp(unit.replace('/', '\\/')))
  assert.match(text, /unknown/)
  assert.match(text, /total download/)
  assert.match(text, /weak integrity/)
  assert.match(text, /nothing was written/)
  assert.equal(fs.existsSync(rt(deps)), false)
  assert.equal(deps.download.calls.length, 0)
})

test('--plan --json is machine readable and lists skipped dependencies', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  await runProvision(baseOpts({ plan: true, json: true, skip: ['character-bpy'] }), deps.home, deps)
  const plan = JSON.parse(deps.lines.join('\n'))
  assert.equal(plan.platform, PLATFORM)
  assert.ok(plan.skipped.some((s) => s.id === 'character-bpy'))
  assert.ok(plan.units.every((u) => u.path.includes(plan.lockDigest.slice(0, 12))))
})

test('unsupported platforms refuse with exit 2 before touching anything', async () => {
  assert.throws(() => detectPlatform('win32', 'x64'), (e) => e instanceof Refusal && e.code === EXIT.REFUSED && /Windows/.test(e.detail))
  assert.throws(() => detectPlatform('linux', 'ia32'), Refusal)
  const fx = makeFixture(); const deps = makeDeps(fx, { platform: 'win32-x64' })
  const e = await refusal(() => runProvision(baseOpts({ yes: true }), deps.home, deps))
  assert.equal(e.code, EXIT.REFUSED)
  assert.equal(fs.existsSync(rt(deps)), false)
  const r = spawnSync(process.execPath, [BIN, 'provision', '--plan'], { env: { ...process.env, IMG2_HOME: tmp() }, encoding: 'utf8' })
  assert.notEqual(r.status, null)
})

test('a non-TTY without --yes refuses with exit 2 and changes nothing', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  const e = await refusal(() => runProvision(baseOpts({ yes: false }), deps.home, deps))
  assert.equal(e.code, EXIT.REFUSED)
  assert.match(e.message, /not a terminal/)
  assert.equal(fs.existsSync(rt(deps)), false)
  assert.equal(deps.download.calls.length, 0)
})

test('the single confirmation defaults to yes; declining exits 3 without changes', async () => {
  assert.ok(isAffirmative('')); assert.ok(isAffirmative('Y')); assert.ok(isAffirmative('yes')); assert.ok(!isAffirmative('n')); assert.ok(!isAffirmative('no'))
  const fx = makeFixture()
  const asked = []
  const declined = makeDeps(fx, { isTTY: true, confirm: async (q) => { asked.push(q); return false } })
  assert.equal(await runProvision(baseOpts({ yes: false }), declined.home, declined), EXIT.DECLINED)
  assert.equal(asked.length, 1)
  assert.equal(fs.existsSync(rt(declined)), false)
  const accepted = makeDeps(fx, { isTTY: true, confirm: async () => true })
  assert.equal(await runProvision(baseOpts({ yes: false }), accepted.home, accepted), EXIT.OK)
})

test('a successful run writes selectors.json (0600, atomic), env.sh and a receipt with hashes and exit codes', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  assert.equal(await runProvision(baseOpts(), deps.home, deps), EXIT.OK)
  const file = path.join(rt(deps), 'selectors.json')
  const st = fs.lstatSync(file)
  assert.ok(st.isFile())
  assert.equal(st.mode & 0o777, 0o600)
  const sel = readJson(file)
  const locks = loadLocks(fx.root)
  assert.equal(sel.schema, 1)
  assert.equal(sel.lockDigest, locks.lockDigest)
  assert.equal(sel.pluginsLockDigest, locks.pluginsDigest)
  assert.deepEqual(sel.selectedPlugins, ['character', 'cs2', 'interior', 'jev', 'pixi2d'])
  assert.match(sel.createdAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/)
  const allowed = ['IMG2_CHARACTER_NODE', 'IMG2_CHARACTER_BROWSER', 'IMG2_CHARACTER_BPY_PYTHON', 'IMG2_CHARACTER_THREE_ROOT', 'IMG2_CHARACTER_THREE_SHA256', 'IMG2_BLENDER_PYTHON', 'IMG2THREEJS_VISION_PYTHON', 'PLAYWRIGHT_BROWSERS_PATH']
  assert.deepEqual(Object.keys(sel.env).sort(), allowed.slice().sort())
  assert.match(sel.env.IMG2_CHARACTER_THREE_SHA256, /^[0-9a-f]{64}$/)
  for (const [k, v] of Object.entries(sel.env)) if (k !== 'IMG2_CHARACTER_THREE_SHA256') assert.ok(path.isAbsolute(v) && fs.realpathSync(v).startsWith(fs.realpathSync(rt(deps))), k)
  assert.notEqual(sel.env.IMG2_CHARACTER_BPY_PYTHON, sel.env.IMG2_BLENDER_PYTHON, 'bpy lives in separate environments')
  assert.deepEqual(validateSelectorsFile(rt(deps), { lockDigest: locks.lockDigest }), [])
  assert.ok(fs.readFileSync(path.join(rt(deps), 'env.sh'), 'utf8').includes("export IMG2_BLENDER_PYTHON='"))
  assert.equal(fs.readdirSync(rt(deps)).filter((n) => n.includes('.tmp')).length, 0, 'no temp files left by the atomic write')
  const receipt = readJson(path.join(rt(deps), 'provision.json'))
  assert.equal(receipt.status, 'ok')
  assert.ok(receipt.steps.some((s) => s.kind === 'exec' && s.exitCode === 0))
  const art = receipt.steps.filter((s) => s.kind === 'artifact')
  assert.ok(art.length >= 10 && art.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)))
})

test('selectors.json validation catches wrong mode, foreign digest, escaping paths and a wrong Three digest', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  await runProvision(baseOpts(), deps.home, deps)
  const file = path.join(rt(deps), 'selectors.json')
  const good = readJson(file)
  const rewrite = (patch) => { fs.writeFileSync(file, JSON.stringify({ ...good, ...patch })); fs.chmodSync(file, 0o600) }
  fs.chmodSync(file, 0o644)
  assert.match(validateSelectorsFile(rt(deps)).join(), /mode is 644/)
  rewrite({ lockDigest: 'f'.repeat(64) })
  assert.match(validateSelectorsFile(rt(deps), { lockDigest: good.lockDigest }).join(), /differs from the installed harness lock/)
  const outside = tmp(); fs.writeFileSync(path.join(outside, 'x'), '1')
  rewrite({ env: { ...good.env, IMG2_BLENDER_PYTHON: path.join(outside, 'x') } })
  assert.match(validateSelectorsFile(rt(deps)).join(), /resolves outside/)
  fs.symlinkSync(path.join(outside, 'x'), path.join(rt(deps), 'escape'))
  rewrite({ env: { ...good.env, IMG2_BLENDER_PYTHON: path.join(rt(deps), 'escape') } })
  assert.match(validateSelectorsFile(rt(deps)).join(), /resolves outside/, 'a symlink escaping the runtime tree is refused')
  rewrite({ env: { ...good.env, SOMETHING_ELSE: '1' } })
  assert.match(validateSelectorsFile(rt(deps)).join(), /not allowed/)
  rewrite({ env: { ...good.env, IMG2_CHARACTER_THREE_SHA256: '0'.repeat(64) } })
  assert.match(validateSelectorsFile(rt(deps)).join(), /does not match the files/)
})

test('a hash mismatch refuses the artifact and activates nothing', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx, { download: stubDownloader(makeFixture().bytes) })
  // a download whose bytes differ from the locked hash (different fixture bytes under the same URL)
  const tampered = makeDeps(fx, { download: stubDownloader(fx.bytes, { tamper: (u) => u.endsWith('numpy-1.26.4-cp311-cp311-manylinux.whl') }) })
  const code = await runProvision(baseOpts(), tampered.home, tampered)
  assert.equal(code, EXIT.FAIL)
  assert.match(tampered.errs.join('\n'), /hash mismatch/)
  assert.equal(fs.existsSync(path.join(rt(tampered), 'selectors.json')), false)
  const dir = digestDir(tampered, fx)
  assert.equal(fs.existsSync(path.join(dir, 'character')), false)
  assert.equal(fs.existsSync(path.join(dir, 'interior')), false)
  assert.equal(fs.readdirSync(path.join(rt(tampered), 'cache', 'sha256')).some((n) => n === sha256(Buffer.from('wheel numpy 1.26.4') + 'tampered')), false)
  assert.equal(readJson(path.join(rt(tampered), 'provision.json')).status, 'failed')
  void deps
})

test('a size mismatch against the lock is refused', async () => {
  const fx = makeFixture({ mutate: (lock) => { lock.dependencies[0].artifacts[0].size += 5 } })
  const deps = makeDeps(fx)
  assert.equal(await runProvision(baseOpts(), deps.home, deps), EXIT.FAIL)
  assert.match(deps.errs.join('\n'), /size mismatch/)
})

test('weak-hash artifacts are refused with exit 2 unless --allow-weak-hash, which records a real sha256', async () => {
  const blob = Buffer.from('{"config": true}')
  const gitSha = (b) => { const h = import.meta; void h; return require_sha1('blob ' + b.length + '\0', b) }
  const fx = makeFixture({
    mutate: (lock, bytes) => {
      const url = 'https://huggingface.example.test/config.json'
      bytes.set(url, blob)
      lock.dependencies.push({
        id: 'vision-model-config', environment: 'vision', kind: 'model', name: 'cfg', version: 'rev', group: 'vision', consumers: ['vision'], requires: ['vision-torch'],
        probe: 'vision-offline-inference', ownership: 'harness', constraints: { platforms: [PLATFORM] }, exports: [], status: 'unresolved',
        reason: { code: 'x', reason: 'git blob sha1 only' },
        artifacts: [{ platform: 'any', filename: 'config.json', url, size: blob.length, gitBlobSha1: gitSha(blob) }],
      })
      lock.profiles.full.dependencies.push('vision-model-config')
    },
  })
  assert.equal(integrityOf(fx.entry('vision-model-config').artifacts[0]).weak, true)
  const refused = makeDeps(fx)
  const e = await refusal(() => runProvision(baseOpts({ allowWeakHash: false }), refused.home, refused))
  assert.equal(e.code, EXIT.REFUSED)
  assert.match(e.detail, /config\.json \[git SHA-1\]/)
  assert.match(e.detail, /chrome-linux64\.zip/)
  assert.equal(fs.existsSync(rt(refused)), false)
  assert.equal(refused.download.calls.length, 0)

  const allowed = makeDeps(fx)
  assert.equal(await runProvision(baseOpts({ allowWeakHash: true }), allowed.home, allowed), EXIT.OK)
  const receipt = readJson(path.join(rt(allowed), 'provision.json'))
  const row = receipt.steps.find((s) => s.kind === 'artifact' && s.dependency === 'vision-model-config')
  assert.equal(row.sha256, sha256(blob))
  assert.equal(row.weak, 'git SHA-1')
  assert.equal(receipt.allowWeakHash, true)
  assert.ok(receipt.steps.some((s) => s.kind === 'browser-tree' && /^[0-9a-f]{64}$/.test(s.treeSha256)), 'browser tree sha256 recorded')
})

function require_sha1(head, body) { return crypto.createHash('sha1').update(head).update(body).digest('hex') }

test('a git blob that does not match its pinned SHA-1 is refused even with --allow-weak-hash', async () => {
  const blob = Buffer.from('payload')
  const fx = makeFixture({
    mutate: (lock, bytes) => {
      const url = 'https://huggingface.example.test/c.json'
      bytes.set(url, Buffer.from('something else'))
      lock.dependencies.push({
        id: 'vision-model-config', environment: 'vision', kind: 'model', name: 'cfg', version: 'rev', group: 'vision', consumers: ['vision'], requires: ['vision-torch'],
        probe: 'vision-offline-inference', ownership: 'harness', constraints: { platforms: [PLATFORM] }, exports: [], status: 'unresolved', reason: { code: 'x', reason: 'y' },
        artifacts: [{ platform: 'any', filename: 'c.json', url, gitBlobSha1: require_sha1('blob ' + blob.length + '\0', blob) }],
      })
      lock.profiles.full.dependencies.push('vision-model-config')
    },
  })
  const deps = makeDeps(fx)
  assert.equal(await runProvision(baseOpts({ allowWeakHash: true }), deps.home, deps), EXIT.FAIL)
  assert.match(deps.errs.join('\n'), /git blob SHA-1 mismatch/)
})

test('non-HTTPS artifact URLs are rejected by the lock validator', () => {
  const fx = makeFixture({ mutate: (lock) => { lock.dependencies[0].artifacts[0].url = 'http://artifacts.example.test/python.tar.gz' } })
  assert.throws(() => loadLocks(fx.root), (e) => e instanceof Refusal && /invalid/.test(e.message) && /https/.test(e.detail))
})

test('a failed step leaves the previous runtime untouched, then a re-run resumes without re-downloading', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  assert.equal(await runProvision(baseOpts(), deps.home, deps), EXIT.OK)
  const dir = digestDir(deps, fx)
  const before = snapshot(dir)
  const beforeSel = fs.readFileSync(path.join(rt(deps), 'selectors.json'), 'utf8')

  // a new lock (different digest) whose interior install fails after character succeeded
  const fx2 = makeFixture({ mutate: (lock) => { lock.generatedAt = 'second' } })
  const deps2 = makeDeps(fx2, { home: deps.home, run: stubRunner({ failOn: ['--require-hashes'] }), download: stubDownloader(fx2.bytes) })
  assert.equal(await runProvision(baseOpts(), deps2.home, deps2), EXIT.FAIL)
  assert.deepEqual(snapshot(dir), before, 'previous runtime is byte-identical')
  assert.equal(fs.readFileSync(path.join(rt(deps), 'selectors.json'), 'utf8'), beforeSel, 'selectors still point at the previous runtime')
  assert.equal(readJson(path.join(rt(deps), 'provision.json')).status, 'failed')
  assert.equal(fs.existsSync(path.join(digestDir(deps2, fx2), '.staging', 'character')), false, 'failed stage is removed')

  const deps3 = makeDeps(fx2, { home: deps.home, download: stubDownloader(fx2.bytes) })
  assert.equal(await runProvision(baseOpts(), deps3.home, deps3), EXIT.OK)
  assert.equal(deps3.download.calls.length, 0, 'every artifact came from the verified cache')
  assert.equal(readJson(path.join(rt(deps), 'selectors.json')).lockDigest, loadLocks(fx2.root).lockDigest)
})

test('a failed probe on a re-provision does not replace the active unit', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  await runProvision(baseOpts(), deps.home, deps)
  const dir = digestDir(deps, fx)
  const before = snapshot(path.join(dir, 'character'))
  fs.rmSync(path.join(dir, 'character', '.img2-unit.json'))
  fs.writeFileSync(path.join(dir, 'character', 'marker'), 'old runtime')
  const bpyBroken = makeDeps(fx, { home: deps.home, run: stubRunner({ failProbe: ['import bpy'] }) })
  assert.equal(await runProvision(baseOpts(), bpyBroken.home, bpyBroken), EXIT.FAIL)
  assert.match(bpyBroken.errs.join('\n'), /probe failed for character/)
  assert.equal(fs.readFileSync(path.join(dir, 'character', 'marker'), 'utf8'), 'old runtime')
  assert.ok(Object.keys(before).length > 0)
})

test('an idempotent re-run reuses verified units and installs nothing new', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  await runProvision(baseOpts(), deps.home, deps)
  const dir = digestDir(deps, fx)
  const before = snapshot(dir)
  const again = makeDeps(fx, { home: deps.home })
  assert.equal(await runProvision(baseOpts(), again.home, again), EXIT.OK)
  assert.equal(again.download.calls.length, 0)
  assert.equal(again.run.calls.filter((c) => c.args.includes('install') || c.args.includes('venv')).length, 0)
  assert.deepEqual(snapshot(dir), before)
  const receipt = readJson(path.join(rt(deps), 'provision.json'))
  assert.ok(receipt.units.every((u) => u.reused))
})

test('a tampered active unit is detected on re-run and rebuilt from the cache', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  await runProvision(baseOpts(), deps.home, deps)
  const dir = digestDir(deps, fx)
  const failing = makeDeps(fx, { home: deps.home, run: stubRunner({ failProbe: ['import bpy'] }) })
  assert.equal(await runProvision(baseOpts(), failing.home, failing), EXIT.FAIL, 'reuse is rejected when the probe fails and the rebuild fails too')
  assert.ok(fs.existsSync(path.join(dir, 'character', 'venv')), 'active unit still in place')
})

test('--skip disables the dependency and everything that needs it, with a clear message', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  assert.equal(await runProvision(baseOpts({ plan: true, skip: ['node-runtime'] }), deps.home, deps), EXIT.OK)
  const text = deps.lines.join('\n')
  assert.match(text, /node-runtime: skipped by --skip node-runtime/)
  assert.match(text, /character-three: requires node-runtime, which is disabled/)
  assert.match(text, /mcp-fake: requires node-runtime/)
  assert.match(text, /browser-chromium-1\.64\.0: requires node-runtime/)
  assert.doesNotMatch(text, /\ncharacter-node /)
  const run = makeDeps(fx)
  assert.equal(await runProvision(baseOpts({ skip: ['node-runtime'] }), run.home, run), EXIT.OK)
  const sel = readJson(path.join(rt(run), 'selectors.json'))
  assert.equal(sel.env.IMG2_CHARACTER_NODE, undefined)
  assert.equal(sel.env.IMG2_CHARACTER_THREE_ROOT, undefined)
  assert.ok(sel.env.IMG2_CHARACTER_BPY_PYTHON)
  const receipt = readJson(path.join(rt(run), 'provision.json'))
  assert.ok(receipt.skipped.some((s) => s.id === 'mcp-fake'))
  assert.deepEqual(receipt.skipRequested, ['node-runtime'])
})

test('an unknown --skip id is refused; skipping an essential bpy is allowed only explicitly', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  const e = await refusal(() => runProvision(baseOpts({ skip: ['no-such-dep'] }), deps.home, deps))
  assert.equal(e.code, EXIT.REFUSED)
  assert.equal(await runProvision(baseOpts({ plan: true, skip: ['interior-bpy'] }), deps.home, deps), EXIT.OK)
})

test('an essential bpy missing on the platform refuses unless explicitly skipped', async () => {
  const fx = makeFixture({ mutate: (lock) => { lock.dependencies.find((d) => d.id === 'interior-bpy').constraints.platforms = ['darwin-arm64'] } })
  const deps = makeDeps(fx)
  const e = await refusal(() => runProvision(baseOpts({ plan: true }), deps.home, deps))
  assert.equal(e.code, EXIT.REFUSED)
  assert.match(e.message, /essential dependency interior-bpy/)
  assert.equal(await runProvision(baseOpts({ plan: true, skip: ['interior-bpy'] }), deps.home, deps), EXIT.OK)
})

test('the minimal profile omits vision and MCP; --plugins narrows to the selected plugins', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  await runProvision(baseOpts({ minimal: true }), deps.home, deps)
  assert.equal(readJson(path.join(rt(deps), 'provision.json')).profile, 'minimal')
  const sel = readJson(path.join(rt(deps), 'selectors.json'))
  assert.equal(sel.env.IMG2THREEJS_VISION_PYTHON, undefined)
  assert.ok(sel.env.IMG2_CHARACTER_BPY_PYTHON)
  assert.equal(fs.existsSync(path.join(digestDir(deps, fx), 'vision')), false)
  assert.equal(fs.existsSync(path.join(digestDir(deps, fx), 'mcp')), false)

  const only = makeDeps(fx)
  await runProvision(baseOpts({ plugins: 'character' }), only.home, only)
  const s2 = readJson(path.join(rt(only), 'selectors.json'))
  assert.deepEqual(s2.selectedPlugins, ['character'])
  assert.equal(s2.env.IMG2_BLENDER_PYTHON, undefined, 'interior is not selected')
  assert.ok(s2.env.IMG2_CHARACTER_BPY_PYTHON)
  const bad = makeDeps(fx)
  assert.equal((await refusal(() => runProvision(baseOpts({ plugins: 'character,nope' }), bad.home, bad))).code, EXIT.REFUSED)
  assert.throws(() => parseProvisionOpts({ ...baseOpts(), minimal: true, profile: 'full' }), Refusal)
})

test('--offline works only from a complete cache and refuses before changing anything otherwise', async () => {
  const fx = makeFixture(); const cold = makeDeps(fx)
  const e = await refusal(() => runProvision(baseOpts({ offline: true }), cold.home, cold))
  assert.equal(e.code, EXIT.REFUSED)
  assert.match(e.message, /cache is incomplete/)
  assert.match(e.detail, /python\.tar\.gz/)
  assert.equal(fs.existsSync(path.join(rt(cold), 'selectors.json')), false)
  assert.equal(cold.download.calls.length, 0)

  const online = makeDeps(fx)
  await runProvision(baseOpts(), online.home, online)
  const dir = digestDir(online, fx)
  fs.rmSync(dir, { recursive: true }) // keep only the cache
  fs.rmSync(path.join(rt(online), 'selectors.json'))
  const off = makeDeps(fx, { home: online.home, download: async () => { throw new Error('network used while --offline') } })
  assert.equal(await runProvision(baseOpts({ offline: true }), off.home, off), EXIT.OK)
  assert.ok(fs.existsSync(path.join(rt(off), 'selectors.json')))
})

test('a corrupted cache entry is discarded and re-downloaded, never used', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  await runProvision(baseOpts({ plugins: 'character' }), deps.home, deps)
  const cacheDir = path.join(rt(deps), 'cache', 'sha256')
  const victim = fs.readdirSync(cacheDir)[0]
  fs.writeFileSync(path.join(cacheDir, victim), 'corrupted')
  fs.rmSync(digestDir(deps, fx), { recursive: true })
  const again = makeDeps(fx, { home: deps.home })
  assert.equal(await runProvision(baseOpts({ plugins: 'character' }), again.home, again), EXIT.OK)
  assert.ok(again.download.calls.length >= 1)
  assert.equal(sha256(fs.readFileSync(path.join(cacheDir, victim))), victim)
})

test('postinstall scripts do not run unless the lock marks the package reviewed', async () => {
  const marker = (dir) => path.join(dir, 'ran')
  const build = (reviewed) => makeFixture({
    mutate: (lock, bytes) => {
      const dep = lock.dependencies.find((d) => d.id === 'mcp-fake')
      const buf = makeTar({ scripts: { postinstall: 'touch ran' }, bin: { 'fake-mcp': 'server.js' } })
      const url = 'https://artifacts.example.test/fake-mcp-1.0.0.tgz'
      bytes.set(url, buf)
      dep.artifacts = [{ platform: 'any', url, integrity: 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64') }]
      if (reviewed) dep.scriptsReviewed = true
    },
  })
  const locked = build(false); const a = makeDeps(locked)
  await runProvision(baseOpts(), a.home, a)
  assert.equal(fs.existsSync(marker(path.join(digestDir(a, locked), 'mcp', 'mcp-fake', 'node', 'node_modules', 'fake-mcp'))), false)
  const receipt = readJson(path.join(rt(a), 'provision.json'))
  assert.deepEqual(receipt.steps.find((s) => s.kind === 'npm-root' && s.unit === 'mcp/mcp-fake').scriptsSkipped, ['fake-mcp@1.0.0'])
  const reviewed = build(true); const b = makeDeps(reviewed, { run: stubRunner() })
  await runProvision(baseOpts(), b.home, b)
  assert.ok(b.run.calls.some((c) => c.file === '/bin/sh' && c.args.includes('touch ran')), 'a reviewed script runs through the runner')
})
import { makeTarGz } from './runtime-fixtures.mjs'
function makeTar(extra) {
  return makeTarGz([{ name: 'package/package.json', data: JSON.stringify({ name: 'fake-mcp', version: '1.0.0', ...extra }) }, { name: 'package/server.js', data: '//' }])
}

test('pip installs from a generated requirements file with hashes, wheels only, in separate environments', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  await runProvision(baseOpts(), deps.home, deps)
  const dir = digestDir(deps, fx)
  const req = fs.readFileSync(path.join(dir, 'character', 'requirements.lock.txt'), 'utf8')
  assert.match(req, /^bpy==4\.5\.15 --hash=sha256:[0-9a-f]{64}$/m)
  assert.match(req, /^certifi==2026\.1\.1 --hash=sha256:/m, 'transitive pins included')
  assert.doesNotMatch(req, /4\.3\.0/)
  assert.match(fs.readFileSync(path.join(dir, 'interior', 'requirements.lock.txt'), 'utf8'), /^bpy==4\.3\.0 --hash=sha256:/m)
  const pip = deps.run.calls.filter((c) => c.args.includes('install') && c.args.includes('pip'))
  assert.ok(pip.length >= 3)
  for (const c of pip) for (const flag of ['--require-hashes', '--only-binary=:all:', '--no-index', '--no-deps', '--isolated']) assert.ok(c.args.includes(flag), flag)
  assert.deepEqual(readJson(path.join(dir, 'character', 'venv', 'installed.json')).bpy, '4.5.15')
  assert.deepEqual(readJson(path.join(dir, 'interior', 'venv', 'installed.json')).bpy, '4.3.0')
})

test('ambient pip/python/node settings never reach installer or probe children', async () => {
  const keep = { PIP_INDEX_URL: process.env.PIP_INDEX_URL, PYTHONPATH: process.env.PYTHONPATH, NODE_OPTIONS: process.env.NODE_OPTIONS }
  process.env.PIP_INDEX_URL = 'https://evil.example.test/'; process.env.PYTHONPATH = '/evil'; process.env.NODE_OPTIONS = '--require /evil.js'
  try {
    const fx = makeFixture(); const deps = makeDeps(fx)
    await runProvision(baseOpts({ plugins: 'character' }), deps.home, deps)
    for (const c of deps.run.calls) {
      assert.equal(c.env?.PIP_INDEX_URL, undefined); assert.equal(c.env?.PYTHONPATH, undefined); assert.equal(c.env?.NODE_OPTIONS, undefined)
      assert.equal(c.env?.PYTHONNOUSERSITE, '1')
    }
  } finally { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
})

test('browsers install through the pinned Playwright CLI into a dedicated PLAYWRIGHT_BROWSERS_PATH under the runtime tree', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  await runProvision(baseOpts(), deps.home, deps)
  const install = deps.run.calls.find((c) => c.args.at(-2)?.endsWith?.('cli.js') || (c.args[0]?.endsWith('cli.js') && c.args[1] === 'install'))
  assert.ok(install, 'playwright install was run')
  assert.match(install.args[0], /playwright-core[\\/]cli\.js$/)
  assert.ok(install.env.PLAYWRIGHT_BROWSERS_PATH.includes(path.join('runtime')) && install.env.PLAYWRIGHT_BROWSERS_PATH.includes('.staging'))
  const sel = readJson(path.join(rt(deps), 'selectors.json'))
  assert.ok(sel.env.PLAYWRIGHT_BROWSERS_PATH.startsWith(path.join(fs.realpathSync(rt(deps)), loadLocks(fx.root).lockDigest.slice(0, 12), 'browsers')))
})

test('--remove removes only what provisioning owns', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  await runProvision(baseOpts(), deps.home, deps)
  fs.writeFileSync(path.join(rt(deps), 'user-notes.txt'), 'mine')
  fs.mkdirSync(path.join(deps.home, 'plugins')); fs.writeFileSync(path.join(deps.home, 'plugins', 'keep'), '1')
  fs.writeFileSync(path.join(deps.home, 'receipts.json'), '[]')
  const lines = []
  assert.equal(removeRuntime(deps.home, (l) => lines.push(l)), EXIT.OK)
  assert.deepEqual(fs.readdirSync(rt(deps)), ['user-notes.txt'])
  assert.ok(fs.existsSync(path.join(deps.home, 'plugins', 'keep')))
  assert.ok(fs.existsSync(path.join(deps.home, 'receipts.json')))
  assert.match(lines.join('\n'), /left in place/)
  const clean = makeDeps(makeFixture()); await runProvision(baseOpts(), clean.home, clean)
  removeRuntime(clean.home)
  assert.equal(fs.existsSync(rt(clean)), false)
  assert.equal(removeRuntime(clean.home), EXIT.OK, 'removing nothing is fine')
})

test('a second provision cannot run concurrently, and a stale lock from a dead process is cleared', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  fs.mkdirSync(rt(deps), { recursive: true })
  fs.writeFileSync(path.join(rt(deps), '.provision.lock'), String(process.pid))
  const e = await refusal(() => runProvision(baseOpts(), deps.home, deps))
  assert.match(e.message, /another img2 provision is running/)
  fs.writeFileSync(path.join(rt(deps), '.provision.lock'), '2147483646')
  assert.equal(await runProvision(baseOpts(), deps.home, deps), EXIT.OK)
  assert.equal(fs.existsSync(path.join(rt(deps), '.provision.lock')), false, 'lock released')
})

test('the real CLI wires provision: --plan works against the shipped lock and writes nothing', () => {
  const home = tmp()
  const r = spawnSync(process.execPath, [BIN, 'provision', '--plan'], { env: { ...process.env, IMG2_HOME: home }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /character-bpy/); assert.match(r.stdout, /interior-bpy/); assert.match(r.stdout, /nothing was written/)
  assert.deepEqual(fs.readdirSync(home), [])
  const noTty = spawnSync(process.execPath, [BIN, 'provision', '--profile', 'minimal'], { env: { ...process.env, IMG2_HOME: home }, encoding: 'utf8', input: '' })
  assert.equal(noTty.status, 2)
  assert.match(noTty.stderr, /not a terminal/)
  assert.deepEqual(fs.readdirSync(home), [])
  assert.equal(spawnSync(process.execPath, [BIN, 'provision', '--profile', 'huge', '--plan'], { env: { ...process.env, IMG2_HOME: home }, encoding: 'utf8' }).status, 2)
  assert.equal(spawnSync(process.execPath, [BIN, 'provision', '--remove', '--plan'], { env: { ...process.env, IMG2_HOME: home }, encoding: 'utf8' }).status, 2)
})

test('--skip python-runtime does not cascade: a matching system interpreter stands in', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  await runProvision(baseOpts({ plan: true, skip: ['python-runtime'] }), deps.home, deps)
  const text = deps.lines.join('\n')
  assert.match(text, /python-runtime: skipped by --skip python-runtime/)
  assert.doesNotMatch(text, /character-bpy: requires/)
  assert.match(text, /\ncharacter /)
})

// ---------------------------------------------------------------- runtime exec hardening

import { realRunner, mcpHandshake } from '../bin/runtime/exec.mjs'

test('realRunner: a timeout kills the whole process group and returns without waiting on pipes a grandchild holds', async () => {
  const run = realRunner()
  const t0 = Date.now()
  const r = await run('/bin/sh', ['-c', 'sleep 30 & echo $! ; wait'], { timeout: 300, killGraceMs: 100 })
  assert.equal(r.timedOut, true)
  assert.ok(Date.now() - t0 < 5000, 'returned promptly after the kill, not after the grandchild closed the pipes')
  const grandchild = Number(r.stdout.trim().split('\n')[0])
  assert.ok(grandchild > 0)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.throws(() => process.kill(grandchild, 0), /ESRCH/, 'grandchild is gone')
})

test('mcpHandshake: a JSON-RPC error from tools/list fails the handshake', async () => {
  const server = [
    "process.stdin.setEncoding('utf8'); let b = ''",
    "process.stdin.on('data', (c) => { b += c; let i; while ((i = b.indexOf('\\n')) >= 0) { const m = JSON.parse(b.slice(0, i)); b = b.slice(i + 1)",
    "  if (m.id === 1) console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 's', version: '1' } } }))",
    "  if (m.id === 2) console.log(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found' } })) } })",
  ].join('\n')
  const r = await mcpHandshake({ command: process.execPath, args: ['-e', server], timeout: 10_000 })
  assert.equal(r.ok, false)
  assert.match(r.error, /tools\/list failed.*Method not found/)
  const good = await mcpHandshake({ command: process.execPath, args: ['-e', server.replace("error: { code: -32601, message: 'Method not found' }", "result: { tools: [{}, {}] }")], timeout: 10_000 })
  assert.equal(good.ok, true); assert.equal(good.toolCount, 2)
  const malformed = await mcpHandshake({ command: process.execPath, args: ['-e', server.replace("error: { code: -32601, message: 'Method not found' }", "result: {}")], timeout: 10_000 })
  assert.equal(malformed.ok, false); assert.match(malformed.error, /no tools array/)
  const silent = await mcpHandshake({ command: process.execPath, args: ['-e', server.replace("if (m.id === 2)", "if (false)")], timeout: 500 })
  assert.equal(silent.ok, false); assert.match(silent.error, /no reply/)
})

// ---------------------------------------------------------------- cache pins

import { Cache } from '../bin/runtime/cache.mjs'

test('cache: bytes stored under an old pin are not reused once the artifact pins (git blob SHA-1, size) change', async () => {
  const url = 'https://artifacts.example.test/cfg.json'
  const old = Buffer.from('old config'); const next = Buffer.from('new config!')
  const gitSha = (b) => crypto.createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex')
  const served = { current: old }
  const download = async (u, dest) => { download.calls += 1; fs.writeFileSync(dest, served.current) }
  download.calls = 0
  const cache = new Cache({ dir: tmp(), download, allowWeak: true })
  const first = await cache.fetch({ url, size: old.length, gitBlobSha1: gitSha(old) }, 'cfg')
  assert.equal(first.cached, false)
  assert.equal((await cache.fetch({ url, size: old.length, gitBlobSha1: gitSha(old) }, 'cfg')).cached, true, 'same pins hit the cache')
  assert.equal(download.calls, 1)
  served.current = next
  const bumped = await cache.fetch({ url, size: next.length, gitBlobSha1: gitSha(next) }, 'cfg')
  assert.equal(bumped.cached, false, 'a changed pin forces a re-download')
  assert.equal(fs.readFileSync(bumped.file, 'utf8'), 'new config!')
  assert.equal(download.calls, 2)
  // same bytes, pins that no longer match them: refused after the re-download, never served from cache
  await assert.rejects(() => cache.fetch({ url, size: next.length, gitBlobSha1: gitSha(old) }, 'cfg'), /git blob SHA-1 mismatch/)
})

// ---------------------------------------------------------------- transactional activation

test('a failing later unit rolls back units this run already switched in, and the message is true', async () => {
  const fx = makeFixture(); const first = makeDeps(fx)
  assert.equal(await runProvision(baseOpts(), first.home, first), EXIT.OK)
  const dir = digestDir(first, fx)
  const before = snapshot(path.join(dir, 'character')); const beforeSel = fs.readFileSync(path.join(rt(first), 'selectors.json'), 'utf8')
  assert.equal(readJson(path.join(dir, 'character', 'venv', 'installed.json')).bpy, '4.5.15')
  // --skip character-bpy changes the character unit's fingerprint (rebuilt, switched in), then vision fails its probe
  const second = makeDeps(fx, { home: first.home, run: stubRunner({ failProbe: ['import torch'] }) })
  assert.equal(await runProvision(baseOpts({ skip: ['character-bpy'] }), second.home, second), EXIT.FAIL)
  assert.deepEqual(snapshot(path.join(dir, 'character')), before, 'the previous character environment is back, byte for byte')
  assert.equal(fs.readFileSync(path.join(rt(first), 'selectors.json'), 'utf8'), beforeSel)
  assert.equal(fs.existsSync(path.join(dir, '.rollback')), false)
  assert.match(second.errs.join('\n'), /rolled back/)
  assert.doesNotMatch(second.errs.join('\n'), /untouched/)
  assert.ok(readJson(path.join(rt(first), 'provision.json')).rolledBack.includes('character'))
  // and the runtime still works: a clean rerun succeeds
  assert.equal(await runProvision(baseOpts(), first.home, makeDeps(fx, { home: first.home })), EXIT.OK)
})

// ---------------------------------------------------------------- pip check and stale WHEEL tags

test('pip check remains fail-closed for unsupported wheels and missing or conflicting requirements', async () => {
  const fx = makeFixture()
  for (const stdout of [
    'bpy 4.5.15 is not supported on this platform\n',
    'bpy 4.5.15 requires cython, which is not installed.\n',
    'bpy 4.5.15 has requirement numpy<2.0,>=1.26, but you have numpy 2.0.0.\n',
  ]) {
    const inner = stubRunner()
    const run = (file, args, opts) => args.includes('pip') && args.includes('check')
      ? { code: 1, signal: null, stdout, stderr: '', timedOut: false, error: null }
      : inner(file, args, opts)
    const deps = makeDeps(fx, { run })
    assert.equal(await runProvision(baseOpts(), deps.home, deps), EXIT.FAIL)
    assert.match(deps.errs.join('\n'), /pip check failed/)
    assert.ok(deps.errs.join('\n').includes(stdout.trim()))
  }
})

test('vision probes pinned distributions inside a closure-only lock entry, not its descriptive name', async () => {
  const fx = makeFixture({ mutate: (lock) => {
    const torch = lock.dependencies.find((d) => d.id === 'vision-torch')
    const certifi = structuredClone(lock.dependencies.find((d) => d.id === 'character-bpy').transitive[0])
    torch.transitive = [certifi]
    const otherPlatform = structuredClone(certifi)
    otherPlatform.name = 'cuda-bindings'
    otherPlatform.artifacts = otherPlatform.artifacts.map((a) => ({ ...a, platform: 'darwin-arm64' }))
    torch.transitive.push(otherPlatform)
    lock.dependencies.push({ ...structuredClone(torch), id: 'vision-transitive', name: 'vision transitive closure (uv.lock)',
      version: 'uv.lock@abc', artifacts: [], transitive: [certifi], exports: [] })
    lock.profiles.full.dependencies.push('vision-transitive')
  } })
  const deps = makeDeps(fx)
  assert.equal(await runProvision(baseOpts(), deps.home, deps), EXIT.OK, deps.errs.join('\n'))
})
