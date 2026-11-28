// Catalog runtime for the public img2 plugin feed.
export const CATALOG_URL = 'https://raw.githubusercontent.com/img2threejs/img2/main/catalog.json'
import { validatePayload } from './runtime/catalog-validation.mjs'

function fail(message) { throw new Error(message) }

function buildInstall(row) {
  if (row.npmCli) return ['npx', '--yes', row.npmCli, 'install', '--yes']
  return ['npx', '--yes', '@img2threejs/img2@latest', 'add', row.source, '--plugin', row.id, '--yes']
}

export async function getCatalog({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') fail('fetchImpl must be a function')
  let res
  try { res = await fetchImpl(CATALOG_URL, { signal: AbortSignal.timeout(10000) }) }
  catch (err) { fail('failed to fetch catalog: ' + (err && err.message ? err.message : 'network error')) }
  if (!res || typeof res.status !== 'number') fail('failed to fetch catalog: no response')
  if (res.status < 200 || res.status >= 300) fail('catalog request failed with HTTP ' + res.status)
  let text
  try { text = await res.text() }
  catch (err) { fail('failed to read catalog body: ' + (err && err.message ? err.message : 'read error')) }
  let payload
  try { payload = JSON.parse(text) }
  catch (err) { fail('catalog body is not valid JSON: ' + (err && err.message ? err.message : 'parse error')) }
  const { rows, updatedAt } = validatePayload(payload)
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let pub = 0, priv = 0, npm = 0
  for (const r of rows) {
    if (r.access === 'public') pub++
    else if (r.access === 'private') priv++
    if (r.npmCli) npm++
  }
  return {
    version: 1,
    status: 'ok',
    source: CATALOG_URL,
    updatedAt,
    counts: { total: rows.length, public: pub, private: priv, npmClis: npm },
    plugins: rows.map(r => ({ ...r, install: buildInstall(r) })),
  }
}
