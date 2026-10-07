import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UI = new URL('../bin/ui.mjs', import.meta.url).href
const PIPE_FRAMING = (action) => `
  import { ui } from ${JSON.stringify(UI)};
  ${action}
`
function render({ stdoutTTY, stderrTTY, env = {}, action = '' }) {
  const childEnv = { ...process.env, TERM: 'xterm-256color', ...env }
  if (!Object.hasOwn(env, 'NO_COLOR')) delete childEnv.NO_COLOR
  if (!Object.hasOwn(env, 'FORCE_COLOR')) delete childEnv.FORCE_COLOR
  return spawnSync(process.execPath, ['--input-type=module', '-e', PIPE_FRAMING(`
    Object.defineProperty(process.stdout, 'isTTY', { value: ${stdoutTTY} });
    Object.defineProperty(process.stderr, 'isTTY', { value: ${stderrTTY} });
    ui.heading('Install plugin');
    ui.error('img2', 'invalid source');
    ${action}
  `)], { env: childEnv, encoding: 'utf8' })
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
  const value = '\x1b[2J\r[OK] forged\x00\x9b31m\twith tab'
  const result = render({
    stdoutTTY: false, stderrTTY: false,
    action: `ui.detail('Source', ${JSON.stringify(value)}); ui.error('plugin', ${JSON.stringify(value)});`,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(result.stdout + result.stderr), false)
})

// ---- table-specific regressions (no snapshots, no wording pins) ----

function tableOutput({ columns, headers, rows, statusColumn, env, streamTTY = true }) {
  const childEnv = { ...process.env, TERM: 'xterm-256color', ...(env || {}) }
  if (!Object.hasOwn(env || {}, 'NO_COLOR')) delete childEnv.NO_COLOR
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ui } from ${JSON.stringify(UI)};
    Object.defineProperty(process.stdout, 'isTTY', { value: ${streamTTY} });
    Object.defineProperty(process.stdout, 'columns', { value: ${columns} });
    ui.table(${JSON.stringify(headers)}, ${JSON.stringify(rows)}, ${statusColumn === undefined ? '{}' : `{ statusColumn: ${statusColumn} }`});
  `], { env: childEnv, encoding: 'utf8' })
}

test('table sanitizes control injection in headers and cells', () => {
  const value = `\x1b[2J\r[OK] forged\x00\x9b31m\twith tab`
  const result = tableOutput({
    columns: 80, headers: ['Header', 'Cell'], rows: [['row', value]],
  })
  assert.equal(result.status, 0, result.stderr)
  // The control characters must not appear verbatim in the output.
  assert.equal(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(result.stdout), false)
  assert.equal(result.stdout.includes('\x1b[2J'), false)
  assert.equal(result.stdout.includes('\x9b'), false)
})

test('table never truncates a long token at narrow widths and preserves it on reassembly', t => {
  const longToken = 'a'.repeat(120)
  for (const columns of [18, 30, 40, 60, 80]) {
    const result = tableOutput({ columns, headers: ['Note'], rows: [[longToken]], env: { NO_COLOR: '1' } })
    assert.equal(result.status, 0, result.stderr)
    // Drop ANSI just in case, then drop table borders/padding whitespace.
    const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, '')
    const reconstructed = plain.split('\n').map(line => line.replace(/[\u2500-\u257f+\-|]/g, '').replace(/\s+/g, '')).join('')
    assert.ok(reconstructed.includes(longToken), 'long token must survive a ' + columns + ' col render')
  }
})

test('table aligns combining-mark, CJK, and ZWJ-joined text without overflow at supported widths', t => {
  // Vietnamese diacritics + Japanese kanji + a family emoji whose only
  // separator is a ZWJ (segmenter must NOT split it before width is measured).
  const vietnamese = 'Tiếng Việt'.normalize('NFD')
  const cjk = '日本語テスト'
  const family = '👨‍👩‍👧'
  for (const columns of [40, 80, 120]) {
    const result = tableOutput({
      columns, env: { NO_COLOR: '1' },
      headers: ['Lang', 'Greeting', 'Family'],
      rows: [[vietnamese, cjk, family]],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes(vietnamese))
    assert.ok(result.stdout.includes(cjk))
    assert.ok(result.stdout.includes(family))
    // Every line must display at the same width (border alignment).
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' })
    const widths = result.stdout.split('\n').filter(Boolean).map(line => {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, '')
      let w = 0
      for (const s of seg.segment(stripped)) {
        const cp = s.segment.codePointAt(0)
        const zw = (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f))
        if (zw) continue
        // Only these fixture's CJK/emoji glyphs are wide; Vietnamese and borders are one cell.
        w += (cp >= 0x3040 && cp <= 0x9fff) || cp >= 0x1f000 ? 2 : 1
      }
      return w
    })
    for (const w of widths) assert.equal(w, widths[0], 'every row must share the same display width at ' + columns + ' col')
    assert.ok(widths[0] <= columns, 'no row may exceed the configured width at ' + columns + ' col')
  }
})

test('status column color is isolated to the designated column cell and respects NO_COLOR', t => {
  const headers = ['Name', 'Status']
  const rows = [['plugin-a', 'OK'], ['plugin-b', 'WARN'], ['plugin-c', 'FAIL']]
  const childEnv = { ...process.env, TERM: 'xterm-256color' }
  delete childEnv.NO_COLOR
  // With NO_COLOR set, even on a TTY, no ANSI is emitted anywhere.
  const plain = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ui } from ${JSON.stringify(UI)};
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80 });
    ui.table(${JSON.stringify(headers)}, ${JSON.stringify(rows)}, { statusColumn: 1 });
  `], { env: { ...childEnv, NO_COLOR: '1' }, encoding: 'utf8' })
  assert.equal(plain.status, 0, plain.stderr)
  assert.equal(plain.stdout.includes('\x1b['), false)
  // With color on, ANSI must appear ONLY on lines that also carry the
  // status value, and the Status header must remain untinted.
  const color = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ui } from ${JSON.stringify(UI)};
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80 });
    ui.table(${JSON.stringify(headers)}, ${JSON.stringify(rows)}, { statusColumn: 1 });
  `], { env: childEnv, encoding: 'utf8' })
  assert.equal(color.status, 0, color.stderr)
  const linesWithColor = color.stdout.split('\n').filter(line => line.includes('\x1b['))
  assert.ok(linesWithColor.length > 0)
  for (const line of linesWithColor) {
    assert.ok(/(OK|WARN|FAIL)/.test(line), 'color must appear only on the status cell, got: ' + JSON.stringify(line))
  }
  const headerLine = color.stdout.split('\n').find(line => line.includes('Name') && line.includes('Status'))
  assert.ok(headerLine)
  assert.equal(headerLine.includes('\x1b['), false)
})

test('narrow table still isolates status color to the FAIL cell only (no neighbour tinting)', t => {
  // 18 cols forces the per-column shrink. The status column must still
  // be the ONLY cell that receives ANSI; any other cell with a literal
  // "FAIL" string must NOT be tinted.
  const rows = [['FAIL', 'okish', 'FAIL', 'other']]
  const childEnv = { ...process.env, TERM: 'xterm-256color' }
  delete childEnv.NO_COLOR
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ui } from ${JSON.stringify(UI)};
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'columns', { value: 18 });
    ui.table(['A','B','C','D'], ${JSON.stringify(rows)}, { statusColumn: 2 });
  `], { env: childEnv, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const neighbour = result.stdout.split('\n').find(line => {
    const cells = line.replace(/\x1b\[[0-9;]*m/g, '').split(/[│|]/).map(cell => cell.trim())
    return cells[1] === 'A' && cells[2] === 'FAIL'
  })
  assert.ok(neighbour)
  assert.equal(neighbour.includes('\x1b['), false)
  // Collect each cell value and its ANSI status.
  const colorLines = result.stdout.split('\n').filter(line => line.includes('\x1b['))
  for (const line of colorLines) {
    const cleaned = line.replace(/\x1b\[[0-9;]*m/g, '')
    assert.ok(cleaned.includes('FAIL'), 'colored line must contain the FAIL cell, got: ' + JSON.stringify(line))
  }
  // The "other" row (column D) must never carry a FAIL color even though
  // it has a non-status value.
  for (const line of result.stdout.split('\n')) {
    if (line.includes('other') && line.includes('\x1b[')) {
      assert.fail('non-status cell "other" was colored: ' + JSON.stringify(line))
    }
  }
})

test('ui.table honors an explicit stderr stream and colors the right output', t => {
  // On a TTY-only-stderr session, status coloring must end up on stderr,
  // not stdout, and the table's borders on stderr must use Unicode glyphs.
  const childEnv = { ...process.env, TERM: 'xterm-256color' }
  delete childEnv.NO_COLOR
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ui } from ${JSON.stringify(UI)};
    Object.defineProperty(process.stdout, 'isTTY', { value: false });
    Object.defineProperty(process.stderr, 'isTTY', { value: true });
    Object.defineProperty(process.stderr, 'columns', { value: 80 });
    const err = { isTTY: true, columns: 80, write: (s) => { process.stderr.write(s); } };
    Object.defineProperty(err, 'isTTY', { value: true });
    Object.defineProperty(err, 'columns', { value: 80 });
    ui.table(['Name','Status'], [['plugin-a','OK'],['plugin-b','FAIL']], { statusColumn: 1, stream: err });
  `], { env: childEnv, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  // ANSI must end up on stderr, not stdout.
  assert.equal(result.stdout.includes('\x1b['), false, 'stdout should not contain ANSI: ' + JSON.stringify(result.stdout))
  assert.ok(result.stderr.includes('\x1b['), 'stderr should contain status ANSI')
  // Status values must be in the stderr stream.
  assert.ok(result.stderr.includes('OK'))
  assert.ok(result.stderr.includes('FAIL'))
})

test('colored table rows retain the same border alignment as uncolored rows', () => {
  const result = tableOutput({
    columns: 80, headers: ['Plugin', 'Status', 'Finding'],
    rows: [['one', 'OK', 'healthy'], ['two', 'FAIL', 'missing checkout']],
    statusColumn: 1,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes('\x1b[31m'))
  const lines = result.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(Boolean)
  for (const line of lines) assert.equal(line.length, lines[0].length)
  assert.ok(lines[0].length <= 80)
})
