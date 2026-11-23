import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { validateDependenciesLock, validatePluginsLock } from '../bin/locks.mjs'

const read = name => JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))
const deps = () => read('dependencies.lock.json')
const plugins = () => read('plugins.lock.json')
const catalog = read('catalog.json')
const APPROVED = ['character', 'cs2', 'interior', 'jev', 'pixi2d']
const entry = (lock, id) => lock.dependencies.find(d => d.id === id)

test('committed dependencies.lock.json is valid', () => assert.deepEqual(validateDependenciesLock(deps()), []))
test('committed plugins.lock.json is valid', () => assert.deepEqual(validatePluginsLock(plugins(), catalog), []))

test('every approved plugin appears exactly once and nothing else', () => {
  const ids = plugins().plugins.map(p => p.id).sort()
  assert.deepEqual(ids, APPROVED)
  assert.deepEqual(catalog.plugins.map(p => p.id).sort(), ids)
})

test('plugins.lock rejects unapproved, duplicate and missing plugins', () => {
  const extra = plugins(); extra.plugins.push({ ...extra.plugins[0], id: 'environment' })
  assert.match(validatePluginsLock(extra, catalog).join('\n'), /not in catalog/)
  const dup = plugins(); dup.plugins.push({ ...dup.plugins[0] })
  assert.match(validatePluginsLock(dup, catalog).join('\n'), /duplicate plugin id character/)
  const gone = plugins(); gone.plugins = gone.plugins.filter(p => p.id !== 'jev')
  assert.match(validatePluginsLock(gone, catalog).join('\n'), /jev is missing/)
})

test('plugin pins: full SHA, catalog-matching repo/visibility, default-on, honest unpushed note', () => {
  const lock = plugins()
  for (const p of lock.plugins) {
    assert.match(p.commit, /^[0-9a-f]{40}$/)
    assert.equal(p.default, true)
    assert.equal(p.selectable, true)
  }
  assert.equal(lock.plugins.find(p => p.id === 'jev').visibility, 'public')
  const bad = plugins(); bad.plugins[0].commit = 'abc123'
  assert.match(validatePluginsLock(bad, catalog).join('\n'), /40-hex/)
  const leak = plugins(); leak.plugins[0].capability = 'plugin-character'
  assert.match(validatePluginsLock(leak, catalog).join('\n'), /repository name/)
  const hidden = plugins(); Object.assign(hidden.plugins[0], { pinState: 'unpushed-local', note: 'pinned' })
  assert.match(validatePluginsLock(hidden, catalog).join('\n'), /must say so/)
})

test('every resolved entry has https URLs and 64-hex sha256; unresolved entries explain why', () => {
  const lock = deps()
  const statuses = new Set(lock.dependencies.map(d => d.status))
  assert.deepEqual([...statuses].sort(), ['resolved', 'unresolved'])
  const broken = deps(); entry(broken, 'character-bpy').artifacts[0].sha256 = null
  assert.match(validateDependenciesLock(broken).join('\n'), /character-bpy: resolved entry needs a 64-hex sha256/)
  const http = deps(); entry(http, 'character-numpy').artifacts[0].url = 'http://example.com/x.whl'
  assert.match(validateDependenciesLock(http).join('\n'), /must be https/)
  const invented = deps(); entry(invented, 'character-numpy').artifacts[0].sha256 = 'abc'
  assert.match(validateDependenciesLock(invented).join('\n'), /64 lowercase hex/)
  const silent = deps(); delete entry(silent, 'interior-three').reason
  assert.match(validateDependenciesLock(silent).join('\n'), /interior-three: unresolved entry needs reason/)
  const lying = deps(); entry(lying, 'interior-three').status = 'resolved'
  assert.match(validateDependenciesLock(lying).join('\n'), /interior-three: resolved entry has no artifacts|interior-three.*sha256/)
})

test('transitive pins are held to the same standard as the entry itself', () => {
  const lock = deps()
  const bpy = entry(lock, 'character-bpy')
  assert.ok(bpy.transitive.length > 0)
  bpy.transitive[0].artifacts[0].sha256 = null
  assert.match(validateDependenciesLock(lock).join('\n'), /character-bpy>.*needs a 64-hex sha256/)
})

test('full profile references only existing ids and covers the whole lock; minimal is a closed subset', () => {
  const lock = deps()
  const ids = new Set(lock.dependencies.map(d => d.id))
  for (const id of lock.profiles.full.dependencies) assert.ok(ids.has(id), id)
  assert.equal(new Set(lock.profiles.full.dependencies).size, ids.size)
  for (const group of ['vision', 'mcp']) {
    const minimal = new Set(lock.profiles.minimal.dependencies)
    for (const d of lock.dependencies.filter(d => d.group === group)) assert.ok(!minimal.has(d.id), `${d.id} is in minimal`)
  }
  const dangling = deps(); dangling.profiles.full.dependencies.push('ghost')
  assert.match(validateDependenciesLock(dangling).join('\n'), /unknown id ghost/)
  const open = deps(); open.profiles.minimal.dependencies = open.profiles.minimal.dependencies.filter(id => id !== 'python-runtime')
  assert.match(validateDependenciesLock(open).join('\n'), /requires python-runtime, which the profile omits/)
})

test('bpy environments are distinct and pinned to the plugin requirements', () => {
  const lock = deps()
  const character = entry(lock, 'character-bpy'), interior = entry(lock, 'interior-bpy')
  assert.equal(character.version, '4.5.15')
  assert.equal(interior.version, '4.3.0')
  assert.notEqual(character.environment, interior.environment)
  for (const e of [character, interior]) assert.deepEqual(e.constraints.python, { abi: 'cp311', range: '==3.11.*' })
  interior.environment = character.environment
  assert.match(validateDependenciesLock(lock).join('\n'), /distinct environments/)
})

test('Three is not unified: character 0.186.1 and interior viewer 0.180.0 stay separate', () => {
  const lock = deps()
  assert.equal(entry(lock, 'character-three').version, '0.186.1')
  assert.equal(entry(lock, 'interior-three').version, '0.180.0')
  entry(lock, 'interior-three').environment = 'character-node'
  assert.match(validateDependenciesLock(lock).join('\n'), /Three must live in distinct environments/)
})

test('pinned tool versions match the plugins\' own requirement files', () => {
  const lock = deps()
  const pins = { 'pixi2d-pixi-js': '8.22.0', 'pixi2d-playwright': '1.64.0', 'interior-vite': '6.4.1', 'interior-gltf-validator': '2.0.0-dev.3.10',
    'glb-esbuild': '0.24.2', 'glb-playwright': '1.57.0', 'mcp-chrome-devtools': '1.6.0', 'mcp-threejs-devtools': '0.4.1', 'mcp-playwright': '0.0.78', 'mcp-context7': '3.2.5' }
  for (const [id, v] of Object.entries(pins)) assert.equal(entry(lock, id).version, v, id)
  assert.equal(entry(lock, 'node-runtime').constraints.node, '>=22')
  assert.ok(entry(lock, 'cs2-source2viewer-cli') && entry(lock, 'cs2-dotnet-runtime'))
  assert.equal(entry(lock, 'browser-chromium-1.64.0').environment, 'browsers')
})

test('npm entries carry sha512 integrity for every tarball', () => {
  for (const d of deps().dependencies.filter(d => d.kind === 'npm')) {
    for (const a of [...d.artifacts, ...(d.transitive ?? []).flatMap(t => t.artifacts)]) assert.match(a.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, d.id)
  }
})

test('dependency ids are unique and requires has no cycles', () => {
  const dup = deps(); dup.dependencies.push({ ...dup.dependencies[0] })
  assert.match(validateDependenciesLock(dup).join('\n'), /duplicate dependency id/)
  const cyc = deps(); entry(cyc, 'python-runtime').requires = ['character-bpy']
  assert.match(validateDependenciesLock(cyc).join('\n'), /requires cycle/)
})
