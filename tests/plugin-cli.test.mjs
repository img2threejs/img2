import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const BIN = path.join(ROOT, 'bin', 'img2.mjs')
const HELPER = new URL('../bin/plugin-cli.mjs', import.meta.url).href

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
}
function commit(dir) {
  git(['add', '-A'], dir)
  git(['-c', 'user.name=img2-test', '-c', 'user.email=test@img2.invalid', 'commit', '-qm', 'fixture'], dir)
}
function fixture(t, { sourceId = 'demo', ref = 'v0.1.0' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'img2-wrapper-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const localBin = path.join(home, '.local', 'bin')
  fs.mkdirSync(localBin, { recursive: true })
  fs.mkdirSync(path.join(home, '.claude'))
  const harness = path.join(root, 'harness-source')
  fs.mkdirSync(path.join(harness, 'bin'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'bin'), path.join(harness, 'bin'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'img2_core'), path.join(harness, 'img2_core'), { recursive: true, filter: p => !p.includes('__pycache__') })
  fs.writeFileSync(path.join(harness, 'package.json'), fs.readFileSync(path.join(ROOT, 'package.json')))
  git(['init', '-qb', 'main'], harness)
  commit(harness)
  const plugin = path.join(root, 'plugin-source')
  fs.mkdirSync(plugin)
  const manifest = { schema: 1, name: sourceId, version: '0.1.0', description: 'Fixture plugin', capabilities: [{ from: 'image', to: 'threejs-code' }], requires: { harness: '>=0.1.0', coreApi: 1 } }
  fs.writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(plugin, 'SKILL.md'), '# Fixture\n')
  fs.writeFileSync(path.join(plugin, '.gitignore'), '_img2_local.py\n')
  git(['init', '-qb', 'main'], plugin)
  commit(plugin)
  git(['tag', 'v0.1.0'], plugin)
  const pkg = path.join(root, 'package.json')
  fs.writeFileSync(pkg, JSON.stringify({ name: 'img2-demo', version: '0.1.0', img2Plugin: { id: 'demo', source: 'img2threejs/demo', ...(ref ? { ref } : {}) } }))
  const entry = path.join(root, 'wrapper.mjs')
  fs.writeFileSync(entry, `import { runPluginCli } from ${JSON.stringify(HELPER)}; process.exitCode = await runPluginCli({ packageUrl: new URL('./package.json', import.meta.url) });\n`)
  const env = { ...process.env, HOME: home, IMG2_HOME: path.join(home, '.img2'), PATH: localBin + path.delimiter + process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'url.' + harness + '.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/img2threejs/img2', GIT_CONFIG_KEY_1: 'url.' + plugin + '.insteadOf', GIT_CONFIG_VALUE_1: 'https://github.com/img2threejs/demo.git', GIT_CONFIG_KEY_2: 'protocol.file.allow', GIT_CONFIG_VALUE_2: 'always' }
  const run = args => spawnSync(process.execPath, [entry, ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const harnessRun = args => spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' })
  return { root, home, plugin, manifest, env, run, harnessRun, H: env.IMG2_HOME }
}
function ok(result) { assert.equal(result.status, 0, result.stderr + result.stdout) }
function snapshot(dir) {
  const result = {}
  if (!fs.existsSync(dir)) return result
  function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name)
      const st = fs.lstatSync(file)
      const key = path.relative(dir, file)
      if (st.isSymbolicLink()) result[key] = 'link:' + fs.readlinkSync(file)
      else if (st.isDirectory()) { result[key] = 'directory'; walk(file) }
      else result[key] = fs.readFileSync(file).toString('base64')
    }
  }
  walk(dir)
  return result
}
function registry(sb) { return JSON.parse(fs.readFileSync(path.join(sb.H, 'plugins.json'), 'utf8')) }

test('dry-run and non-TTY refusal preserve home before bootstrap, including explicit ref override', t => {
  const sb = fixture(t)
  const before = snapshot(sb.home)
  ok(sb.run(['install', '--ref', 'v0.2.0', '--dry-run']))
  assert.deepEqual(snapshot(sb.home), before)
  assert.equal(sb.run(['install', '--force']).status, 3)
  assert.deepEqual(snapshot(sb.home), before)
  for (const args of [['install', '--ref', 'main', '--dry-run'], ['install', '--ref', '--yes'], ['install', 'extra'], ['--version', '--unknown'], ['--help', '--unknown']]) {
    assert.equal(sb.run(args).status, 2, args.join(' '))
    assert.deepEqual(snapshot(sb.home), before)
  }
})

test('first install links the actual plugin; repeat install is byte-identical', t => {
  const sb = fixture(t)
  ok(sb.run(['install', '--yes']))
  assert.equal(registry(sb).plugins[0].ref, 'v0.1.0')
  const link = path.join(sb.home, '.claude', 'skills', 'img2-demo')
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(sb.H, 'plugins', 'demo')))
  const before = snapshot(sb.home)
  ok(sb.run(['install', '--yes']))
  assert.deepEqual(snapshot(sb.home), before)
})

test('ref replacement requires force and uses the explicit ref instead of the metadata pin', t => {
  const sb = fixture(t)
  ok(sb.run(['install', '--yes']))
  fs.writeFileSync(path.join(sb.plugin, 'plugin.json'), JSON.stringify({ ...sb.manifest, version: '0.2.0' }))
  commit(sb.plugin)
  git(['tag', 'v0.2.0'], sb.plugin)
  const before = snapshot(sb.home)
  assert.equal(sb.run(['install', '--ref', 'v0.2.0', '--yes']).status, 2)
  assert.deepEqual(snapshot(sb.home), before)
  ok(sb.run(['install', '--ref', 'v0.2.0', '--force', '--yes']))
  assert.equal(registry(sb).plugins[0].ref, 'v0.2.0')
  assert.equal(JSON.parse(fs.readFileSync(path.join(sb.H, 'plugins', 'demo', 'plugin.json'))).version, '0.2.0')
})

for (const linked of [true, false]) {
  test('local link/another source is protected across install, update and remove: ' + linked, t => {
    const sb = fixture(t)
    ok(sb.harnessRun(['install', '--from', path.join(sb.root, 'harness-source'), '--yes']))
    if (linked) ok(sb.harnessRun(['add', '--link', sb.plugin]))
    else {
      ok(sb.run(['install', '--yes']))
      const reg = registry(sb)
      reg.plugins[0].repo = 'img2threejs/another-source'
      fs.writeFileSync(path.join(sb.H, 'plugins.json'), JSON.stringify(reg))
    }
    const before = snapshot(sb.home)
    for (const args of [['install', '--force', '--yes'], ['update', '--yes'], ['remove', '--yes']]) {
      assert.equal(sb.run(args).status, 2, args.join(' '))
      assert.deepEqual(snapshot(sb.home), before)
    }
  })
}

test('corrupt registry is surfaced without treating it as empty or mutating home', t => {
  const sb = fixture(t)
  ok(sb.harnessRun(['install', '--from', path.join(sb.root, 'harness-source'), '--yes']))
  fs.writeFileSync(path.join(sb.H, 'plugins.json'), '{broken')
  const before = snapshot(sb.home)
  assert.equal(sb.run(['install', '--yes']).status, 1)
  assert.deepEqual(snapshot(sb.home), before)
})

test('a source with another plugin identity cannot be installed even with force', t => {
  const sb = fixture(t, { sourceId: 'another' })
  ok(sb.harnessRun(['install', '--from', path.join(sb.root, 'harness-source'), '--yes']))
  const before = snapshot(sb.home)
  assert.equal(sb.run(['install', '--force', '--yes']).status, 2)
  assert.deepEqual(snapshot(sb.home), before)
  assert.deepEqual(registry(sb).plugins, [])
})

test('update check is read-only; update and removal require consent and change the registered plugin', t => {
  const sb = fixture(t)
  ok(sb.run(['install', '--yes']))
  fs.writeFileSync(path.join(sb.plugin, 'plugin.json'), JSON.stringify({ ...sb.manifest, version: '0.2.0' }))
  commit(sb.plugin)
  git(['tag', 'v0.2.0'], sb.plugin)
  const before = snapshot(sb.home)
  assert.equal(sb.run(['update', '--check']).status, 1)
  assert.deepEqual(snapshot(sb.home), before)
  assert.equal(sb.run(['update']).status, 3)
  assert.deepEqual(snapshot(sb.home), before)
  ok(sb.run(['update', '--yes']))
  assert.equal(registry(sb).plugins[0].ref, 'v0.2.0')
  const updated = snapshot(sb.home)
  assert.equal(sb.run(['remove']).status, 3)
  assert.deepEqual(snapshot(sb.home), updated)
  ok(sb.run(['remove', '--yes']))
  assert.deepEqual(registry(sb).plugins, [])
  assert.equal(fs.lstatSync(path.join(sb.home, '.claude', 'skills', 'img2-demo'), { throwIfNoEntry: false }), undefined)
})
