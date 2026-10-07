import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UI = new URL('../bin/ui.mjs', import.meta.url).href
function render({ stdoutTTY, stderrTTY, env = {}, action = '' }) {
  const childEnv = { ...process.env, TERM: 'xterm-256color', ...env }
  if (!Object.hasOwn(env, 'NO_COLOR')) delete childEnv.NO_COLOR
  if (!Object.hasOwn(env, 'FORCE_COLOR')) delete childEnv.FORCE_COLOR
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ui } from ${JSON.stringify(UI)};
    Object.defineProperty(process.stdout, 'isTTY', { value: ${stdoutTTY} });
    Object.defineProperty(process.stderr, 'isTTY', { value: ${stderrTTY} });
    ui.heading('Install plugin');
    ui.error('img2', 'invalid source');
    ${action}
  `], { env: childEnv, encoding: 'utf8' })
}

for (const scenario of [
  { name: 'interactive terminal', stdoutTTY: true, stderrTTY: true, stdoutColor: true, stderrColor: true },
  { name: 'piped output ignores FORCE_COLOR', stdoutTTY: false, stderrTTY: false, stdoutColor: false, stderrColor: false, env: { FORCE_COLOR: '1' } },
  { name: 'empty NO_COLOR disables terminal styling', stdoutTTY: true, stderrTTY: true, stdoutColor: false, stderrColor: false, env: { NO_COLOR: '' } },
  { name: 'dumb terminal remains plain', stdoutTTY: true, stderrTTY: true, stdoutColor: false, stderrColor: false, env: { TERM: 'dumb' } },
  { name: 'stdout and stderr use their own terminal capability', stdoutTTY: false, stderrTTY: true, stdoutColor: false, stderrColor: true },
]) {
  test(scenario.name, () => {
    const result = render(scenario)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.includes('\x1b['), scenario.stdoutColor)
    assert.equal(result.stderr.includes('\x1b['), scenario.stderrColor)
  })
}

test('a copied next command keeps shell metacharacters literal', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'img2-ui-command-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const marker = path.join(root, 'injected')
  const literal = path.join(root, "folder ' $(touch " + marker + ')')
  const result = render({ stdoutTTY: false, stderrTTY: false, action: `ui.next(['mkdir', '-p', ${JSON.stringify(literal)}]);` })
  assert.equal(result.status, 0, result.stderr)
  const command = result.stdout.trimEnd().split('\n').at(-1).trim()
  const executed = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
  assert.equal(executed.status, 0, executed.stderr)
  assert.equal(fs.statSync(literal).isDirectory(), true)
  assert.equal(fs.existsSync(marker), false)
})

test('a copied narrow-terminal command preserves home-relative quoted paths and arguments', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'img2-ui-narrow-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, "home with 'quotes")
  fs.mkdirSync(home)
  const literal = path.join(home, "folder with 'quotes", 'nested')
  const env = { HOME: home, NO_COLOR: '1' }
  const result = render({
    stdoutTTY: true, stderrTTY: false, env,
    action: `Object.defineProperty(process.stdout, 'columns', { value: 24 }); ui.next(['mkdir', '-p', ${JSON.stringify(literal)}]);`,
  })
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.trimEnd().split('\n')
  const start = lines.findIndex(line => line.trimStart().startsWith('mkdir '))
  assert.notEqual(start, -1)
  const command = lines.slice(start).join('\n')
  const executed = spawnSync('/bin/sh', ['-c', command], { env: { ...process.env, ...env }, encoding: 'utf8' })
  assert.equal(executed.status, 0, executed.stderr)
  assert.equal(fs.statSync(literal).isDirectory(), true)
})

test('untrusted values cannot inject terminal control sequences into plain output', () => {
  const value = '\x1b[2J\r[OK] forged\x00\x9b31m'
  const result = render({
    stdoutTTY: false, stderrTTY: false,
    action: `ui.detail('Source', ${JSON.stringify(value)}); ui.error('plugin', ${JSON.stringify(value)});`,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(result.stdout + result.stderr), false)
})
