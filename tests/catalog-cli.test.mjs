import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const BIN = path.join(ROOT, 'bin', 'img2.mjs')

import { CATALOG_URL } from '../bin/catalog.mjs'

function run(args, env, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env,
    cwd: opts.cwd,
    timeout: opts.timeout ?? 20000,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
  })
}

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'img2-plugins-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const H = path.join(root, 'H')
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), NO_COLOR: '1' }
  delete env.IMG2_HOME
  delete env.IMG2THREEJS_HOME
  return { root, home, H, env }
}

function writeFetchFixture(root, payload, { fetchStatus = 200, fetchReject = false } = {}) {
  const fixturePath = path.join(root, 'catalog.json')
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  fs.writeFileSync(fixturePath, text)
  const preloadPath = path.join(root, 'preload.mjs')
  fs.writeFileSync(preloadPath, `
import fs from 'node:fs'
const MARKER = ${JSON.stringify(path.join(root, 'fetch-called'))}
const FIXTURE = ${JSON.stringify(fixturePath)}
const TARGET = ${JSON.stringify(CATALOG_URL)}
const STATUS = ${JSON.stringify(fetchStatus)}
const TEXT = fs.readFileSync(FIXTURE, 'utf8')
const REJECT = ${JSON.stringify(fetchReject)}
globalThis.fetch = (url) => {
  if (url !== TARGET) throw new Error('unexpected catalog URL')
  fs.writeFileSync(MARKER, 'called')
  if (REJECT) return Promise.reject(new Error('simulated network failure'))
  return Promise.resolve({ status: STATUS, text: () => Promise.resolve(TEXT) })
}
`)
  return preloadPath
}

function snapshotTree(dir) {
  if (!fs.existsSync(dir)) return null
  const walk = (d) => {
    const out = {}
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) out[e.name] = walk(p)
      else if (e.isFile()) out[e.name] = fs.readFileSync(p)
      else if (e.isSymbolicLink()) out[e.name] = { __symlink: fs.readlinkSync(p) }
    }
    return out
  }
  return walk(dir)
}

const fixtureCatalog = {
  schema: 1,
  updatedAt: '2026-10-07',
  plugins: [
    { id: 'character', description: 'd1', source: 'img2threejs/plugin-character', access: 'public', npmCli: null },
    { id: 'environment', description: 'd2', source: 'img2threejs/plugin-environment', access: 'private', npmCli: 'img2-environment' },
    { id: 'hello-cube', description: 'd3', source: 'img2threejs/plugin-hello-cube', access: 'public', npmCli: null },
  ],
}

function envFor(sb, { preload = null, home = sb.home, invalidHome = false } = {}) {
  const env = { ...sb.env, HOME: home }
  if (invalidHome) env.IMG2_HOME = 'relative-home'
  if (preload) env.NODE_OPTIONS = '--import=' + preload
  return env
}

// ---------------------------------------------------------------- tests

test('plugins --json: counts match the validated list and the source is the canonical URL', (t) => {
  const sb = sandbox(t)
  const preload = writeFetchFixture(sb.root, fixtureCatalog)
  const r = run(['plugins', '--json'], envFor(sb, { preload }))
  assert.equal(r.status, 0, r.stderr)
  const env = JSON.parse(r.stdout)
  assert.equal(env.status, 'ok')
  assert.equal(env.source, CATALOG_URL)
  assert.equal(env.counts.total, fixtureCatalog.plugins.length)
  assert.equal(env.counts.public, 2)
  assert.equal(env.counts.private, 1)
  assert.equal(env.counts.npmClis, 1)
  assert.equal(env.plugins.length, 3)
})

test('plugins --json: error vs empty catalog are distinguishable (counts:null on error, counts.total:0 on ok)', (t) => {
  const sb = sandbox(t)
  const preload = writeFetchFixture(sb.root, { schema: 1, updatedAt: '2026-10-07', plugins: [] })
  const r1 = run(['plugins', '--json'], envFor(sb, { preload }))
  assert.equal(r1.status, 0)
  const ok = JSON.parse(r1.stdout)
  assert.equal(ok.status, 'ok')
  assert.equal(ok.counts.total, 0)

  const badPreload = writeFetchFixture(sb.root, { schema: 2, updatedAt: '2026-10-07', plugins: [] })
  const r2 = run(['plugins', '--json'], envFor(sb, { preload: badPreload }))
  assert.equal(r2.status, 1, r2.stderr)
  const err = JSON.parse(r2.stdout)
  assert.equal(err.status, 'error')
  assert.equal(err.counts, null)
  assert.deepEqual(err.plugins, [])
  assert.equal(err.source, CATALOG_URL, 'error envelope still names the canonical source')
  assert.ok(err.error && /schema/.test(err.error), 'error must carry the validation cause')
})

test('plugins --json: a 500 response is reported with status:error and counts:null (exit 1)', (t) => {
  const sb = sandbox(t)
  const preload = writeFetchFixture(sb.root, fixtureCatalog, { fetchStatus: 503 })
  const r = run(['plugins', '--json'], envFor(sb, { preload }))
  assert.equal(r.status, 1, r.stderr)
  const err = JSON.parse(r.stdout)
  assert.equal(err.status, 'error')
  assert.equal(err.counts, null)
  assert.equal(err.source, CATALOG_URL)
})


test('plugins: refuses a positional argument before any network access (exit 2; --json emits the same envelope)', (t) => {
  const sb = sandbox(t)
  const preload = writeFetchFixture(sb.root, fixtureCatalog)
  const r = run(['plugins', 'extra-positional', '--json'], envFor(sb, { preload }))
  assert.equal(r.status, 2, r.stderr)
  assert.equal(fs.existsSync(path.join(sb.root, 'fetch-called')), false)
  const err = JSON.parse(r.stdout)
  assert.equal(err.status, 'error')
  assert.equal(err.counts, null)
  assert.deepEqual(err.plugins, [])
  assert.equal(err.source, CATALOG_URL, 'source is the canonical URL even on usage refusal')
})

test('plugins: refuses a value-bearing irrelevant flag before any network access (exit 2)', (t) => {
  const sb = sandbox(t)
  const preload = writeFetchFixture(sb.root, fixtureCatalog)
  const r = run(['plugins', '--home', '/tmp/x', '--json'], envFor(sb, { preload }))
  assert.equal(r.status, 2, r.stderr)
  assert.equal(fs.existsSync(path.join(sb.root, 'fetch-called')), false)
  const err = JSON.parse(r.stdout)
  assert.equal(err.status, 'error')
  assert.equal(err.counts, null)
  assert.match(err.error, /--home/)
})

test('plugins: refuses a boolean irrelevant flag before any network access (exit 2)', (t) => {
  const sb = sandbox(t)
  const preload = writeFetchFixture(sb.root, fixtureCatalog)
  const r = run(['plugins', '--yes', '--json'], envFor(sb, { preload }))
  assert.equal(r.status, 2, r.stderr)
  assert.equal(fs.existsSync(path.join(sb.root, 'fetch-called')), false)
  const err = JSON.parse(r.stdout)
  assert.equal(err.status, 'error')
  assert.match(err.error, /--yes/)
})

test('plugins works despite an invalid ambient IMG2_HOME', (t) => {
  const sb = sandbox(t)
  const preload = writeFetchFixture(sb.root, fixtureCatalog)
  const r = run(['plugins', '--json'], envFor(sb, { preload, invalidHome: true }))
  assert.equal(r.status, 0, r.stderr)
  const env = JSON.parse(r.stdout)
  assert.equal(env.status, 'ok')
})

test('plugins: read-only on a fresh sandbox and on a populated $IMG2_HOME -- byte-identical trees', (t) => {
  const sb = sandbox(t)
  const preload = writeFetchFixture(sb.root, fixtureCatalog)

  const before1 = snapshotTree(sb.home)
  const r1 = run(['plugins', '--json'], envFor(sb, { preload }))
  assert.equal(r1.status, 0)
  assert.deepEqual(snapshotTree(sb.home), before1)

  fs.mkdirSync(sb.H, { recursive: true })
  fs.writeFileSync(path.join(sb.H, 'plugins.json'), 'corrupt registry: must not be read')
  fs.mkdirSync(path.join(sb.H, 'harness'), { recursive: true })
  fs.writeFileSync(path.join(sb.H, 'harness', 'MARKER'), 'do-not-touch\n')
  const before2 = snapshotTree(sb.H)
  const r2 = run(['plugins'], { ...envFor(sb, { preload }), IMG2_HOME: sb.H })
  assert.equal(r2.status, 0)
  assert.deepEqual(snapshotTree(sb.H), before2)
})

test('plugins --json: large catalog (>64 KiB envelope) round-trips through JSON.parse with exact counts', (t) => {
  const sb = sandbox(t)
  const N = 500
  const desc = 'x'.repeat(400)
  const plugins = []
  for (let i = 0; i < N; i += 1) {
    plugins.push({
      id: 'plugin-' + String(i).padStart(4, '0'),
      description: desc,
      source: 'img2threejs/plugin-' + String(i).padStart(4, '0'),
      access: i % 7 === 0 ? 'private' : 'public',
      npmCli: i % 11 === 0 ? 'img2-plugin-' + String(i).padStart(4, '0') : null,
    })
  }
  const payload = { schema: 1, updatedAt: '2026-10-07', plugins }
  const preload = writeFetchFixture(sb.root, payload)
  const r = run(['plugins', '--json'], envFor(sb, { preload }))
  assert.equal(r.status, 0, r.stderr)
  const env = JSON.parse(r.stdout)
  assert.equal(env.status, 'ok')
  assert.equal(env.counts.total, N)
  assert.equal(env.plugins.length, N)
  assert.ok(JSON.stringify(env).length > 64 * 1024, 'envelope must exceed one default pipe highWaterMark')
})
