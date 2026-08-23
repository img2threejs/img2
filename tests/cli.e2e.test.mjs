import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/img2.mjs', import.meta.url))

function gitq(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  try {
    gitq(['init', '-q', '-b', 'main'], dir)
  } catch {
    gitq(['init', '-q'], dir)
    gitq(['checkout', '-q', '-b', 'main'], dir)
  }
}

function commitAll(dir, msg) {
  gitq(['add', '-A'], dir)
  gitq(['-c', 'user.name=img2-test', '-c', 'user.email=test@img2.invalid', 'commit', '-q', '-m', msg], dir)
}

function makeHarnessRepo(root) {
  const dir = path.join(root, 'fixture-harness')
  initRepo(dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture harness\n')
  // The working-tree img2_core, so a cloned fixture harness can serve the tools' fallback import.
  fs.cpSync(fileURLToPath(new URL('../img2_core', import.meta.url)), path.join(dir, 'img2_core'), {
    recursive: true,
    filter: (src) => !src.includes('__pycache__'),
  })
  commitAll(dir, 'init')
  return dir
}

function makePluginRepo(root, name, { manifest = {}, tag = 'v0.1.0', tool = 'print("ok")\n' } = {}) {
  const dir = path.join(root, 'fixture-' + name)
  initRepo(dir)
  const doc = {
    schema: 1,
    name,
    version: '0.1.0',
    description: 'Test plugin ' + name + '.',
    capabilities: [{ from: 'image', to: 'threejs-code' }],
    requires: { harness: '>=0.1.0', coreApi: 1 },
    ...manifest,
  }
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(doc, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# ' + name + '\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), '_img2_local.py\n')
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'tools', 'noop.py'), tool)
  commitAll(dir, 'init')
  if (tag) gitq(['tag', tag], dir)
  return dir
}

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'img2-e2e-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const HOME = path.join(root, 'home')
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true })
  const H = path.join(HOME, '.img2')
  const env = { PATH: process.env.PATH, HOME, IMG2_HOME: H, GIT_TERMINAL_PROMPT: '0' }
  return { root, HOME, H, env }
}

function run(args, env, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, cwd })
}

function installed(t) {
  const sb = makeSandbox(t)
  const harnessSrc = makeHarnessRepo(sb.root)
  const r = run(['install', '--from', harnessSrc, '--yes'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  return { ...sb, harnessSrc }
}

test('install creates the $IMG2_HOME layout and merges settings idempotently', (t) => {
  const sb = makeSandbox(t)
  const harnessSrc = makeHarnessRepo(sb.root)
  const settingsPath = path.join(sb.HOME, '.claude', 'settings.json')
  fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash'] } }, null, 2))

  let r = run(['install', '--from', harnessSrc, '--yes'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  for (const d of ['harness', 'plugins', 'generated', 'backups']) {
    assert.ok(fs.existsSync(path.join(sb.H, d)), d + ' missing')
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.H, 'plugins.json'), 'utf8')), { version: 1, plugins: [] })
  assert.ok(fs.existsSync(path.join(sb.H, 'receipts.json')))

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  assert.equal(settings.theme, 'dark')
  assert.deepEqual(settings.permissions.allow, ['Bash'])
  assert.deepEqual(settings.permissions.additionalDirectories, [sb.H])

  r = run(['install', '--from', harnessSrc, '--yes'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).permissions.additionalDirectories, [sb.H])
})

test('install refuses a legacy checkout unless --migrate-legacy moves it to backups', (t) => {
  const sb = makeSandbox(t)
  const harnessSrc = makeHarnessRepo(sb.root)
  const legacyRepo = path.join(sb.HOME, '.img2threejs', 'repo')
  fs.mkdirSync(legacyRepo, { recursive: true })
  fs.writeFileSync(path.join(legacyRepo, 'SKILL.md'), 'legacy\n')

  let r = run(['install', '--from', harnessSrc, '--yes'], sb.env, sb.root)
  assert.equal(r.status, 2, r.stderr + r.stdout)
  assert.match(r.stderr, /--migrate-legacy/)

  r = run(['install', '--from', harnessSrc, '--yes', '--migrate-legacy'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(!fs.existsSync(legacyRepo))
  const backups = fs.readdirSync(path.join(sb.H, 'backups'))
  assert.equal(backups.filter((b) => b.startsWith('legacy-img2threejs-repo-')).length, 1)
})

test('IMG2THREEJS_HOME is honoured with a deprecation warning', (t) => {
  const sb = makeSandbox(t)
  const harnessSrc = makeHarnessRepo(sb.root)
  const env = { ...sb.env, IMG2THREEJS_HOME: path.join(sb.HOME, '.i2-alias') }
  delete env.IMG2_HOME
  const r = run(['install', '--from', harnessSrc, '--yes'], env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stderr, /deprecated/)
  assert.ok(fs.existsSync(path.join(sb.HOME, '.i2-alias', 'harness')))
})

test('add / list / sync / doctor / remove lifecycle', (t) => {
  const sb = installed(t)
  const plugin = makePluginRepo(sb.root, 'hello-cube')
  const pluginUrl = 'file://' + plugin

  let r = run(['add', pluginUrl], sb.env, sb.root)
  assert.equal(r.status, 2, 'expected refusal, got: ' + r.stderr + r.stdout)
  assert.match(r.stderr, /allow-any-source/)

  r = run(['add', 'evil/plugin-x'], sb.env, sb.root)
  assert.equal(r.status, 2)

  r = run(['add', pluginUrl, '--allow-any-source'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)

  const reg = JSON.parse(fs.readFileSync(path.join(sb.H, 'plugins.json'), 'utf8'))
  assert.equal(reg.plugins.length, 1)
  const row = reg.plugins[0]
  assert.equal(row.id, 'hello-cube')
  assert.equal(row.ref, 'v0.1.0')
  assert.match(row.resolvedSha, /^[0-9a-f]{40}$/)

  const link = path.join(sb.HOME, '.claude', 'skills', 'img2-hello-cube')
  assert.ok(fs.lstatSync(link).isSymbolicLink())
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(sb.H, 'plugins', 'hello-cube')))

  const stanza = 'CORE = ' + JSON.stringify(path.join(sb.H, 'harness')) + '\n'
  assert.equal(fs.readFileSync(path.join(sb.H, 'plugins', 'hello-cube', '_img2_local.py'), 'utf8'), stanza)
  const toolsLocal = path.join(sb.H, 'plugins', 'hello-cube', 'tools', '_img2_local.py')
  assert.equal(fs.readFileSync(toolsLocal, 'utf8'), stanza)

  const index = fs.readFileSync(path.join(sb.H, 'generated', 'index.md'), 'utf8')
  assert.match(index, /hello-cube/)
  assert.match(index, /image -> threejs-code/)
  assert.match(index, /img2-hello-cube/)
  const routes = JSON.parse(fs.readFileSync(path.join(sb.H, 'generated', 'routes.json'), 'utf8'))
  assert.deepEqual(routes, { version: 1, routes: [{ from: 'image', to: 'threejs-code', plugin: 'hello-cube' }] })

  r = run(['add', pluginUrl, '--allow-any-source'], sb.env, sb.root)
  assert.equal(r.status, 1, 'duplicate add must exit 1: ' + r.stderr + r.stdout)
  assert.match(r.stderr, /hello-cube/)
  assert.match(r.stderr, /--force/)

  r = run(['add', pluginUrl, '--allow-any-source', '--force'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(fs.readdirSync(path.join(sb.H, 'backups')).some((b) => b.startsWith('hello-cube-')))

  r = run(['list'], sb.env, sb.root)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /hello-cube\s+0\.1\.0\s+v0\.1\.0\s+[0-9a-f]{7}/)

  r = run(['sync', '--check'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)

  const manifestPath = path.join(sb.H, 'plugins', 'hello-cube', 'plugin.json')
  const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  doc.description = 'Edited description.'
  fs.writeFileSync(manifestPath, JSON.stringify(doc, null, 2) + '\n')

  r = run(['sync', '--check'], sb.env, sb.root)
  assert.equal(r.status, 1, 'drift must be non-zero: ' + r.stdout)
  assert.match(r.stdout, /drift/)

  r = run(['sync'], sb.env, sb.root)
  assert.equal(r.status, 0)
  r = run(['sync', '--check'], sb.env, sb.root)
  assert.equal(r.status, 0)

  r = run(['doctor'], sb.env, sb.root)
  assert.equal(r.status, 0, 'doctor must pass on a clean install: ' + r.stdout + r.stderr)

  fs.rmSync(toolsLocal)
  r = run(['sync', '--check'], sb.env, sb.root)
  assert.equal(r.status, 1, 'a missing tools/_img2_local.py must be drift: ' + r.stdout)
  assert.match(r.stdout, /tools[\\/]_img2_local\.py/)
  r = run(['doctor'], sb.env, sb.root)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /tools[\\/]_img2_local\.py is missing/)
  fs.writeFileSync(toolsLocal, 'CORE = "/stale"\n')
  r = run(['doctor'], sb.env, sb.root)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /tools[\\/]_img2_local\.py is stale/)
  r = run(['sync'], sb.env, sb.root)
  assert.equal(r.status, 0)
  assert.equal(fs.readFileSync(toolsLocal, 'utf8'), stanza)
  r = run(['doctor'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stdout + r.stderr)

  const badTool = path.join(sb.H, 'plugins', 'hello-cube', 'tools', 'bad.py')
  fs.writeFileSync(badTool, 'from pathlib import Path\nfrom forge.state import x\nROOT = Path(__file__).parents[3]\n')
  r = run(['doctor'], sb.env, sb.root)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /parents\[/)
  assert.match(r.stdout, /forge/)
  fs.rmSync(badTool)

  r = run(['remove', 'hello-cube'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.throws(() => fs.lstatSync(link))
  assert.ok(!fs.existsSync(path.join(sb.H, 'plugins', 'hello-cube')))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.H, 'plugins.json'), 'utf8')).plugins, [])
  assert.doesNotMatch(fs.readFileSync(path.join(sb.H, 'generated', 'index.md'), 'utf8'), /hello-cube/)

  r = run(['remove', 'hello-cube'], sb.env, sb.root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no registered plugin/)
})

test('add blocks version and schema mismatches naming both sides', (t) => {
  const sb = installed(t)

  const old = makePluginRepo(sb.root, 'needs-newer', { manifest: { requires: { harness: '>=99.0.0', coreApi: 1 } } })
  let r = run(['add', 'file://' + old, '--allow-any-source'], sb.env, sb.root)
  assert.equal(r.status, 1, r.stderr + r.stdout)
  assert.match(r.stderr, />=99\.0\.0/)
  assert.match(r.stderr, /0\.1\.0/)

  const wrongCore = makePluginRepo(sb.root, 'wrong-core', { manifest: { requires: { harness: '>=0.1.0', coreApi: 2 } } })
  r = run(['add', 'file://' + wrongCore, '--allow-any-source'], sb.env, sb.root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /coreApi 2/)
  assert.match(r.stderr, /coreApi 1/)

  const newSchema = makePluginRepo(sb.root, 'new-schema', { manifest: { schema: 2 } })
  r = run(['add', 'file://' + newSchema, '--allow-any-source'], sb.env, sb.root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /schema 2/)

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.H, 'plugins.json'), 'utf8')).plugins, [])
  assert.deepEqual(
    fs.readdirSync(path.join(sb.H, 'plugins')).filter((n) => !n.startsWith('.')),
    [],
    'a refused add must leave no clone behind',
  )
})

test('add --link registers a local checkout without cloning; remove keeps it intact', (t) => {
  const sb = installed(t)
  const local = makePluginRepo(sb.root, 'dev-plugin')

  let r = run(['add', '--link', local], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const row = JSON.parse(fs.readFileSync(path.join(sb.H, 'plugins.json'), 'utf8')).plugins[0]
  assert.equal(row.repo, 'link:' + local)
  assert.equal(row.ref, 'local')
  assert.equal(row.resolvedSha, 'local')

  const mount = path.join(sb.H, 'plugins', 'dev-plugin')
  assert.ok(fs.lstatSync(mount).isSymbolicLink())
  assert.equal(fs.realpathSync(mount), fs.realpathSync(local))
  assert.ok(fs.existsSync(path.join(local, '_img2_local.py')))

  r = run(['remove', 'dev-plugin'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(fs.existsSync(path.join(local, 'plugin.json')), 'remove must not touch the linked checkout')
  assert.ok(!fs.existsSync(mount))
})

test('add without a semver tag warns and records the default branch', (t) => {
  const sb = installed(t)
  const untagged = makePluginRepo(sb.root, 'untagged', { tag: null })
  const r = run(['add', 'file://' + untagged, '--allow-any-source'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stderr, /no semver tag/)
  const row = JSON.parse(fs.readFileSync(path.join(sb.H, 'plugins.json'), 'utf8')).plugins[0]
  assert.equal(row.ref, 'main')
  assert.match(row.resolvedSha, /^[0-9a-f]{40}$/)
})

test('add refuses when a foreign path occupies the skill link name', (t) => {
  const sb = installed(t)
  const plugin = makePluginRepo(sb.root, 'squatted')
  const target = path.join(sb.HOME, '.claude', 'skills', 'img2-squatted')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.symlinkSync(sb.root, target)

  const r = run(['add', 'file://' + plugin, '--allow-any-source'], sb.env, sb.root)
  assert.equal(r.status, 2, r.stderr + r.stdout)
  assert.match(r.stderr, /foreign/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.H, 'plugins.json'), 'utf8')).plugins, [])
})

test('a tools/ script resolves img2_core via _img2_local.py with no IMG2_HOME set', (t) => {
  const sb = installed(t)
  const stanza = [
    'import os, sys',
    'root = os.environ.get("IMG2_HOME")',
    'if root: sys.path.insert(0, os.path.join(root, "harness"))',
    'else:',
    '    try: import _img2_local; sys.path.insert(0, _img2_local.CORE)',
    '    except ImportError: sys.exit("img2: core not linked - run `img2 sync`")',
    'from img2_core import require_core_api',
    'require_core_api(1)',
    'print("fallback ok")',
  ].join('\n') + '\n'
  const plugin = makePluginRepo(sb.root, 'fallback-check', { tool: stanza })

  const r = run(['add', 'file://' + plugin, '--allow-any-source'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const script = path.join(sb.H, 'plugins', 'fallback-check', 'tools', 'noop.py')

  const py = spawnSync('python3', [script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: sb.HOME }, cwd: sb.root })
  assert.equal(py.status, 0, py.stderr + py.stdout)
  assert.match(py.stdout, /fallback ok/)
})

test('the harness checkout stays git-clean through add and sync', (t) => {
  const sb = installed(t)
  const plugin = makePluginRepo(sb.root, 'clean-check')
  const r = run(['add', 'file://' + plugin, '--allow-any-source'], sb.env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const porcelain = execFileSync('git', ['status', '--porcelain'], {
    cwd: path.join(sb.H, 'harness'),
    encoding: 'utf8',
  })
  assert.equal(porcelain.trim(), '', 'registering a plugin must not dirty the harness checkout')
})

test('install links an img2 launcher into a writable PATH dir and respects foreign files', (t) => {
  const sb = makeSandbox(t)
  const harnessSrc = makeHarnessRepo(sb.root)
  const localBin = path.join(sb.HOME, '.local', 'bin')
  fs.mkdirSync(localBin, { recursive: true })
  const env = { ...sb.env, PATH: localBin + path.delimiter + process.env.PATH }

  let r = run(['install', '--from', harnessSrc, '--yes'], env, sb.root)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const link = path.join(localBin, 'img2')
  assert.equal(fs.readlinkSync(link), path.join(sb.H, 'harness', 'bin', 'img2.mjs'))

  r = run(['install', '--from', harnessSrc, '--yes'], env, sb.root)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(fs.lstatSync(link).isSymbolicLink())

  fs.unlinkSync(link)
  fs.writeFileSync(link, '#!/bin/sh\n')
  r = run(['install', '--from', harnessSrc, '--yes'], env, sb.root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /not ours; skipped/)
  assert.equal(fs.readFileSync(link, 'utf8'), '#!/bin/sh\n')
})
