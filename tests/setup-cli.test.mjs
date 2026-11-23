import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIN = path.join(ROOT, 'bin/img2.mjs')
const git = (dir, args, env) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' }).trim()

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'img2-setup-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home'), H = path.join(home, '.img2')
  fs.mkdirSync(home)
  const env = { ...process.env, HOME: home, IMG2_HOME: H, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(root, 'no-git-config'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', NO_COLOR: '1' }
  delete env.IMG2THREEJS_HOME
  return { root, home, H, env }
}

function run(sb, args, bin = BIN) {
  const r = spawnSync(process.execPath, [bin, 'setup', '--home', sb.H, ...args], { env: sb.env, encoding: 'utf8', timeout: 15_000 })
  assert.ifError(r.error)
  return { code: r.status, text: r.stdout + r.stderr }
}

test('setup CLI refuses invalid input/options and offline fresh installs without writing home', t => {
  const sb = sandbox(t)
  for (const args of [['--plugins', 'cs2,nope'], ['--plugins', ''], ['--json'], ['extra'], ['--offline']]) {
    const r = run(sb, args)
    assert.equal(r.code, 2, r.text)
    assert.equal(fs.existsSync(sb.H), false, r.text)
  }
  const r = run(sb, ['--offline'])
  for (const id of ['character', 'cs2', 'interior', 'jev', 'pixi2d']) assert.match(r.text, new RegExp('\\b' + id + '\\b'))
  assert.match(r.text, /Git downloads are disabled/)
})

function installedFixture(t) {
  const sb = sandbox(t)
  // Copy the real CLI with a sandbox-only lock pin; no published Git source is contacted.
  const cli = path.join(sb.root, 'cli')
  fs.mkdirSync(cli)
  fs.cpSync(path.join(ROOT, 'bin'), path.join(cli, 'bin'), { recursive: true })
  for (const file of ['package.json', 'dependencies.lock.json', 'catalog.json']) fs.copyFileSync(path.join(ROOT, file), path.join(cli, file))
  fs.mkdirSync(path.join(sb.H, 'harness'), { recursive: true })
  git(path.join(sb.H, 'harness'), ['init', '-q'], sb.env)
  fs.mkdirSync(path.join(sb.home, '.claude'), { recursive: true })
  const dir = path.join(sb.H, 'plugins/cs2')
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'], sb.env)
  git(dir, ['remote', 'add', 'origin', 'https://github.com/img2threejs/plugin-cs2'], sb.env)
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ schema: 1, name: 'cs2', version: '0.1.0', description: 'offline fixture', capabilities: [], requires: { harness: '>=0.1.0', coreApi: 1 } }))
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Fixture\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), '_img2_local.py\n')
  git(dir, ['add', '.'], sb.env)
  git(dir, ['commit', '-qm', 'fixture'], sb.env)
  const sha = git(dir, ['rev-parse', 'HEAD'], sb.env)
  const pins = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins.lock.json'), 'utf8'))
  Object.assign(pins.plugins.find(p => p.id === 'cs2'), { commit: sha, pinState: 'on-origin' })
  fs.writeFileSync(path.join(cli, 'plugins.lock.json'), JSON.stringify(pins))
  fs.writeFileSync(path.join(sb.H, 'plugins.json'), JSON.stringify({ version: 1, plugins: [{ id: 'cs2', repo: 'img2threejs/plugin-cs2', ref: sha, resolvedSha: sha }] }))
  fs.writeFileSync(path.join(sb.H, 'receipts.json'), '[]')
  return { ...sb, bin: path.join(cli, 'bin/img2.mjs'), dir, sha }
}

test('setup CLI repairs pinned host links and generated files on repeat without cloning offline', t => {
  const sb = installedFixture(t)
  const link = path.join(sb.home, '.claude/skills/img2-cs2')
  for (let i = 0; i < 2; i++) {
    const r = run(sb, ['--plugins', 'cs2', '--offline'], sb.bin)
    // Real provision refuses hash-weak artifacts before touching runtime; earlier repairs still run.
    assert.equal(r.code, 2, r.text)
    assert.match(r.text, /Setup stopped at provision/)
    assert.match(r.text, /Kept cs2 at/)
    assert.equal(fs.realpathSync(link), sb.dir)
    assert.equal(fs.existsSync(path.join(sb.H, 'generated/routes.json')), true)
    assert.equal(fs.existsSync(path.join(sb.H, 'runtime')), false)
    assert.equal(git(sb.dir, ['rev-parse', 'HEAD'], sb.env), sb.sha)
    if (i === 0) {
      fs.unlinkSync(link)
      fs.writeFileSync(path.join(sb.H, 'generated/routes.json'), 'broken generated data')
    }
  }
})

test('setup CLI preserves dirty and local registrations rather than replacing them', t => {
  const sb = installedFixture(t)
  const skill = path.join(sb.dir, 'SKILL.md')
  fs.writeFileSync(skill, 'user changes\n')
  let r = run(sb, ['--plugins', 'cs2', '--offline'], sb.bin)
  assert.equal(r.code, 2, r.text)
  assert.match(r.text, /dirty checkout/)
  assert.equal(fs.readFileSync(skill, 'utf8'), 'user changes\n')
  fs.writeFileSync(path.join(sb.H, 'plugins.json'), JSON.stringify({ version: 1, plugins: [{ id: 'cs2', repo: 'link:' + sb.dir, ref: 'local', resolvedSha: 'local' }] }))
  r = run(sb, ['--plugins', 'cs2', '--offline'], sb.bin)
  assert.equal(r.code, 2, r.text)
  assert.match(r.text, /local or foreign registration/)
  assert.equal(fs.readFileSync(skill, 'utf8'), 'user changes\n')
  assert.equal(fs.existsSync(path.join(sb.H, 'generated')), false)
})
