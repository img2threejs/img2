import os from 'node:os'
import path from 'node:path'

// Only presentation: never inspect registrations, run commands, or change install state.
const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ch => '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0'))
const color = (stream, code, value) => stream.isTTY && process.env.TERM !== 'dumb' && !Object.hasOwn(process.env, 'NO_COLOR')
  ? '\x1b[' + code + 'm' + value + '\x1b[0m'
  : value
const line = (stream, value = '') => stream.write(value + '\n')
const quote = value => /^[a-zA-Z0-9_./:@=-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'"

function status(stream, label, code, message) {
  flow(clean(message).split(' '), '', stream, '  ' + color(stream, code, '[' + label + ']') + ' ')
}

function flow(tokens, continuation = '', stream = process.stdout, prefix = '    ') {
  const width = stream.isTTY && stream.columns ? stream.columns - continuation.length : Infinity
  let indent = prefix
  let text = indent
  let used = indent.replace(/\x1b\[[0-9;]*m/g, '').length
  for (const token of tokens) {
    if (text !== indent && used + 1 + token.length > width) {
      line(stream, text + continuation)
      indent = continuation ? '      ' : '    '
      text = indent
      used = indent.length
    }
    const gap = text === indent ? '' : ' '
    text += gap + token
    used += gap.length + token.length
  }
  line(stream, text)
}

export const ui = {
  heading(title) {
    line(process.stdout)
    line(process.stdout, '  ' + color(process.stdout, '1;36', 'img2') + ' / ' + color(process.stdout, '1', clean(title)))
    line(process.stdout)
  },
  detail(label, value) {
    const stream = process.stdout
    const key = clean(label)
    const text = clean(value)
    const prefix = '    ' + key.padEnd(10) + '  '
    if (stream.isTTY && (stream.columns < 64 || prefix.length + text.length > stream.columns)) {
      line(stream, '    ' + color(stream, '2', key))
      line(stream, '      ' + text)
    } else {
      line(stream, color(stream, '2', prefix) + text)
    }
  },
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
    if (detail) {
      for (const text of String(detail).split(/\r?\n/)) line(process.stderr, '    ' + clean(text))
    }
  },
  next(argv, message = 'Restart your agent to load the updated skills, then check the installation:') {
    line(process.stdout)
    line(process.stdout, '  ' + color(process.stdout, '1', 'Next'))
    flow(clean(message).split(' '))
    printCommand(argv)
    line(process.stdout)
  },
  command(argv) {
    printCommand(argv)
  },
}

function printCommand(argv) {
  const home = process.stdout.isTTY ? os.homedir() : null
  const args = argv.map(value => clean(home && value.startsWith(home + path.sep)
    ? '"$HOME"' + quote(value.slice(home.length))
    : quote(value)))
  flow(args, process.stdout.isTTY ? ' \\' : '')
}
