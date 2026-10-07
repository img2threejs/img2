// Catalog runtime for the public img2 plugin feed.
export const CATALOG_URL = 'https://raw.githubusercontent.com/img2threejs/img2/main/catalog.json'

const ID_RE = /^[a-z][a-z0-9-]*$/
const SOURCE_RE = /^img2threejs\/plugin-[A-Za-z0-9_.-]+$/
const NPM_BARE = /^img2-[a-z][a-z0-9-]*$/
const NPM_SCOPED = /^@img2threejs\/[a-z][a-z0-9-]*$/
// Reject any control or whitespace character; JS $ matches before a final \n, so the
// guard is what makes the id/source/npm identities "complete-string" matches.
const CONTROL_OR_WS = /[\x00-\x20\x7f]/

function isAsciiClean(value) {
  return typeof value === 'string' && !CONTROL_OR_WS.test(value)
}

function fail(message) { throw new Error(message) }

function isObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v) }

function isCalendarDate(value) {
  if (typeof value !== 'string') return false
  if (!isAsciiClean(value)) return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const y = +m[1], mo = +m[2], d = +m[3]
  if (mo < 1 || mo > 12) return false
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
  return d >= 1 && d <= dim
}

function isValidNpmCli(name) {
  if (typeof name !== 'string') return false
  return NPM_BARE.test(name) || NPM_SCOPED.test(name)
}

function checkNpmCliField(value) {
  if (value === null) return
  if (typeof value !== 'string') fail('npmCli must be null or a string')
  if (!isAsciiClean(value)) fail('npmCli "' + value + '" must be img2-* or @img2threejs/* and contain no whitespace or control characters')
  if (!isValidNpmCli(value)) fail('npmCli "' + value + '" must be img2-* or @img2threejs/*')
}

function checkRow(raw, index, seenIds, seenSources, seenNpm) {
  if (!isObject(raw)) fail('plugins[' + index + '] must be an object')
  const { id, description, source, access, npmCli } = raw
  if (typeof id !== 'string' || !isAsciiClean(id) || !ID_RE.test(id)) fail('plugins[' + index + '].id "' + id + '" must match ' + ID_RE)
  if (typeof description !== 'string' || description.trim().length === 0) fail('plugins[' + index + '].description must be a non-empty string')
  if (typeof source !== 'string' || !isAsciiClean(source) || !SOURCE_RE.test(source)) fail('plugins[' + index + '].source "' + source + '" must match ' + SOURCE_RE)
  if (typeof access !== 'string' || (access !== 'public' && access !== 'private')) fail('plugins[' + index + '].access must be "public" or "private"')
  if (!('npmCli' in raw)) fail('plugins[' + index + '].npmCli is required (null or a string)')
  checkNpmCliField(npmCli)
  const idKey = id
  const sourceKey = source.toLowerCase()
  if (seenIds.has(idKey)) fail('duplicate plugin id "' + id + '"')
  if (seenSources.has(sourceKey)) fail('duplicate plugin source "' + source + '"')
  if (npmCli && seenNpm.has(npmCli)) fail('duplicate npmCli "' + npmCli + '"')
  seenIds.add(idKey)
  seenSources.add(sourceKey)
  if (npmCli) seenNpm.add(npmCli)
  return { id, description, source, access, npmCli: npmCli ?? null }
}

function buildInstall(row) {
  if (row.npmCli) return ['npx', '--yes', row.npmCli, 'install', '--yes']
  return ['npx', '--yes', '@img2threejs/img2@latest', 'add', row.source, '--plugin', row.id, '--yes']
}

function validatePayload(payload) {
  if (!isObject(payload)) fail('payload must be a JSON object')
  if (payload.schema !== 1) fail('schema must be 1, got ' + JSON.stringify(payload.schema))
  if (!isCalendarDate(payload.updatedAt)) fail('updatedAt must be a calendar date YYYY-MM-DD')
  if (!Array.isArray(payload.plugins)) fail('plugins must be an array')
  const seenIds = new Set(), seenSources = new Set(), seenNpm = new Set()
  const rows = []
  for (let i = 0; i < payload.plugins.length; i++) rows.push(checkRow(payload.plugins[i], i, seenIds, seenSources, seenNpm))
  return { rows, updatedAt: payload.updatedAt }
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
