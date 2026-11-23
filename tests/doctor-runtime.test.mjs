import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXIT } from '../bin/runtime/errors.mjs'
import { runDoctorRuntime } from '../bin/runtime/doctor.mjs'
import { numericVersion, tinyGlb } from '../bin/runtime/probes.mjs'
import { runProvision } from '../bin/runtime/provision.mjs'
import { loadLocks } from '../bin/runtime/lock.mjs'
import { baseOpts, makeDeps, makeFixture, stubMcp, stubRunner, tmp } from './runtime-fixtures.mjs'

const BIN = fileURLToPath(new URL('../bin/img2.mjs', import.meta.url))
const provisioned = async (over = {}) => {
  const fx = makeFixture(); const deps = makeDeps(fx, over)
  assert.equal(await runProvision(baseOpts(), deps.home, deps), EXIT.OK)
  return { fx, deps }
}
const doctor = async (fx, deps, over = {}, json = false) => {
  const d = makeDeps(fx, { home: deps.home, ...over })
  const code = await runDoctorRuntime({ home: deps.home, json, deps: d })
  return { code, text: d.lines.join('\n'), d }
}

test('numeric bpy version is extracted from the LTS version string', () => {
  assert.equal(numericVersion('4.5.15 LTS'), '4.5.15')
  assert.equal(numericVersion('4.3.0'), '4.3.0')
})

test('doctor --runtime passes on a healthy runtime and keeps auth and licensed input apart from failures', async () => {
  const { fx, deps } = await provisioned()
  const r = await doctor(fx, deps)
  assert.equal(r.code, EXIT.OK, r.text)
  assert.match(r.text, /PASS +bpy-import \[character-bpy\]\s+bpy 4\.5\.15 \(4\.5\.15 LTS\)/)
  assert.match(r.text, /PASS +bpy-import \[interior-bpy\]\s+bpy 4\.3\.0/)
  assert.match(r.text, /PASS +bpy-export/)
  assert.match(r.text, /PASS +node-three-import/)
  assert.match(r.text, /PASS +chromium-webgl-capture/)
  assert.match(r.text, /PASS +source2viewer-version/)
  assert.match(r.text, /PASS +mcp-initialize-tools-list \[mcp-fake\]\s+fake-mcp 1\.0\.0, 3 tools/)
  assert.match(r.text, /PASS +vision-offline-inference/)
  assert.match(r.text, /AUTH +jev-login/)
  assert.match(r.text, /LICENSED-INPUT +cs2-vpk/)
  assert.match(r.text, /0 failed/)
})

test('doctor --runtime --json is machine readable with counts and per-check fields', async () => {
  const { fx, deps } = await provisioned()
  const r = await doctor(fx, deps, {}, true)
  const j = JSON.parse(r.text)
  assert.equal(j.ok, true)
  assert.equal(j.counts.fail, 0)
  assert.equal(j.counts.auth, 1)
  assert.equal(j.counts['licensed-input'], 1)
  assert.ok(j.checks.every((c) => ['pass', 'fail', 'skipped', 'auth', 'licensed-input'].includes(c.status) && typeof c.id === 'string' && typeof c.expected === 'string'))
  assert.equal(j.checks.find((c) => c.id === 'bpy-import' && c.dependency === 'interior-bpy').actual, 'bpy 4.3.0 (4.3.0 LTS)')
})

test('a Jev key in the environment or Keychain turns the auth condition into a pass; a VPK clears the licensed-input condition', async () => {
  const { fx, deps } = await provisioned()
  const withKey = await doctor(fx, deps, { env: { TYPESAFE_API_KEY: 'k' } })
  assert.match(withKey.text, /AUTH +jev-login/)
  const home = tmp()
  const vpk = path.join(home, '.steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/pak01_dir.vpk')
  fs.mkdirSync(path.dirname(vpk), { recursive: true }); fs.writeFileSync(vpk, '')
  const found = await doctor(fx, deps, { home })
  assert.match(found.text, /PASS +cs2-vpk/)
  assert.equal(found.code, EXIT.OK)
})

test('a broken bpy import is a precise failure with expected/actual/stderr/remedy and a non-zero exit', async () => {
  const { fx, deps } = await provisioned()
  const r = await doctor(fx, deps, { run: stubRunner({ failProbe: ['import bpy'] }) })
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.text, /FAIL +bpy-import \[character-bpy\]/)
  assert.match(r.text, /expected: bpy 4\.5\.15/)
  assert.match(r.text, /actual +: .*exit 1/)
  assert.match(r.text, /stderr +: Traceback: probe exploded/)
  assert.match(r.text, /remedy +: img2 provision/)
  assert.match(r.text, /2 failed|[1-9]\d* failed/)
})

test('a wrong installed version, a missing WebGL context and a silent MCP server are each reported as failures', async () => {
  const { fx, deps } = await provisioned()
  const wrong = await doctor(fx, deps, { run: stubRunner() })
  assert.equal(wrong.code, EXIT.OK)
  const venv = path.join(deps.home, 'runtime', loadLocks(fx.root).lockDigest.slice(0, 12), 'interior', 'venv', 'installed.json')
  fs.writeFileSync(venv, JSON.stringify({ bpy: '4.2.0', numpy: '1.26.4' }))
  const v = await doctor(fx, deps)
  assert.equal(v.code, EXIT.FAIL)
  assert.match(v.text, /FAIL +bpy-import \[interior-bpy\][\s\S]*actual +: bpy 4\.2\.0/)
  fs.writeFileSync(venv, JSON.stringify({ bpy: '4.3.0', numpy: '1.26.4' }))
  const gl = await doctor(fx, deps, { run: stubRunner({ webgl: false }) })
  assert.equal(gl.code, EXIT.FAIL)
  assert.match(gl.text, /FAIL +chromium-webgl-capture[\s\S]*no WebGL context/)
  const mcp = await doctor(fx, deps, { mcp: stubMcp({ 'fake-mcp': { ok: false, error: 'no reply within 60000 ms', stderr: 'boom' } }) })
  assert.equal(mcp.code, EXIT.FAIL)
  assert.match(mcp.text, /FAIL +mcp-initialize-tools-list[\s\S]*no reply within 60000 ms/)
})

test('a unit missing from disk fails with where it should have been; skipped dependencies are listed, not failed', async () => {
  const fx = makeFixture(); const deps = makeDeps(fx)
  await runProvision(baseOpts({ skip: ['mcp-fake'] }), deps.home, deps)
  const ok = await doctor(fx, deps)
  assert.equal(ok.code, EXIT.OK)
  assert.match(ok.text, /SKIP +skipped \[mcp-fake\]/)
  fs.rmSync(path.join(deps.home, 'runtime', loadLocks(fx.root).lockDigest.slice(0, 12), 'cs2'), { recursive: true })
  const gone = await doctor(fx, deps)
  assert.equal(gone.code, EXIT.FAIL)
  assert.match(gone.text, /FAIL +source2viewer-version \[cs2-source2viewer-cli\][\s\S]*not installed/)
})

test('doctor --runtime without a provision, or against a different lock, fails rather than guessing', async () => {
  const fx = makeFixture(); const bare = makeDeps(fx)
  const none = await doctor(fx, bare)
  assert.equal(none.code, EXIT.FAIL)
  assert.match(none.text, /no provision\.json/)
  const { deps } = await provisioned()
  const other = makeFixture({ mutate: (lock) => { lock.generatedAt = 'changed' } })
  const stale = await doctor(other, deps)
  assert.equal(stale.code, EXIT.FAIL)
  assert.match(stale.text, /differs from the installed harness lock/)
})

test('doctor rejects selectors whose pluginsLockDigest is stale, as the core reader does', async () => {
  const { fx, deps } = await provisioned()
  const file = path.join(deps.home, 'runtime', 'selectors.json')
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...doc, pluginsLockDigest: 'f'.repeat(64) })); fs.chmodSync(file, 0o600)
  const r = await doctor(fx, deps)
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.text, /FAIL +selectors[\s\S]*pluginsLockDigest/)
})

test('a tampered selectors.json (escaping path, loose mode) fails the selectors check', async () => {
  const { fx, deps } = await provisioned()
  const file = path.join(deps.home, 'runtime', 'selectors.json')
  fs.chmodSync(file, 0o644)
  const r = await doctor(fx, deps)
  assert.equal(r.code, EXIT.FAIL)
  assert.match(r.text, /FAIL +selectors[\s\S]*mode is 644/)
})

test('the tiny GLB used by the validator probe is a well-formed glTF 2.0 binary', () => {
  const b = tinyGlb()
  assert.equal(b.readUInt32LE(0), 0x46546c67)
  assert.equal(b.readUInt32LE(4), 2)
  assert.equal(b.readUInt32LE(8), b.length)
  const jsonLen = b.readUInt32LE(12)
  assert.equal(b.readUInt32LE(16), 0x4e4f534a)
  assert.equal(JSON.parse(b.toString('utf8', 20, 20 + jsonLen)).asset.version, '2.0')
  assert.equal(b.length % 4, 0)
})

test('the real CLI: doctor --runtime on an empty home fails with exit 1 and a remedy', () => {
  const home = tmp()
  const r = spawnSync(process.execPath, [BIN, 'doctor', '--runtime'], { env: { ...process.env, IMG2_HOME: home }, encoding: 'utf8' })
  assert.equal(r.status, 1, r.stderr + r.stdout)
  assert.match(r.stdout, /FAIL +provision/)
  assert.match(r.stdout, /remedy +: img2 provision/)
  const j = spawnSync(process.execPath, [BIN, 'doctor', '--runtime', '--json'], { env: { ...process.env, IMG2_HOME: home }, encoding: 'utf8' })
  assert.equal(j.status, 1)
  assert.equal(JSON.parse(j.stdout).ok, false)
  assert.deepEqual(fs.readdirSync(home), [])
})
