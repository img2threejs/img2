// Builds one unit into a staging directory. Every external program goes through ctx.exec (the injectable
// runner); every download goes through ctx.cache (hash verified before use).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { StepError } from './errors.mjs'
import { extractTarGz, extractZip } from './extract.mjs'
import { atomicWriteFile, ensureDir, isUnder, rmrf, treeDigest } from './fsx.mjs'
import { artifactsOf, integrityOf } from './lock.mjs'
import { installNpmRoot } from './npmroot.mjs'
import { evaluatePipCheck } from './pipcheck.mjs'
import { threeInventoryDigest } from './selectors.mjs'
import { browsersOf, cliRootOf, nodeRootOf, venvPython } from './probes.mjs'

export const PROVISION_SCHEMA = 1

const PW_BROWSER_NAMES = { chromium: 'chromium', 'chromium-headless-shell': 'chromium-headless-shell', firefox: 'firefox', webkit: 'webkit' }

export function unitFingerprint({ unit, platform, lock, cliDep }) {
  const h = crypto.createHash('sha256')
  h.update(JSON.stringify({ v: PROVISION_SCHEMA, platform, unit: unit.name, deps: unit.deps.map((d) => d.entry), cli: cliDep ?? null }))
  return h.digest('hex')
}

// Fetch (and verify) every artifact of the given dependencies on this platform.
async function fetchArtifacts(ctx, entries) {
  const out = []
  for (const entry of entries) {
    for (const x of artifactsOf(entry, ctx.platform)) {
      if (x.skipped) continue
      const label = entry.id + (x.part === 'transitive' ? ' > ' + x.name + '@' + x.version : '')
      const got = await ctx.step(label, 'download+verify', () => ctx.cache.fetch(x.artifact, label))
      out.push({ dep: entry.id, ...x, got })
      ctx.record({ kind: 'artifact', dependency: entry.id, name: x.name, version: x.version, url: x.artifact.url, sha256: got.sha256, algo: got.algo, size: got.size, cached: got.cached, weak: got.weak })
    }
  }
  return out
}

// ---------------------------------------------------------------- python

async function systemPython(ctx, lockEntry) {
  const want = /cp(\d)(\d+)/.exec(lockEntry?.constraints?.python?.abi ?? 'cp311')
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const seen = new Set()
  const found = []
  for (const name of [`python${want[1]}.${want[2]}`, 'python3']) {
    for (const dir of dirs) {
      const p = path.join(dir, name)
      if (seen.has(p) || !fs.existsSync(p)) continue
      seen.add(p)
      const r = await ctx.run(p, ['-I', '-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'], { timeout: 30_000 })
      const v = r.stdout.trim()
      found.push(p + ' = ' + (v || 'unusable'))
      if (r.code === 0 && v.startsWith(want[1] + '.' + want[2] + '.')) return { path: p, version: v, managed: false }
    }
  }
  throw new StepError('no usable Python ' + want[1] + '.' + want[2] + ' interpreter',
    'the managed CPython from the lock is disabled (--skip) and no matching system python was found.\nchecked: ' + (found.join('; ') || 'nothing on PATH'))
}

export async function interpreter(ctx) {
  const managed = path.join(ctx.rtDir, 'runtime', 'python-runtime', 'bin', 'python3')
  if (fs.existsSync(managed)) {
    const version = ctx.lock.dependencies.find((e) => e.id === 'python-runtime')?.version
    return { path: managed, version, managed: true }
  }
  const entry = ctx.lock.dependencies.find((e) => e.id === 'python-runtime')
  return systemPython(ctx, entry)
}

async function buildVenv(ctx, unit, stage, pipDeps) {
  const py = await ctx.step(unit.name, 'select interpreter', () => interpreter(ctx))
  ctx.record({ kind: 'interpreter', unit: unit.name, path: py.path, version: py.version, managed: py.managed })
  const fetched = await fetchArtifacts(ctx, pipDeps.map((d) => d.entry))
  // A system interpreter would make venv/bin/python a symlink out of the runtime tree (refused by the
  // selector contract); copies keep it inside. The managed CPython stays a symlink (it needs its lib/).
  await ctx.exec(unit.name, 'python -m venv', py.path, ['-I', '-m', 'venv', ...(py.managed ? [] : ['--copies']), path.join(stage, 'venv')], { timeout: 300_000 })
  const wheels = path.join(stage, '.wheels')
  ensureDir(wheels)
  for (const f of fetched) {
    const name = f.artifact.filename ?? path.basename(new URL(f.artifact.url).pathname)
    if (!/^[A-Za-z0-9_.+!-]+\.whl$/.test(name)) throw new StepError('refusing non-wheel pip artifact ' + JSON.stringify(name) + ' (--only-binary=:all:)')
    const dest = path.join(wheels, name)
    if (fs.existsSync(dest)) continue
    try { fs.linkSync(f.got.file, dest) } catch { fs.copyFileSync(f.got.file, dest) }
  }
  const req = []
  const byArtifact = new Map(fetched.map((f) => [f.artifact.url, f]))
  const wanted = new Map()
  for (const entry of pipDeps.map((d) => d.entry)) {
    for (const x of artifactsOf(entry, ctx.platform)) {
      const f = byArtifact.get(x.artifact.url)
      const integ = integrityOf(x.artifact)
      const key = x.name.toLowerCase().replace(/[-_.]+/g, '-') + '==' + x.version
      if (!wanted.has(key)) wanted.set(key, new Set())
      wanted.get(key).add(integ.weak ? 'sha256:' + f.got.sha256 : integ.algo + ':' + integ.hex)
    }
  }
  const seen = new Map()
  for (const key of wanted.keys()) {
    const [n, v] = key.split('==')
    if (seen.has(n) && seen.get(n) !== v) throw new StepError('two versions of ' + n + ' in one environment: ' + seen.get(n) + ' and ' + v)
    seen.set(n, v)
  }
  for (const [k, hs] of [...wanted.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) req.push(k + ' ' + [...hs].sort().map((h) => '--hash=' + h).join(' '))
  const reqFile = path.join(stage, 'requirements.lock.txt')
  atomicWriteFile(reqFile, '# generated from dependencies.lock.json by img2 provision\n' + req.join('\n') + '\n', 0o644)
  const venvPy = venvPython(stage)
  await ctx.exec(unit.name, 'pip install --require-hashes', venvPy, ['-I', '-m', 'pip', '--isolated', 'install', '--no-input', '--no-index', '--find-links', wheels,
    '--require-hashes', '--only-binary=:all:', '--no-deps', '-r', reqFile], { timeout: 1_800_000 })
  const waivers = []
  const check = await ctx.exec(unit.name, 'pip check', venvPy, ['-I', '-m', 'pip', '--isolated', 'check'], { timeout: 120_000, tolerateFailure: true })
  if (!check.ok) {
    const output = [check.stdout, check.stderr].filter(Boolean).join('\n')
    // Only a failed (not killed, not unstartable) pip check is ever examined for the waiver.
    const candidates = check.error || check.timedOut || check.code === null ? [] : fetched.map((f) => {
      const integ = integrityOf(f.artifact)
      const filename = f.artifact.filename ?? path.basename(new URL(f.artifact.url).pathname)
      return { name: f.name, version: f.version, filename, file: path.join(wheels, filename), lockSha256: integ.algo === 'sha256' ? integ.hex : null }
    })
    const verdict = evaluatePipCheck({ output, candidates, platform: ctx.platform })
    if (check.error || check.timedOut || check.code === null || verdict.fatal.length) {
      throw new StepError('pip check failed (exit ' + check.code + ') in ' + unit.name, [check.error, output.trim().slice(-1500), ...verdict.fatal].filter(Boolean).join('\n'), { exitCode: check.code })
    }
    for (const w of verdict.waivers) {
      waivers.push(w)
      ctx.record({ kind: 'waiver', unit: unit.name, ...w })
    }
  }
  rmrf(wheels)
  return { python: py, installed: req.map((l) => l.split(' ')[0]), waivers }
}

// ---------------------------------------------------------------- npm roots

function runScriptFor(ctx, unit) {
  return async ({ root, node }) => {
    const pkgDir = path.join(root, node.dir)
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    for (const key of ['preinstall', 'install', 'postinstall']) {
      if (!pkg.scripts?.[key]) continue
      await ctx.exec(unit.name, 'reviewed ' + key + ' script of ' + node.name, '/bin/sh', ['-c', pkg.scripts[key]], {
        cwd: pkgDir, env: { PATH: path.join(root, 'node_modules', '.bin') + path.delimiter + path.join(ctx.rtDir, 'runtime', 'node-runtime', 'bin') + path.delimiter + '/usr/bin:/bin' },
      })
    }
  }
}

async function buildNpm(ctx, unit, rootDir, npmDeps, label) {
  const fetched = await fetchArtifacts(ctx, npmDeps.map((d) => d.entry ?? d))
  const packages = fetched.filter((f) => f.artifact.url).map((f) => ({ name: f.name, version: f.version, file: f.got.file, scriptsReviewed: f.scriptsReviewed }))
  const rootDeps = npmDeps.map((d) => ({ name: (d.entry ?? d).name, version: (d.entry ?? d).version }))
  const result = await ctx.step(unit.name, 'npm install (pinned tarballs) ' + label, () => installNpmRoot({ root: rootDir, packages, rootDeps, runScript: runScriptFor(ctx, unit), label }))
  ctx.record({ kind: 'npm-root', unit: unit.name, root: label, packages: result.placements.length, scriptsSkipped: result.scriptsSkipped, scriptsRun: result.scriptsRun })
  return result
}

// ---------------------------------------------------------------- browsers

async function buildBrowser(ctx, unit, stage, dep, cliDep) {
  if (!cliDep) throw new StepError('no pinned Playwright package in the lock provides the CLI for ' + dep.id)
  const kinds = [...new Set(forKinds(dep, ctx.platform))]
  const names = kinds.map((k) => PW_BROWSER_NAMES[k]).filter(Boolean)
  if (!names.length) throw new StepError('no installable browser for ' + dep.id + ' on ' + ctx.platform)
  await buildNpm(ctx, unit, cliRootOf(stage), [cliDep], 'cli')
  const browsers = browsersOf(stage)
  ensureDir(browsers)
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify({ dep, cliDep: cliDep.id, platform: ctx.platform, names })).digest('hex').slice(0, 32)
  const cacheDir = path.join(ctx.cacheDir, 'browsers', cacheKey)
  const recorded = path.join(cacheDir, 'digest.txt')
  let restored = false
  if (fs.existsSync(recorded)) {
    const want = fs.readFileSync(recorded, 'utf8').trim()
    if (treeDigest(path.join(cacheDir, 'tree')) === want) {
      rmrf(browsers)
      fs.cpSync(path.join(cacheDir, 'tree'), browsers, { recursive: true, verbatimSymlinks: true })
      ctx.record({ kind: 'browser-cache', unit: unit.name, restoredFrom: cacheDir, treeSha256: want })
      restored = true
    } else rmrf(cacheDir)
  }
  if (!restored) {
    if (ctx.offline) throw new StepError('--offline: browsers for ' + dep.id + ' are not in the cache', 'the pinned Playwright CLI downloads them from its CDN; run once online to fill the cache')
    const cli = path.join(cliRootOf(stage), 'node_modules', 'playwright-core', 'cli.js')
    await ctx.exec(unit.name, 'playwright install ' + names.join(' '), path.join(ctx.rtDir, 'runtime', 'node-runtime', 'bin', 'node'), [cli, 'install', ...names], {
      cwd: cliRootOf(stage), env: { PLAYWRIGHT_BROWSERS_PATH: browsers, PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: '1' }, timeout: 1_800_000,
    })
    const digest = treeDigest(browsers)
    ctx.record({ kind: 'browser-tree', unit: unit.name, dependency: dep.id, treeSha256: digest, note: 'sha256 computed locally over the installed tree; the lock pins no SHA-256 for these archives' })
    rmrf(cacheDir)
    ensureDir(cacheDir)
    fs.cpSync(browsers, path.join(cacheDir, 'tree'), { recursive: true, verbatimSymlinks: true })
    atomicWriteFile(recorded, digest + '\n', 0o600)
  }
  const exec = await ctx.exec(unit.name, 'playwright executablePath', path.join(ctx.rtDir, 'runtime', 'node-runtime', 'bin', 'node'), ['-e',
    'process.stdout.write(JSON.stringify({ chromium: require("playwright-core").chromium.executablePath() }))'], {
    cwd: cliRootOf(stage), env: { PLAYWRIGHT_BROWSERS_PATH: browsers }, timeout: 60_000,
  })
  let exe = null
  try { exe = JSON.parse(exec.stdout.trim().split('\n').pop()).chromium } catch { /* fall through */ }
  if (!exe || !isUnder(stage, exe) || !fs.existsSync(exe)) throw new StepError('Playwright did not install a Chromium executable under the staged unit', 'reported ' + JSON.stringify(exe))
  return { exports: { IMG2_CHARACTER_BROWSER: path.relative(stage, exe), PLAYWRIGHT_BROWSERS_PATH: 'browsers' } }
}

function forKinds(dep, platform) {
  return (dep.artifacts ?? []).filter((a) => a.platform === platform || a.platform === 'any').map((a) => a.kind)
}

// ---------------------------------------------------------------- archives

function flatten(dir) {
  const names = fs.readdirSync(dir)
  if (names.length === 1 && fs.lstatSync(path.join(dir, names[0])).isDirectory()) {
    const inner = path.join(dir, names[0])
    for (const n of fs.readdirSync(inner)) fs.renameSync(path.join(inner, n), path.join(dir, n))
    fs.rmdirSync(inner)
  }
}

async function buildArchive(ctx, unit, stage, dep, { strip, flat = false }) {
  const [f] = await fetchArtifacts(ctx, [dep])
  if (!f) throw new StepError('no artifact for ' + dep.id + ' on ' + ctx.platform)
  const name = f.artifact.filename ?? path.basename(new URL(f.artifact.url).pathname)
  const stats = await ctx.step(dep.id, 'extract ' + name, async () => (/\.zip$/.test(name) ? extractZip(f.got.file, stage, { strip }) : extractTarGz(f.got.file, stage, { strip })))
  if (flat) flatten(stage)
  ctx.record({ kind: 'extract', unit: unit.name, archive: name, entries: stats.entries, bytes: stats.bytes })
}

// ---------------------------------------------------------------- vision models

function hfTarget(artifact) {
  const u = new URL(artifact.url)
  const m = /^\/([^/]+)\/([^/]+)\/resolve\/([0-9a-f]{40})\/(.+)$/.exec(u.pathname)
  if (!m) return null
  return { repo: m[1] + '/' + m[2], revision: m[3], file: decodeURIComponent(m[4]) }
}

async function placeModels(ctx, unit, stage, modelDeps) {
  const fetched = await fetchArtifacts(ctx, modelDeps.map((d) => d.entry))
  const hf = path.join(stage, 'huggingface')
  const models = path.join(stage, 'models')
  ensureDir(hf)
  ensureDir(models)
  const refs = new Map()
  for (const f of fetched) {
    const target = hfTarget(f.artifact)
    if (target) {
      const repoDir = path.join(hf, 'models--' + target.repo.replace('/', '--'))
      const snap = path.join(repoDir, 'snapshots', target.revision)
      const dest = path.join(snap, target.file)
      if (!isUnder(snap, dest)) throw new StepError('unsafe model file name ' + target.file)
      ensureDir(path.dirname(dest))
      fs.copyFileSync(f.got.file, dest)
      refs.set(repoDir, target.revision)
    } else {
      const name = f.artifact.filename
      if (!/^[A-Za-z0-9._-]+$/.test(name ?? '')) throw new StepError('unsafe model file name ' + JSON.stringify(name))
      fs.copyFileSync(f.got.file, path.join(models, name))
    }
  }
  for (const [repoDir, revision] of refs) {
    ensureDir(path.join(repoDir, 'refs'))
    atomicWriteFile(path.join(repoDir, 'refs', 'main'), revision, 0o644)
  }
}

// ---------------------------------------------------------------- unit dispatcher

// Returns { exports } where export paths are relative to the unit directory.
export async function buildUnit(ctx, unit, stage, cliDep) {
  const exportsOut = {}
  const waivers = []
  const deps = unit.deps
  const single = deps[0]
  if (unit.name === 'runtime/python-runtime') {
    await buildArchive(ctx, unit, stage, single.entry, { strip: 1 })
    exportsOut.IMG2_PYTHON = 'bin/python3'
  } else if (unit.name === 'runtime/node-runtime') {
    await buildArchive(ctx, unit, stage, single.entry, { strip: 1 })
    exportsOut.IMG2_CHARACTER_NODE = 'bin/node'
  } else if (unit.name === 'cs2/cs2-source2viewer-cli') {
    await buildArchive(ctx, unit, stage, single.entry, { strip: 0, flat: true })
    const exe = path.join(stage, 'Source2Viewer-CLI')
    if (!fs.existsSync(exe)) throw new StepError('Source2Viewer-CLI executable not found in the archive', fs.readdirSync(stage).join(', '))
    fs.chmodSync(exe, 0o755)
    exportsOut.SOURCE2VIEWER_CLI = 'Source2Viewer-CLI'
  } else if (unit.name === 'cs2/cs2-dotnet-runtime') {
    await buildArchive(ctx, unit, stage, single.entry, { strip: 0 })
    if (fs.existsSync(path.join(stage, 'dotnet'))) fs.chmodSync(path.join(stage, 'dotnet'), 0o755)
    exportsOut.DOTNET_ROOT = '.'
  } else if (unit.environment === 'browsers') {
    Object.assign(exportsOut, (await buildBrowser(ctx, unit, stage, single.entry, cliDep)).exports)
  } else {
    const pipDeps = deps.filter((d) => d.entry.kind === 'pip')
    const npmDeps = deps.filter((d) => d.entry.kind === 'npm')
    const modelDeps = deps.filter((d) => d.entry.kind === 'model')
    if (pipDeps.length) waivers.push(...(await buildVenv(ctx, unit, stage, pipDeps)).waivers)
    if (npmDeps.length) await buildNpm(ctx, unit, nodeRootOf(stage), npmDeps, 'node')
    if (modelDeps.length) await placeModels(ctx, unit, stage, modelDeps)
    if (pipDeps.length && unit.environment === 'character') exportsOut.IMG2_CHARACTER_BPY_PYTHON = path.relative(stage, venvPython(stage))
    if (pipDeps.length && unit.environment === 'interior') exportsOut.IMG2_BLENDER_PYTHON = path.relative(stage, venvPython(stage))
    if (pipDeps.length && unit.environment === 'vision') exportsOut.IMG2THREEJS_VISION_PYTHON = path.relative(stage, venvPython(stage))
    if (unit.environment === 'character-node') {
      const three = path.join(nodeRootOf(stage), 'node_modules', 'three')
      exportsOut.IMG2_CHARACTER_THREE_ROOT = path.relative(stage, three)
      try { exportsOut.IMG2_CHARACTER_THREE_SHA256 = threeInventoryDigest(three) } catch (e) {
        throw new StepError('cannot hash the installed Three package', e.message)
      }
    }
  }
  return { exports: exportsOut, waivers }
}
