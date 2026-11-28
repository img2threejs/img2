// The one narrow waiver `img2 provision` grants after `pip check` fails.
//
// Every bpy cp311 wheel PyPI publishes for macOS arm64 carries the right filename tag
// (cp311-cp311-macosx_11_0_arm64) but an internal `*.dist-info/WHEEL` line `Tag: cp39-cp39-macosx_11_0_arm64`
// (an upstream packaging defect). pip installs it, then `pip check` says "bpy X is not supported on this
// platform". The waiver applies to exactly that line, for exactly the lock-pinned wheel, and nothing else:
// any other line, any other package, any hash mismatch, any other tag difference stays fatal.
import fs from 'node:fs'
import zlib from 'node:zlib'
import { fileSha256Sync } from './fsx.mjs'

export const WAIVER_REASON = 'upstream-wheel-tag-mismatch'
export const WAIVABLE_PACKAGE = 'bpy'

const PLATFORM_TAG = {
  'darwin-arm64': /^macosx_\d+_\d+_arm64$/,
  'darwin-x64': /^macosx_\d+_\d+_x86_64$/,
  'linux-x64': /^(manylinux[0-9a-z_]*_x86_64|linux_x86_64)$/,
  'linux-arm64': /^(manylinux[0-9a-z_]*_aarch64|linux_aarch64)$/,
}

// {dist}-{version}(-{build})?-{python}-{abi}-{platform}.whl
export function filenameTag(filename) {
  const m = /^[^-]+-[^-]+(?:-\d[^-]*)?-([^-]+)-([^-]+)-([^-]+)\.whl$/.exec(String(filename))
  return m ? { python: m[1], abi: m[2], platform: m[3] } : null
}

// The text of one member of a zip, reading only the central directory and that member (wheels are large).
export function readZipMember(file, wanted) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const tailLen = Math.min(size, 22 + 65535)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i -= 1) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    if (eocd < 0) throw new Error('not a zip file')
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOff = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || cdOff === 0xffffffff) throw new Error('zip64 wheels are not supported')
    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdOff)
    let off = 0
    for (let n = 0; n < count; n += 1) {
      if (cd.readUInt32LE(off) !== 0x02014b50) throw new Error('corrupt zip central directory')
      const method = cd.readUInt16LE(off + 10)
      const csize = cd.readUInt32LE(off + 20)
      const nameLen = cd.readUInt16LE(off + 28)
      const extraLen = cd.readUInt16LE(off + 30)
      const commentLen = cd.readUInt16LE(off + 32)
      const localOff = cd.readUInt32LE(off + 42)
      const name = cd.toString('utf8', off + 46, off + 46 + nameLen)
      off += 46 + nameLen + extraLen + commentLen
      if (!wanted(name)) continue
      const local = Buffer.alloc(30)
      fs.readSync(fd, local, 0, 30, localOff)
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('corrupt zip local header')
      const start = localOff + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
      const raw = Buffer.alloc(csize)
      fs.readSync(fd, raw, 0, csize, start)
      if (method === 0) return raw.toString('utf8')
      if (method === 8) return zlib.inflateRawSync(raw).toString('utf8')
      throw new Error('unsupported zip compression method ' + method)
    }
    return null
  } finally { fs.closeSync(fd) }
}

export function wheelTags(file) {
  const text = readZipMember(file, (n) => /^[^/]+\.dist-info\/WHEEL$/.test(n))
  if (text === null) return []
  return text.split(/\r?\n/).filter((l) => /^Tag:/i.test(l)).map((l) => l.slice(4).trim())
}

const normalize = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-')

// output: stdout+stderr of the failed `pip check`. candidates: [{ name, version, filename, file, lockSha256 }]
// (the wheels pip just installed, each pinned by a lock SHA-256). Returns { waivers, fatal }: `fatal` is the list
// of reasons the failure cannot be waived (empty when every line is covered by a waiver).
export function evaluatePipCheck({ output, candidates, platform }) {
  const lines = String(output).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const waivers = []
  const fatal = []
  if (!lines.length) return { waivers, fatal: ['pip check failed without saying why'] }
  for (const line of lines) {
    const m = /^(\S+) (\S+) is not supported on this platform\.?$/.exec(line)
    if (!m) { fatal.push('not waivable: ' + line); continue }
    const [, name, version] = m
    if (normalize(name) !== WAIVABLE_PACKAGE) { fatal.push('not waivable (only ' + WAIVABLE_PACKAGE + ' is): ' + line); continue }
    const c = candidates.find((x) => normalize(x.name) === normalize(name) && x.version === version)
    if (!c) { fatal.push('not waivable (no lock-pinned wheel of ' + name + ' ' + version + ' was installed): ' + line); continue }
    if (!/^[0-9a-f]{64}$/.test(c.lockSha256 ?? '')) { fatal.push('not waivable (the lock pins no SHA-256 for ' + c.filename + '): ' + line); continue }
    let actual
    try { actual = fileSha256Sync(c.file) } catch (e) { fatal.push('not waivable (cannot hash ' + c.filename + ': ' + e.message + '): ' + line); continue }
    if (actual !== c.lockSha256) { fatal.push('not waivable (installed wheel sha256 ' + actual + ' != lock ' + c.lockSha256 + '): ' + line); continue }
    const fn = filenameTag(c.filename)
    if (!fn || !PLATFORM_TAG[platform]?.test(fn.platform)) { fatal.push('not waivable (wheel filename tag ' + JSON.stringify(fn) + ' does not match ' + platform + '): ' + line); continue }
    let inner
    try { inner = wheelTags(c.file) } catch (e) { fatal.push('not waivable (cannot read WHEEL of ' + c.filename + ': ' + e.message + '): ' + line); continue }
    // internal tags must all be <cpNN>-<cpNN>-<same platform> with a python tag that differs from the filename's
    const tags = inner.map((t) => t.split('-'))
    const only = tags.length > 0 && tags.every(([py, abi, plat, ...rest]) => rest.length === 0 && /^cp3\d+$/.test(py) && py === abi && py !== fn.python && plat === fn.platform)
    if (!only) { fatal.push('not waivable (internal WHEEL tag ' + JSON.stringify(inner) + ' differs from the filename tag ' + [fn.python, fn.abi, fn.platform].join('-') + ' in more than the python tag): ' + line); continue }
    waivers.push({ package: name, version, reason: WAIVER_REASON, wheelSha256: actual, wheel: c.filename, filenameTag: [fn.python, fn.abi, fn.platform].join('-'), internalTags: inner, pipCheck: line })
  }
  return { waivers, fatal }
}
