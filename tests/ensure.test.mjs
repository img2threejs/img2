import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOG_URL } from '../bin/catalog.mjs'
import { harnessVersion } from '../bin/img2.mjs'

const BIN = fileURLToPath(new URL('../bin/img2.mjs', import.meta.url))
const CORE = fileURLToPath(new URL('../img2_core', import.meta.url))
const CLI_TAG = 'v' + harnessVersion()
const OLD_TAG = 'v0.0.1'
const catalog = {
  schema: 1,
  updatedAt: '2026-11-04',
  plugins: [
    { id: 'hello-cube', description: 'Public example.', source: 'img2threejs/plugin-hello-cube', access: 'public', npmCli: null },
    { id: 'environment', description: 'Private environment.', source: 'img2threejs/plugin-environment', access: 'private', npmCli: null },
  ],
}

function git(sb, dir, args) {
  return execFileSync('git', args, { cwd: dir, env: sb.env, encoding: 'utf8', stdio: 'pipe', timeout: 15000 }).trim()
}

function commit(sb, dir) {
  git(sb, dir, ['add', '-A'])
  git(sb, dir, ['-c', 'user.name=img2-test', '-c', 'user.email=test@img2.invalid', 'commit', '-qm', 'fixture'])
}

// A working repo `work` whose bare `origin` sits where the insteadOf rewrite of
// https://github.com/img2threejs/<name> lands.
function bareOrigin(sb, name) {
  const work = path.join(sb.root, 'work-' + name)
  fs.mkdirSync(work, { recursive: true })
  git(sb, work, ['init', '-q', '-b', 'main'])
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(sb.origins, name)], { env: sb.env })
  git(sb, work, ['remote', 'add', 'origin', path.join(sb.origins, name)])
  return work
}

function release(sb, work, tag, files) {
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(work, file), content)
  commit(sb, work)
  git(sb, work, ['tag', tag])
  git(sb, work, ['push', '-q', 'origin', 'main', tag])
  return git(sb, work, ['rev-parse', 'HEAD'])
}

function harnessRelease(sb, tag) {
  return release(sb, sb.harnessWork, tag, { 'package.json': JSON.stringify({ version: tag.slice(1) }) + '\n' })
}

function pluginRelease(sb, version) {
  return release(sb, sb.pluginWork, 'v' + version, {
    'plugin.json': JSON.stringify({
      schema: 1, name: 'hello-cube', version, description: 'Fixture plugin.',
      capabilities: [{ from: 'image', to: 'threejs-code' }],
      requires: { harness: '>=0.1.0', coreApi: 1 },
    }) + '\n',
    'SKILL.md': '# hello-cube\n',
    '.gitignore': '_img2_local.py\n',
  })
}

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'img2-ensure-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const HOME = path.join(root, 'home')
  const origins = path.join(root, 'origins')
  for (const dir of ['.claude/skills', '.codex/skills', '.config/opencode/skills', '.local/bin']) {
    fs.mkdirSync(path.join(HOME, dir), { recursive: true })
  }
  fs.mkdirSync(origins)
  const config = path.join(root, 'gitconfig')
  fs.writeFileSync(config, '[url "file://' + origins + '/"]\n  insteadOf = https://github.com/img2threejs/\n')
  const preload = path.join(root, 'preload.mjs')
  const fetched = path.join(root, 'catalog-fetched')
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    globalThis.fetch = async url => {
      if (url !== ${JSON.stringify(CATALOG_URL)}) throw new Error('unexpected URL');
      fs.writeFileSync(${JSON.stringify(fetched)}, '1');
      return { status: 200, text: async () => ${JSON.stringify(JSON.stringify(catalog))} };
    };
  `)
  const sb = {
    root, HOME, origins, fetched, H: path.join(HOME, '.img2'),
    env: { HOME, PATH: path.join(HOME, '.local/bin') + path.delimiter + process.env.PATH,
      IMG2_HOME: path.join(HOME, '.img2'), XDG_CONFIG_HOME: path.join(HOME, '.config'),
      GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1',
      NODE_OPTIONS: '--import=' + preload },
  }
  sb.harnessWork = bareOrigin(sb, 'img2')
  fs.cpSync(CORE, path.join(sb.harnessWork, 'img2_core'), { recursive: true, filter: src => !src.includes('__pycache__') })
  fs.writeFileSync(path.join(sb.harnessWork, '.gitignore'), '__pycache__/\n_img2_local.py\n')
  sb.pluginWork = bareOrigin(sb, 'plugin-hello-cube.git')
  return sb
}

function run(sb, args, expected = 0, env = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: sb.root, env: { ...sb.env, ...env }, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  })
  assert.equal(result.status, expected, JSON.stringify(args) + '\n' + result.stdout + result.stderr + (result.error || ''))
  return result
}

const hd = sb => path.join(sb.H, 'harness')
const head = sb => git(sb, hd(sb), ['rev-parse', 'HEAD'])
const marker = sb => path.join(sb.H, 'auto-install')
const registrations = sb => JSON.parse(fs.readFileSync(path.join(sb.H, 'plugins.json'), 'utf8')).plugins

function snapshot(dirs) {
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
  for (const dir of dirs) if (fs.existsSync(dir)) walk(dir, dir)
  return out
}

const stateDirs = sb => [sb.H, path.join(sb.HOME, '.claude'), path.join(sb.HOME, '.codex'), path.join(sb.HOME, '.config')]

test('install pins the newest harness tag; only --auto-install writes the consent marker', t => {
  const sb = sandbox(t)
  harnessRelease(sb, OLD_TAG)
  const newest = harnessRelease(sb, CLI_TAG)
  fs.writeFileSync(path.join(sb.harnessWork, 'README.md'), 'unreleased\n')
  commit(sb, sb.harnessWork)
  git(sb, sb.harnessWork, ['push', '-q', 'origin', 'main'])

  run(sb, ['install', '--yes'])
  assert.equal(head(sb), newest)
  assert.equal(git(sb, hd(sb), ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'checkout is detached')
  assert.equal(fs.existsSync(marker(sb)), false)

  run(sb, ['install', '--yes', '--auto-install'])
  assert.match(fs.readFileSync(marker(sb), 'utf8'), /^\d{4}-\d{2}-\d{2}T\S+ official-public-catalog\n$/)
  assert.equal(head(sb), newest, 'an existing checkout is kept as is')
})

test('update advances a clean official checkout to a tag pushed after it was cloned; --check moves nothing', t => {
  const sb = sandbox(t)
  harnessRelease(sb, OLD_TAG)
  pluginRelease(sb, '0.1.0')
  run(sb, ['install', '--yes'])
  run(sb, ['add', 'hello-cube', '--yes'])
  const before = head(sb)
  const target = harnessRelease(sb, CLI_TAG)
  pluginRelease(sb, '0.2.0')
  assert.throws(() => git(sb, hd(sb), ['rev-parse', '--verify', '-q', 'refs/tags/' + CLI_TAG]), 'clone predates the tag')

  const check = run(sb, ['update', '--check'], 1)
  assert.match(check.stdout, /harness\s*\|\s*pending\s*\|\s*v/)
  assert.match(check.stdout, /Pending updates\s*\|\s*2/)
  assert.equal(head(sb), before)
  assert.equal(registrations(sb)[0].ref, 'v0.1.0')

  git(sb, hd(sb), ['checkout', '-q', '-b', 'main'])
  const r = run(sb, ['update'])
  assert.ok(r.stdout.indexOf('harness') < r.stdout.indexOf('hello-cube'), 'harness is handled before plugins')
  assert.match(r.stdout + r.stderr, /left branch "main"; now detached at v/)
  assert.equal(head(sb), target)
  assert.equal(registrations(sb)[0].ref, 'v0.2.0')
  assert.match(run(sb, ['update', 'harness']).stdout, /not behind/)
})

test('update leaves dirty, dev-branch and foreign-origin checkouts in place', t => {
  const sb = sandbox(t)
  harnessRelease(sb, OLD_TAG)
  run(sb, ['install', '--yes'])
  harnessRelease(sb, CLI_TAG)
  const start = head(sb)

  fs.writeFileSync(path.join(hd(sb), 'package.json'), '{"version":"0.0.2"}\n')
  assert.match(run(sb, ['update', 'harness']).stdout, /skipped\s*\|\s*dirty/)
  assert.equal(head(sb), start)
  git(sb, hd(sb), ['checkout', '-q', '--', 'package.json'])

  git(sb, hd(sb), ['checkout', '-q', '-b', 'dev'])
  fs.writeFileSync(path.join(hd(sb), 'README.md'), 'local work\n')
  commit(sb, hd(sb))
  const dev = head(sb)
  assert.match(run(sb, ['update', 'harness']).stdout, /not behind v/)
  assert.equal(head(sb), dev)

  git(sb, hd(sb), ['checkout', '-q', '--detach', start])
  git(sb, hd(sb), ['remote', 'set-url', 'origin', 'file://' + path.join(sb.origins, 'img2')])
  assert.match(run(sb, ['update', 'harness']).stdout, /local origin/)
  assert.equal(head(sb), start)
})

test('ensure on a fresh home without consent exits 3 and creates nothing', t => {
  const sb = sandbox(t)
  const before = snapshot([sb.HOME])
  const r = run(sb, ['ensure', 'hello-cube'], 3)
  assert.match(r.stderr, /install --yes --auto-install/)
  assert.deepEqual(snapshot([sb.HOME]), before)
  assert.equal(fs.existsSync(sb.fetched), false)
})

test('ensure refuses every option, extra or non-ID positional, non-public ID and missing consent without changes', t => {
  const sb = sandbox(t)
  harnessRelease(sb, CLI_TAG)
  pluginRelease(sb, '0.1.0')
  run(sb, ['install', '--yes', '--auto-install'])
  const before = snapshot(stateDirs(sb))

  const refusals = [
    [['ensure', 'hello-cube', '--allow-any-source'], 2],
    [['ensure', '--force', 'hello-cube'], 2],
    [['ensure', 'hello-cube', '--link', sb.pluginWork], 2],
    [['ensure', 'hello-cube', '--home', sb.H], 2],
    [['ensure', 'hello-cube', '--yes'], 2],
    [['--yes', 'ensure', 'hello-cube'], 2],
    [['ensure', 'hello-cube', '-v'], 2],
    [['ensure', 'hello-cube', 'environment'], 2],
    [['ensure'], 2],
    [['ensure', 'img2threejs/plugin-hello-cube'], 2],
    [['ensure', ''], 2],
    [['ensure', '--', 'hello-cube'], 2],
  ]
  for (const [args, code] of refusals) {
    run(sb, args, code)
    assert.equal(fs.existsSync(sb.fetched), false, JSON.stringify(args) + ' refused before the catalog')
  }
  run(sb, ['ensure', 'environment'], 2)
  run(sb, ['ensure', 'unknown-plugin'], 2)
  assert.match(run(sb, ['ensure', 'hello-cube'], 3, { IMG2_AUTO_INSTALL: '0' }).stderr, /--auto-install/)
  assert.deepEqual(snapshot(stateDirs(sb)), before)

  fs.rmSync(marker(sb))
  const withoutMarker = snapshot(stateDirs(sb))
  run(sb, ['ensure', 'hello-cube'], 3)
  assert.deepEqual(snapshot(stateDirs(sb)), withoutMarker)
  assert.deepEqual(registrations(sb), [])
})

test('ensure fails without changes when the checkout cannot reach the CLI version', t => {
  const sb = sandbox(t)
  harnessRelease(sb, OLD_TAG)
  pluginRelease(sb, '0.1.0')
  run(sb, ['install', '--yes', '--auto-install'])
  const start = head(sb)
  const gitDir = path.join(hd(sb), '.git')
  const state = () => Object.fromEntries(Object.entries(snapshot(stateDirs(sb))).filter(([key]) => !key.startsWith(gitDir)))
  const before = state()

  const r = run(sb, ['ensure', 'hello-cube'], 1)
  assert.ok(r.stderr.includes('tag ' + CLI_TAG + ' not on origin'), r.stderr)
  fs.renameSync(path.join(sb.origins, 'img2'), path.join(sb.origins, 'img2-offline'))
  assert.match(run(sb, ['ensure', 'hello-cube'], 1).stderr, /was not advanced: fetch failed/)
  assert.equal(head(sb), start)
  assert.deepEqual(state(), before)
})

test('a failed harness fetch is reported and plugin updates still run', t => {
  const sb = sandbox(t)
  harnessRelease(sb, OLD_TAG)
  pluginRelease(sb, '0.1.0')
  run(sb, ['install', '--yes'])
  run(sb, ['add', 'hello-cube', '--yes'])
  pluginRelease(sb, '0.2.0')
  fs.renameSync(path.join(sb.origins, 'img2'), path.join(sb.origins, 'img2-offline'))
  const r = run(sb, ['update'])
  assert.match(r.stdout, /harness\s*\|\s*skipped\s*\|\s*fetch failed/)
  assert.equal(registrations(sb)[0].ref, 'v0.2.0')
})

test('ensure advances the checkout to the CLI version, adds a public plugin once and never updates it', t => {
  const sb = sandbox(t)
  harnessRelease(sb, OLD_TAG)
  const pinned = pluginRelease(sb, '0.1.0')
  run(sb, ['install', '--yes', '--auto-install'])
  const target = harnessRelease(sb, CLI_TAG)

  const r = run(sb, ['ensure', 'hello-cube'])
  assert.ok(r.stdout.includes('ensured hello-cube v0.1.0 ' + pinned + ' profile-check: run forge/state.py init --help'), r.stdout)
  assert.equal(head(sb), target)
  assert.deepEqual(registrations(sb).map(row => [row.id, row.repo, row.ref]), [['hello-cube', 'img2threejs/plugin-hello-cube', 'v0.1.0']])
  assert.ok(fs.lstatSync(path.join(sb.HOME, '.claude/skills/img2-hello-cube')).isSymbolicLink())

  pluginRelease(sb, '0.2.0')
  const again = run(sb, ['ensure', 'hello-cube'])
  assert.ok(again.stdout.includes('hello-cube already installed v0.1.0'), again.stdout)
  assert.equal(registrations(sb)[0].resolvedSha, pinned)
})
