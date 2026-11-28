import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './fsx.mjs'
import { Refusal } from './errors.mjs'

// Link a completely written owner record into place: a contender can never observe an empty new lock.
// Ambiguous/dead owners require explicit operator recovery; PID reuse is never grounds for stealing it.
export function acquireLock(root) {
  ensureDir(root)
  const file = path.join(root, '.provision.lock')
  const token = crypto.randomBytes(16).toString('hex')
  const candidate = path.join(root, '.provision-owner-' + process.pid + '-' + token)
  let identity
  const fd = fs.openSync(candidate, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }) + '\n')
    fs.fsyncSync(fd)
    identity = fs.fstatSync(fd)
  } finally { fs.closeSync(fd) }
  try {
    fs.linkSync(candidate, file)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Refusal('another img2 provision owns the lock at ' + file,
      'Wait for its owner. Recovery is explicit: only after verifying that provisioner has exited, remove ' + file + ' and rerun. Empty, malformed and dead-PID records are never reclaimed automatically.')
  } finally { fs.unlinkSync(candidate) }
  return () => {
    try {
      const current = fs.lstatSync(file)
      if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isFile()) return
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (owner.token === token && owner.pid === process.pid) fs.unlinkSync(file)
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
  }
}
