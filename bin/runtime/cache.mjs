// Content-addressed download cache. Nothing is used before its pinned hash has been verified.
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { Refusal, StepError } from './errors.mjs'
import { atomicWriteJson, ensureDir, hashFile, rmrf } from './fsx.mjs'
import { integrityOf } from './lock.mjs'

const MAX_REDIRECTS = 8

export function assertHttps(url) {
  let u
  try { u = new URL(url) } catch { throw new StepError('invalid URL ' + JSON.stringify(url)) }
  if (u.protocol !== 'https:') throw new StepError('refusing non-HTTPS URL ' + url)
  if (u.username || u.password) throw new StepError('refusing URL with embedded credentials')
  return u
}

// Real downloader: HTTPS at every redirect hop, bounded size and time, streamed to `dest`.
export function httpsDownload(url, dest, { maxBytes = 8 * 1024 ** 3, timeout = 120_000 } = {}) {
  const hop = (target, left) => new Promise((resolve, reject) => {
    let u
    try { u = assertHttps(target) } catch (e) { reject(e); return }
    const req = https.get(u, { headers: { 'user-agent': 'img2-provision', accept: '*/*' }, timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume()
        if (!res.headers.location) { reject(new StepError('redirect without Location from ' + target)); return }
        if (left <= 0) { reject(new StepError('too many redirects fetching ' + url)); return }
        let next
        try { next = new URL(res.headers.location, u).toString() } catch { reject(new StepError('bad redirect target')); return }
        hop(next, left - 1).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) { res.resume(); reject(new StepError('HTTP ' + res.statusCode + ' fetching ' + target)); return }
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBytes) { res.resume(); reject(new StepError('download larger than ' + maxBytes + ' bytes')); return }
      const out = fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 })
      let got = 0
      res.on('data', (c) => {
        got += c.length
        if (got > maxBytes) { req.destroy(new StepError('download larger than ' + maxBytes + ' bytes')); out.destroy() }
      })
      res.on('error', reject)
      out.on('error', reject)
      out.on('finish', resolve)
      res.pipe(out)
    })
    req.on('timeout', () => req.destroy(new StepError('timeout fetching ' + target)))
    req.on('error', reject)
  })
  return hop(url, MAX_REDIRECTS)
}

const gitBlobSha1 = (file) => {
  const data = fs.readFileSync(file)
  return crypto.createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex')
}

export class Cache {
  constructor({ dir, download, offline = false, allowWeak = false }) {
    this.dir = dir
    this.download = download
    this.offline = offline
    this.allowWeak = allowWeak
    this.indexFile = path.join(dir, 'weak-index.json')
  }

  entry(algo, hex) { return path.join(this.dir, algo, hex) }

  readIndex() {
    try { return JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) } catch { return {} }
  }

  // True when fetch() could be satisfied without the network (existence only; fetch re-verifies the bytes).
  has(artifact) {
    const integ = integrityOf(artifact)
    const sized = (file) => {
      try {
        const st = fs.statSync(file)
        return st.isFile() && (!Number.isFinite(artifact.size) || st.size === artifact.size)
      } catch { return false }
    }
    if (!integ.weak) return sized(this.entry(integ.algo, integ.hex))
    const known = this.readIndex()[artifact.url]
    return !!known && sized(this.entry('sha256', known.sha256))
  }

  // A cached entry is reused only if its bytes satisfy EVERY pin of the current artifact: the content hash,
  // the declared size and (weak entries) the git blob SHA-1. A pin changed since the entry was stored
  // makes it stale, whatever the index says.
  async fresh(file, algo, hex, artifact = {}) {
    if (!fs.existsSync(file)) return null
    const h = await hashFile(file, [...new Set(['sha256', algo])])
    const sizeOk = !Number.isFinite(artifact.size) || artifact.size === h.size
    const blobOk = !artifact.gitBlobSha1 || gitBlobSha1(file) === artifact.gitBlobSha1
    if (h[algo] === hex && sizeOk && blobOk) return h
    rmrf(file) // corrupt, tampered or no longer matching the pins: never reused
    return null
  }

  // fetch(artifact, label) -> { file, algo, sha256, size, cached, weak }
  async fetch(artifact, label) {
    const integ = integrityOf(artifact)
    if (integ.weak && !this.allowWeak) {
      throw new Refusal('weak integrity for ' + label + ' (' + integ.kind + ')', 'rerun with --allow-weak-hash to record a locally computed SHA-256')
    }
    assertHttps(artifact.url)
    ensureDir(path.join(this.dir, 'tmp'))
    return integ.weak ? this.fetchWeak(artifact, label, integ) : this.fetchStrong(artifact, label, integ)
  }

  async fetchStrong(artifact, label, integ) {
    const dest = this.entry(integ.algo, integ.hex)
    const hit = await this.fresh(dest, integ.algo, integ.hex, artifact)
    if (hit) return { file: dest, algo: integ.algo, sha256: hit.sha256, size: hit.size, cached: true, weak: null }
    if (this.offline) throw new StepError('--offline: ' + label + ' is not in the cache', integ.algo + ':' + integ.hex)
    const tmp = await this.fetchTmp(artifact, label)
    const h = await hashFile(tmp, [...new Set(['sha256', integ.algo])])
    if (h[integ.algo] !== integ.hex) {
      rmrf(tmp)
      throw new StepError('hash mismatch for ' + label, 'expected ' + integ.algo + ':' + integ.hex + '\nactual   ' + integ.algo + ':' + h[integ.algo] + '\nnothing was activated')
    }
    this.checkSize(artifact, h.size, tmp, label)
    ensureDir(path.dirname(dest))
    fs.renameSync(tmp, dest)
    return { file: dest, algo: integ.algo, sha256: h.sha256, size: h.size, cached: false, weak: null }
  }

  async fetchWeak(artifact, label, integ) {
    const index = this.readIndex()
    const known = index[artifact.url]
    if (known) {
      const dest = this.entry('sha256', known.sha256)
      const hit = await this.fresh(dest, 'sha256', known.sha256, artifact)
      if (hit) return { file: dest, algo: 'sha256', sha256: known.sha256, size: hit.size, cached: true, weak: integ.kind }
    }
    if (this.offline) throw new StepError('--offline: ' + label + ' is not in the cache', integ.kind)
    const tmp = await this.fetchTmp(artifact, label)
    const h = await hashFile(tmp, ['sha256'])
    this.checkSize(artifact, h.size, tmp, label)
    if (artifact.gitBlobSha1 && gitBlobSha1(tmp) !== artifact.gitBlobSha1) {
      rmrf(tmp)
      throw new StepError('git blob SHA-1 mismatch for ' + label, 'expected ' + artifact.gitBlobSha1)
    }
    const dest = this.entry('sha256', h.sha256)
    ensureDir(path.dirname(dest))
    fs.renameSync(tmp, dest)
    atomicWriteJson(this.indexFile, { ...this.readIndex(), [artifact.url]: { sha256: h.sha256, size: h.size, weak: integ.kind } }, 0o600)
    return { file: dest, algo: 'sha256', sha256: h.sha256, size: h.size, cached: false, weak: integ.kind }
  }

  async fetchTmp(artifact, label) {
    const tmp = path.join(this.dir, 'tmp', crypto.randomBytes(8).toString('hex'))
    try {
      await this.download(artifact.url, tmp, { size: artifact.size })
    } catch (e) {
      rmrf(tmp)
      if (e instanceof StepError || e instanceof Refusal) throw e
      throw new StepError('download failed for ' + label, e.message)
    }
    return tmp
  }

  checkSize(artifact, size, tmp, label) {
    if (Number.isFinite(artifact.size) && artifact.size !== size) {
      rmrf(tmp)
      throw new StepError('size mismatch for ' + label, 'expected ' + artifact.size + ' bytes, got ' + size)
    }
  }
}
