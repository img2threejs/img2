// Bounded runtime probes. The same functions prove a staged unit before activation and an active
// unit under `img2 doctor --runtime`; every one returns precise checks (expected / actual / stderr / remedy).
import fs from 'node:fs'
import path from 'node:path'
import { cleanEnv, mcpHandshake } from './exec.mjs'
import { atomicWriteFile, rmrf } from './fsx.mjs'
import crypto from 'node:crypto'

export const venvPython = (unitDir) => path.join(unitDir, 'venv', 'bin', 'python')
export const nodeRootOf = (unitDir) => path.join(unitDir, 'node')
export const browsersOf = (unitDir) => path.join(unitDir, 'browsers')
export const cliRootOf = (unitDir) => path.join(unitDir, 'cli')

const tail = (s, n = 1500) => String(s ?? '').trim().slice(-n)

// Numeric bpy version: bpy.app.version_string is "4.5.15 LTS" for the LTS build.
export const numericVersion = (s) => (/\d+(?:\.\d+)*/.exec(String(s)) ?? [''])[0]

function check(id, dependency, ok, expected, actual, extra = {}) {
  return { id, dependency, status: ok ? 'pass' : 'fail', expected, actual: String(actual ?? ''), ...extra }
}

function lastJson(stdout) {
  const lines = String(stdout).trim().split(/\r?\n/).reverse()
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    try { return JSON.parse(line) } catch { /* keep looking */ }
  }
  return null
}

// One subprocess that must print a JSON object on its last line.
async function script(pctx, file, args, { cwd, env, timeout = 120_000 } = {}) {
  const r = await pctx.run(file, args, { cwd, env: cleanEnv(env ?? {}), timeout })
  const json = lastJson(r.stdout)
  const problem = r.error ? 'could not start ' + file + ': ' + r.error
    : r.timedOut ? 'timed out after ' + timeout + ' ms'
      : r.code !== 0 ? 'exit ' + r.code + (r.signal ? ' (' + r.signal + ')' : '')
        : json === null ? 'no JSON result on stdout' : null
  return { r, json, problem, stderr: tail(r.stderr) }
}

const py = (pctx, unitDir, code, opts) => script(pctx, venvPython(unitDir), ['-I', '-B', '-c', code], opts)
const nodeBin = (pctx) => path.join(pctx.rtDir, 'runtime', 'node-runtime', 'bin', 'node')
const nodeRun = (pctx, cwd, code, { esm = false, env, timeout } = {}) =>
  script(pctx, nodeBin(pctx), esm ? ['--input-type=module', '-e', code] : ['-e', code], { cwd, env, timeout })

const NUMPY = async (pctx, deps) => {
  const out = []
  for (const d of deps) {
    const code = 'import json, numpy as np\na = np.arange(6, dtype="float64").reshape(2, 3)\nb = (a @ a.T).tolist()\nprint(json.dumps({"version": np.__version__, "product": b}))'
    const t = await py(pctx, pctx.unitDir, code)
    const ok = !t.problem && t.json.version === d.entry.version && t.json.product?.flat().join() === '5,14,14,50'
    out.push(check('numpy-array-op', d.id, ok, 'numpy ' + d.entry.version + ' and a@a.T == [[5,14],[14,50]]', t.problem ?? 'numpy ' + t.json.version + ' product ' + JSON.stringify(t.json.product), {
      path: venvPython(pctx.unitDir), stderr: t.stderr, remedy: 'img2 provision',
    }))
  }
  return out
}

const PILLOW = async (pctx, deps) => {
  const out = []
  for (const d of deps) {
    const code = 'import io, json, PIL\nfrom PIL import Image\nim = Image.new("RGB", (4, 4), (10, 20, 30)).resize((2, 2))\nbuf = io.BytesIO()\nim.save(buf, "PNG")\nback = Image.open(io.BytesIO(buf.getvalue())).convert("RGB")\nprint(json.dumps({"version": PIL.__version__, "size": list(back.size), "pixel": list(back.getpixel((0, 0)))}))'
    const t = await py(pctx, pctx.unitDir, code)
    const ok = !t.problem && t.json.version === d.entry.version && t.json.size?.join() === '2,2' && t.json.pixel?.join() === '10,20,30'
    out.push(check('pillow-image-op', d.id, ok, 'Pillow ' + d.entry.version + ' resize/PNG round trip', t.problem ?? 'Pillow ' + t.json.version + ' ' + JSON.stringify(t.json), {
      path: venvPython(pctx.unitDir), stderr: t.stderr, remedy: 'img2 provision',
    }))
  }
  return out
}

const BPY = async (pctx, deps) => {
  const out = []
  for (const d of deps) {
    const code = [
      'import json, os, tempfile',
      'import bpy',
      'res = {"version": ".".join(str(n) for n in bpy.app.version), "versionString": bpy.app.version_string, "module": bpy.__file__}',
      'try:',
      '    bpy.ops.wm.read_factory_settings(use_empty=True)',
      '    mesh = bpy.data.meshes.new("img2probe")',
      '    mesh.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [(0, 1, 2)])',
      '    mesh.update()',
      '    obj = bpy.data.objects.new("img2probe", mesh)',
      '    bpy.context.scene.collection.objects.link(obj)',
      '    try:',
      '        bpy.ops.preferences.addon_enable(module="io_scene_gltf2")',
      '    except Exception:',
      '        pass',
      '    out = os.path.join(tempfile.mkdtemp(prefix="img2-bpy-"), "probe.glb")',
      '    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB")',
      '    res["glbMagic"] = open(out, "rb").read(4).decode("latin1")',
      '    res["glbBytes"] = os.path.getsize(out)',
      'except Exception as e:',
      '    res["exportError"] = type(e).__name__ + ": " + str(e)[:400]',
      'print(json.dumps(res))',
    ].join('\n')
    const t = await py(pctx, pctx.unitDir, code, { timeout: 180_000, env: { TMPDIR: pctx.tmpDir } })
    const numeric = t.json ? numericVersion(t.json.version) : null
    out.push(check('bpy-import', d.id, !t.problem && numeric === d.entry.version, 'bpy ' + d.entry.version, t.problem ?? 'bpy ' + numeric + ' (' + t.json.versionString + ')', {
      path: venvPython(pctx.unitDir), stderr: t.stderr, remedy: 'img2 provision (bpy needs the exact CPython ABI in the lock)',
    }))
    if (!t.problem) {
      const exported = t.json.glbMagic === 'glTF' && t.json.glbBytes > 20
      out.push(check('bpy-export', d.id, exported, 'mesh created and exported as GLB (glTF magic)', exported ? t.json.glbBytes + ' bytes' : (t.json.exportError ?? 'no GLB written'), {
        path: venvPython(pctx.unitDir), stderr: t.stderr, remedy: 'rerun img2 doctor --runtime; if it persists, reinstall with img2 provision --remove then img2 provision',
      }))
    }
  }
  return out
}

const VISION = async (pctx, deps) => {
  const names = new Set(deps.filter((d) => d.entry.kind === 'pip').map((d) => d.entry.name))
  const hf = path.join(pctx.unitDir, 'huggingface')
  const code = [
    'import json, os, importlib.metadata as m',
    'res = {}',
    'for n in ' + JSON.stringify([...names]) + ':',
    '    res[n] = m.version(n)',
    'if "torch" in res:',
    '    import torch',
    '    y = torch.nn.Linear(4, 2)(torch.ones(1, 4))',
    '    res["torchOutputShape"] = list(y.shape)',
    'if "mediapipe" in res:',
    '    import mediapipe',
    '    res["mediapipeImport"] = True',
    'if "transformers" in res:',
    '    import transformers',
    '    res["transformersImport"] = True',
    'depth = os.path.join(' + JSON.stringify(hf) + ', "models--depth-anything--Depth-Anything-V2-Small-hf")',
    'if "transformers" in res and "torch" in res and os.path.isdir(depth):',
    '    import numpy as np',
    '    from transformers import AutoImageProcessor, AutoModelForDepthEstimation',
    '    proc = AutoImageProcessor.from_pretrained("depth-anything/Depth-Anything-V2-Small-hf", cache_dir=' + JSON.stringify(hf) + ', local_files_only=True, use_fast=False)',
    '    model = AutoModelForDepthEstimation.from_pretrained("depth-anything/Depth-Anything-V2-Small-hf", cache_dir=' + JSON.stringify(hf) + ', local_files_only=True)',
    '    from PIL import Image',
    '    img = Image.fromarray((np.random.RandomState(0).rand(64, 64, 3) * 255).astype("uint8"))',
    '    with torch.no_grad():',
    '        out = model(**proc(images=img, return_tensors="pt"))',
    '    res["depthOutput"] = list(out.predicted_depth.shape)',
    'print(json.dumps(res))',
  ].join('\n')
  const env = { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HOME: hf, MPLCONFIGDIR: path.join(pctx.tmpDir, 'mpl') }
  const t = await py(pctx, pctx.unitDir, code, { timeout: 300_000, env })
  const missing = t.json ? deps.filter((d) => d.entry.kind === 'pip' && t.json[d.entry.name] !== d.entry.version).map((d) => d.entry.name) : []
  const ok = !t.problem && missing.length === 0
  const wantsDepth = deps.some((d) => d.id === 'vision-model-depth-anything-weights')
  const depthOk = !wantsDepth || (t.json && Array.isArray(t.json.depthOutput))
  return [
    check('vision-offline-inference', 'vision', ok && depthOk,
      'vision imports at pinned versions' + (wantsDepth ? ' and an offline depth-model inference' : ''),
      t.problem ?? (missing.length ? 'version mismatch: ' + missing.join(', ') : JSON.stringify(t.json)),
      { path: venvPython(pctx.unitDir), stderr: t.stderr, remedy: 'img2 provision' }),
  ]
}

const PLAYWRIGHT_PY = async (pctx, deps) => {
  const out = []
  for (const d of deps) {
    const browsers = pctx.browsersFor('browser-chromium-' + d.entry.version)
    const code = [
      'import json, importlib.metadata as m',
      'from playwright.sync_api import sync_playwright',
      'res = {"version": m.version("playwright")}',
      'with sync_playwright() as p:',
      '    b = p.chromium.launch(headless=True, args=["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])',
      '    res["chromium"] = b.version',
      '    b.close()',
      'print(json.dumps(res))',
    ].join('\n')
    const t = await py(pctx, pctx.unitDir, code, { timeout: 120_000, env: { PLAYWRIGHT_BROWSERS_PATH: browsers } })
    out.push(check('playwright-python-import', d.id, !t.problem && t.json.version === d.entry.version,
      'playwright (python) ' + d.entry.version + ' launches headless Chromium', t.problem ?? 'playwright ' + t.json.version + ' / chromium ' + t.json.chromium,
      { path: venvPython(pctx.unitDir), stderr: t.stderr, remedy: 'img2 provision' }))
  }
  return out
}

const NODE_THREE = async (pctx, deps) => {
  const root = nodeRootOf(pctx.unitDir)
  const out = []
  for (const d of deps) {
    const t = await nodeRun(pctx, root, 'import * as T from "three"\nimport fs from "node:fs"\nconst v = JSON.parse(fs.readFileSync("node_modules/three/package.json", "utf8")).version\nconsole.log(JSON.stringify({ revision: T.REVISION, version: v, mesh: typeof T.Mesh }))', { esm: true })
    const rev = d.entry.version.split('.')[1]
    out.push(check('node-three-import', d.id, !t.problem && t.json.version === d.entry.version && t.json.revision === rev && t.json.mesh === 'function',
      'import three ' + d.entry.version + ' (REVISION ' + rev + ')', t.problem ?? 'three ' + t.json.version + ' REVISION ' + t.json.revision, { path: root, stderr: t.stderr, remedy: 'img2 provision' }))
  }
  return out
}

const VITE_BUILD = async (pctx, deps) => {
  const root = nodeRootOf(pctx.unitDir)
  const vite = deps.find((d) => d.entry.name === 'vite')
  const hasThree = deps.some((d) => d.entry.name === 'three')
  if (!vite) return []
  const dir = path.join(root, '.img2-probe-' + crypto.randomBytes(4).toString('hex'))
  try {
    atomicWriteFile(path.join(dir, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>', 0o644)
    atomicWriteFile(path.join(dir, 'main.js'), (hasThree ? 'import * as THREE from "three"\nwindow.r = THREE.REVISION\n' : 'window.r = 1\n'), 0o644)
    const out = path.join(dir, 'dist')
    const t = await nodeRun(pctx, root, [
      'const { build, version } = await import("vite")',
      'await build({ root: ' + JSON.stringify(dir) + ', logLevel: "silent", configFile: false, build: { outDir: ' + JSON.stringify(out) + ', emptyOutDir: true } })',
      'const fs = await import("node:fs")',
      'const files = fs.readdirSync(' + JSON.stringify(path.join(out, 'assets')) + ')',
      'console.log(JSON.stringify({ vite: version, assets: files }))',
    ].join('\n'), { esm: true, timeout: 180_000 })
    const ok = !t.problem && t.json.vite === vite.entry.version && t.json.assets.some((f) => f.endsWith('.js'))
    return [check('viewer-vite-build', vite.id, ok, 'vite ' + vite.entry.version + ' bundles a module importing three', t.problem ?? JSON.stringify(t.json), { path: root, stderr: t.stderr, remedy: 'img2 provision' })]
  } finally { rmrf(dir) }
}

export function tinyGlb() {
  const bin = Buffer.alloc(36)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4))
  const json = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }], buffers: [{ byteLength: 36 }],
  })
  const jsonBuf = Buffer.concat([Buffer.from(json), Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length
  const head = Buffer.alloc(12)
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8)
  const chunk = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b }
  return Buffer.concat([head, chunk(jsonBuf.length, 0x4e4f534a), jsonBuf, chunk(bin.length, 0x004e4942), bin])
}

const GLTF_VALIDATE = async (pctx, deps) => {
  const root = nodeRootOf(pctx.unitDir)
  const d = deps.find((x) => x.entry.name === 'gltf-validator')
  if (!d) return []
  const b64 = tinyGlb().toString('base64')
  const t = await nodeRun(pctx, root, [
    'const v = await import("gltf-validator")',
    'const api = v.default ?? v',
    'const bytes = new Uint8Array(Buffer.from(' + JSON.stringify(b64) + ', "base64"))',
    'const report = await api.validateBytes(bytes)',
    'console.log(JSON.stringify({ errors: report.issues.numErrors, warnings: report.issues.numWarnings, version: report.validatorVersion }))',
  ].join('\n'), { esm: true })
  return [check('gltf-validate', d.id, !t.problem && t.json.errors === 0, 'gltf-validator reports 0 errors for a one-triangle GLB', t.problem ?? 'errors=' + t.json.errors + ' warnings=' + t.json.warnings + ' validator ' + t.json.version, { path: root, stderr: t.stderr, remedy: 'img2 provision' })]
}

const PIXI = async (pctx, deps) => {
  const root = nodeRootOf(pctx.unitDir)
  const out = []
  for (const d of deps) {
    const t = await nodeRun(pctx, root, 'const fs = require("node:fs")\nconst v = JSON.parse(fs.readFileSync("node_modules/' + d.entry.name + '/package.json", "utf8")).version\nif (' + JSON.stringify(d.entry.name) + ' === "playwright") require("playwright")\nconsole.log(JSON.stringify({ version: v }))')
    out.push(check('pixi-replay-runtime-lock', d.id, !t.problem && t.json.version === d.entry.version, d.entry.name + '@' + d.entry.version, t.problem ?? d.entry.name + '@' + t.json.version, { path: root, stderr: t.stderr, remedy: 'img2 provision' }))
  }
  return out
}

const ESBUILD = async (pctx, deps) => {
  const root = nodeRootOf(pctx.unitDir)
  const d = deps.find((x) => x.entry.name === 'esbuild')
  if (!d) return []
  const t = await nodeRun(pctx, root, 'const e = require("esbuild")\nconst r = e.buildSync({ stdin: { contents: "export const x = 1" }, bundle: true, write: false, format: "esm" })\nconsole.log(JSON.stringify({ version: e.version, out: r.outputFiles[0].text.length > 0 }))')
  return [check('esbuild-build', d.id, !t.problem && t.json.version === d.entry.version && t.json.out === true, 'esbuild ' + d.entry.version + ' bundles a module', t.problem ?? JSON.stringify(t.json), { path: root, stderr: t.stderr, remedy: 'img2 provision (the platform binary @esbuild/<os>-<cpu> must be present)' })]
}

const browserKinds = (deps) => [...new Set(deps.flatMap((d) => (d.entry.artifacts ?? []).map((a) => a.kind)))]

async function launchProbe(pctx, { cwd, mod, browsers, types, depId, remedy }) {
  const out = []
  for (const type of types) {
    const isChromium = type === 'chromium'
    const launch = isChromium
      ? 'const b = await t.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] })'
      : 'const b = await t.launch({ headless: true })'
    const body = isChromium
      ? [
        '  const p = await b.newPage()',
        '  await p.setContent("<canvas id=c width=16 height=16></canvas>")',
        '  const r = await p.evaluate(() => {',
        '    const gl = c.getContext("webgl2") || c.getContext("webgl")',
        '    if (!gl) return { error: "no WebGL context" }',
        '    gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT)',
        '    const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)',
        '    return { gl: gl.getParameter(gl.VERSION), px: Array.from(px) }',
        '  })',
      ]
      : ['  const r = {}']
    const t = await script(pctx, nodeBin(pctx), ['-e', [
      '(async () => {',
      '  const pw = require(' + JSON.stringify(mod) + ')',
      '  const t = pw[' + JSON.stringify(type) + ']',
      '  ' + launch,
      ...body,
      '  const version = b.version()',
      '  await b.close()',
      '  console.log(JSON.stringify({ version, ...r }))',
      '})().catch((e) => { console.error(String(e && e.stack || e).slice(0, 1500)); process.exit(1) })',
    ].join('\n')], { cwd, env: { PLAYWRIGHT_BROWSERS_PATH: browsers }, timeout: 120_000 })
    const ok = !t.problem && (!isChromium || (!t.json.error && t.json.px?.[0] === 255 && t.json.px?.[1] === 0 && t.json.px?.[2] === 0))
    out.push(check('chromium-webgl-capture', depId, ok,
      type + ' launches headless' + (isChromium ? ' and renders a red WebGL clear' : ''),
      t.problem ?? (t.json.error ?? type + ' ' + t.json.version + (t.json.gl ? ' / ' + t.json.gl + ' px ' + JSON.stringify(t.json.px) : '')),
      { path: browsers, stderr: t.stderr, remedy: remedy ?? (process.platform === 'linux' ? 'install the browser system libraries (npx playwright install-deps) then rerun img2 doctor --runtime' : 'img2 provision') }))
  }
  return out
}

// A browser unit proves the browsers it installed through the pinned Playwright CLI beside them.
const BROWSER_UNIT = async (pctx, deps) => {
  const out = []
  for (const d of deps) {
    const types = [...new Set(browserKinds([d]).map((k) => (k === 'chromium-headless-shell' ? 'chromium' : k)))]
    out.push(...await launchProbe(pctx, { cwd: cliRootOf(pctx.unitDir), mod: 'playwright-core', browsers: browsersOf(pctx.unitDir), types, depId: d.id }))
  }
  return out
}

// An npm root that pins Playwright proves it can drive the browser unit it requires.
const PLAYWRIGHT_NODE = async (pctx, deps) => {
  const out = []
  for (const d of deps) {
    const browserId = d.entry.requires.find((r) => r.startsWith('browser-'))
    out.push(...await launchProbe(pctx, { cwd: nodeRootOf(pctx.unitDir), mod: 'playwright', browsers: pctx.browsersFor(browserId), types: ['chromium'], depId: d.id }))
  }
  return out
}

const MCP = async (pctx, deps) => {
  const root = nodeRootOf(pctx.unitDir)
  const out = []
  for (const d of deps) {
    let bin
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', ...d.entry.name.split('/'), 'package.json'), 'utf8'))
      const b = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0]
      bin = path.join(root, 'node_modules', ...d.entry.name.split('/'), b)
    } catch (e) {
      out.push(check('mcp-initialize-tools-list', d.id, false, d.entry.name + ' installed with a bin', e.message, { path: root, remedy: 'img2 provision' }))
      continue
    }
    const browserId = d.entry.requires.find((x) => x.startsWith('browser-'))
    const r = await pctx.mcp({ command: nodeBin(pctx), args: [bin], cwd: root, env: cleanEnv(browserId ? { PLAYWRIGHT_BROWSERS_PATH: pctx.browsersFor(browserId) } : {}), timeout: 60_000 })
    out.push(check('mcp-initialize-tools-list', d.id, r.ok, d.entry.name + ' answers initialize (and tools/list)',
      r.ok ? (r.serverInfo?.name ?? '?') + ' ' + (r.serverInfo?.version ?? '') + (r.toolCount !== null ? ', ' + r.toolCount + ' tools' : '') : r.error,
      { path: bin, stderr: tail(r.stderr), remedy: 'img2 provision' }))
  }
  return out
}

const S2V = async (pctx, deps) => {
  const d = deps[0]
  const exe = path.join(pctx.unitDir, 'Source2Viewer-CLI')
  const r = await pctx.run(exe, ['--version'], { env: cleanEnv({ DOTNET_ROOT: pctx.dotnetRoot ?? '', DOTNET_BUNDLE_EXTRACT_BASE_DIR: pctx.tmpDir }), timeout: 60_000 })
  const text = (r.stdout + ' ' + r.stderr).trim()
  const ok = r.code === 0 && !r.error && text.length > 0
  return [check('source2viewer-version', d.id, ok, 'Source2Viewer-CLI --version exits 0 (lock pin ' + d.entry.version + ')',
    r.error ?? (ok ? text.split(/\r?\n/)[0].slice(0, 200) : 'exit ' + r.code + (r.timedOut ? ' (timeout)' : '')), { path: exe, stderr: tail(r.stderr), remedy: 'img2 provision; on Linux install libicu and libssl' })]
}

const DOTNET = async (pctx, deps) => {
  const d = deps[0]
  const exe = path.join(pctx.unitDir, 'dotnet')
  const r = await pctx.run(exe, ['--list-runtimes'], { env: cleanEnv({ DOTNET_ROOT: pctx.unitDir, DOTNET_CLI_HOME: pctx.tmpDir, DOTNET_NOLOGO: '1' }), timeout: 60_000 })
  const ok = r.code === 0 && r.stdout.includes('Microsoft.NETCore.App ' + d.entry.version)
  return [check('dotnet-runtime-exec', d.id, ok, 'dotnet --list-runtimes lists Microsoft.NETCore.App ' + d.entry.version, r.error ?? (r.stdout.trim().split('\n')[0] || 'exit ' + r.code), { path: exe, stderr: tail(r.stderr), remedy: 'img2 provision' })]
}

const PYTHON_RT = async (pctx, deps) => {
  const d = deps[0]
  const exe = path.join(pctx.unitDir, 'bin', 'python3')
  const t = await script(pctx, exe, ['-I', '-B', '-c', 'import sys, json; print(json.dumps({"version": ".".join(map(str, sys.version_info[:3]))}))'])
  return [check('python-runtime-version', d.id, !t.problem && t.json.version === d.entry.version, 'CPython ' + d.entry.version, t.problem ?? 'CPython ' + t.json.version, { path: exe, stderr: t.stderr, remedy: 'img2 provision' })]
}

const NODE_RT = async (pctx, deps) => {
  const d = deps[0]
  const exe = path.join(pctx.unitDir, 'bin', 'node')
  const r = await pctx.run(exe, ['--version'], { env: cleanEnv(), timeout: 30_000 })
  const v = r.stdout.trim()
  return [check('node-runtime-version', d.id, r.code === 0 && v === 'v' + d.entry.version, 'node v' + d.entry.version, r.error ?? v ?? 'exit ' + r.code, { path: exe, stderr: tail(r.stderr), remedy: 'img2 provision' })]
}

export const PROBES = {
  'python-runtime-version': PYTHON_RT,
  'node-runtime-version': NODE_RT,
  'bpy-import-version-export': BPY,
  'numpy-array-op': NUMPY,
  'pillow-image-op': PILLOW,
  'playwright-python-import': PLAYWRIGHT_PY,
  'vision-offline-inference': VISION,
  'node-three-import': NODE_THREE,
  'viewer-vite-build': VITE_BUILD,
  'gltf-validate': GLTF_VALIDATE,
  'pixi-replay-runtime-lock': PIXI,
  'esbuild-build': ESBUILD,
  'playwright-chromium-capture': PLAYWRIGHT_NODE,
  'chromium-webgl-capture': BROWSER_UNIT,
  'mcp-playwright-browsers': BROWSER_UNIT,
  'mcp-initialize-tools-list': MCP,
  'source2viewer-version': S2V,
  'dotnet-runtime-exec': DOTNET,
}

// Each distinct implementation runs once per unit, over every dependency whose probe id maps to it.
export async function runProbes(pctx, deps) {
  const groups = new Map()
  const out = []
  for (const d of deps) {
    const fn = PROBES[d.entry.probe]
    if (!fn) { out.push(check(d.entry.probe, d.id, false, 'a known probe', 'no probe implementation for ' + d.entry.probe, { remedy: 'upgrade img2' })); continue }
    if (!groups.has(fn)) groups.set(fn, [])
    groups.get(fn).push(d)
  }
  for (const [fn, covered] of groups) out.push(...await fn(pctx, covered))
  return out
}
