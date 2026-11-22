// Offline fixtures for the provisioning tests: archive builders, a tiny lock, a stub downloader and a
// stub runner that plays python/pip/node/Playwright. Nothing here touches the network or installs software.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
export const sri512 = (b) => 'sha512-' + crypto.createHash('sha512').update(b).digest('base64')
export const tmp = (prefix = 'img2-prov-') => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix))

// ---------------------------------------------------------------- archives

function tarHeader({ name, size = 0, mode = 0o644, type = '0', link = '' }) {
  const h = Buffer.alloc(512)
  h.write(name.slice(0, 100), 0, 'utf8')
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100)
  h.write('0000000\0', 108); h.write('0000000\0', 116)
  h.write(size.toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.write('        ', 148)
  h.write(type, 156)
  h.write(link, 157, 'utf8')
  h.write('ustar\0' + '00', 257)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}

// entries: [{ name, data?, mode?, type?: 'file'|'dir'|'symlink'|'hardlink', link? }]
export function makeTarGz(entries) {
  const parts = []
  for (const e of entries) {
    const type = e.type ?? 'file'
    const code = { file: '0', dir: '5', symlink: '2', hardlink: '1' }[type]
    const data = Buffer.from(e.data ?? '')
    parts.push(tarHeader({ name: e.name, size: type === 'file' ? data.length : 0, mode: e.mode ?? (type === 'dir' ? 0o755 : 0o644), type: code, link: e.link ?? '' }))
    if (type === 'file') { parts.push(data); parts.push(Buffer.alloc((512 - (data.length % 512)) % 512)) }
  }
  parts.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(parts))
}

const crc32 = (buf) => {
  let c; let crc = 0xffffffff
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c }
  return (crc ^ 0xffffffff) >>> 0
}

// entries: [{ name, data?, mode?, symlink? }] (stored, no compression)
export function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const data = Buffer.from(e.symlink ?? e.data ?? '')
    const mode = e.symlink ? 0o120777 : e.name.endsWith('/') ? 0o040755 : 0o100000 | (e.mode ?? 0o644)
    const crc = crc32(data)
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14)
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6)
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE((mode << 16) >>> 0, 38); c.writeUInt32LE(offset, 42)
    locals.push(l, name, data); centrals.push(c, name)
    offset += l.length + name.length + data.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

// ---------------------------------------------------------------- fixture lock

const THREE_FILES = ['build/three.core.js', 'build/three.module.js', 'examples/jsm/loaders/GLTFLoader.js', 'examples/jsm/utils/BufferGeometryUtils.js', 'examples/jsm/utils/SkeletonUtils.js']

function npmTarball(name, version, extra = {}, files = {}) {
  const pkg = { name, version, ...extra }
  const entries = [{ name: 'package/package.json', data: JSON.stringify(pkg) }]
  for (const [f, d] of Object.entries(files)) entries.push({ name: 'package/' + f, data: d })
  return makeTarGz(entries)
}

export const PLATFORM = 'linux-x64'
export const URL_BASE = 'https://artifacts.example.test/'

// Returns { root, bytes: Map(url -> Buffer), lock, entry(id) }. `mutate(lock, bytes)` may alter before writing.
export function makeFixture({ mutate } = {}) {
  const bytes = new Map()
  const put = (name, buf) => { const url = URL_BASE + name; bytes.set(url, buf); return url }
  const art = (name, buf, extra = {}) => ({ platform: PLATFORM, filename: name, url: put(name, buf), size: buf.length, sha256: sha256(buf), ...extra })
  const npmArt = (name, version, extra, files) => {
    const buf = npmTarball(name, version, extra, files)
    return { platform: 'any', url: put(name.replace('/', '__') + '-' + version + '.tgz', buf), integrity: sri512(buf), unpackedSize: buf.length * 3 }
  }
  const base = (id, environment, kind, name, version, requires, probe, consumers, artifacts, extra = {}) => ({
    id, environment, kind, name, version, group: environment, consumers, requires, probe, ownership: 'harness',
    constraints: { ...(kind === 'pip' ? { python: { abi: 'cp311', range: '==3.11.*' } } : {}), platforms: [PLATFORM] },
    artifacts, exports: [], status: 'resolved', ...extra,
  })
  const wheel = (n, v) => art(`${n}-${v}-cp311-cp311-manylinux.whl`, Buffer.from(`wheel ${n} ${v}`))
  const unresolved = { status: 'unresolved', reason: { code: 'sha256-not-in-registry-metadata', reason: 'npm publishes sha512 SRI only' } }

  const deps = [
    base('python-runtime', 'runtime', 'runtime-archive', 'CPython', '3.11.18', [], 'python-runtime-version', ['character', 'interior', 'vision', 'harness'],
      [art('python.tar.gz', makeTarGz([{ name: 'python/bin/python3', data: '#!stub python', mode: 0o755 }, { name: 'python/lib/x', data: 'lib' }]))], { exports: ['IMG2_PYTHON'] }),
    base('node-runtime', 'runtime', 'runtime-archive', 'Node.js', '22.23.5', [], 'node-runtime-version', ['character', 'mcp', 'pixi2d', 'harness'],
      [art('node.tar.gz', makeTarGz([{ name: 'node-v22/bin/node', data: '#!stub node', mode: 0o755 }]))], { exports: ['IMG2_CHARACTER_NODE'] }),
    base('character-numpy', 'character', 'pip', 'numpy', '1.26.4', ['python-runtime'], 'numpy-array-op', ['character'], [wheel('numpy', '1.26.4')]),
    base('character-bpy', 'character', 'pip', 'bpy', '4.5.15', ['python-runtime', 'character-numpy'], 'bpy-import-version-export', ['character'], [wheel('bpy', '4.5.15')],
      { exports: ['IMG2_CHARACTER_BPY_PYTHON'], transitive: [{ name: 'certifi', version: '2026.1.1', artifacts: [wheel('certifi', '2026.1.1')] }] }),
    base('interior-numpy', 'interior', 'pip', 'numpy', '1.26.4', ['python-runtime'], 'numpy-array-op', ['interior'], [wheel('numpy', '1.26.4')]),
    base('interior-bpy', 'interior', 'pip', 'bpy', '4.3.0', ['python-runtime', 'interior-numpy'], 'bpy-import-version-export', ['interior'], [wheel('bpy', '4.3.0')], { exports: ['IMG2_BLENDER_PYTHON'] }),
    base('vision-torch', 'vision', 'pip', 'torch', '2.13.0', ['python-runtime'], 'vision-offline-inference', ['vision'], [wheel('torch', '2.13.0')], { exports: ['IMG2THREEJS_VISION_PYTHON'] }),
    base('character-three', 'character-node', 'npm', 'three', '0.186.1', ['node-runtime'], 'node-three-import', ['character'],
      [npmArt('three', '0.186.1', {}, Object.fromEntries(THREE_FILES.map((f) => [f, 'js ' + f])))], { exports: ['IMG2_CHARACTER_THREE_ROOT', 'IMG2_CHARACTER_THREE_SHA256'], ...unresolved }),
    base('browser-chromium-1.64.0', 'browsers', 'browser', 'Chromium bundle', 'chromium 156 for playwright 1.64.0', ['node-runtime'], 'chromium-webgl-capture', ['pixi2d', 'character'],
      [{ platform: PLATFORM, url: URL_BASE + 'chrome-linux64.zip', size: 1000, filename: 'chrome-linux64.zip', kind: 'chromium' }], { exports: ['IMG2_CHARACTER_BROWSER'], ...unresolved }),
    base('pixi2d-playwright', 'pixi2d', 'npm', 'playwright', '1.64.0', ['node-runtime', 'browser-chromium-1.64.0'], 'playwright-chromium-capture', ['pixi2d'],
      [npmArt('playwright', '1.64.0', { dependencies: { 'playwright-core': '1.64.0' } })], {
        transitive: [{ name: 'playwright-core', version: '1.64.0', artifacts: [npmArt('playwright-core', '1.64.0', { bin: { 'playwright-core': 'cli.js' } }, { 'cli.js': '// stub cli' })] }], ...unresolved,
      }),
    base('mcp-fake', 'mcp', 'npm', 'fake-mcp', '1.0.0', ['node-runtime'], 'mcp-initialize-tools-list', ['mcp'],
      [npmArt('fake-mcp', '1.0.0', { bin: { 'fake-mcp': 'server.js' } }, { 'server.js': '// stub' })], unresolved),
    base('cs2-source2viewer-cli', 'cs2', 'binary', 'Source2Viewer-CLI', '21.1', [], 'source2viewer-version', ['cs2'],
      [art('cli-linux-x64.zip', makeZip([{ name: 'Source2Viewer-CLI', data: '#!stub s2v', mode: 0o755 }]))], { exports: ['SOURCE2VIEWER_CLI'] }),
  ]
  const ids = deps.map((d) => d.id)
  const lock = {
    schema: 1, release: null, platforms: ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'],
    environments: Object.fromEntries(['runtime', 'browsers', 'cs2'].map((n) => [n, { kind: 'dir' }])
      .concat(['character', 'interior', 'vision'].map((n) => [n, { kind: 'venv', python: '3.11' }]))
      .concat(['character-node', 'mcp'].map((n) => [n, { kind: 'npm-root' }])).concat([['pixi2d', { kind: 'npm-root' }]])),
    profiles: { full: { dependencies: ids }, minimal: { dependencies: ids.filter((i) => !['vision-torch', 'mcp-fake'].includes(i)) } },
    dependencies: deps,
  }
  const pluginsLock = {
    schema: 1, defaultInstall: 'all',
    plugins: ['character', 'cs2', 'interior', 'jev', 'pixi2d'].map((id) => ({ id, capability: id, selectable: true, default: true })),
  }
  mutate?.(lock, bytes)
  const root = tmp('img2-lock-')
  fs.writeFileSync(path.join(root, 'dependencies.lock.json'), JSON.stringify(lock, null, 2))
  fs.writeFileSync(path.join(root, 'plugins.lock.json'), JSON.stringify(pluginsLock, null, 2))
  return { root, bytes, lock, pluginsLock, entry: (id) => lock.dependencies.find((d) => d.id === id) }
}

// ---------------------------------------------------------------- stub downloader and runner

export function stubDownloader(bytes, { onFetch, tamper } = {}) {
  const fn = async (url, dest) => {
    fn.calls.push(url)
    onFetch?.(url)
    let buf = bytes.get(url)
    if (!buf) throw new Error('404 ' + url)
    if (tamper?.(url)) buf = Buffer.concat([buf, Buffer.from('tampered')])
    fs.writeFileSync(dest, buf)
  }
  fn.calls = []
  return fn
}

const ok = (stdout = '') => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false, error: null })
const bad = (stderr, code = 1) => ({ code, signal: null, stdout: '', stderr, timedOut: false, error: null })
const json = (v) => ok(JSON.stringify(v) + '\n')

// failOn: array of predicates/strings matched against `file + ' ' + args.join(' ')` (first match fails that call).
export function stubRunner({ failOn = [], failProbe = [], webgl = true } = {}) {
  const calls = []
  const matches = (list, text) => list.some((m) => (typeof m === 'string' ? text.includes(m) : m(text)))
  const run = async (file, args, opts = {}) => {
    const text = file + ' ' + args.join(' ')
    calls.push({ file, args, cwd: opts.cwd, env: opts.env })
    if (matches(failOn, text)) return bad('stub failure for: ' + text.slice(0, 120))
    const base = path.basename(file)

    if (args.includes('venv')) { // python -I -m venv [--copies] <dir>
      const dir = args.at(-1)
      fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'bin', 'python'), '#!/usr/bin/env stub-python\n', { mode: 0o755 })
      fs.writeFileSync(path.join(dir, 'bin', 'activate'), 'VIRTUAL_ENV=' + dir + '\n')
      fs.writeFileSync(path.join(dir, 'pyvenv.cfg'), 'home = stub\n')
      return ok()
    }
    if (args.includes('pip') && args.includes('install')) {
      const req = fs.readFileSync(args[args.indexOf('-r') + 1], 'utf8')
      const links = args[args.indexOf('--find-links') + 1]
      if (!args.includes('--require-hashes') || !args.includes('--only-binary=:all:')) return bad('missing --require-hashes/--only-binary')
      const installed = {}
      for (const line of req.split('\n').filter((l) => l && !l.startsWith('#'))) {
        const [pin] = line.split(' ')
        const [n, v] = pin.split('==')
        if (!/--hash=sha256:[0-9a-f]{64}/.test(line)) return bad('requirement without a hash: ' + line)
        const wheel = fs.readdirSync(links).find((f) => f.toLowerCase().replace(/[-_.]+/g, '-').startsWith(n + '-' + v.replace(/\./g, '-')) || f.toLowerCase().startsWith(n + '-' + v))
        if (!wheel) return bad('no wheel for ' + pin)
        installed[n] = v
      }
      fs.writeFileSync(path.join(path.dirname(path.dirname(file)), 'installed.json'), JSON.stringify(installed))
      return ok()
    }
    if (args.includes('pip') && args.includes('check')) return ok('No broken requirements found.')

    if (args.includes('-c') && (base === 'python' || base === 'python3')) { // probes
      const code = args[args.indexOf('-c') + 1]
      if (matches(failProbe, code)) return bad('Traceback: probe exploded')
      if (file.includes('python-runtime') && file.endsWith('bin/python3')) return json({ version: '3.11.18' })
      let installed = {}
      try { installed = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(file)), 'installed.json'), 'utf8')) } catch { /* not a venv */ }
      if (code.includes('torchOutputShape') || code.includes('import torch')) return json({ ...installed, torchOutputShape: [1, 2] })
      if (code.includes('import bpy')) return json({ version: installed.bpy, versionString: installed.bpy + ' LTS', module: '/x/bpy', glbMagic: 'glTF', glbBytes: 2048 })
      if (code.includes('numpy as np')) return json({ version: installed.numpy, product: [[5, 14], [14, 50]] })
      if (code.includes('PIL')) return json({ version: installed.pillow, size: [2, 2], pixel: [10, 20, 30] })
      if (code.includes('sync_playwright')) return json({ version: installed.playwright, chromium: '156' })
      return bad('unknown python probe')
    }
    if (file.endsWith('/node') && args.includes('--version')) return ok('v22.23.5\n')
    if (file.endsWith('/node') && args[0]?.endsWith('cli.js') && args[1] === 'install') {
      const dir = opts.env.PLAYWRIGHT_BROWSERS_PATH
      fs.mkdirSync(path.join(dir, 'chromium-1', 'chrome-linux'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'chromium-1', 'chrome-linux', 'chrome'), '#!stub chromium', { mode: 0o755 })
      return ok()
    }
    if (file.endsWith('/node')) {
      const code = args.at(-1)
      if (matches(failProbe, code)) return bad('Error: node probe exploded')
      if (code.includes('executablePath')) return json({ chromium: path.join(opts.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1', 'chrome-linux', 'chrome') })
      if (code.includes('t.launch')) {
        if (!fs.existsSync(path.join(opts.env.PLAYWRIGHT_BROWSERS_PATH ?? '/nonexistent', 'chromium-1'))) return bad('browserType.launch: Executable does not exist')
        return json(webgl ? { version: '156.0', gl: 'WebGL 2.0', px: [255, 0, 0, 255] } : { version: '156.0', error: 'no WebGL context' })
      }
      if (code.includes('REVISION')) {
        const v = JSON.parse(fs.readFileSync(path.join(opts.cwd, 'node_modules', 'three', 'package.json'), 'utf8')).version
        return json({ revision: v.split('.')[1], version: v, mesh: 'function' })
      }
      if (code.includes('node_modules/')) {
        const name = /node_modules\/([^/"]+)\/package\.json/.exec(code)[1]
        return json({ version: JSON.parse(fs.readFileSync(path.join(opts.cwd, 'node_modules', name, 'package.json'), 'utf8')).version })
      }
      return bad('unknown node probe')
    }
    if (base === 'Source2Viewer-CLI') return ok('Source2Viewer-CLI 21.1\n')
    if (file === '/usr/bin/security') return bad('could not be found', 44)
    return bad('stub runner: unexpected command ' + text.slice(0, 160))
  }
  run.calls = calls
  return run
}

export const stubMcp = (answers = {}) => async ({ args }) => answers[path.basename(path.dirname(args[0]))] ?? { ok: true, serverInfo: { name: 'fake-mcp', version: '1.0.0' }, toolCount: 3, stderr: '' }

export function makeDeps(fx, over = {}) {
  const lines = []
  const errs = []
  return {
    run: over.run ?? stubRunner(), mcp: over.mcp ?? stubMcp(),
    download: over.download ?? stubDownloader(fx.bytes),
    isTTY: false, confirm: over.confirm ?? (async () => true),
    out: (l) => lines.push(l), err: (l) => errs.push(l), lines, errs,
    now: () => new Date('2026-11-22T10:00:00Z'), lockRoot: fx.root, platform: PLATFORM,
    env: {}, home: tmp('img2-home-'), ...over,
  }
}

export const baseOpts = (o = {}) => ({ plan: false, yes: true, profile: null, minimal: false, plugins: null, skip: [], offline: false, allowWeakHash: true, remove: false, json: false, ...o })
