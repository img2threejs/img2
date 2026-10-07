import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cli-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  return { root, home, env: { ...process.env, HOME: home, IMG2_HOME: path.join(home, '.img2'), GIT_TERMINAL_PROMPT: '0' } }
}

test('install dry-run preserves the complete isolated home', t => {
  const sb = sandbox(t)
  const result = spawnSync(process.execPath, [BIN, 'install', '--dry-run'], { env: sb.env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(fs.readdirSync(sb.home), [])
})

test('install without consent refuses before creating a harness or host links', t => {
  const sb = sandbox(t)
  const result = spawnSync(process.execPath, [BIN, 'install'], { env: sb.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(result.status, 3, result.stderr)
  assert.deepEqual(fs.readdirSync(sb.home), [])
})
