// Safe tar(.gz)/zip extraction: no path traversal, no symlink escape, no device nodes, bounded size.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { isUnder } from './fsx.mjs'

export const LIMITS = { maxBytes: 12 * 1024 ** 3, maxEntries: 400_000 }

export class UnsafeArchive extends Error {}

// A relative archive path made safe, or null when the entry is only the stripped top directory.
export function cleanRel(name, strip = 0) {
  if (typeof name !== 'string' || name.includes('\0') || name.includes('\\')) throw new UnsafeArchive('unsafe entry name ' + JSON.stringify(name))
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new UnsafeArchive('absolute entry name ' + JSON.stringify(name))
  const parts = name.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) throw new UnsafeArchive('path traversal in entry ' + JSON.stringify(name))
  if (parts.length <= strip) return null
  return parts.slice(strip).join('/')
}

export class SafeWriter {
  constructor(dest, { strip = 0, limits = LIMITS } = {}) {
    fs.mkdirSync(dest, { recursive: true })
    this.dest = fs.realpathSync.native(dest)
    this.strip = strip
    this.limits = limits
    this.bytes = 0
    this.entries = 0
    this.links = []
    this.hardlinkSources = new Set()
  }

  rel(name) {
    this.entries += 1
    if (this.entries > this.limits.maxEntries) throw new UnsafeArchive('archive has too many entries')
    return cleanRel(name, this.strip)
  }

  // mkdir -p that refuses to pass through (or create over) a symlink.
  ensureParents(rel) {
    let cur = this.dest
    for (const part of rel.split('/')) {
      cur = path.join(cur, part)
      const st = fs.lstatSync(cur, { throwIfNoEntry: false })
      if (!st) fs.mkdirSync(cur, { mode: 0o700 })
      else if (st.isSymbolicLink()) throw new UnsafeArchive('entry passes through symlink ' + path.relative(this.dest, cur))
      else if (!st.isDirectory()) throw new UnsafeArchive('entry parent is not a directory: ' + path.relative(this.dest, cur))
    }
  }

  // lstat every component: a hardlink source must be a regular file reached without crossing any symlink,
  // otherwise `link -> sub/up/..` style chains make the copy read outside the destination.
  regularFileNoSymlinks(rel) {
    let cur = this.dest
    const parts = rel.split('/')
    for (let i = 0; i < parts.length; i += 1) {
      cur = path.join(cur, parts[i])
      const st = fs.lstatSync(cur, { throwIfNoEntry: false })
      if (!st) return null
      if (st.isSymbolicLink()) throw new UnsafeArchive('hardlink source passes through symlink ' + path.relative(this.dest, cur))
      if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return null
      if (i === parts.length - 1) {
        const real = fs.realpathSync.native(cur)
        if (!isUnder(this.dest, real)) throw new UnsafeArchive('hardlink source resolves outside the destination: ' + rel)
        return st
      }
    }
    return null
  }

  target(rel) {
    const t = path.join(this.dest, rel)
    if (!isUnder(this.dest, t)) throw new UnsafeArchive('entry escapes destination: ' + rel)
    return t
  }

  dir(name, mode) {
    const rel = this.rel(name)
    if (rel === null) return
    this.ensureParents(rel)
    fs.chmodSync(this.target(rel), ((mode ?? 0o755) & 0o777) | 0o700)
  }

  count(n) {
    this.bytes += n
    if (this.bytes > this.limits.maxBytes) throw new UnsafeArchive('archive expands beyond ' + this.limits.maxBytes + ' bytes')
  }

  // Returns { write(buf), close() } for a regular file; null if the entry is the stripped root.
  openFile(name, mode) {
    const rel = this.rel(name)
    if (rel === null) return null
    const parent = path.posix.dirname(rel)
    if (parent !== '.') this.ensureParents(parent)
    const t = this.target(rel)
    const st = fs.lstatSync(t, { throwIfNoEntry: false })
    if (st && (st.isSymbolicLink() || st.isFile())) fs.unlinkSync(t)
    else if (st) throw new UnsafeArchive('cannot overwrite directory with file: ' + rel)
    const fd = fs.openSync(t, 'wx', ((mode ?? 0o644) & 0o755) | 0o600)
    return {
      write: (buf) => { this.count(buf.length); fs.writeSync(fd, buf) },
      close: () => { fs.closeSync(fd); fs.chmodSync(t, ((mode ?? 0o644) & 0o777 & ~0o7000) | 0o600) },
    }
  }

  file(name, mode, buf) {
    const f = this.openFile(name, mode)
    if (!f) return
    try { f.write(buf) } finally { f.close() }
  }

  symlink(name, linkTarget) {
    const rel = this.rel(name)
    if (rel === null) return
    if (typeof linkTarget !== 'string' || !linkTarget || linkTarget.includes('\0') || linkTarget.includes('\\') || linkTarget.startsWith('/') || /^[A-Za-z]:/.test(linkTarget)) {
      throw new UnsafeArchive('symlink ' + rel + ' has unsafe target ' + JSON.stringify(linkTarget))
    }
    const resolved = path.resolve(this.dest, path.posix.dirname(rel), linkTarget)
    if (resolved !== this.dest && !isUnder(this.dest, resolved)) throw new UnsafeArchive('symlink ' + rel + ' escapes the destination: ' + linkTarget)
    const parent = path.posix.dirname(rel)
    if (parent !== '.') this.ensureParents(parent)
    const t = this.target(rel)
    if (fs.lstatSync(t, { throwIfNoEntry: false })) fs.rmSync(t, { force: true })
    fs.symlinkSync(linkTarget, t)
    this.links.push(t)
  }

  hardlink(name, linkName, mode) {
    const rel = this.rel(name)
    const from = cleanRel(linkName, this.strip)
    if (rel === null || from === null) return
    const src = this.target(from)
    const st = this.regularFileNoSymlinks(from)
    if (!st) throw new UnsafeArchive('hardlink ' + rel + ' points at missing or non-regular ' + linkName)
    const parent = path.posix.dirname(rel)
    if (parent !== '.') this.ensureParents(parent)
    const t = this.target(rel)
    if (fs.lstatSync(t, { throwIfNoEntry: false })) fs.rmSync(t, { force: true })
    fs.copyFileSync(src, t)
    this.count(st.size)
    fs.chmodSync(t, (mode ?? st.mode) & 0o777 & ~0o7000 | 0o600)
    this.hardlinkSources.add(from)
  }

  // Chains of symlinks can leave the tree even when each target looks local: resolve them for real.
  finish() {
    for (const from of this.hardlinkSources) {
      if (!this.regularFileNoSymlinks(from)) throw new UnsafeArchive('hardlink source is no longer a regular file: ' + from)
    }
    for (const link of this.links) {
      let real
      try { real = fs.realpathSync.native(link) } catch (e) {
        if (e.code === 'ENOENT') continue
        throw new UnsafeArchive('symlink ' + path.relative(this.dest, link) + ' does not resolve: ' + e.code)
      }
      if (real !== this.dest && !isUnder(this.dest, real)) throw new UnsafeArchive('symlink ' + path.relative(this.dest, link) + ' resolves outside the destination')
    }
  }
}

// ---------------------------------------------------------------- tar

class Pull {
  constructor(iterable) { this.it = iterable[Symbol.asyncIterator](); this.chunks = []; this.len = 0; this.done = false }
  async fill(n) {
    while (this.len < n && !this.done) {
      const { value, done } = await this.it.next()
      if (done) this.done = true
      else { this.chunks.push(value); this.len += value.length }
    }
  }
  async read(n) {
    await this.fill(n)
    const take = Math.min(n, this.len)
    const out = Buffer.allocUnsafe(take)
    let off = 0
    while (off < take) {
      const c = this.chunks[0]
      const k = Math.min(c.length, take - off)
      c.copy(out, off, 0, k)
      off += k
      if (k === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(k)
    }
    this.len -= take
    return out
  }
}

const octal = (buf) => {
  if (buf[0] & 0x80) {
    let n = 0
    for (let i = 1; i < buf.length; i += 1) n = n * 256 + buf[i]
    return n
  }
  const s = buf.toString('latin1').replace(/\0.*$/s, '').trim()
  return s ? parseInt(s, 8) : 0
}
const cstr = (buf) => buf.toString('utf8').replace(/\0.*$/s, '')

function paxRecords(buf) {
  const out = {}
  let i = 0
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i)
    if (sp < 0) break
    const len = parseInt(buf.toString('latin1', i, sp), 10)
    if (!Number.isFinite(len) || len <= 0) throw new UnsafeArchive('corrupt pax header')
    const rec = buf.toString('utf8', sp + 1, i + len - 1)
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    i += len
  }
  return out
}

export async function extractTarGz(file, dest, opts = {}) {
  const w = new SafeWriter(dest, opts)
  const input = fs.createReadStream(file).pipe(zlib.createGunzip())
  const pull = new Pull(input)
  let longName = null
  let longLink = null
  let pax = {}
  let globalPax = {}
  const skipPad = async (size) => { const pad = (512 - (size % 512)) % 512; if (pad) await pull.read(pad) }
  for (;;) {
    const hdr = await pull.read(512)
    if (hdr.length === 0) break
    if (hdr.length < 512) throw new UnsafeArchive('truncated tar header')
    if (hdr.every((b) => b === 0)) break
    let sum = 0
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : hdr[i]
    if (sum !== octal(hdr.subarray(148, 156))) throw new UnsafeArchive('tar header checksum mismatch')
    const type = String.fromCharCode(hdr[156] || 48)
    let size = octal(hdr.subarray(124, 136))
    const mode = octal(hdr.subarray(100, 108))
    const isUstar = hdr.toString('latin1', 257, 262) === 'ustar'
    let name = cstr(hdr.subarray(0, 100))
    if (isUstar && hdr[345]) name = cstr(hdr.subarray(345, 500)) + '/' + name
    let link = cstr(hdr.subarray(157, 257))
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      if (size > 1024 * 1024) throw new UnsafeArchive('oversized tar metadata record')
      const body = await pull.read(size)
      await skipPad(size)
      if (type === 'x') pax = paxRecords(body)
      else if (type === 'g') globalPax = { ...globalPax, ...paxRecords(body) }
      else if (type === 'L') longName = cstr(body)
      else longLink = cstr(body)
      continue
    }
    const meta = { ...globalPax, ...pax }
    if (meta.path) name = meta.path
    else if (longName !== null) name = longName
    if (meta.linkpath) link = meta.linkpath
    else if (longLink !== null) link = longLink
    if (meta.size) size = parseInt(meta.size, 10)
    pax = {}; longName = null; longLink = null
    if (type === '0' || type === '7') {
      const f = w.openFile(name, mode)
      let left = size
      while (left > 0) {
        const buf = await pull.read(Math.min(left, 1024 * 1024))
        if (buf.length === 0) throw new UnsafeArchive('truncated tar entry ' + name)
        if (f) f.write(buf)
        left -= buf.length
      }
      if (f) f.close()
      await skipPad(size)
    } else {
      await pull.read(size)
      await skipPad(size)
      if (type === '5') w.dir(name, mode)
      else if (type === '2') w.symlink(name, link)
      else if (type === '1') w.hardlink(name, link, mode)
      else throw new UnsafeArchive('unsupported tar entry type ' + JSON.stringify(type) + ' for ' + name)
    }
  }
  w.finish()
  return { entries: w.entries, bytes: w.bytes }
}

// ---------------------------------------------------------------- zip

export function extractZip(file, dest, opts = {}) {
  const w = new SafeWriter(dest, opts)
  const buf = fs.readFileSync(file)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new UnsafeArchive('not a zip file (no end-of-central-directory record)')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || off === 0xffffffff) throw new UnsafeArchive('zip64 archives are not supported')
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new UnsafeArchive('corrupt zip central directory')
    const madeBy = buf.readUInt16LE(off + 4)
    const flags = buf.readUInt16LE(off + 8)
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const usize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const attrs = buf.readUInt32LE(off + 38)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    off += 46 + nameLen + extraLen + commentLen
    if (flags & 1) throw new UnsafeArchive('encrypted zip entry ' + name)
    if (csize === 0xffffffff || usize === 0xffffffff) throw new UnsafeArchive('zip64 entry ' + name)
    w.count(usize)
    const unix = madeBy >> 8 === 3 ? attrs >>> 16 : 0
    const kind = unix & 0o170000
    if (name.endsWith('/') || kind === 0o040000) { w.dir(name, unix & 0o777 || 0o755); continue }
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new UnsafeArchive('corrupt zip local header for ' + name)
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28)
    const raw = buf.subarray(start, start + csize)
    let data
    if (method === 0) data = raw
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw new UnsafeArchive('unsupported zip compression method ' + method + ' for ' + name)
    if (data.length !== usize) throw new UnsafeArchive('zip entry size mismatch for ' + name)
    if (kind === 0o120000) w.symlink(name, data.toString('utf8'))
    else if (kind === 0 || kind === 0o100000) w.file(name, unix & 0o777 || 0o644, data)
    else throw new UnsafeArchive('unsupported zip entry type for ' + name)
  }
  w.finish()
  return { entries: w.entries, bytes: w.bytes }
}
