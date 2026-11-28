import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { isDirty, executableLocalConfig, runGit } from '../bin/gitsafe.mjs'
import { cleanEnv } from '../bin/runtime/exec.mjs'
import { loadLocks, resolveSelection } from '../bin/runtime/lock.mjs'
import { makeFixture } from './runtime-fixtures.mjs'

const sandbox = t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'img2-review-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { HOME: root, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim()
  git(['init', '-q'])
  fs.writeFileSync(path.join(root, 'file.txt'), 'original\n')
  git(['add', '.']); git(['commit', '-qm', 'fixture'])
  return { root, env, git }
}

function withEnv(env, fn) {
  const previous = process.env
  process.env = { ...env }
  try { return fn() } finally { process.env = previous }
}

for (const worktree of [false, true]) {
  test('H4 cleanliness never runs refresh-needed filters from ' + (worktree ? 'worktree config' : 'local config'), t => {
    const sb = sandbox(t)
    const marker = path.join(sb.root, '.git/filter-ran')
    const filter = path.join(sb.root, '.git/filter.sh')
    fs.writeFileSync(filter, '#!/bin/sh\nprintf ran > ' + JSON.stringify(marker) + '\ncat\n', { mode: 0o755 })
    fs.writeFileSync(path.join(sb.root, '.gitattributes'), 'file.txt filter=fixture\n')
    sb.git(['add', '.gitattributes']); sb.git(['commit', '-qm', 'attributes'])
    if (worktree) sb.git(['config', 'extensions.worktreeConfig', 'true'])
    sb.git(['config', ...(worktree ? ['--worktree'] : []), 'filter.fixture.clean', filter])
    fs.utimesSync(path.join(sb.root, 'file.txt'), new Date(1000), new Date(1000))
    withEnv(sb.env, () => {
      assert.equal(isDirty(sb.root), false)
      assert.equal(fs.existsSync(marker), false, 'clean filter executed')
      assert.ok(executableLocalConfig(sb.root).includes('filter.fixture.clean'))
      fs.writeFileSync(path.join(sb.root, 'file.txt'), 'changed\n')
      assert.equal(isDirty(sb.root), true)
      assert.equal(fs.existsSync(marker), false)
    })
  })
}

test('H4 worktree includes are identified without executing their configured programs', t => {
  const sb = sandbox(t)
  const included = path.join(sb.root, 'included-config')
  fs.writeFileSync(included, '[filter "fixture"]\n clean = false\n')
  sb.git(['config', 'extensions.worktreeConfig', 'true'])
  sb.git(['config', '--worktree', 'include.path', included])
  withEnv(sb.env, () => assert.ok(executableLocalConfig(sb.root).includes('include.path')))
})

test('H3 trusted SSH transport works while checkout SSH overrides are refused', t => {
  const sb = sandbox(t)
  const marker = path.join(sb.root, 'ssh-ran')
  const ssh = path.join(sb.root, 'ssh-fixture.sh')
  fs.writeFileSync(ssh, '#!/bin/sh\nprintf ran >> ' + JSON.stringify(marker) + '\nexec git-upload-pack ' + JSON.stringify(sb.root) + '\n', { mode: 0o755 })
  const config = path.join(sb.root, 'trusted-gitconfig')
  fs.writeFileSync(config, '[core]\n sshCommand = ' + ssh + '\n')
  const env = { ...sb.env, GIT_CONFIG_GLOBAL: config, GIT_SSH_VARIANT: 'ssh' }
  withEnv(env, () => {
    const refs = runGit(['ls-remote', 'ssh://fixture.invalid/source'])
    assert.match(refs, /HEAD/)
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ran')
    const malicious = path.join(sb.root, 'checkout-ssh.sh')
    const badMarker = path.join(sb.root, 'checkout-ran')
    fs.writeFileSync(malicious, '#!/bin/sh\nprintf ran > ' + JSON.stringify(badMarker) + '\nexit 1\n', { mode: 0o755 })
    sb.git(['config', 'core.sshCommand', malicious])
    assert.throws(() => runGit(['fetch', 'ssh://fixture.invalid/source'], sb.root), /configuration|untrusted/)
    assert.equal(fs.existsSync(badMarker), false)
  })
})

test('H6 installer child allowlist removes secrets and cannot be bypassed by overrides', t => {
  const sb = sandbox(t)
  const secrets = { GITHUB_TOKEN: 'fixture-github', AWS_SECRET_ACCESS_KEY: 'fixture-aws', TYPESAFE_API_KEY: 'fixture-typesafe',
    NODE_OPTIONS: '--require /fixture', PYTHONPATH: '/fixture', PIP_INDEX_URL: 'https://fixture.invalid' }
  const env = cleanEnv({ ...secrets, PLAYWRIGHT_BROWSERS_PATH: '/fixture/browser' }, { ...sb.env, ...secrets, HTTPS_PROXY: 'http://127.0.0.1:9' })
  const result = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const actual = JSON.parse(result.stdout)
  for (const key of Object.keys(secrets)) assert.equal(actual[key], undefined, key)
  assert.equal(actual.HOME, sb.root)
  assert.equal(actual.HTTPS_PROXY, 'http://127.0.0.1:9')
  assert.equal(actual.PLAYWRIGHT_BROWSERS_PATH, '/fixture/browser')
})

for (const contents of [null, '{', '{}']) {
  test('H8 required catalog fails closed for ' + JSON.stringify(contents), t => {
    const fx = makeFixture()
    t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }))
    const file = path.join(fx.root, 'catalog.json')
    if (contents === null) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, contents)
    assert.throws(() => loadLocks(fx.root), error => error.code === 2)
  })
}

const worker = `
import fs from 'node:fs';
import { runProvision } from ${JSON.stringify(new URL('../bin/runtime/provision.mjs', import.meta.url).href)};
import { baseOpts, makeDeps, makeFixture } from ${JSON.stringify(new URL('./runtime-fixtures.mjs', import.meta.url).href)};
const home = process.argv[1];
if (process.argv[2] === 'hold') {
  const opened = fs.openSync.bind(fs), linked = fs.linkSync.bind(fs);
  let held = false;
  const barrier = () => { if (held) return; held = true; process.send('published'); fs.readFileSync(0); };
  fs.openSync = (file, ...args) => { const fd = opened(file, ...args); if (String(file).endsWith('/.provision.lock') && args[0] === 'wx') barrier(); return fd; };
  fs.linkSync = (from, to, ...args) => { const result = linked(from, to, ...args); if (String(to).endsWith('/.provision.lock')) barrier(); return result; };
}
const fx = makeFixture();
try { process.exitCode = await runProvision(baseOpts({plugins:'cs2'}), home, makeDeps(fx, {home})); }
catch (error) { process.stdout.write(error.message + '\\n'); process.exitCode = error.code ?? 1; }
finally { fs.rmSync(fx.root, {recursive:true, force:true}); }
`

function provisionChild(t, home, hold = false) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker, home, hold ? 'hold' : 'run'], {
    env: { HOME: home, PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  let text = ''
  child.stdout.on('data', chunk => { text += chunk })
  child.stderr.on('data', chunk => { text += chunk })
  const exit = once(child, 'exit').then(([code, signal]) => ({ code, signal, text }))
  return { child, exit }
}

test('H7 a contender cannot steal a lock at the publication barrier', { timeout: 15000 }, async t => {
  const sb = sandbox(t)
  const home = path.join(sb.root, 'home')
  const owner = provisionChild(t, home, true)
  assert.equal((await once(owner.child, 'message'))[0], 'published')
  const contender = provisionChild(t, home)
  const result = await contender.exit
  owner.child.stdin.end()
  const original = await owner.exit
  assert.equal(result.code, 2, result.text)
  assert.equal(original.code, 0, original.text)
  assert.equal(fs.existsSync(path.join(home, 'runtime/.provision.lock')), false)
})

test('H7 release never removes a replacement owner and dead-owner recovery is explicit', { timeout: 15000 }, async t => {
  const sb = sandbox(t)
  const home = path.join(sb.root, 'home')
  const owner = provisionChild(t, home, true)
  assert.equal((await once(owner.child, 'message'))[0], 'published')
  const lock = path.join(home, 'runtime/.provision.lock')
  fs.unlinkSync(lock)
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'replacement-owner' }))
  owner.child.stdin.end()
  const original = await owner.exit
  assert.equal(original.code, 0, original.text)
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'replacement-owner')
  fs.unlinkSync(lock)
  const crashed = provisionChild(t, home, true)
  assert.equal((await once(crashed.child, 'message'))[0], 'published')
  crashed.child.kill('SIGKILL')
  await crashed.exit
  const blocked = await provisionChild(t, home).exit
  assert.equal(blocked.code, 2, blocked.text)
  assert.match(blocked.text, /recover|remove|lock/i)
  fs.unlinkSync(lock) // explicit operator recovery, after the real owner has exited
  const recovered = await provisionChild(t, home).exit
  assert.equal(recovered.code, 0, recovered.text)
})

test('H3 HTTPS transport honors a trusted proxy, CA and synthetic credential helper', { timeout: 20000 }, async t => {
  const sb = sandbox(t)
  const cert = path.join(sb.root, '.git/fixture-cert.pem')
  const key = path.join(sb.root, '.git/fixture-key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=fixture.invalid', '-addext', 'subjectAltName=DNS:fixture.invalid'], { env: sb.env, stdio: 'pipe' })
  const helper = path.join(sb.root, '.git/credential-fixture.sh')
  const marker = path.join(sb.root, '.git/helper-ran')
  fs.writeFileSync(helper, '#!/bin/sh\nif [ "$1" = get ]; then\n printf ran >> ' + JSON.stringify(marker)
    + '\n printf "username=fixture\\npassword=synthetic-password\\n"\nfi\n', { mode: 0o755 })
  const advertisement = execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', sb.root], { env: sb.env })
  const serverCode = `
    const fs = require('fs'), http = require('http'), https = require('https'), net = require('net');
    const sockets = new Set();
    const tls = https.createServer({key:fs.readFileSync(${JSON.stringify(key)}),cert:fs.readFileSync(${JSON.stringify(cert)})}, (req,res) => {
      if (req.headers.authorization !== 'Basic ' + Buffer.from('fixture:synthetic-password').toString('base64')) {
        res.writeHead(401, {'WWW-Authenticate':'Basic realm="fixture"'}); res.end(); return;
      }
      const service = Buffer.from('# service=git-upload-pack\\n');
      res.writeHead(200, {'Content-Type':'application/x-git-upload-pack-advertisement'});
      res.end(Buffer.concat([Buffer.from((service.length+4).toString(16).padStart(4,'0')),service,Buffer.from('0000'),Buffer.from(${JSON.stringify(advertisement.toString('base64'))},'base64')]));
    });
    const proxy = http.createServer();
    for (const server of [tls,proxy]) server.on('connection', socket => {sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    proxy.on('connect',(req,client,head) => {
      if (req.url !== 'fixture.invalid:443') {client.destroy(); return;}
      const upstream = net.connect(tls.address().port,'127.0.0.1',()=>{
        client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
        if(head.length) upstream.write(head); client.pipe(upstream);upstream.pipe(client);
      });
      sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));
      upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
    });
    tls.listen(0,'127.0.0.1',()=>proxy.listen(0,'127.0.0.1',()=>process.send({port:proxy.address().port})));
    process.on('message',()=>{for(const socket of sockets) socket.destroy();proxy.close();tls.close();process.disconnect();});
  `
  const server = spawn(process.execPath, ['-e', serverCode], { env: sb.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  t.after(() => { if (server.exitCode === null) server.kill('SIGKILL') })
  const exited = once(server, 'exit')
  const [{ port }] = await once(server, 'message')
  const config = path.join(sb.root, '.git/trusted-http-config')
  fs.writeFileSync(config, '[http]\n proxy = http://127.0.0.1:' + port + '\n sslCAInfo = ' + cert + '\n[credential]\n helper = ' + helper + '\n')
  try {
    withEnv({ ...sb.env, GIT_CONFIG_GLOBAL: config }, () => {
      const refs = runGit(['ls-remote', 'https://fixture.invalid/source'])
      assert.ok(refs.includes(sb.git(['rev-parse', 'HEAD'])), refs)
      assert.equal(fs.readFileSync(marker, 'utf8'), 'ran')
      fs.appendFileSync(config, '[http]\n sslVerify = false\n')
      assert.throws(() => runGit(['ls-remote', 'https://fixture.invalid/source']), /TLS verification/)
    })
  } finally {
    server.send('stop')
    await exited
  }
})

test('H8 full Linux arm64 provisioning explicitly refuses unavailable bpy wheels', () => {
  const locked = loadLocks()
  assert.throws(() => resolveSelection({ lock: locked.lock, pluginsLock: locked.plugins, platform: 'linux-arm64' }),
    error => error.code === 2 && /bpy/.test(error.detail))
  const selection = resolveSelection({ lock: locked.lock, pluginsLock: locked.plugins, platform: 'linux-arm64', skip: ['character-bpy', 'interior-bpy'] })
  for (const id of ['character-bpy', 'interior-bpy']) assert.equal(selection.skipped.find(row => row.id === id).cause, 'user')
})
