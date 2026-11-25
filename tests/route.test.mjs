// `img2 route` / `img2 core-run` (bin/route.mjs): offline, fixture-based. The "python" is a shell script that
// reports the argv and environment it was started with, so the tests see exactly what the core would see.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
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
function fixture(t, { pillow = true, digest = DIGEST } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'img2-route-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const H = path.join(root, 'home', '.img2')
  const rt = path.join(H, 'runtime', digest.slice(0, 12))
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
    kind: 'img2.setup-provision', version: 1, status: 'ok', img2Home: H, lockDigest: digest,
    python: { path: python, version: '3.11.18', managed: true },
    core: { dir: path.join(H, 'core'), route: path.join(H, 'core', 'forge', 'route.py'), commit: SHA },
    pins: { harnessSha: SHA, harnessRoot: hd, harnessExecutable: launcher, harnessExecutableSha256: sha256(fs.readFileSync(launcher)), node: path.join(nodeDir, 'node'), nodeSha256: sha256(fs.readFileSync(path.join(nodeDir, 'node'))), plugins: {} },
  }))
  fs.writeFileSync(path.join(H, 'runtime', 'provision.json'), JSON.stringify({
    schema: 2, status: 'ok', lockDigest: digest,
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

const routeDir = (fx) => path.join(fx.rt, 'route-python')
const routePth = (fx) => path.join(routeDir(fx), 'lib', 'python3.11', 'site-packages', 'img2-route.pth')

test('a Pillow site that is not one canonical single-line directory inside the runtime is never written to a .pth', t => {
  const fx = fixture(t)
  const loaded = loadRouteRecord(fx.H)
  const pillow = findPillowEnv(loaded)
  const outside = path.join(fx.root, 'outside')
  fs.mkdirSync(outside)
  const nl = path.join(fx.rt, 'jev', 'x\nimport os')
  fs.mkdirSync(nl)
  const evil = [
    '/x\nimport os; os.system("touch /tmp/pwned")', '/x\rimport os', '/x\0y', '/x\timport os', 'import os', '#' + pillow.site,
    'relative/site-packages', outside, fx.rt, fx.rt + '/jev/venv/../venv/lib/python3.11/site-packages', nl,
  ]
  for (const site of evil) {
    assert.throws(() => ensureRouteInterpreter(loaded, { ...pillow, site }, { probe: probeOk }), (e) => e instanceof Refusal && /Pillow site-packages/.test(e.message), JSON.stringify(site))
    assert.ok(!fs.existsSync(routeDir(fx)), 'nothing was built for ' + JSON.stringify(site))
  }
  ensureRouteInterpreter(loaded, pillow, { probe: probeOk })
  assert.equal(fs.readFileSync(routePth(fx), 'utf8'), fs.realpathSync(fx.site) + '\n', 'exactly one line, the verified site')
})

test('python.version is validated and pyvenv.cfg comes from a fixed template', t => {
  const fx = fixture(t)
  const loaded = loadRouteRecord(fx.H)
  const pillow = findPillowEnv(loaded)
  for (const version of ['3.11.18\ninclude-system-site-packages = true', '3.11', '3.11.18 ', 'x.y.z', 3.11, undefined, '3.11.18\r\n']) {
    const record = { ...loaded.record, python: { ...loaded.record.python, version, extra: 'home = /evil' } }
    assert.throws(() => ensureRouteInterpreter({ ...loaded, record }, pillow, { probe: probeOk }), (e) => e instanceof Refusal && /MAJOR\.MINOR\.PATCH/.test(e.message), JSON.stringify(version))
    assert.ok(!fs.existsSync(routeDir(fx)))
  }
  ensureRouteInterpreter(loaded, pillow, { probe: probeOk })
  assert.equal(fs.readFileSync(path.join(routeDir(fx), 'pyvenv.cfg'), 'utf8'), 'home = ' + fx.pyBin + '\ninclude-system-site-packages = false\nversion = 3.11.18\n')
})

test('a cached route-python whose pyvenv.cfg or .pth was altered is rebuilt even though the stamp still matches', t => {
  const fx = fixture(t)
  const loaded = loadRouteRecord(fx.H)
  const pillow = findPillowEnv(loaded)
  ensureRouteInterpreter(loaded, pillow, { probe: probeOk })
  const cfgFile = path.join(routeDir(fx), 'pyvenv.cfg')
  const cfg = fs.readFileSync(cfgFile, 'utf8')
  const pth = fs.readFileSync(routePth(fx), 'utf8')
  fs.writeFileSync(cfgFile, cfg.replace('= false', '= true'))
  ensureRouteInterpreter(loaded, pillow, { probe: probeOk })
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), cfg, 'pyvenv.cfg restored')
  fs.writeFileSync(routePth(fx), pth + 'import os\n')
  ensureRouteInterpreter(loaded, pillow, { probe: probeOk })
  assert.equal(fs.readFileSync(routePth(fx), 'utf8'), pth, '.pth restored')
})

test('a digest directory that is a symlink out of the runtime tree is refused', t => {
  const fx = fixture(t)
  const loaded = loadRouteRecord(fx.H)
  const outside = path.join(fx.root, 'elsewhere')
  fs.renameSync(fx.rt, outside)
  fs.symlinkSync(outside, fx.rt)
  assert.throws(() => findPillowEnv(loaded), (e) => e instanceof Refusal && /not a real directory inside/.test(e.message))
})

test('a Pillow site-packages that is a symlink out of the runtime tree is refused', t => {
  const fx = fixture(t)
  const loaded = loadRouteRecord(fx.H)
  const outside = path.join(fx.root, 'outside-site')
  fs.mkdirSync(path.join(outside, 'PIL'), { recursive: true })
  fs.rmSync(fx.site, { recursive: true })
  fs.symlinkSync(outside, fx.site)
  assert.throws(() => findPillowEnv(loaded), (e) => /no PIL under its site-packages/.test(e.detail))
})

test('a recorded node that is missing or not executable is refused, never replaced by the ambient PATH node', t => {
  const fx = fixture(t)
  const node = path.join(fx.nodeDir, 'node')
  const host = { PATH: [path.dirname(process.execPath), '/usr/bin'].join(path.delimiter) }
  fs.chmodSync(node, 0o644)
  assert.throws(() => buildRouteEnv(loadRouteRecord(fx.H), host), (e) => e instanceof Refusal && /does not exist or is not executable/.test(e.message) && /img2 setup/.test(e.detail))
  fs.rmSync(node)
  assert.throws(() => buildRouteEnv(loadRouteRecord(fx.H), host), (e) => e instanceof Refusal && /does not exist or is not executable/.test(e.message))
})

test('a recorded node whose sha256 differs from the pin is refused; a matching one is used', t => {
  const fx = fixture(t)
  const node = path.join(fx.nodeDir, 'node')
  assert.equal(buildRouteEnv(loadRouteRecord(fx.H), { PATH: '/usr/bin' }).env.PATH.split(path.delimiter)[1], fx.nodeDir)
  fs.writeFileSync(node, '#!/bin/sh\necho swapped\n', { mode: 0o755 })
  assert.throws(() => buildRouteEnv(loadRouteRecord(fx.H), { PATH: '/usr/bin' }), (e) => e instanceof Refusal && /sha256 mismatch/.test(e.message))
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

function onDemandFixture(t, { badPin = false, missingCard = false } = {}) {
  const source = path.resolve(path.dirname(BIN), '..')
  const digest = sha256(fs.readFileSync(path.join(source, 'dependencies.lock.json')))
  const fx = fixture(t, { digest })
  const env = { HOME: path.dirname(fx.H), IMG2_HOME: fx.H, PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', NO_COLOR: '1' }
  const git = (cwd, args) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  const work = path.join(fx.root, 'plugin-source'), origins = path.join(fx.root, 'origins')
  fs.mkdirSync(work); fs.mkdirSync(origins)
  git(work, ['init', '-q'])
  fs.writeFileSync(path.join(work, 'plugin.json'), JSON.stringify({ schema: 1, name: 'interior', version: '0.1.0',
    description: 'fixture', capabilities: [{ from: 'image', to: 'interior-scene-candidate' }], requires: { harness: '>=0.6.0', coreApi: 1 } }))
  fs.writeFileSync(path.join(work, 'SKILL.md'), '# Fixture\n')
  fs.writeFileSync(path.join(work, '.gitignore'), '_img2_local.py\n')
  const rawCard = JSON.stringify({ kind: 'img2.route-card', version: 1, outputKind: '3d-scene', costClass: 'local',
    requires: { roles: ['scene-container'], observations: { enclosure: ['enclosed-room'], roomCount: [1] } },
    notFor: { observations: { roomCount: ['>1'] } }, deps: [] })
  if (!missingCard) fs.writeFileSync(path.join(work, 'route.json'), rawCard)
  git(work, ['add', '.']); git(work, ['commit', '-qm', 'pinned producer'])
  const pin = badPin ? '0'.repeat(40) : git(work, ['rev-parse', 'HEAD'])
  const origin = path.join(origins, 'plugin-interior.git')
  git(work, ['clone', '--bare', '-q', work, origin])
  // A newer branch tip proves routing installs the lock SHA, not "latest".
  fs.writeFileSync(path.join(work, 'not-the-pin'), 'newer\n')
  git(work, ['add', '.']); git(work, ['commit', '-qm', 'newer unselected source'])
  git(work, ['push', '-q', origin, 'HEAD'])
  fs.cpSync(path.join(source, 'bin'), path.join(fx.hd, 'bin'), { recursive: true })
  for (const name of ['package.json', 'catalog.json', 'plugins.lock.json', 'dependencies.lock.json']) fs.copyFileSync(path.join(source, name), path.join(fx.hd, name))
  const locks = JSON.parse(fs.readFileSync(path.join(fx.hd, 'plugins.lock.json')))
  Object.assign(locks.plugins.find(row => row.id === 'interior'), { commit: pin,
    routing: { schema: 1, commit: pin, routeCardSha256: sha256(rawCard), card: JSON.parse(rawCard) } })
  fs.writeFileSync(path.join(fx.hd, 'plugins.lock.json'), JSON.stringify(locks))
  git(fx.hd, ['init', '-q']); git(fx.hd, ['add', '.']); git(fx.hd, ['commit', '-qm', 'installed harness'])
  const record = JSON.parse(fs.readFileSync(path.join(fx.H, 'provision.json')))
  record.pins.harnessSha = git(fx.hd, ['rev-parse', 'HEAD'])
  record.pins.harnessExecutableSha256 = sha256(fs.readFileSync(fx.launcher))
  fs.writeFileSync(path.join(fx.H, 'provision.json'), JSON.stringify(record))
  fs.writeFileSync(path.join(fx.H, 'runtime/selectors.json'), JSON.stringify({ schema: 1, lockDigest: digest,
    pluginsLockDigest: sha256(fs.readFileSync(path.join(fx.hd, 'plugins.lock.json'))), selectedPlugins: ['interior', 'jev'] }))
  fs.writeFileSync(path.join(fx.H, 'auto-install'), 'fixture consent\n')
  fs.mkdirSync(path.join(env.HOME, '.claude'))
  Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.file://' + origins + '/.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/img2threejs/' })
  fs.writeFileSync(path.join(fx.root, 'objects.json'), JSON.stringify({ kind: 'img2.object-proposals', version: 1,
    objects: [{ objectId: 'room', label: 'ordinary space', role: 'scene-container', observations: { enclosure: 'enclosed-room', roomCount: 1 } }] }))
  const args = ['route', '--workspace', fx.root, '--run-id', 'same-request', '--image', 'room.png',
    '--objects', 'objects.json', '--expected-output', '3d', '--create-children']
  const run = (extra = {}) => spawnSync(process.execPath, [fx.launcher, ...args], { env: { ...env, ...extra }, cwd: fx.root, encoding: 'utf8', timeout: 30_000 })
  const registry = () => JSON.parse(fs.readFileSync(path.join(fx.H, 'plugins.json'))).plugins
  const editLock = mutate => {
    const file = path.join(fx.hd, 'plugins.lock.json'), doc = JSON.parse(fs.readFileSync(file))
    mutate(doc); fs.writeFileSync(file, JSON.stringify(doc))
    git(fx.hd, ['add', '.']); git(fx.hd, ['commit', '-qm', 'fixture lock change'])
    const record = JSON.parse(fs.readFileSync(path.join(fx.H, 'provision.json')))
    record.pins.harnessSha = git(fx.hd, ['rev-parse', 'HEAD'])
    fs.writeFileSync(path.join(fx.H, 'provision.json'), JSON.stringify(record))
    const selectorsFile = path.join(fx.H, 'runtime/selectors.json'), selectors = JSON.parse(fs.readFileSync(selectorsFile))
    selectors.pluginsLockDigest = sha256(fs.readFileSync(file))
    fs.writeFileSync(selectorsFile, JSON.stringify(selectors))
  }
  return { ...fx, env, args, run, pin, registry, origin, editLock }
}

test('route installs an absent trusted plugin at the exact lock pin and continues the same request', t => {
  const fx = onDemandFixture(t)
  assert.equal(fs.existsSync(path.join(fx.H, 'plugins/interior')), false)
  const r = fx.run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fx.registry()[0].resolvedSha, fx.pin)
  assert.match(r.stdout, /ARGV:.*--run-id same-request.*--objects objects.json.*--expected-output 3d.*--create-children/)
  assert.ok(!r.stdout.includes('Installed '), 'installer diagnostics must not corrupt router stdout')
  const record = JSON.parse(fs.readFileSync(path.join(fx.H, 'provision.json')))
  assert.equal(record.pins.plugins.interior.sha, fx.pin)
})

test('an already installed exact route pin is reused with its origin unavailable', t => {
  const fx = onDemandFixture(t)
  assert.equal(fx.run().status, 0)
  const before = fs.readFileSync(path.join(fx.H, 'plugins.json'))
  fs.renameSync(fx.origin, fx.origin + '.unavailable')
  const r = fx.run()
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(fs.readFileSync(path.join(fx.H, 'plugins.json')), before)
  assert.equal(fx.registry().length, 1)
})

test('concurrent route requests install one exact pin and both continue', { timeout: 40_000 }, async t => {
  const fx = onDemandFixture(t)
  const start = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fx.launcher, ...fx.args], { env: fx.env, cwd: fx.root, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    child.once('error', reject); child.once('close', status => resolve({ status, stdout, stderr }))
  })
  const results = await Promise.all([start(), start()])
  for (const r of results) { assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /--run-id same-request/) }
  assert.equal(fx.registry().length, 1)
  assert.equal(fx.registry()[0].resolvedSha, fx.pin)
})

test('failed exact-pin fetch preserves the prior registry and setup receipt', t => {
  const fx = onDemandFixture(t, { badPin: true })
  const previous = fs.readFileSync(path.join(fx.H, 'provision.json'))
  const r = fx.run()
  assert.notEqual(r.status, 0)
  assert.equal(fs.existsSync(path.join(fx.H, 'plugins/interior')), false)
  assert.equal(fs.existsSync(path.join(fx.H, 'plugins.json')), false)
  assert.deepEqual(fs.readFileSync(path.join(fx.H, 'provision.json')), previous)
})

test('late route-install publication failure rolls back registry, links and setup receipt', t => {
  const fx = onDemandFixture(t)
  const previous = fs.readFileSync(path.join(fx.H, 'provision.json'))
  const preload = path.join(fx.root, 'publication-fault.cjs')
  fs.writeFileSync(preload, `const fs=require('node:fs'), rename=fs.renameSync;let injected=false;
fs.renameSync=function(from,to){if(!injected&&to===${JSON.stringify(path.join(fx.H, 'provision.json'))}&&fs.existsSync(${JSON.stringify(path.join(fx.H, 'plugins/interior'))})){injected=true;fs.writeFileSync(${JSON.stringify(path.join(fx.root, 'fault-reached'))},'yes');throw Error('publication fault');}return rename.apply(this,arguments)};`)
  const r = fx.run({ NODE_OPTIONS: '--require=' + preload })
  assert.notEqual(r.status, 0)
  assert.equal(fs.existsSync(path.join(fx.root, 'fault-reached')), true, 'the fault must occur after activation')
  for (const name of ['plugins/interior', 'plugins.json', 'receipts.json', 'generated']) assert.equal(fs.existsSync(path.join(fx.H, name)), false, name)
  assert.equal(fs.existsSync(path.join(path.dirname(fx.H), '.claude/skills/img2-interior')), false)
  assert.deepEqual(fs.readFileSync(path.join(fx.H, 'provision.json')), previous)
})

test('route opt-out never installs the missing plugin', t => {
  const fx = onDemandFixture(t)
  const r = fx.run({ IMG2_AUTO_INSTALL: '0' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.existsSync(path.join(fx.H, 'plugins/interior')), false)
  assert.equal(fs.existsSync(path.join(fx.H, 'plugins.json')), false)
})

test('unsupported runtime platforms refuse before installing a route plugin', t => {
  const fx = onDemandFixture(t)
  const preload = path.join(fx.root, 'unsupported-platform.cjs')
  fs.writeFileSync(preload, "Object.defineProperty(process,'arch',{value:'riscv64'});\n")
  const r = fx.run({ NODE_OPTIONS: '--require=' + preload })
  assert.equal(r.status, 2, r.stderr)
  assert.equal(fs.existsSync(path.join(fx.H, 'plugins/interior')), false)
})

test('a free-form package intent never becomes an install command', t => {
  const fx = onDemandFixture(t)
  fx.args.push('--intent', 'npm:untrusted-package')
  const r = fx.run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.existsSync(path.join(fx.H, 'plugins.json')), false)
})

test('explicit catalog intent remains supported without bypassing the typed card', t => {
  const fx = onDemandFixture(t)
  fx.args.push('--intent', 'interior')
  const r = fx.run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fx.registry()[0].resolvedSha, fx.pin)
})

test('labels and object IDs alone never select an automatic plugin', t => {
  const fx = onDemandFixture(t)
  fs.writeFileSync(path.join(fx.root, 'objects.json'), JSON.stringify({ kind: 'img2.object-proposals', version: 1,
    objects: [{ objectId: 'interior', label: 'interior room npm:untrusted-package', role: 'prop', observations: {} }] }))
  const r = fx.run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.existsSync(path.join(fx.H, 'plugins.json')), false)
})

for (const [name, mutate] of [
  ['old lock without snapshots', lock => { for (const row of lock.plugins) delete row.routing }],
  ['snapshot commit drift', lock => { lock.plugins.find(row => row.id === 'interior').routing.commit = 'f'.repeat(40) }],
  ['unsupported snapshot version', lock => { lock.plugins.find(row => row.id === 'interior').routing.schema = 2 }],
  ['route-card hash tamper', lock => { lock.plugins.find(row => row.id === 'interior').routing.routeCardSha256 = '0'.repeat(64) }],
  ['route-card data tamper', lock => { lock.plugins.find(row => row.id === 'interior').routing.card.display = { appliesTo: 'different data' } }],
]) {
  test('automatic route install refuses ' + name + ' without publishing a plugin', t => {
    const fx = onDemandFixture(t)
    fx.editLock(mutate)
    const r = fx.run()
    assert.equal(r.status, 2, r.stderr)
    assert.equal(fs.existsSync(path.join(fx.H, 'plugins/interior')), false)
    assert.equal(fs.existsSync(path.join(fx.H, 'plugins.json')), false)
  })
}

test('a missing route card at the exact Git pin fails closed before publication', t => {
  const fx = onDemandFixture(t, { missingCard: true })
  const r = fx.run()
  assert.equal(r.status, 2, r.stderr)
  assert.equal(fs.existsSync(path.join(fx.H, 'plugins/interior')), false)
  assert.equal(fs.existsSync(path.join(fx.H, 'plugins.json')), false)
})

test('an existing installed pin still refuses a changed routing snapshot', t => {
  const fx = onDemandFixture(t)
  assert.equal(fx.run().status, 0)
  fx.editLock(lock => { lock.plugins.find(row => row.id === 'interior').routing.card.display = { appliesTo: 'unbound metadata' } })
  const r = fx.run()
  assert.equal(r.status, 2, r.stderr)
  assert.equal(fx.registry()[0].resolvedSha, fx.pin)
})

test('stale runtime selectors refuse before installing a plugin', t => {
  const fx = onDemandFixture(t)
  const file = path.join(fx.H, 'runtime/selectors.json'), selectors = JSON.parse(fs.readFileSync(file))
  selectors.pluginsLockDigest = '0'.repeat(64)
  fs.writeFileSync(file, JSON.stringify(selectors))
  const r = fx.run()
  assert.equal(r.status, 2, r.stderr)
  assert.equal(fs.existsSync(path.join(fx.H, 'plugins.json')), false)
})

test('a committed catalog symlink cannot import metadata from outside the pinned harness', t => {
  const fx = onDemandFixture(t)
  fx.editLock(() => {
    const file = path.join(fx.hd, 'catalog.json'), outside = path.join(fx.root, 'outside-catalog.json')
    fs.renameSync(file, outside)
    fs.symlinkSync(outside, file)
  })
  const r = fx.run()
  assert.equal(r.status, 2, r.stderr)
  assert.equal(fs.existsSync(path.join(fx.H, 'plugins.json')), false)
})
