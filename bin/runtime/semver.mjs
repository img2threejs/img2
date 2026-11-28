// Small npm-compatible semver matcher, used only to place the lock's pinned tarballs in node_modules.
const V = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(s) {
  const m = V.exec(String(s).trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

function cmpPre(a, b) {
  if (!a.length && !b.length) return 0
  if (!a.length) return 1
  if (!b.length) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const an = /^\d+$/.test(a[i])
    const bn = /^\d+$/.test(b[i])
    if (an && bn) { if (+a[i] !== +b[i]) return +a[i] < +b[i] ? -1 : 1 } else if (an) return -1
    else if (bn) return 1
    else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

export function compareVersions(x, y) {
  const a = typeof x === 'string' ? parseVersion(x) : x
  const b = typeof y === 'string' ? parseVersion(y) : y
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  return cmpPre(a.pre, b.pre)
}

const isX = (s) => s === undefined || s === '' || s === 'x' || s === 'X' || s === '*'
const ver = (major, minor, patch, pre = []) => ({ major, minor, patch, pre })
const floor = (a, b, c) => ver(a ?? 0, b ?? 0, c ?? 0)
const ceil0 = (a, b, c) => ver(a, b, c, ['0']) // lowest prerelease of a version: excludes its prereleases

function partial(s) {
  const m = /^[v=]*(\d+|[xX*])?(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s)
  if (!m) throw new Error('bad semver range part ' + JSON.stringify(s))
  const n = (v) => (isX(v) ? undefined : +v)
  return { major: n(m[1]), minor: n(m[2]), patch: n(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

function desugar(token) {
  const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.*)$/.exec(token)
  const op = m[1] ?? ''
  const p = partial(m[2])
  const { major: a, minor: b, patch: c } = p
  const full = a !== undefined && b !== undefined && c !== undefined
  if (a === undefined) return op === '<' ? [['<', ver(0, 0, 0, ['0'])]] : [['>=', ver(0, 0, 0)]]
  if (op === '' || op === '=') {
    if (full) return [['=', ver(a, b, c, p.pre)]]
    return b === undefined ? [['>=', floor(a)], ['<', ceil0(a + 1, 0, 0)]] : [['>=', floor(a, b)], ['<', ceil0(a, b + 1, 0)]]
  }
  if (op === '>=') return [['>=', full ? ver(a, b, c, p.pre) : floor(a, b, c)]]
  if (op === '>') {
    if (full) return [['>', ver(a, b, c, p.pre)]]
    return [['>=', b === undefined ? floor(a + 1) : floor(a, b + 1)]]
  }
  if (op === '<') return [['<', full ? ver(a, b, c, p.pre) : ceil0(a, b ?? 0, c ?? 0)]]
  if (op === '<=') {
    if (full) return [['<=', ver(a, b, c, p.pre)]]
    return [['<', b === undefined ? ceil0(a + 1, 0, 0) : ceil0(a, b + 1, 0)]]
  }
  const lo = full ? ver(a, b, c, p.pre) : floor(a, b, c)
  if (op.startsWith('~')) {
    return [['>=', lo], ['<', b === undefined ? ceil0(a + 1, 0, 0) : ceil0(a, b + 1, 0)]]
  }
  // caret
  let hi
  if (a > 0 || b === undefined) hi = ceil0(a + 1, 0, 0)
  else if (b > 0 || c === undefined) hi = ceil0(0, b + 1, 0)
  else hi = ceil0(0, 0, c + 1)
  return [['>=', lo], ['<', hi]]
}

function parseSet(set) {
  let s = set.trim()
  const hy = /^(\S+)\s+-\s+(\S+)$/.exec(s)
  if (hy) {
    const lo = partial(hy[1])
    const hi = partial(hy[2])
    const out = [['>=', floor(lo.major, lo.minor, lo.patch)]]
    if (hi.patch !== undefined) out.push(['<=', ver(hi.major, hi.minor, hi.patch, hi.pre)])
    else if (hi.minor !== undefined) out.push(['<', ceil0(hi.major, hi.minor + 1, 0)])
    else if (hi.major !== undefined) out.push(['<', ceil0(hi.major + 1, 0, 0)])
    return out
  }
  s = s.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1')
  return s.split(/\s+/).filter(Boolean).flatMap(desugar)
}

function test(op, v, c) {
  const r = compareVersions(v, c)
  return op === '=' ? r === 0 : op === '>' ? r > 0 : op === '>=' ? r >= 0 : op === '<' ? r < 0 : r <= 0
}

export function satisfies(version, range) {
  const v = parseVersion(version)
  if (!v) return false
  const r = String(range ?? '*').trim()
  if (/^(https?:|git|file:|npm:|github:|[\w.-]+\/[\w.-]+$)/.test(r) && !/^[~^<>=\d xX*v|-]/.test(r)) return false
  for (const set of r.split('||')) {
    let comps
    try { comps = parseSet(set || '*') } catch { return false }
    if (!comps.every(([op, c]) => test(op, v, c))) continue
    if (v.pre.length && !comps.some(([, c]) => c.pre.length && c.major === v.major && c.minor === v.minor && c.patch === v.patch)) continue
    return true
  }
  return false
}
