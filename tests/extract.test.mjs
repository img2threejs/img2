import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { extractTarGz, extractZip, UnsafeArchive } from '../bin/runtime/extract.mjs'
import { installNpmRoot } from '../bin/runtime/npmroot.mjs'
import { satisfies } from '../bin/runtime/semver.mjs'
import { makeTarGz, makeZip, tmp } from './runtime-fixtures.mjs'

const write = (dir, name, buf) => { const f = path.join(dir, name); fs.writeFileSync(f, buf); return f }
const reject = async (fn, re) => { await assert.rejects(async () => fn(), (e) => e instanceof UnsafeArchive && re.test(e.message)) }

test('tar: extracts files, directories, modes and relative symlinks; strips the top directory', async () => {
  const d = tmp(); const out = path.join(d, 'out')
  const f = write(d, 'a.tgz', makeTarGz([
    { name: 'top/', type: 'dir' }, { name: 'top/bin/run', data: '#!x', mode: 0o755 }, { name: 'top/lib/a.txt', data: 'hello' }, { name: 'top/lib/link', type: 'symlink', link: 'a.txt' },
  ]))
  const r = await extractTarGz(f, out, { strip: 1 })
  assert.equal(fs.readFileSync(path.join(out, 'lib', 'a.txt'), 'utf8'), 'hello')
  assert.equal(fs.statSync(path.join(out, 'bin', 'run')).mode & 0o111, 0o111)
  assert.equal(fs.readlinkSync(path.join(out, 'lib', 'link')), 'a.txt')
  assert.ok(r.entries >= 4)
})

test('tar: path traversal, absolute names and symlink escapes are refused and write nothing outside', async () => {
  for (const [name, entries, re] of [
    ['dotdot', [{ name: '../escape.txt', data: 'x' }], /traversal/],
    ['nested dotdot', [{ name: 'a/../../escape.txt', data: 'x' }], /traversal/],
    ['absolute', [{ name: '/tmp/img2-abs.txt', data: 'x' }], /absolute/],
    ['symlink up', [{ name: 'l', type: 'symlink', link: '../outside' }], /escapes/],
    ['symlink absolute', [{ name: 'l', type: 'symlink', link: '/etc/passwd' }], /unsafe target/],
    ['write through symlink', [{ name: 'dir', type: 'symlink', link: '.' }, { name: 'dir/inner.txt', data: 'x' }], /through symlink|escapes/],
    ['chain', [{ name: 'a', type: 'symlink', link: 'b' }, { name: 'b', type: 'symlink', link: '../x' }], /escapes/],
  ]) {
    const d = tmp(); const out = path.join(d, 'out')
    const f = write(d, 'a.tgz', makeTarGz(entries))
    await reject(() => extractTarGz(f, out), re)
    assert.equal(fs.existsSync(path.join(d, 'escape.txt')), false, name)
    assert.equal(fs.existsSync('/tmp/img2-abs.txt'), false, name)
  }
})

test('tar: a symlink that points back inside but resolves outside through another link is caught at the end', async () => {
  const d = tmp(); const out = path.join(d, 'out')
  const f = write(d, 'a.tgz', makeTarGz([{ name: 'sub/up', type: 'symlink', link: '..' }, { name: 'link', type: 'symlink', link: 'sub/up/..' }]))
  await reject(() => extractTarGz(f, out), /escapes|outside/)
})

test('tar: device nodes, a corrupted checksum and oversized archives are refused', async () => {
  const d = tmp()
  const raw = zlib.gunzipSync(makeTarGz([{ name: 'f', data: 'abc' }]))
  const fifo = Buffer.from(raw); fifo[156] = '6'.charCodeAt(0)
  let sum = 0; for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : fifo[i]
  fifo.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  await reject(() => extractTarGz(write(d, 'dev.tgz', zlib.gzipSync(fifo)), path.join(d, 'o1')), /unsupported tar entry type/)
  const bad = Buffer.from(raw); bad[0] ^= 0xff
  await reject(() => extractTarGz(write(d, 'bad.tgz', zlib.gzipSync(bad)), path.join(d, 'o2')), /checksum/)
  await reject(() => extractTarGz(write(d, 'big.tgz', makeTarGz([{ name: 'f', data: 'x'.repeat(100) }])), path.join(d, 'o3'), { limits: { maxBytes: 10, maxEntries: 10 } }), /expands beyond/)
  await reject(() => extractTarGz(write(d, 'many.tgz', makeTarGz([{ name: 'a', data: '1' }, { name: 'b', data: '1' }])), path.join(d, 'o4'), { limits: { maxBytes: 1e6, maxEntries: 1 } }), /too many entries/)
})

test('tar: a hardlink may only point at an extracted regular file inside the tree', async () => {
  const d = tmp()
  const ok = write(d, 'ok.tgz', makeTarGz([{ name: 'a', data: 'same' }, { name: 'b', type: 'hardlink', link: 'a' }]))
  await extractTarGz(ok, path.join(d, 'o1'))
  assert.equal(fs.readFileSync(path.join(d, 'o1', 'b'), 'utf8'), 'same')
  await reject(() => extractTarGz(write(d, 'evil.tgz', makeTarGz([{ name: 'b', type: 'hardlink', link: '/etc/passwd' }])), path.join(d, 'o2')), /absolute|missing/)
})

test('tar: a hardlink source behind symlinked ancestors never reads outside the destination', async () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'secret'), 'TOP SECRET')
  const f = write(d, 'h.tgz', makeTarGz([
    { name: 'out/sub/up', type: 'symlink', link: '..' },
    { name: 'out/escape', type: 'symlink', link: 'sub/up/..' },
    { name: 'out/stolen', type: 'hardlink', link: 'out/escape/secret' },
    { name: 'out/escape', data: 'replace the escape symlink before finish()' },
  ]))
  await reject(() => extractTarGz(f, path.join(d, 'out'), { strip: 1 }), /symlink|outside/)
  assert.equal(fs.existsSync(path.join(d, 'out', 'stolen')), false)
  const direct = write(d, 'h2.tgz', makeTarGz([{ name: 'real', data: 'x' }, { name: 'ln', type: 'symlink', link: 'real' }, { name: 'h', type: 'hardlink', link: 'ln' }]))
  await reject(() => extractTarGz(direct, path.join(d, 'o2')), /symlink/)
  const changedSource = write(d, 'h3.tgz', makeTarGz([
    { name: 'src', data: 'safe' }, { name: 'h', type: 'hardlink', link: 'src' },
    { name: 'src', type: 'symlink', link: 'h' },
  ]))
  await reject(() => extractTarGz(changedSource, path.join(d, 'o3')), /symlink/)
})

test('zip: extracts files and relative symlinks, refuses traversal, absolute names and symlink escapes', async () => {
  const d = tmp(); const out = path.join(d, 'out')
  extractZip(write(d, 'ok.zip', makeZip([{ name: 'cli', data: '#!x', mode: 0o755 }, { name: 'sub/', data: '' }, { name: 'sub/l', symlink: '../cli' }])), out)
  assert.equal(fs.statSync(path.join(out, 'cli')).mode & 0o111, 0o111)
  assert.equal(fs.readlinkSync(path.join(out, 'sub', 'l')), '../cli')
  for (const [entries, re] of [
    [[{ name: '../x', data: '1' }], /traversal/], [[{ name: '/abs', data: '1' }], /absolute/],
    [[{ name: 'l', symlink: '../../outside' }], /escapes/], [[{ name: 'a\\b', data: '1' }], /unsafe entry name/],
  ]) {
    assert.throws(() => extractZip(write(d, 'bad.zip', makeZip(entries)), path.join(tmp(), 'o')), (e) => e instanceof UnsafeArchive && re.test(e.message))
  }
  assert.throws(() => extractZip(write(d, 'junk.zip', Buffer.from('not a zip at all')), path.join(d, 'j')), /not a zip/)
})

test('semver matcher covers the ranges real npm manifests use', () => {
  for (const [v, r] of [['1.2.3', '^1.0.0'], ['0.2.5', '^0.2.3'], ['1.2.9', '~1.2.3'], ['4.6.7', '^3.25.0 || ^4.0.0'], ['1.0.5', '>=1.0.5 <2'], ['1.5.0', '*'], ['1.5.0', '1.x'], ['2.0.0-dev.3.10', '2.0.0-dev.3.10'], ['1.2.3', '1.2.3 - 2.3.4'], ['18.2.0', '>=18']]) assert.ok(satisfies(v, r), v + ' ' + r)
  for (const [v, r] of [['2.0.0', '^1.0.0'], ['0.3.0', '^0.2.3'], ['1.3.0', '~1.2.3'], ['17.9.0', '>=18'], ['1.0.0-beta.1', '^1.0.0'], ['0.0.1751165', '^0.0.1608973'], ['2.1.0', '>=1.0.5 <2']]) assert.ok(!satisfies(v, r), v + ' ' + r)
})

const pkgTar = (name, version, extra = {}, files = {}) => makeTarGz([{ name: 'package/package.json', data: JSON.stringify({ name, version, ...extra }) }, ...Object.entries(files).map(([n, data]) => ({ name: 'package/' + n, data }))])

test('npm root: hoists to the root, nests conflicting versions, links bins, and skips unreviewed install scripts', async () => {
  const d = tmp()
  const pkgs = [
    ['app', '1.0.0', { dependencies: { zod: '^4.0.0', 'content-type': '^1.0.5', sub: '1.0.0' }, bin: { app: 'cli.js' } }, { 'cli.js': '//' }],
    ['sub', '1.0.0', { dependencies: { zod: '^3.25.0' } }],
    ['zod', '4.6.7', {}], ['zod', '3.25.76', {}], ['content-type', '1.0.5', { scripts: { postinstall: 'node x' } }],
  ].map(([n, v, e, f]) => ({ name: n, version: v, file: write(d, n + v + '.tgz', pkgTar(n, v, e, f)) }))
  const root = path.join(d, 'root')
  const r = await installNpmRoot({ root, packages: pkgs, rootDeps: [{ name: 'app', version: '1.0.0' }], runScript: async () => assert.fail('unreviewed script must not run') })
  const ver = (p) => JSON.parse(fs.readFileSync(path.join(root, p, 'package.json'), 'utf8')).version
  assert.equal(ver('node_modules/zod'), '4.6.7')
  assert.equal(ver('node_modules/sub/node_modules/zod'), '3.25.76')
  assert.equal(fs.readlinkSync(path.join(root, 'node_modules', '.bin', 'app')), '../app/cli.js')
  assert.deepEqual(r.scriptsSkipped, ['content-type@1.0.5'])
  assert.equal(fs.existsSync(path.join(root, '.store')), false)
})

test('npm root: a tarball whose package.json identity differs from the lock is refused', async () => {
  const d = tmp()
  const pkgs = [{ name: 'a', version: '1.0.0', file: write(d, 'a.tgz', pkgTar('evil', '1.0.0')) }]
  await assert.rejects(() => installNpmRoot({ root: path.join(d, 'r'), packages: pkgs, rootDeps: [{ name: 'a', version: '1.0.0' }], runScript: async () => {} }), /identity mismatch/)
})

test('npm root: a dependency the lock cannot satisfy fails; an unsatisfied optional dependency is skipped', async () => {
  const d = tmp()
  const mk = (extra) => [{ name: 'a', version: '1.0.0', file: write(d, 'a' + Math.random() + '.tgz', pkgTar('a', '1.0.0', extra)) }]
  await assert.rejects(() => installNpmRoot({ root: path.join(d, 'r1'), packages: mk({ dependencies: { missing: '^1' } }), rootDeps: [{ name: 'a', version: '1.0.0' }], runScript: async () => {} }), /cannot satisfy/)
  const r = await installNpmRoot({ root: path.join(d, 'r2'), packages: mk({ optionalDependencies: { fsevents: '^2' } }), rootDeps: [{ name: 'a', version: '1.0.0' }], runScript: async () => {} })
  assert.equal(r.placements.length, 1)
})

test('npm root: unsafe package names are refused', async () => {
  const d = tmp()
  await assert.rejects(() => installNpmRoot({ root: path.join(d, 'r'), packages: [{ name: '../evil', version: '1.0.0', file: write(d, 'e.tgz', pkgTar('../evil', '1.0.0')) }], rootDeps: [{ name: '../evil', version: '1.0.0' }], runScript: async () => {} }), /unsafe package name/)
})
