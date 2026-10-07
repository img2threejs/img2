import os from 'node:os'
import path from 'node:path'

// Presentation only: no registry reads, subprocesses or filesystem mutations.
const SGR = /\x1b\[[0-9;]*m/g
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const MARKS = /^[\p{Mark}\u200b-\u200f\u2060\ufeff]*$/u
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\ufe0f/u
const STATUS = {
  ok: '32', pass: '32', done: '32', linked: '32', relinked: '32', unchanged: '32',
  unlinked: '32', updated: '32', 'up to date': '32',
  warn: '33', warning: '33', pending: '33', drift: '33', 'no tag': '33',
  fail: '31', failed: '31', error: '31', public: '36', private: '35',
}

function clean(value) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ch => '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0'))
}

function allowsColor(stream) {
  return stream.isTTY && process.env.TERM !== 'dumb' && !Object.hasOwn(process.env, 'NO_COLOR')
}

function color(stream, code, text) {
  return code && allowsColor(stream) ? '\x1b[' + code + 'm' + text + '\x1b[0m' : text
}

function graphemeWidth(text) {
  if (MARKS.test(text)) return 0
  if (EMOJI.test(text)) return 2
  const cp = text.codePointAt(0)
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)) ? 2 : 1
}

function width(text) {
  let result = 0
  for (const part of SEGMENTER.segment(text)) result += graphemeWidth(part.segment)
  return result
}

function columns(stream) { return stream.isTTY && stream.columns ? Math.max(12, stream.columns) : 100 }
function line(stream, text = '') { stream.write(text + '\n') }
function padded(text, size) { return text + ' '.repeat(Math.max(0, size - width(text))) }

// Prefer word boundaries; hard-wrap only tokens that cannot fit on an empty line.
function wrap(text, size) {
  const result = []
  let current = '', used = 0, gap = ''
  for (const token of text.match(/\s+|\S+/gu) || []) {
    if (/^\s+$/u.test(token)) { gap += token; continue }
    const tokenWidth = width(token)
    if (current && used + width(gap) + tokenWidth > size) {
      result.push(current)
      current = ''; used = 0; gap = ''
    }
    if (tokenWidth <= size) {
      if (current) { current += gap; used += width(gap) }
      current += token; used += tokenWidth
    } else {
      for (const part of SEGMENTER.segment(token)) {
        const next = graphemeWidth(part.segment)
        if (current && used + next > size) { result.push(current); current = ''; used = 0 }
        current += part.segment; used += next
      }
    }
    gap = ''
  }
  if (current || !result.length) result.push(current)
  return result
}

function drawTable(stream, headers, rows, statusColumn = -1, statusRow = null) {
  if (!headers.length) return
  const count = headers.length
  const budget = Math.max(count * 2, columns(stream) - count * 3 - 1)
  const widths = headers.map((header, i) => {
    let desired = width(header)
    for (const row of rows) desired = Math.max(desired, width(row[i]))
    return Math.max(2, Math.min(budget, desired))
  })
  let total = widths.reduce((sum, value) => sum + value, 0)
  while (total > budget) {
    let largest = 0
    for (let i = 1; i < count; i++) if (widths[i] > widths[largest]) largest = i
    widths[largest] -= 1
    total -= 1
  }
  const unicode = stream.isTTY && process.env.TERM !== 'dumb'
  const border = unicode ? ['┌', '┬', '┐', '├', '┼', '┤', '└', '┴', '┘', '─', '│'] : ['+', '+', '+', '+', '+', '+', '+', '+', '+', '-', '|']
  const separator = offset => line(stream, border[offset] + widths.map(value => border[9].repeat(value + 2)).join(border[offset + 1]) + border[offset + 2])
  const record = (cells, rowIndex) => {
    const wrapped = cells.map((cell, i) => wrap(cell, widths[i]))
    const height = Math.max(...wrapped.map(cell => cell.length))
    const statusCode = rowIndex >= 0 && (statusRow === null || rowIndex === statusRow)
      ? STATUS[(cells[statusColumn] || '').trim().toLowerCase()] : null
    for (let r = 0; r < height; r++) {
      line(stream, border[10] + wrapped.map((cell, i) => {
        const text = padded(cell[r] || '', widths[i])
        return ' ' + color(stream, i === statusColumn ? statusCode : null, text) + ' '
      }).join(border[10]) + border[10])
    }
  }
  separator(0)
  record(headers, -1)
  separator(3)
  rows.forEach((row, i) => {
    record(row, i)
    if (i < rows.length - 1) separator(3)
  })
  separator(6)
  if (!rows.length) line(stream, '(no rows)')
}

function table(headers, rows, { stream = process.stdout, statusColumn = -1 } = {}) {
  const names = headers.map(clean)
  const cells = rows.map(row => names.map((_, i) => clean(row[i])))
  if (names.length > 2 && columns(stream) - names.length * 3 - 1 < names.length * 8) {
    // A record becomes a Field/Value table; only its original status field is colored.
    const records = cells.length ? cells : [names.map(() => '')]
    records.forEach((record, i) => {
      drawTable(stream, ['Field', 'Value'], names.map((name, j) => [name, record[j]]), 1, statusColumn)
      if (i < records.length - 1) line(stream)
    })
    if (!cells.length) line(stream, '(no rows)')
    return
  }
  drawTable(stream, names, cells, statusColumn)
}

const SAFE = /^[a-zA-Z0-9_./:@=-]+$/
function quoteArg(value) { return SAFE.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'" }

function flow(stream, tokens, continuation = '', prefix = '    ') {
  const limit = stream.isTTY && stream.columns ? stream.columns - continuation.length : Infinity
  let indent = prefix, text = prefix, used = width(prefix.replace(SGR, ''))
  for (const token of tokens) {
    const tokenWidth = width(token)
    if (text !== indent && used + 1 + tokenWidth > limit) {
      line(stream, text + continuation)
      indent = continuation ? '      ' : '    '
      text = indent; used = width(indent)
    }
    const gap = text === indent ? '' : ' '
    text += gap + token; used += gap.length + tokenWidth
  }
  line(stream, text)
}

function status(stream, label, code, message) {
  flow(stream, clean(message).split(' '), '', '  ' + color(stream, code, '[' + label + ']') + ' ')
}

const SLOGAN = 'Rebuild the object in a reference image as a code-only, procedural Three.js model.'
// Source pixels dissolve into a three-face wire cube, adapted from the brand SVG.
const LOGO = [
  [' [] ', '   .-------.', '36', '38;5;215'],
  ['[]  ', " .'       /|", '36', '38;5;213'],
  [' [] ', '+--------+ |', '36', '38;5;221'],
  ['    ', '|        | +', '35', null],
  ['    ', '|        |/', '35', null],
  ['    ', '+--------+', '35', null],
]
let bannerShown = false
function banner() {
  if (bannerShown) return
  bannerShown = true
  const stream = process.stdout
  const wordmark = color(stream, '1;36', 'img2threejs')
  if (stream.isTTY && process.env.TERM !== 'dumb') {
    const logoWidth = Math.max(...LOGO.map(([pixels, cube]) => pixels.length + 2 + cube.length))
    const logo = LOGO.map(([pixels, cube, code, pixelCode]) => color(stream, pixelCode, pixels) + '  ' + color(stream, code, cube) + ' '.repeat(logoWidth - pixels.length - 2 - cube.length))
    if (columns(stream) >= logoWidth + 26) {
      const side = [wordmark, ...wrap(SLOGAN, columns(stream) - logoWidth - 2).map(text => color(stream, '2', text))]
      for (let i = 0; i < Math.max(logo.length, side.length); i++) line(stream, (logo[i] || ' '.repeat(logoWidth)) + '  ' + (side[i] || ''))
      line(stream)
      return
    }
    for (const row of logo) line(stream, row.trimEnd())
  }
  line(stream, wordmark)
  for (const text of wrap(SLOGAN, columns(stream))) line(stream, color(stream, '2', text))
  line(stream)
}

function printCommand(stream, argv) {
  const home = stream.isTTY ? os.homedir() : null
  const args = argv.map(value => clean(home && value.startsWith(home + path.sep)
    ? '"$HOME"' + quoteArg(value.slice(home.length)) : quoteArg(value)))
  flow(stream, args, stream.isTTY ? ' \\' : '')
}

export const ui = {
  banner,
  table,
  heading(title) {
    banner()
    line(process.stdout)
    line(process.stdout, '  ' + color(process.stdout, '1;36', 'img2') + ' / ' + color(process.stdout, '1', clean(title)))
    line(process.stdout)
  },
  detail(label, value) { table(['Field', 'Value'], [[label, value]]) },
  path(value) {
    const home = os.homedir()
    return process.stdout.isTTY && (value === home || value.startsWith(home + path.sep)) ? '~' + value.slice(home.length) : value
  },
  step(current, total, title) {
    line(process.stdout)
    line(process.stdout, '  ' + color(process.stdout, '36', '[' + current + '/' + total + ']') + ' ' + color(process.stdout, '1', clean(title)))
  },
  ok(message) { status(process.stdout, 'OK', '32', message) },
  info(message) { status(process.stdout, 'INFO', '36', message) },
  warn(message) { status(process.stderr, 'WARN', '33', message) },
  prompt(message, stream = process.stdout) { return '  ' + color(stream, '36', '[?]') + ' ' + clean(message) + ' [y/N] ' },
  error(scope, message, detail) {
    status(process.stderr, 'ERROR', '31', scope + ': ' + message)
    if (detail) for (const text of String(detail).split(/\r?\n/)) line(process.stderr, '    ' + clean(text))
  },
  next(argv, message = 'Restart your agent to load the updated skills, then check the installation:') {
    line(process.stdout)
    line(process.stdout, '  ' + color(process.stdout, '1', 'Next'))
    flow(process.stdout, clean(message).split(' '))
    printCommand(process.stdout, argv)
    line(process.stdout)
  },
  command(argv) { printCommand(process.stdout, argv) },
}
