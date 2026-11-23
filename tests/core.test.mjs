import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { validateCorePin, validatePluginsLock } from '../bin/runtime/locks.mjs'
import { ROOT, gitIn, makeCoreSource, copyCli, coreInsteadOf } from './core-fixture.mjs'

const read = name => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'))

// A sandbox whose https://github.com/img2threejs/img2threejs resolves to a local fixture repo (Git insteadOf),
// and a copy of the CLI whose lock pins the fixture's first commit. No network, no real HOME.
function sandbox(t, { commits = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'img2-core-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home'), H = path.join(home, '.img2')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const base = {
    ...process.env, HOME: home, IMG2_HOME: H, XDG_CONFIG_HOME: path.join(home, '.config'), NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'no-git-config'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  }
  delete base.IMG2THREEJS_HOME
  const { source, shas } = makeCoreSource(root, base, commits)
  const env = { ...base, GIT_CONFIG_COUNT: '1', ...coreInsteadOf(source, 0) }
  const cli = copyCli(root, shas[0])
  const sb = { root, home, H, env, source, shas, bin: path.join(cli, 'bin/img2.mjs'), cli }
  sb.run = (args, over = {}) => spawnSync(process.execPath, [sb.bin, ...args], { env: { ...env, ...over }, encoding: 'utf8', timeout: 60_000 })
  sb.pin = sha => {
    const lock = JSON.parse(fs.readFileSync(path.join(cli, 'plugins.lock.json'), 'utf8'))
    lock.core.commit = sha
    fs.writeFileSync(path.join(cli, 'plugins.lock.json'), JSON.stringify(lock))
  }
  return sb
}

const link = sb => path.join(sb.home, '.claude/skills/img2threejs')

test('the committed core pin is a full origin SHA on the core repo and the validator holds it to that', () => {
  assert.deepEqual(validateCorePin(read('plugins.lock.json').core), [])
  assert.deepEqual(validatePluginsLock(read('plugins.lock.json'), read('catalog.json')), [])
  const good = read('plugins.lock.json').core
  assert.match(validateCorePin(undefined).join(), /required/)
  assert.match(validateCorePin({ ...good, commit: 'main' }).join(), /40-hex/)
  assert.match(validateCorePin({ ...good, repo: 'https://github.com/evil/core' }).join(), /repo must be/)
  assert.match(validateCorePin({ ...good, id: 'other' }).join(), /id must be/)
  assert.match(validateCorePin({ ...good, branch: '' }).join(), /branch is required/)
  assert.match(validateCorePin({ ...good, pinState: 'unpushed-local', note: 'pinned' }).join(), /must say so/)
  const lock = read('plugins.lock.json'); delete lock.core
  assert.match(validatePluginsLock(lock, read('catalog.json')).join(), /core pin is required/)
})

test('install checks the core out at the exact pin, verifies it, links it into the host and keeps it on repeat', t => {
  const sb = sandbox(t)
  let r = sb.run(['install', '--from', ROOT, '--yes'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const core = path.join(sb.H, 'core')
  assert.equal(gitIn(core, ['rev-parse', 'HEAD'], sb.env), sb.shas[0])
  assert.equal(fs.readFileSync(path.join(core, 'forge/route.py'), 'utf8'), '# router v0\n')
  assert.equal(fs.realpathSync(link(sb)), fs.realpathSync(core))
  assert.match(r.stdout, /Core cloned at /)
  const receipts = JSON.parse(fs.readFileSync(path.join(sb.H, 'receipts.json'), 'utf8'))
  assert.ok(receipts.some(e => e.plugin === 'core' && e.target === link(sb)))
  r = sb.run(['install', '--from', ROOT, '--yes'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /Core kept at /)
})

test('core-path prints where route.py lives, as plain text and as JSON, and fails when there is no core', t => {
  const sb = sandbox(t)
  let r = sb.run(['core-path'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no core router at/)
  assert.equal(sb.run(['install', '--from', ROOT, '--yes']).status, 0)
  r = sb.run(['core-path'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, path.join(sb.H, 'core/forge/route.py') + '\n')
  const json = JSON.parse(sb.run(['core-path', '--json']).stdout)
  assert.deepEqual(json, { core: path.join(sb.H, 'core'), route: path.join(sb.H, 'core/forge/route.py'), commit: sb.shas[0], python: null })
})

test('a foreign host link is refused before any download and nothing is cloned', t => {
  const sb = sandbox(t)
  fs.mkdirSync(path.dirname(link(sb)), { recursive: true })
  const foreign = path.join(sb.root, 'other-skill')
  fs.mkdirSync(foreign)
  fs.symlinkSync(foreign, link(sb))
  const r = sb.run(['install', '--from', ROOT, '--yes'])
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr + r.stdout, /foreign symlink/)
  assert.equal(fs.existsSync(path.join(sb.H, 'core')), false)
  assert.equal(fs.readlinkSync(link(sb)), foreign)
})

test('a core behind its pin is advanced; a dirty or foreign-origin core is never overwritten', t => {
  const sb = sandbox(t, { commits: 2 })
  assert.equal(sb.run(['install', '--from', ROOT, '--yes']).status, 0)
  const core = path.join(sb.H, 'core')
  sb.pin(sb.shas[1])
  let r = sb.run(['install', '--from', ROOT, '--yes'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /Core updated at /)
  assert.equal(gitIn(core, ['rev-parse', 'HEAD'], sb.env), sb.shas[1])
  fs.writeFileSync(path.join(core, 'forge/route.py'), '# local edit\n')
  sb.pin(sb.shas[0])
  r = sb.run(['install', '--from', ROOT, '--yes'])
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr + r.stdout, /dirty core checkout/)
  assert.equal(fs.readFileSync(path.join(core, 'forge/route.py'), 'utf8'), '# local edit\n')
  gitIn(core, ['checkout', '-q', '--', '.'], sb.env)
  gitIn(core, ['remote', 'set-url', 'origin', 'https://example.test/else'], sb.env)
  r = sb.run(['install', '--from', ROOT, '--yes'])
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr + r.stdout, /has origin/)
})

test('doctor warns when the core is absent and fails on a wrong commit, a missing router or a broken host link', t => {
  const sb = sandbox(t)
  assert.equal(sb.run(['install', '--from', ROOT, '--yes', '--no-core']).status, 0)
  let r = sb.run(['doctor', '--json'])
  let report = JSON.parse(r.stdout)
  assert.equal(report.fails, 0, r.stdout)
  assert.ok(report.findings.some(f => f.plugin === 'core' && f.level === 'WARN' && /not installed/.test(f.message)))

  assert.equal(sb.run(['install', '--from', ROOT, '--yes']).status, 0)
  r = sb.run(['doctor', '--json'])
  report = JSON.parse(r.stdout)
  assert.equal(report.fails, 0, r.stdout)
  assert.ok(report.findings.some(f => f.plugin === 'core' && f.level === 'INFO' && /pinned/.test(f.message)))

  fs.unlinkSync(link(sb))
  report = JSON.parse(sb.run(['doctor', '--json']).stdout)
  assert.ok(report.findings.some(f => f.plugin === 'core' && f.level === 'FAIL' && /link missing/.test(f.message)), JSON.stringify(report))
  assert.equal(sb.run(['install', '--from', ROOT, '--yes']).status, 0)

  sb.pin('f'.repeat(40))
  report = JSON.parse(sb.run(['doctor', '--json']).stdout)
  assert.ok(report.findings.some(f => f.plugin === 'core' && f.level === 'FAIL' && /not the pinned/.test(f.message)), JSON.stringify(report))
})

test('install --offline-style absence: setup refuses a missing core offline before any mutation', t => {
  const sb = sandbox(t)
  const r = sb.run(['setup', '--offline', '--home', sb.H])
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.equal(fs.existsSync(sb.H), false)
})

test('the router-input record carries exactly what the core route_one.py loader needs, from the installed home', async t => {
  const sb = sandbox(t)
  assert.equal(sb.run(['install', '--from', ROOT, '--yes']).status, 0)
  const { writeProvisionRecord } = await import('../bin/img2.mjs')
  const file = writeProvisionRecord(sb.H, { python: { path: '/py/python3', version: '3.11.9', managed: true }, lockDigest: 'd'.repeat(64) })
  assert.equal(file, path.join(sb.H, 'provision.json'))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  const harness = path.join(sb.H, 'harness')
  assert.equal(record.status, 'ok')
  assert.equal(record.img2Home, sb.H)
  assert.equal(record.pins.harnessRoot, harness)
  assert.equal(record.pins.harnessExecutable, path.join(harness, 'bin/img2.mjs'))
  assert.equal(record.pins.harnessSha, gitIn(harness, ['rev-parse', 'HEAD'], sb.env))
  assert.match(record.pins.harnessExecutableSha256, /^[0-9a-f]{64}$/)
  assert.equal(record.pins.node, fs.realpathSync(process.execPath))
  assert.deepEqual(record.core, { dir: path.join(sb.H, 'core'), route: path.join(sb.H, 'core/forge/route.py'), commit: sb.shas[0] })
  assert.deepEqual(record.python, { path: '/py/python3', version: '3.11.9', managed: true })
  assert.deepEqual(record.pins.plugins, {})
})
