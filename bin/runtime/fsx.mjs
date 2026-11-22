import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export function isUnder(parent, child) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode })
  const st = fs.lstatSync(dir)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('refusing to use non-directory or symlink: ' + dir)
}

export const rmrf = (target) => fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 })

// Write via a sibling temp file and rename: readers see the old or the new file, never a partial one.
export function atomicWriteFile(file, data, mode = 0o600) {
  const dir = path.dirname(file)
  ensureDir(dir)
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'))
  let fd = null
  try {
    fd = fs.openSync(tmp, 'wx', mode)
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, file)
  } catch (e) {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* already failing */ }
    rmrf(tmp)
    throw e
  }
}

export const atomicWriteJson = (file, value, mode = 0o600) => atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n', mode)

// One streaming pass computing every requested digest (hex).
export async function hashFile(file, algos = ['sha256']) {
  const hashes = Object.fromEntries(algos.map((a) => [a, crypto.createHash(a)]))
  let size = 0
  for await (const chunk of fs.createReadStream(file)) {
    size += chunk.length
    for (const h of Object.values(hashes)) h.update(chunk)
  }
  return { size, ...Object.fromEntries(Object.entries(hashes).map(([a, h]) => [a, h.digest('hex')])) }
}

export function fileSha256Sync(file) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n))
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}

// Stable digest of a directory tree (relative paths, file bytes, symlink targets); used as the
// receipt hash for content the pinned Playwright CLI downloaded on our behalf.
export function treeDigest(root) {
  const h = crypto.createHash('sha256')
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      const r = rel ? rel + '/' + name : name
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) h.update('l ' + r + ' ' + fs.readlinkSync(p) + '\n')
      else if (st.isDirectory()) { h.update('d ' + r + '\n'); walk(p, r) }
      else if (st.isFile()) h.update('f ' + r + ' ' + st.size + ' ' + fileSha256Sync(p) + '\n')
    }
  }
  walk(root, '')
  return h.digest('hex')
}

export function liveProcess(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
