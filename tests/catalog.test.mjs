import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { CATALOG_URL, getCatalog } from '../bin/catalog.mjs'

function payload(plugins, { schema = 1, updatedAt = '2026-01-15' } = {}) {
  return JSON.stringify({ schema, updatedAt, plugins })
}

function okJson(text) {
  return async () => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } })
}
function okPayload(plugins, overrides) { return okJson(payload(plugins, overrides)) }

const ROWS = [
  { id: 'img-conv', description: 'image to threejs', source: 'img2threejs/plugin-img-conv', access: 'public', npmCli: null },
  { id: 'alpha', description: 'a', source: 'img2threejs/plugin-alpha', access: 'public', npmCli: 'img2-alpha' },
  { id: 'beta', description: 'b', source: 'img2threejs/plugin-beta', access: 'private', npmCli: null },
  { id: 'gamma', description: 'g', source: 'img2threejs/plugin-gamma', access: 'public', npmCli: '@img2threejs/gamma' },
]

test('valid catalog: counts, sorted ids, install route by npmCli presence', async () => {
  const r = await getCatalog({ fetchImpl: okPayload(ROWS) })
  assert.deepEqual(r.plugins.map(p => p.id), ['alpha', 'beta', 'gamma', 'img-conv'])
  assert.deepEqual(r.counts, { total: 4, public: 3, private: 1, npmClis: 2 })
  const byId = Object.fromEntries(r.plugins.map(p => [p.id, p.install]))
  assert.deepEqual(byId.alpha, ['npx', '--yes', 'img2-alpha', 'install', '--yes'])
  assert.deepEqual(byId.gamma, ['npx', '--yes', '@img2threejs/gamma', 'install', '--yes'])
  assert.deepEqual(byId.beta, ['npx', '--yes', '@img2threejs/img2@latest', 'add', 'img2threejs/plugin-beta', '--plugin', 'beta', '--yes'])
  assert.deepEqual(byId['img-conv'], ['npx', '--yes', '@img2threejs/img2@latest', 'add', 'img2threejs/plugin-img-conv', '--plugin', 'img-conv', '--yes'])
})

test('valid empty catalog returns zero counts and a success envelope', async () => {
  const r = await getCatalog({ fetchImpl: okPayload([]) })
  assert.equal(r.status, 'ok')
  assert.equal(r.source, CATALOG_URL)
  assert.equal(r.updatedAt, '2026-01-15')
  assert.deepEqual(r.counts, { total: 0, public: 0, private: 0, npmClis: 0 })
  assert.deepEqual(r.plugins, [])
})

test('HTTP, network, and body failures surface actionable reason in Error.message', async () => {
  await assert.rejects(getCatalog({ fetchImpl: async () => new Response('nope', { status: 500 }) }),
    err => err instanceof Error && /HTTP 500/.test(err.message))
  await assert.rejects(getCatalog({ fetchImpl: async () => { throw new TypeError('socket hang up') } }),
    err => err instanceof Error && /socket hang up/.test(err.message))
  await assert.rejects(getCatalog({ fetchImpl: okJson('{not json') }),
    err => err instanceof Error && /not valid JSON/.test(err.message))
  await assert.rejects(getCatalog({ fetchImpl: okJson('null') }),
    err => err instanceof Error && /payload must be a JSON object/.test(err.message))
})

test('a stalled response body is bounded by the internal request timeout', { timeout: 15000 }, async (t) => {
  let requested = false
  const server = http.createServer((_req, res) => {
    requested = true
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"schema":1,')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  const { port } = server.address()
  await assert.rejects(
    getCatalog({ fetchImpl: (_url, init) => fetch('http://127.0.0.1:' + port, init) }),
    err => /failed to read catalog body/.test(err.message) && /abort|timeout/i.test(err.message)
  )
  assert.equal(requested, true)
})

test('invalid schema, date, and array shape fail with the actual reason in Error.message', async () => {
  await assert.rejects(getCatalog({ fetchImpl: okPayload([], { schema: 2 }) }),
    err => /schema must be 1/.test(err.message))
  for (const updatedAt of ['2026-13-01', '2025-02-30', '2026-02-30', '2025-04-31', '2025-00-15', '2025-01-32', '2025-01-00', '2025-1-1', '']) {
    await assert.rejects(getCatalog({ fetchImpl: okPayload([], { updatedAt }) }),
      err => /updatedAt must be a calendar date YYYY-MM-DD/.test(err.message),
      'expected rejection for updatedAt=' + JSON.stringify(updatedAt))
  }
  const r = await getCatalog({ fetchImpl: okPayload([], { updatedAt: '2024-02-29' }) })
  assert.equal(r.updatedAt, '2024-02-29')
  await assert.rejects(getCatalog({ fetchImpl: okJson(payload([]).replace('[]', '{"a":1}')) }),
    err => /plugins must be an array/.test(err.message))
})

test('identity, source, npmCli fields reject trailing newline or control character', async () => {
  for (const [field, value] of [
    ['id', 'alpha\n'],
    ['id', 'alpha\u0000'],
    ['source', 'img2threejs/plugin-foo\n'],
    ['source', 'IMG2THREEJS/PLUGIN-FOO\u0000'],
    ['npmCli', 'img2-alpha\n'],
  ]) {
    const row = { id: 'alpha', description: 'd', source: 'img2threejs/plugin-foo', access: 'public', npmCli: null }
    row[field] = value
    await assert.rejects(getCatalog({ fetchImpl: okPayload([row]) }),
      err => err instanceof Error && err.message.includes(field),
      'expected rejection for ' + field + '=' + JSON.stringify(value))
  }
})

test('npmCli is namespace-locked: bare img2-* or @img2threejs/<lowercase> only', async () => {
  for (const npmCli of ['left-pad', '@other/cli', 'img2', '@img2threejs', 'IMG2-x', '@Img2threejs/x', 'img2-', '@img2threejs/', '@img2threejs/--bad']) {
    await assert.rejects(getCatalog({ fetchImpl: okPayload([{ id: 'alpha', description: 'd', source: 'img2threejs/plugin-alpha', access: 'public', npmCli }]) }),
      err => /npmCli ".*" must be img2-\* or @img2threejs\/\*/.test(err.message),
      'expected rejection for npmCli=' + JSON.stringify(npmCli))
  }
  await assert.rejects(getCatalog({ fetchImpl: okPayload([{ id: 'alpha', description: 'd', source: 'img2threejs/plugin-alpha', access: 'public', npmCli: 42 }]) }),
    err => /npmCli must be null or a string/.test(err.message))
  await assert.rejects(getCatalog({ fetchImpl: okPayload([{ id: 'alpha', description: 'd', source: 'img2threejs/plugin-alpha', access: 'public' }]) }),
    err => /npmCli is required/.test(err.message))
})

test('duplicate ids, duplicate sources (case-insensitive), and duplicate npmCli all fail whole list', async () => {
  await assert.rejects(getCatalog({ fetchImpl: okPayload([
    { id: 'alpha', description: 'a', source: 'img2threejs/plugin-a', access: 'public', npmCli: null },
    { id: 'alpha', description: 'b', source: 'img2threejs/plugin-b', access: 'public', npmCli: null },
  ]) }), err => /duplicate plugin id "alpha"/.test(err.message))
  await assert.rejects(getCatalog({ fetchImpl: okPayload([
    { id: 'alpha', description: 'a', source: 'img2threejs/plugin-same', access: 'public', npmCli: null },
    { id: 'beta', description: 'b', source: 'img2threejs/plugin-SAME', access: 'public', npmCli: null },
  ]) }), err => /duplicate plugin source/.test(err.message))
  await assert.rejects(getCatalog({ fetchImpl: okPayload([
    { id: 'alpha', description: 'a', source: 'img2threejs/plugin-alpha', access: 'public', npmCli: 'img2-shared' },
    { id: 'beta', description: 'b', source: 'img2threejs/plugin-beta', access: 'public', npmCli: 'img2-shared' },
  ]) }), err => /duplicate npmCli "img2-shared"/.test(err.message))
})
