import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/create-plugin-cli.mjs', import.meta.url))
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'img2-generator-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'plugin')
  fs.mkdirSync(repo)
  fs.writeFileSync(path.join(repo, 'plugin.json'), JSON.stringify({ schema: 1, name: 'demo', version: '0.1.0', description: 'Fixture', capabilities: [{ from: 'image', to: 'threejs-code' }], requires: { harness: '>=0.1.0', coreApi: 1 } }))
  fs.writeFileSync(path.join(repo, 'SKILL.md'), '# Fixture\n')
  const run = args => spawnSync(process.execPath, [BIN, '--directory', repo, '--source', 'img2threejs/demo', '--workflow-ref', 'a'.repeat(40), ...args], { encoding: 'utf8' })
  return { root, repo, run }
}

for (const output of ['cli', 'CLI_QUICKSTART.md', '.github/workflows/cli-publish.yml']) {
  test('existing authored output is preserved: ' + output, t => {
    const sb = fixture(t)
    const target = path.join(sb.repo, output)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (output === 'cli') {
      fs.mkdirSync(target)
      fs.writeFileSync(path.join(target, 'private-file'), 'preserve')
    } else fs.writeFileSync(target, 'preserve')
    const result = sb.run([])
    assert.equal(result.status, 2, result.stderr)
    assert.equal(fs.readFileSync(output === 'cli' ? path.join(target, 'private-file') : target, 'utf8'), 'preserve')
    if (output !== 'cli') assert.equal(fs.existsSync(path.join(sb.repo, 'cli')), false)
  })
}

for (const parent of ['.github', '.github/workflows']) {
  test('symlinked workflow parent cannot write outside the requested repository: ' + parent, t => {
    const sb = fixture(t)
    const outside = path.join(sb.root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'preserve'), 'private')
    const target = path.join(sb.repo, parent)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(outside, target, 'dir')
    assert.equal(sb.run([]).status, 2)
    assert.deepEqual(fs.readdirSync(outside), ['preserve'])
    assert.equal(fs.existsSync(path.join(sb.repo, 'cli')), false)
  })
}

test('a dangling output link is refused before generating any files', t => {
  const sb = fixture(t)
  const outside = path.join(sb.root, 'missing-quickstart')
  fs.symlinkSync(outside, path.join(sb.repo, 'CLI_QUICKSTART.md'))
  assert.equal(sb.run([]).status, 2)
  assert.equal(fs.existsSync(outside), false)
  assert.equal(fs.existsSync(path.join(sb.repo, 'cli')), false)
})

test('invalid refs and malformed flags do not partially generate a CLI', t => {
  const sb = fixture(t)
  const before = fs.readdirSync(sb.repo)
  for (const args of [['--ref', 'main'], ['--ref', 'v01.0.0'], ['--ref', '--private-repo'], ['--name', '../outside'], ['--cli-version', '01.0.0'], ['--unsupported'], ['positional']]) {
    assert.equal(sb.run(args).status, 2, args.join(' '))
    assert.deepEqual(fs.readdirSync(sb.repo), before)
  }
})
