import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EXIT } from '../bin/runtime/errors.mjs'
import { runProvision } from '../bin/runtime/provision.mjs'
import { evaluatePipCheck, filenameTag } from '../bin/runtime/pipcheck.mjs'
import { baseOpts, makeDeps, makeFixture, makeZip, sha256, stubRunner, tmp, URL_BASE } from './runtime-fixtures.mjs'

const NOT_SUPPORTED = 'bpy 4.5.15 is not supported on this platform\n'
const FILENAME = 'bpy-4.5.15-cp311-cp311-manylinux_2_28_x86_64.whl'
const wheelZip = (tag) => makeZip([
  { name: 'bpy/__init__.py', data: '# stub' },
  { name: 'bpy-4.5.15.dist-info/WHEEL', data: 'Wheel-Version: 1.0\nGenerator: setuptools\nRoot-Is-Purelib: false\nTag: ' + tag + '\n' },
])

// A fixture whose character bpy wheel is a real zip carrying the given internal WHEEL tag.
function fixtureWith(tag, { filename = FILENAME } = {}) {
  return makeFixture({ mutate: (lock, bytes) => {
    const dep = lock.dependencies.find((d) => d.id === 'character-bpy')
    const buf = wheelZip(tag)
    const url = URL_BASE + filename
    bytes.set(url, buf)
    dep.artifacts = [{ platform: 'linux-x64', filename, url, size: buf.length, sha256: sha256(buf) }]
  } })
}

// only the character venv fails its pip check (the line names the character bpy pin)
const pipCheckFails = (stdout, inner = stubRunner()) => (file, args, opts) => (args.includes('pip') && args.includes('check') && file.includes('/character/')
  ? { code: 1, signal: null, stdout, stderr: '', timedOut: false, error: null }
  : inner(file, args, opts))

const receipt = (deps) => JSON.parse(fs.readFileSync(path.join(deps.home, 'runtime', 'provision.json'), 'utf8'))

test('the mis-tagged bpy wheel is waived: provision succeeds and the receipt carries the waiver', async () => {
  const fx = fixtureWith('cp39-cp39-manylinux_2_28_x86_64')
  const deps = makeDeps(fx, { run: pipCheckFails(NOT_SUPPORTED) })
  assert.equal(await runProvision(baseOpts(), deps.home, deps), EXIT.OK, deps.errs.join('\n'))
  const r = receipt(deps)
  const w = r.steps.filter((s) => s.kind === 'waiver')
  assert.equal(w.length, 1)
  assert.equal(w[0].package, 'bpy'); assert.equal(w[0].version, '4.5.15')
  assert.equal(w[0].reason, 'upstream-wheel-tag-mismatch')
  assert.equal(w[0].wheelSha256, fx.entry('character-bpy').artifacts[0].sha256)
  assert.deepEqual(r.units.find((u) => u.name === 'character').waivers.map((x) => x.package), ['bpy'])
  assert.equal(r.units.find((u) => u.name === 'interior').waivers, undefined)
})

test('the waiver is fail-closed: another line, another package, or a different tag difference stays fatal', async () => {
  const cases = [
    ['an extra unrelated line', NOT_SUPPORTED + 'bpy 4.5.15 requires cython, which is not installed.\n', 'cp39-cp39-manylinux_2_28_x86_64'],
    ['another package failing', 'numpy 1.26.4 is not supported on this platform\n', 'cp39-cp39-manylinux_2_28_x86_64'],
    ['a different bpy version', 'bpy 9.9.9 is not supported on this platform\n', 'cp39-cp39-manylinux_2_28_x86_64'],
    ['a platform difference, not only the python tag', NOT_SUPPORTED, 'cp39-cp39-win_amd64'],
    ['an abi difference', NOT_SUPPORTED, 'cp39-abi3-manylinux_2_28_x86_64'],
    ['an internal tag equal to the filename tag', NOT_SUPPORTED, 'cp311-cp311-manylinux_2_28_x86_64'],
    ['empty pip check output', '', 'cp39-cp39-manylinux_2_28_x86_64'],
  ]
  for (const [name, stdout, tag] of cases) {
    const fx = fixtureWith(tag)
    const deps = makeDeps(fx, { run: pipCheckFails(stdout) })
    assert.equal(await runProvision(baseOpts(), deps.home, deps), EXIT.FAIL, name)
    assert.match(deps.errs.join('\n'), /pip check failed/, name)
    assert.equal(receipt(deps).steps.filter((s) => s.kind === 'waiver').length, 0, name)
  }
})

test('a wheel whose bytes differ from the lock-pinned sha256 is never waived', () => {
  const dir = tmp('img2-waiver-')
  const file = path.join(dir, FILENAME)
  const good = wheelZip('cp39-cp39-manylinux_2_28_x86_64')
  fs.writeFileSync(file, good)
  const cand = { name: 'bpy', version: '4.5.15', filename: FILENAME, file, lockSha256: sha256(good) }
  const ok = evaluatePipCheck({ output: NOT_SUPPORTED, candidates: [cand], platform: 'linux-x64' })
  assert.equal(ok.fatal.length, 0); assert.equal(ok.waivers.length, 1)
  const wrongPin = evaluatePipCheck({ output: NOT_SUPPORTED, candidates: [{ ...cand, lockSha256: sha256('other') }], platform: 'linux-x64' })
  assert.equal(wrongPin.waivers.length, 0); assert.match(wrongPin.fatal.join('\n'), /!= lock/)
  const noPin = evaluatePipCheck({ output: NOT_SUPPORTED, candidates: [{ ...cand, lockSha256: null }], platform: 'linux-x64' })
  assert.equal(noPin.waivers.length, 0)
  const wrongPlatform = evaluatePipCheck({ output: NOT_SUPPORTED, candidates: [cand], platform: 'darwin-arm64' })
  assert.equal(wrongPlatform.waivers.length, 0); assert.match(wrongPlatform.fatal.join('\n'), /does not match darwin-arm64/)
  const notAWheel = path.join(dir, 'junk.whl')
  fs.writeFileSync(notAWheel, 'not a zip')
  assert.equal(evaluatePipCheck({ output: NOT_SUPPORTED, candidates: [{ ...cand, file: notAWheel, lockSha256: sha256('not a zip') }], platform: 'linux-x64' }).waivers.length, 0)
})

test('a tampered download never reaches pip check (cache hash mismatch is fatal first)', async () => {
  const fx = fixtureWith('cp39-cp39-manylinux_2_28_x86_64')
  const deps = makeDeps(fx, { run: pipCheckFails(NOT_SUPPORTED) })
  const download = async (url, dest) => { fs.writeFileSync(dest, Buffer.concat([fx.bytes.get(url), Buffer.from(url.endsWith(FILENAME) ? 'tampered' : '')])) }
  deps.download = download
  assert.equal(await runProvision(baseOpts(), deps.home, deps), EXIT.FAIL)
  assert.equal(receipt(deps).steps.filter((s) => s.kind === 'waiver').length, 0)
})

test('filenameTag parses python, abi and platform tags', () => {
  assert.deepEqual(filenameTag('bpy-4.5.15-cp311-cp311-macosx_11_0_arm64.whl'), { python: 'cp311', abi: 'cp311', platform: 'macosx_11_0_arm64' })
  assert.equal(filenameTag('bpy.tar.gz'), null)
})
