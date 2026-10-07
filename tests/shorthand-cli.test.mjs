import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOG_URL } from '../bin/catalog.mjs'

const BIN = fileURLToPath(new URL('../bin/img2.mjs', import.meta.url))
const CORE = fileURLToPath(new URL('../img2_core', import.meta.url))
const catalog = {
  schema: 1,
  updatedAt: '2026-10-07',
  plugins: [
    { id: 'hello-cube', description: 'Public example.', source: 'img2threejs/plugin-hello-cube', access: 'public', npmCli: null },
    { id: 'environment', description: 'Private environment.', source: 'img2threejs/plugin-environment', access: 'private', npmCli: 'img2-environment' },
  ],
}

function git(sb, dir, args) {
  return execFileSync('git', args, { cwd: dir, env: sb.env, encoding: 'utf8', stdio: 'pipe', timeout: 15000 }).trim()
}

function commit(sb, dir) {
  git(sb, dir, ['add', '-A'])
  git(sb, dir, ['-c', 'user.name=img2-test', '-c', 'user.email=test@img2.invalid', 'commit', '-qm', 'fixture'])
}

function repo(sb, dir) {
  fs.mkdirSync(dir, { recursive: true })
  git(sb, dir, ['init', '-q', '-b', 'main'])
  return dir
}

function plugin(sb, dir, name = 'environment', version = '0.1.0') {
  repo(sb, dir)
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    schema: 1, name, version, description: 'Fixture plugin.',
    capabilities: [{ from: 'image', to: 'threejs-code' }],
    requires: { harness: '>=0.1.0', coreApi: 1 },
  }) + '\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# ' + name + '\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), '_img2_local.py\n')
  fs.mkdirSync(path.join(dir, 'tools'))
  fs.writeFileSync(path.join(dir, 'tools', 'noop.py'), 'print("ok")\n')
  commit(sb, dir)
  git(sb, dir, ['tag', 'v' + version])
  return dir
}

function preload(sb, payload = catalog, reject = false) {
  fs.writeFileSync(sb.preload, `
    import fs from 'node:fs';
    globalThis.fetch = async url => {
      if (url !== ${JSON.stringify(CATALOG_URL)}) throw new Error('unexpected URL');
      fs.writeFileSync(${JSON.stringify(sb.marker)}, JSON.stringify({ locked: fs.existsSync(${JSON.stringify(path.join(sb.H, '.lock'))}) }));
      if (${reject}) throw new Error('catalog offline');
      return { status: 200, text: async () => ${JSON.stringify(JSON.stringify(payload))} };
    };
  `)
}

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'img2-shorthand-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const HOME = path.join(root, 'home')
  const origins = path.join(root, 'origins')
  for (const dir of ['.claude/skills', '.codex/skills', '.config/opencode/skills', '.local/bin']) {
    fs.mkdirSync(path.join(HOME, dir), { recursive: true })
  }
  fs.mkdirSync(origins)
  const config = path.join(root, 'gitconfig')
  fs.writeFileSync(config, '[url "file://' + origins + '/"]\n  insteadOf = https://github.com/img2threejs/\n')
  const sb = {
    root, HOME, origins, H: path.join(HOME, '.img2'),
    marker: path.join(root, 'catalog-called'), preload: path.join(root, 'preload.mjs'),
    env: { HOME, PATH: path.join(HOME, '.local/bin') + path.delimiter + process.env.PATH,
      IMG2_HOME: path.join(HOME, '.img2'), XDG_CONFIG_HOME: path.join(HOME, '.config'),
      GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
  }
  sb.env.NODE_OPTIONS = '--import=' + sb.preload
  preload(sb)
  return sb
}

function run(sb, args, expected = 0) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: sb.root, env: sb.env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  })
  assert.equal(result.status, expected, JSON.stringify(args) + '\n' + result.stdout + result.stderr + (result.error || ''))
  return result
}

function install(sb) {
  const dir = repo(sb, path.join(sb.root, 'harness'))
  fs.writeFileSync(path.join(dir, 'README.md'), 'Fixture harness.\n')
  fs.cpSync(CORE, path.join(dir, 'img2_core'), { recursive: true, filter: src => !src.includes('__pycache__') })
  commit(sb, dir)
  run(sb, ['install', '--from', dir, '--yes'])
}

function registrations(sb) {
  return JSON.parse(fs.readFileSync(path.join(sb.H, 'plugins.json'), 'utf8')).plugins
}

function snapshot(dir) {
  if (!fs.existsSync(dir)) return null
  const out = {}
  function walk(current, relative) {
    for (const entry of fs.readdirSync(current).sort()) {
      const file = path.join(current, entry)
      const key = path.join(relative, entry)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) out[key] = ['link', fs.readlinkSync(file)]
      else if (stat.isDirectory()) { out[key] = ['dir']; walk(file, key) }
      else out[key] = ['file', fs.readFileSync(file).toString('base64')]
    }
  }
  walk(dir, '')
  return out
}

function healthy(sb) {
  const result = JSON.parse(run(sb, ['doctor', '--json']).stdout)
  assert.equal(result.findings.some(finding => finding.level === 'FAIL'), false)
}

test('bare ID selects its catalog source, honors a non-latest ref, pins Git and links every host', t => {
  const sb = sandbox(t)
  install(sb)
  const origin = plugin(sb, path.join(sb.origins, 'plugin-environment.git'))
  const pinned = git(sb, origin, ['rev-parse', 'v0.1.0'])
  const manifest = JSON.parse(fs.readFileSync(path.join(origin, 'plugin.json'), 'utf8'))
  manifest.version = '0.2.0'
  fs.writeFileSync(path.join(origin, 'plugin.json'), JSON.stringify(manifest) + '\n')
  commit(sb, origin)
  git(sb, origin, ['tag', 'v0.2.0'])
  run(sb, ['add', 'environment', '--ref', 'v0.1.0', '--yes'])
  assert.equal(JSON.parse(fs.readFileSync(sb.marker, 'utf8')).locked, false)
  const [row] = registrations(sb)
  assert.deepEqual([row.id, row.repo, row.ref, row.resolvedSha], ['environment', 'img2threejs/plugin-environment', 'v0.1.0', pinned])
  const clone = path.join(sb.H, 'plugins', 'environment')
  assert.equal(git(sb, clone, ['rev-parse', 'HEAD']), pinned)
  assert.equal(JSON.parse(fs.readFileSync(path.join(clone, 'plugin.json'), 'utf8')).version, '0.1.0')
  for (const dir of ['.claude/skills', '.codex/skills', '.config/opencode/skills']) {
    const target = path.join(sb.HOME, dir, 'img2-environment')
    assert.ok(fs.lstatSync(target).isSymbolicLink())
    assert.equal(fs.realpathSync(target), clone)
  }
  healthy(sb)
  const before = snapshot(sb.HOME)
  fs.rmSync(sb.marker)
  preload(sb, catalog, true)
  run(sb, ['add', 'environment', '--yes'], 1)
  assert.equal(fs.existsSync(sb.marker), false)
  assert.deepEqual(snapshot(sb.HOME), before)
})

test('missing harness, unknown ID, invalid catalog and network errors never mutate install state', t => {
  const sb = sandbox(t)
  run(sb, ['add', 'environment', '--yes'], 1)
  assert.equal(fs.existsSync(sb.marker), false)
  assert.equal(fs.existsSync(sb.H), false)
  install(sb)
  const before = snapshot(sb.HOME)
  run(sb, ['add', 'no-such-plugin', '--yes'], 2)
  assert.deepEqual(snapshot(sb.HOME), before)
  preload(sb, { ...catalog, schema: 999 })
  run(sb, ['add', 'environment', '--yes'], 1)
  assert.deepEqual(snapshot(sb.HOME), before)
  preload(sb, catalog, true)
  run(sb, ['add', 'environment', '--yes'], 1)
  assert.deepEqual(snapshot(sb.HOME), before)
})

test('caller ID mismatch refuses before fetching; a wrong cloned manifest is also refused', t => {
  const sb = sandbox(t)
  install(sb)
  const before = snapshot(sb.HOME)
  preload(sb, catalog, true)
  run(sb, ['add', 'environment', '--plugin', 'hello-cube', '--yes'], 2)
  assert.equal(fs.existsSync(sb.marker), false)
  assert.deepEqual(snapshot(sb.HOME), before)
  const origin = plugin(sb, path.join(sb.origins, 'plugin-environment.git'), 'different-id')
  const original = snapshot(origin)
  preload(sb)
  run(sb, ['add', 'environment', '--yes'], 2)
  assert.deepEqual(snapshot(sb.HOME), before)
  assert.deepEqual(snapshot(origin), original)
})

test('local registration survives --yes without --force; explicit force backs up only its mount', t => {
  const sb = sandbox(t)
  install(sb)
  const local = plugin(sb, path.join(sb.root, 'local'), 'environment', '9.9.9')
  const origin = plugin(sb, path.join(sb.origins, 'plugin-environment.git'))
  run(sb, ['add', '--link', local, '--yes'])
  const localBefore = snapshot(local)
  const homeBefore = snapshot(sb.HOME)
  preload(sb, catalog, true)
  run(sb, ['add', 'environment', '--yes'], 2)
  assert.equal(fs.existsSync(sb.marker), false)
  assert.deepEqual(snapshot(sb.HOME), homeBefore)
  assert.deepEqual(snapshot(local), localBefore)
  preload(sb)
  run(sb, ['add', 'environment', '--force', '--yes'])
  const [row] = registrations(sb)
  assert.equal(row.repo, 'img2threejs/plugin-environment')
  assert.equal(row.resolvedSha, git(sb, origin, ['rev-parse', 'v0.1.0']))
  assert.deepEqual(snapshot(local), localBefore)
  const backup = fs.readdirSync(path.join(sb.H, 'backups')).find(name => name.startsWith('environment-'))
  assert.ok(backup)
  assert.equal(fs.realpathSync(path.join(sb.H, 'backups', backup)), local)
  healthy(sb)
})

test('explicit Git repositories, URLs and local links still work when the catalog is offline', t => {
  const sb = sandbox(t)
  install(sb)
  const github = plugin(sb, path.join(sb.origins, 'plugin-hello-cube.git'), 'hello-cube')
  const explicit = plugin(sb, path.join(sb.root, 'explicit'), 'explicit')
  const local = plugin(sb, path.join(sb.root, 'local'), 'local')
  preload(sb, catalog, true)
  run(sb, ['add', 'img2threejs/plugin-hello-cube', '--yes'])
  run(sb, ['add', 'file://' + explicit, '--allow-any-source', '--yes'])
  run(sb, ['add', '--link', local, '--yes'])
  assert.equal(fs.existsSync(sb.marker), false)
  assert.deepEqual(registrations(sb).map(row => row.id).sort(), ['explicit', 'hello-cube', 'local'])
  assert.equal(registrations(sb).find(row => row.id === 'hello-cube').resolvedSha, git(sb, github, ['rev-parse', 'v0.1.0']))
  healthy(sb)
})
