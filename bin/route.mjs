// `img2 route` / `img2 core-run`: the one supported way to run the pinned core from a harness install.
//
// Why it exists (acceptance round 2, N1-N3): the core must run (N1) under an interpreter that has Pillow, because
// its Jev provider factory runs image preparation as `<sys.executable resolved> -I -B -c ...` (-I ignores PYTHONPATH
// and the factory resolves symlinks, so neither a venv symlink nor PYTHONPATH can supply Pillow); (N2) with the
// managed Python first on PATH, or the dependency probes read the ambient python3; (N3) with a canonical IMG2_HOME,
// or the runtime selectors fail their lexical-root check. All three are decided here, from records setup wrote.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Refusal } from './runtime/errors.mjs'
import { isUnder } from './runtime/fsx.mjs'

// Provisioned environments that carry a probe-verified Pillow, in preference order (Jev's own pin first).
export const PILLOW_UNITS = ['jev', 'pixi2d', 'character', 'interior-surfaces', 'glb-tools', 'vision']
// The only host variables a core run inherits: identity and locale, the credential store, TLS/proxy plumbing.
// TYPESAFE_API_KEY is Jev's documented credential override; it is passed through and never printed.
const PASS_ENV = [
  'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TMPDIR', 'TZ', 'NO_COLOR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'TYPESAFE_API_KEY',
]
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const PIN_FLAGS = [
  ['--harness-root', 'harnessRoot'], ['--harness-sha', 'harnessSha'],
  ['--harness-executable', 'harnessExecutable'], ['--harness-sha256', 'harnessExecutableSha256'],
]
const STAMP = '.img2-route-python.json'

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const realOrNull = (p) => { try { return fs.realpathSync(p) } catch { return null } }
const sha256File = (file) => {
  const hash = crypto.createHash('sha256')
  const buf = Buffer.allocUnsafe(1 << 20)
  const fd = fs.openSync(file, 'r')
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n)) } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}
const isExecutable = (file) => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}

// ---------------------------------------------------------------- the install's records

// $IMG2_HOME/provision.json (written by setup) plus the canonical home. Refuses with the remedy when absent or stale.
export function loadRouteRecord(home) {
  const realHome = realOrNull(home)
  if (!realHome) throw new Refusal('IMG2_HOME does not exist: ' + home, 'run `img2 setup` first (or pass --home <dir> / set IMG2_HOME to an installed home)')
  const file = path.join(realHome, 'provision.json')
  let record
  try { record = readJson(file) } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Refusal(file + ' is missing: this home has no setup record, so the harness pins and the interpreter are unknown',
        'run `img2 setup` for ' + realHome + ' (it writes provision.json after every step verified); nothing was run')
    }
    throw new Refusal(file + ' is not valid JSON: ' + e.message, 'rerun `img2 setup`')
  }
  const bad = (why) => new Refusal(file + ' is not a usable setup record: ' + why, 'rerun `img2 setup`; nothing was run')
  if (record?.kind !== 'img2.setup-provision' || record.version !== 1) throw bad('kind/version')
  if (record.status !== 'ok') throw bad('status is ' + JSON.stringify(record.status))
  if (record.img2Home !== realHome) throw bad('written for ' + record.img2Home + ' but this home is ' + realHome)
  const pins = record.pins
  const absolute = (v) => typeof v === 'string' && path.isAbsolute(v)
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(pins?.harnessSha ?? '') || !/^[0-9a-f]{64}$/.test(pins?.harnessExecutableSha256 ?? '')
    || !absolute(pins?.harnessRoot) || !absolute(pins?.harnessExecutable)) throw bad('the harness pins are incomplete')
  if (!/^[0-9a-f]{64}$/.test(record.lockDigest ?? '') || !absolute(record.python?.path)) throw bad('lockDigest or python is missing')
  if (!isExecutable(record.python.path)) throw bad('the recorded interpreter ' + record.python.path + ' is not executable')
  const route = path.join(realHome, 'core', 'forge', 'route.py')
  if (!fs.existsSync(route)) throw new Refusal('no core router at ' + route, 'run `img2 setup` (or `img2 install`) to check out the pinned core')
  let launcher
  try { launcher = sha256File(pins.harnessExecutable) } catch { throw bad('the harness launcher ' + pins.harnessExecutable + ' is unreadable') }
  if (launcher !== pins.harnessExecutableSha256) {
    throw new Refusal('the harness launcher differs from the setup pin (' + pins.harnessExecutable + ')', 'rerun `img2 setup` so the pins match the installed harness; nothing was run')
  }
  return { home: realHome, record, route, coreDir: path.join(realHome, 'core') }
}

// A provisioned environment whose Pillow passed its runtime probe, for the same CPython as the recorded interpreter.
export function findPillowEnv({ home, record }) {
  const rtRoot = path.join(home, 'runtime')
  const file = path.join(rtRoot, 'provision.json')
  let doc
  try { doc = readJson(file) } catch { throw new Refusal(file + ' is missing or unreadable: the provisioned runtime is unknown', 'run `img2 setup`; nothing was run') }
  if (doc?.status !== 'ok' || doc.lockDigest !== record.lockDigest) {
    throw new Refusal(file + ' does not describe the runtime this setup record names (status ' + JSON.stringify(doc?.status) + ')', 'rerun `img2 setup`; nothing was run')
  }
  // Same rule as the core selector reader (forge/_shared/runtime_selectors.py _runtime_path): the runtime tree is
  // <canonical home>/runtime, and everything used from it must resolve strictly inside it, never to it, never out.
  const realRt = realOrNull(rtRoot)
  if (!realRt) throw new Refusal(rtRoot + ' does not exist', 'rerun `img2 setup`; nothing was run')
  const rtDir = path.join(realRt, record.lockDigest.slice(0, 12))
  const realDigest = realOrNull(rtDir)
  if (realDigest !== rtDir) {
    throw new Refusal(rtDir + ' is not a real directory inside ' + realRt + (realDigest ? ' (it resolves to ' + realDigest + ')' : ''),
      'the runtime digest directory must not be a symlink or missing; rerun `img2 setup`; nothing was run')
  }
  const baseBin = realOrNull(path.dirname(record.python.path))
  const checked = []
  for (const name of PILLOW_UNITS) {
    const unit = doc.units?.find((u) => u.name === name)
    if (!unit) continue
    if (!unit.probes?.some((p) => /-pillow$/.test(p.dependency) && p.status === 'pass')) { checked.push(name + ': no passing Pillow probe'); continue }
    const venv = path.join(rtDir, name, 'venv')
    let cfg = ''
    try { cfg = fs.readFileSync(path.join(venv, 'pyvenv.cfg'), 'utf8') } catch { /* reported below */ }
    const home0 = /^home\s*=\s*(.+)$/m.exec(cfg)?.[1].trim()
    if (!home0 || realOrNull(home0) !== baseBin) { checked.push(name + ': its venv is not built on ' + record.python.path); continue }
    const libDir = path.join(venv, 'lib')
    const tag = (() => { try { return fs.readdirSync(libDir).find((n) => /^python\d+\.\d+$/.test(n)) } catch { return undefined } })()
    const site = tag && realOrNull(path.join(libDir, tag, 'site-packages'))
    if (!site || !isUnder(realRt, site) || !isUnder(realDigest, site) || !fs.statSync(path.join(site, 'PIL'), { throwIfNoEntry: false })?.isDirectory()) {
      checked.push(name + ': no PIL under its site-packages'); continue
    }
    return { unit: name, site, tag, rtDir }
  }
  throw new Refusal('no provisioned environment has a verified Pillow for ' + record.python.path,
    (checked.join('; ') || 'none of ' + PILLOW_UNITS.join(', ') + ' is in the runtime record') + '\nrun `img2 setup` (selecting jev) to provision jev-pillow; nothing was run')
}

// ---------------------------------------------------------------- the interpreter

const CLEAN_PROBE_ENV = { PATH: SYSTEM_PATH.join(path.delimiter), LANG: 'C.UTF-8' }
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

// The Pillow site-packages is written verbatim into a .pth, where a line starting with `import` executes. Accept only
// a single-line, canonical (realpath) absolute directory strictly inside <real runtime>/<digest>/.
function validatePillowSite(home, record, pillow) {
  const bad = (why) => new Refusal('the Pillow site-packages ' + JSON.stringify(pillow.site) + ' is refused: ' + why, 'rerun `img2 setup`; nothing was run')
  const site = pillow.site
  if (typeof site !== 'string' || !path.isAbsolute(site)) throw bad('not an absolute path')
  if (CONTROL.test(site)) throw bad('it contains control characters')
  if (/^(import|#)/.test(site.trim())) throw bad('it would be read as code or a comment')
  if (typeof pillow.tag !== 'string' || !/^python\d+\.\d+$/.test(pillow.tag)) throw bad('the interpreter tag is not pythonX.Y')
  const realRt = realOrNull(path.join(home, 'runtime'))
  const digestDir = realRt && path.join(realRt, record.lockDigest.slice(0, 12))
  if (!digestDir || realOrNull(digestDir) !== digestDir) throw bad('the runtime digest directory is not a real directory inside the runtime tree')
  if (realOrNull(site) !== site || !isUnder(digestDir, site)) throw bad('it is not a canonical path inside ' + digestDir)
  return site
}

// <runtime>/<digest>/route-python: a real (copied, not symlinked) CPython with a pyvenv.cfg on the managed base and a
// .pth naming the verified env's site-packages. A copy because the core resolves symlinks before running the
// preparation child; a .pth because that child runs with -I, which drops PYTHONPATH but still processes site dirs.
// Rebuilt when the base interpreter or the Pillow env changes, and whenever the cached copy's pyvenv.cfg/.pth differ
// from what is generated here (the cache lives in a user-writable home; a stamp alone proves nothing about contents).
export function ensureRouteInterpreter({ home, record }, pillow, { probe = defaultProbe } = {}) {
  const dir = path.join(pillow.rtDir, 'route-python')
  const basePython = fs.realpathSync(record.python.path)
  const version = record.python.version
  if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Refusal('the recorded python version ' + JSON.stringify(version) + ' is not MAJOR.MINOR.PATCH', 'rerun `img2 setup`; nothing was run')
  }
  const baseHome = path.dirname(basePython)
  if (CONTROL.test(baseHome)) throw new Refusal('the recorded interpreter directory contains control characters', 'rerun `img2 setup`; nothing was run')
  const site = validatePillowSite(home, record, pillow)
  const cfg = 'home = ' + baseHome + '\ninclude-system-site-packages = false\nversion = ' + version + '\n'
  const pth = site + '\n'
  const sitePath = (root) => path.join(root, 'lib', pillow.tag, 'site-packages', 'img2-route.pth')
  const baseStat = fs.statSync(basePython)
  const stamp = JSON.stringify({ schema: 1, base: basePython, size: baseStat.size, mtimeMs: baseStat.mtimeMs, site, tag: pillow.tag })
  const python = path.join(dir, 'bin', 'python3')
  const read = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
  const fresh = read(path.join(dir, STAMP)) === stamp && isExecutable(python)
    && read(path.join(dir, 'pyvenv.cfg')) === cfg && read(sitePath(dir)) === pth
  if (!fresh) {
    const staging = dir + '.tmp-' + process.pid
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(path.join(staging, 'bin'), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(sitePath(staging)), { recursive: true, mode: 0o700 })
    fs.copyFileSync(basePython, path.join(staging, 'bin', 'python3'))
    fs.chmodSync(path.join(staging, 'bin', 'python3'), 0o755)
    fs.writeFileSync(path.join(staging, 'pyvenv.cfg'), cfg)
    fs.writeFileSync(sitePath(staging), pth)
    // Interpreters linked to a shared libpython (Linux builds) find it relative to the executable.
    const baseLib = path.join(path.dirname(path.dirname(basePython)), 'lib')
    try {
      for (const name of fs.readdirSync(baseLib).filter((n) => n.startsWith('libpython'))) {
        fs.mkdirSync(path.join(staging, 'lib'), { recursive: true })
        fs.symlinkSync(path.join(baseLib, name), path.join(staging, 'lib', name))
      }
    } catch { /* no shared libpython: nothing to link */ }
    fs.writeFileSync(path.join(staging, STAMP), stamp)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(staging, dir)
  }
  const result = probe(python)
  if (result.code !== 0 || !String(result.stdout).trim()) {
    throw new Refusal('the route interpreter ' + python + ' cannot import Pillow',
      String(result.stderr ?? '').trim().slice(-600) + '\nrerun `img2 setup`; nothing was run')
  }
  return { python, pillowVersion: String(result.stdout).trim(), unit: pillow.unit }
}

function defaultProbe(python) {
  const r = spawnSync(python, ['-I', '-B', '-c', 'import PIL; print(PIL.__version__)'], { env: CLEAN_PROBE_ENV, encoding: 'utf8', timeout: 30_000 })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : '') }
}

// ---------------------------------------------------------------- environment and argv

const absoluteDirs = (value) => String(value ?? '').split(path.delimiter).filter((d) => d && path.isAbsolute(d))

export function findOnPath(name, pathValue) {
  for (const dir of absoluteDirs(pathValue)) if (isExecutable(path.join(dir, name))) return path.join(dir, name)
  return null
}

// Minimal child environment. PATH order: managed Python dir, the node the pins name, the user's `blender` dir,
// the rest of the user's absolute PATH entries, system dirs. Nothing steers the interpreter: no PYTHONPATH/HOME-like
// Python variables, pip/npm/UV settings, or node options are inherited.
export function buildRouteEnv({ home, record }, host = process.env) {
  const node = record.pins.node
  if (typeof node !== 'string' || !path.isAbsolute(node) || !isExecutable(node)) {
    throw new Refusal('the node recorded by setup (' + JSON.stringify(node) + ') does not exist or is not executable',
      'rerun `img2 setup` so the pin names an installed node; the ambient PATH node is never used instead; nothing was run')
  }
  const recordedSha = record.pins.nodeSha256
  if (recordedSha !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(recordedSha)) throw new Refusal('the recorded node sha256 is malformed', 'rerun `img2 setup`; nothing was run')
    if (sha256File(node) !== recordedSha) {
      throw new Refusal('the node at ' + node + ' differs from the setup pin (sha256 mismatch)', 'rerun `img2 setup` so the pin matches the installed node; nothing was run')
    }
  }
  const blender = findOnPath('blender', host.PATH)
  const dirs = [path.dirname(record.python.path), path.dirname(node),
    blender ? path.dirname(blender) : null, ...absoluteDirs(host.PATH), ...SYSTEM_PATH].filter(Boolean)
  const env = {}
  for (const key of PASS_ENV) if (host[key] !== undefined) env[key] = host[key]
  for (const key of Object.keys(host)) if (key.startsWith('LC_')) env[key] = host[key]
  env.PATH = [...new Set(dirs)].join(path.delimiter)
  env.LANG ??= 'C.UTF-8'
  env.IMG2_HOME = home
  env.IMG2_HARNESS_DIR = record.pins.harnessRoot
  env.PYTHONDONTWRITEBYTECODE = '1'
  env.PYTHONNOUSERSITE = '1'
  return { env, blender }
}

// Appends each harness pin flag the caller did not supply (`--flag value` or `--flag=value`).
export function withHarnessPins(args, pins) {
  const out = [...args]
  for (const [flag, key] of PIN_FLAGS) {
    if (!args.some((a) => a === flag || a.startsWith(flag + '='))) out.push(flag, String(pins[key]))
  }
  return out
}

// A script of the pinned core: relative to <core>/forge (or starting with forge/ or scripts/), real path inside the core.
export function resolveCoreScript(coreDir, spec) {
  if (!spec) throw new Refusal('core-run needs a script', 'usage: img2 core-run <script under core/forge, e.g. preflight.py> [args...]')
  const candidate = path.isAbsolute(spec) ? spec : path.join(coreDir, /^(forge|scripts)\//.test(spec) ? '' : 'forge', spec)
  const real = realOrNull(candidate)
  const realCore = realOrNull(coreDir)
  if (!real || !fs.statSync(real).isFile()) throw new Refusal('no such core script: ' + candidate)
  if (!realCore || !isUnder(realCore, real) || !real.endsWith('.py')) throw new Refusal('core-run only runs .py files inside ' + coreDir, 'refused ' + real)
  return real
}

// Everything `img2 route`/`core-run` needs, or a Refusal. No process is started except the two bounded probes.
export function prepareCoreRun({ kind, args, home, host = process.env, probe }) {
  const loaded = loadRouteRecord(home)
  const script = kind === 'route' ? loaded.route : resolveCoreScript(loaded.coreDir, args[0])
  const rest = kind === 'route' ? args : args.slice(1)
  const pillow = findPillowEnv(loaded)
  const interpreter = ensureRouteInterpreter(loaded, pillow, { probe })
  const { env, blender } = buildRouteEnv(loaded, host)
  const argv = [script, ...(kind === 'route' ? withHarnessPins(rest, loaded.record.pins) : rest)]
  return { file: interpreter.python, argv, env, cwd: process.cwd(), home: loaded.home, interpreter, blender }
}

// One stderr line (stdout stays the router's JSON); paths and versions only.
export const describeRun = (p) => 'img2: IMG2_HOME=' + p.home + ' python=' + p.file + ' (Pillow ' + p.interpreter.pillowVersion + ' from the ' + p.interpreter.unit + ' env), '
  + (p.blender ? 'blender=' + p.blender : 'blender not on PATH: interior routes will be blocked (dependency-missing:blender>=4.3)')

export function runCore(prepared, { start = spawn } = {}) {
  return new Promise((resolve) => {
    const child = start(prepared.file, prepared.argv, { env: prepared.env, cwd: prepared.cwd, stdio: 'inherit' })
    child.on('error', (e) => { process.stderr.write('img2: cannot start ' + prepared.file + ': ' + e.message + '\n'); resolve(1) })
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 9) : 1)))
  })
}
