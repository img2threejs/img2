// `img2 route` / `img2 core-run` (bin/route.mjs): offline, fixture-based. The "python" is a shell script that
// reports the argv and environment it was started with, so the tests see exactly what the core would see.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildRouteEnv, ensureRouteInterpreter, findPillowEnv, loadRouteRecord, prepareCoreRun, resolveCoreScript, withHarnessPins } from '../bin/route.mjs'
import { Refusal } from '../bin/runtime/errors.mjs'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'img2.mjs')
const DIGEST = 'a'.repeat(64)
const SHA = 'b'.repeat(40)
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const FAKE_PYTHON = `#!/bin/sh
if [ "$1" = "-I" ]; then echo 11.3.0; exit 0; fi
echo "ARGV:$*"
echo "PATH:$PATH"
echo "IMG2_HOME:$IMG2_HOME"
echo "IMG2_HARNESS_DIR:$IMG2_HARNESS_DIR"
echo "PYTHONPATH:\${PYTHONPATH-unset}"
echo "OTHER:\${PIP_INDEX_URL-unset}\${NODE_OPTIONS-unset}\${SECRET_TOKEN-unset}"
echo "KEY:\${TYPESAFE_API_KEY-unset}"
`

// A canonical home as setup leaves it: provision.json, runtime/provision.json, a managed python, a jev env with PIL.
function fixture(t, { pillow = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'img2-route-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const H = path.join(root, 'home', '.img2')
  const rt = path.join(H, 'runtime', DIGEST.slice(0, 12))
  const pyBin = path.join(rt, 'runtime', 'python-runtime', 'bin')
  fs.mkdirSync(pyBin, { recursive: true })
  const python = path.join(pyBin, 'python3')
  fs.writeFileSync(python, FAKE_PYTHON, { mode: 0o755 })
  fs.mkdirSync(path.join(H, 'core', 'forge'), { recursive: true })
  fs.writeFileSync(path.join(H, 'core', 'forge', 'route.py'), '# router\n')
  fs.writeFileSync(path.join(H, 'core', 'forge', 'preflight.py'), '# preflight\n')
  const hd = path.join(H, 'harness')
  fs.mkdirSync(path.join(hd, 'bin'), { recursive: true })
  const launcher = path.join(hd, 'bin', 'img2.mjs')
  fs.writeFileSync(launcher, '// launcher\n')
  const venv = path.join(rt, 'jev', 'venv')
  const site = path.join(venv, 'lib', 'python3.11', 'site-packages')
  fs.mkdirSync(path.join(site, ...(pillow ? ['PIL'] : [])), { recursive: true })
  fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = ' + pyBin + '\ninclude-system-site-packages = false\nversion = 3.11.18\n')
  const nodeDir = path.join(root, 'nodebin')
  fs.mkdirSync(nodeDir)
  fs.writeFileSync(path.join(nodeDir, 'node'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(H, 'provision.json'), JSON.stringify({
    kind: 'img2.setup-provision', version: 1, status: 'ok', img2Home: H, lockDigest: DIGEST,
    python: { path: python, version: '3.11.18', managed: true },
    core: { dir: path.join(H, 'core'), route: path.join(H, 'core', 'forge', 'route.py'), commit: SHA },
    pins: { harnessSha: SHA, harnessRoot: hd, harnessExecutable: launcher, harnessExecutableSha256: sha256(fs.readFileSync(launcher)), node: path.join(nodeDir, 'node'), nodeSha256: 'c'.repeat(64), plugins: {} },
  }))
  fs.writeFileSync(path.join(H, 'runtime', 'provision.json'), JSON.stringify({
    schema: 2, status: 'ok', lockDigest: DIGEST,
    units: [{ name: 'jev', probes: [{ id: 'pillow-image-op', dependency: 'jev-pillow', status: 'pass' }] }],
  }))
  const blenderDir = path.join(root, 'blenderbin')
  fs.mkdirSync(blenderDir)
  fs.writeFileSync(path.join(blenderDir, 'blender'), '#!/bin/sh\n', { mode: 0o755 })
  return { root, H, rt, python, pyBin, site, hd, launcher, nodeDir, blenderDir }
}

const probeOk = () => ({ code: 0, stdout: '11.3.0\n', stderr: '' })

test('PATH order: managed python dir, pinned node, the user blender dir, user dirs, then system dirs; relative entries dropped', t => {
  const fx = fixture(t)
  const userBin = path.join(fx.root, 'usr-bin')
  const { env, blender } = buildRouteEnv(loadRouteRecord(fx.H), { PATH: ['rel/bin', userBin, fx.blenderDir, '/usr/bin'].join(path.delimiter), HOME: '/h' })
  const parts = env.PATH.split(path.delimiter)
  assert.deepEqual(parts.slice(0, 4), [fx.pyBin, fx.nodeDir, fx.blenderDir, userBin])
  assert.deepEqual(parts.slice(4), ['/usr/bin', '/bin', '/usr/sbin', '/sbin'], 'no duplicates, no relative entry')
  assert.equal(blender, path.join(fx.blenderDir, 'blender'))
})

test('no blender on PATH is reported, not invented', t => {
  const fx = fixture(t)
  const { blender, env } = buildRouteEnv(loadRouteRecord(fx.H), { PATH: '/usr/bin' })
  assert.equal(blender, null)
  assert.ok(!env.PATH.includes('blenderbin'))
})

test('the child environment is minimal: no PYTHONPATH, pip, node options or unrelated secrets; the credential override passes', t => {
  const fx = fixture(t)
  const { env } = buildRouteEnv(loadRouteRecord(fx.H), {
    PATH: '/usr/bin', HOME: '/h', LANG: 'en_US.UTF-8', LC_ALL: 'C', PYTHONPATH: '/evil', PYTHONHOME: '/evil', PYTHONSTARTUP: '/evil.py',
    PIP_INDEX_URL: 'https://evil', NODE_OPTIONS: '--require /evil', SECRET_TOKEN: 'hunter2', AWS_SECRET_ACCESS_KEY: 'x', TYPESAFE_API_KEY: 'k',
  })
  for (const k of ['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PIP_INDEX_URL', 'NODE_OPTIONS', 'SECRET_TOKEN', 'AWS_SECRET_ACCESS_KEY']) assert.equal(env[k], undefined, k)
  assert.equal(env.HOME, '/h')
  assert.equal(env.LC_ALL, 'C')
  assert.equal(env.TYPESAFE_API_KEY, 'k')
  assert.equal(env.PYTHONNOUSERSITE, '1')
})

test('IMG2_HOME is canonical (an aliased path resolves) and IMG2_HARNESS_DIR comes from the pins', t => {
  const fx = fixture(t)
  const alias = path.join(fx.root, 'alias')
  fs.symlinkSync(fx.H, alias)
  const loaded = loadRouteRecord(alias)
  assert.equal(loaded.home, fx.H)
  const { env } = buildRouteEnv(loaded, { PATH: '/usr/bin' })
  assert.equal(env.IMG2_HOME, fx.H)
  assert.equal(env.IMG2_HARNESS_DIR, fx.hd)
})

test('harness pins come from provision.json unless the caller supplied them (either spelling)', t => {
  const fx = fixture(t)
  const { pins } = loadRouteRecord(fx.H).record
  const got = withHarnessPins(['--workspace', 'w', '--run-id', 'r'], pins)
  assert.deepEqual(got.slice(4), ['--harness-root', fx.hd, '--harness-sha', SHA, '--harness-executable', fx.launcher, '--harness-sha256', pins.harnessExecutableSha256])
  const own = withHarnessPins(['--harness-sha=' + 'd'.repeat(40), '--harness-root', '/mine'], pins)
  assert.ok(!own.includes('--harness-sha') && own.includes('--harness-sha=' + 'd'.repeat(40)), 'caller sha kept, not duplicated')
  assert.equal(own.filter((a) => a === '--harness-root').length, 1)
  assert.ok(own.includes('--harness-executable') && own.includes('--harness-sha256'))
})

test('a missing, malformed, failed, foreign or tampered provision record is refused with the remedy and nothing is run', t => {
  const fx = fixture(t)
  const file = path.join(fx.H, 'provision.json')
  const good = fs.readFileSync(file, 'utf8')
  const refuses = (pattern) => assert.throws(() => prepareCoreRun({ kind: 'route', args: [], home: fx.H, probe: probeOk }),
    (e) => e instanceof Refusal && pattern.test(e.message + ' ' + e.detail))
  fs.rmSync(file)
  refuses(/provision\.json is missing[\s\S]*img2 setup/)
  fs.writeFileSync(file, '{not json')
  refuses(/not valid JSON/)
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(good), status: 'failed' }))
  refuses(/status is "failed"/)
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(good), img2Home: '/somewhere/else' }))
  refuses(/written for \/somewhere\/else/)
  const bad = JSON.parse(good); delete bad.pins.harnessSha
  fs.writeFileSync(file, JSON.stringify(bad))
  refuses(/harness pins are incomplete/)
  fs.writeFileSync(file, good)
  fs.writeFileSync(fx.launcher, '// tampered\n')
  refuses(/launcher differs from the setup pin/)
  assert.ok(!fs.existsSync(path.join(fx.rt, 'route-python')), 'no interpreter was built for any refusal')
  assert.throws(() => loadRouteRecord(path.join(fx.root, 'nope')), /IMG2_HOME does not exist/)
})

test('a record without a core checkout is refused', t => {
  const fx = fixture(t)
  fs.rmSync(path.join(fx.H, 'core'), { recursive: true })
  assert.throws(() => loadRouteRecord(fx.H), /no core router at/)
})

test('the Pillow env is found from the runtime record, must be probe-verified and built on the recorded python', t => {
  const fx = fixture(t)
  const loaded = loadRouteRecord(fx.H)
  const found = findPillowEnv(loaded)
  assert.equal(found.unit, 'jev')
  assert.equal(found.site, fs.realpathSync(fx.site))
  const runtimeFile = path.join(fx.H, 'runtime', 'provision.json')
  const doc = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'))
  fs.writeFileSync(runtimeFile, JSON.stringify({ ...doc, units: [{ name: 'jev', probes: [{ dependency: 'jev-pillow', status: 'fail' }] }] }))
  assert.throws(() => findPillowEnv(loaded), (e) => /no provisioned environment has a verified Pillow/.test(e.message) && /no passing Pillow probe/.test(e.detail))
  fs.writeFileSync(runtimeFile, JSON.stringify({ ...doc, lockDigest: 'e'.repeat(64) }))
  assert.throws(() => findPillowEnv(loaded), /does not describe the runtime this setup record names/)
  fs.writeFileSync(runtimeFile, JSON.stringify(doc))
  fs.writeFileSync(path.join(fx.rt, 'jev', 'venv', 'pyvenv.cfg'), 'home = /usr/bin\n')
  assert.throws(() => findPillowEnv(loaded), (e) => /is not built on/.test(e.detail))
})

test('a Pillow env whose site-packages holds no PIL is refused', t => {
  const fx = fixture(t, { pillow: false })
  assert.throws(() => findPillowEnv(loadRouteRecord(fx.H)), (e) => /no PIL under its site-packages/.test(e.detail))
})

test('the route interpreter is a real copy (not a symlink) whose only extra import path is the verified env', t => {
  const fx = fixture(t)
  const loaded = loadRouteRecord(fx.H)
  const pillow = findPillowEnv(loaded)
  const made = ensureRouteInterpreter(loaded, pillow, { probe: probeOk })
  assert.equal(made.python, path.join(fx.rt, 'route-python', 'bin', 'python3'))
  assert.ok(!fs.lstatSync(made.python).isSymbolicLink(), 'the core resolves symlinks, so a link would resolve back to the Pillow-less base')
  assert.equal(fs.readFileSync(made.python, 'utf8'), FAKE_PYTHON)
  const cfg = fs.readFileSync(path.join(fx.rt, 'route-python', 'pyvenv.cfg'), 'utf8')
  assert.match(cfg, new RegExp('^home = ' + fx.pyBin + '$', 'm'))
  assert.match(cfg, /include-system-site-packages = false/)
  const pth = path.join(fx.rt, 'route-python', 'lib', 'python3.11', 'site-packages', 'img2-route.pth')
  assert.equal(fs.readFileSync(pth, 'utf8'), fs.realpathSync(fx.site) + '\n')
  const ino = fs.statSync(made.python).ino
  assert.equal(ensureRouteInterpreter(loaded, pillow, { probe: probeOk }).python, made.python)
  assert.equal(fs.statSync(made.python).ino, ino, 'unchanged inputs: reused, not rebuilt')
  assert.throws(() => ensureRouteInterpreter(loaded, pillow, { probe: () => ({ code: 1, stdout: '', stderr: 'ModuleNotFoundError: PIL' }) }), /cannot import Pillow/)
})

test('core-run accepts only .py files inside the pinned core', t => {
  const fx = fixture(t)
  const core = path.join(fx.H, 'core')
  assert.equal(resolveCoreScript(core, 'preflight.py'), path.join(core, 'forge', 'preflight.py'))
  assert.equal(resolveCoreScript(core, 'forge/preflight.py'), path.join(core, 'forge', 'preflight.py'))
  for (const bad of ['../../harness/bin/img2.mjs', '/etc/hosts', 'missing.py', '']) assert.throws(() => resolveCoreScript(core, bad), Refusal, bad)
  fs.symlinkSync('/etc/hosts', path.join(core, 'forge', 'link.py'))
  assert.throws(() => resolveCoreScript(core, 'link.py'), /only runs \.py files inside/)
})

// ---------------------------------------------------------------- through the real CLI

function cli(fx, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: { PATH: ['/usr/bin', '/bin'].join(path.delimiter), HOME: path.join(fx.root, 'home'), NO_COLOR: '1', ...env }, encoding: 'utf8', timeout: 30_000,
  })
  assert.ifError(r.error)
  return r
}

test('img2 route runs the core under the route interpreter with the full env and pins, through an aliased IMG2_HOME', t => {
  const fx = fixture(t)
  const alias = path.join(fx.root, 'alias')
  fs.symlinkSync(fx.H, alias)
  const r = cli(fx, ['route', '--workspace', '/ws', '--run-id', 'r1'], {
    IMG2_HOME: alias, PYTHONPATH: '/evil', PIP_INDEX_URL: 'https://evil', NODE_OPTIONS: '--no-warnings', SECRET_TOKEN: 'hunter2',
    TYPESAFE_API_KEY: 'sentinel-key', PATH: [fx.blenderDir, '/usr/bin', '/bin'].join(path.delimiter),
  })
  assert.equal(r.status, 0, r.stderr)
  const lines = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]))
  assert.equal(lines.ARGV, [path.join(fx.H, 'core', 'forge', 'route.py'), '--workspace', '/ws', '--run-id', 'r1',
    '--harness-root', fx.hd, '--harness-sha', SHA, '--harness-executable', fx.launcher, '--harness-sha256', sha256(fs.readFileSync(fx.launcher))].join(' '))
  assert.deepEqual(lines.PATH.split(path.delimiter).slice(0, 3), [fx.pyBin, fx.nodeDir, fx.blenderDir])
  assert.equal(lines.IMG2_HOME, fx.H)
  assert.equal(lines.IMG2_HARNESS_DIR, fx.hd)
  assert.equal(lines.PYTHONPATH, 'unset')
  assert.equal(lines.OTHER, 'unsetunsetunset')
  assert.equal(lines.KEY, 'sentinel-key', 'the credential override reaches the child')
  assert.ok(!r.stdout.includes('hunter2') && !r.stderr.includes('hunter2') && !r.stderr.includes('sentinel-key'), 'no secret in the launcher output')
  assert.match(r.stderr, /blender=.*blenderbin\/blender/)
})

test('img2 route reports a missing blender on stderr and keeps stdout for the router', t => {
  const fx = fixture(t)
  const r = cli(fx, ['route', '--run-id', 'r1'], { IMG2_HOME: fx.H })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /blender not on PATH/)
  assert.ok(r.stdout.startsWith('ARGV:'))
})

test('img2 route refuses without provision.json: exit 2, the remedy, and no interpreter started', t => {
  const fx = fixture(t)
  fs.rmSync(path.join(fx.H, 'provision.json'))
  const r = cli(fx, ['route', '--run-id', 'r1'], { IMG2_HOME: fx.H })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /provision\.json is missing/)
  assert.match(r.stderr, /img2 setup/)
  assert.equal(r.stdout, '')
  assert.ok(!fs.existsSync(path.join(fx.rt, 'route-python')), 'no interpreter was built')
})

test('arguments after the command belong to the router: --home and --help are not consumed by img2', t => {
  const fx = fixture(t)
  const r = cli(fx, ['route', '--help', '--home', '/nowhere', '--yes'], { IMG2_HOME: fx.H })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /ARGV:.*route\.py --help --home \/nowhere --yes --harness-root/)
})

test('img2 --home before the command selects the home', t => {
  const fx = fixture(t)
  const r = cli(fx, ['--home', fx.H, 'route', '--run-id', 'r1'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, new RegExp('IMG2_HOME:' + fx.H.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n'))
})

test('img2 core-run runs another core script with the same environment and no pins added', t => {
  const fx = fixture(t)
  const r = cli(fx, ['core-run', 'preflight.py', '--json'], { IMG2_HOME: fx.H })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.stdout.includes('ARGV:' + path.join(fx.H, 'core', 'forge', 'preflight.py') + ' --json\n'), r.stdout)
  assert.ok(!r.stdout.includes('--harness-root'))
  const bad = cli(fx, ['core-run', '../../harness/bin/img2.mjs'], { IMG2_HOME: fx.H })
  assert.equal(bad.status, 2)
})
