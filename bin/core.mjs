// The img2threejs core skill (forge/route.py, preflight, state): pinned in plugins.lock.json under `core`,
// checked out at $IMG2_HOME/core at exactly that commit. Git only; host linking stays in img2.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { Refusal } from './runtime/errors.mjs'
import { executableLocalConfig, isDirty, runGit } from './gitsafe.mjs'

export const coreDir = (H) => path.join(H, 'core')
export const routePathOf = (H) => path.join(coreDir(H), 'forge', 'route.py')

// Hardened Git (see gitsafe.mjs): neither the checkout's own config nor the user's can make it run a program.
const git = (args, cwd) => {
  try {
    return runGit(args, cwd)
  } catch (err) {
    if (err.notFound) throw new Refusal('git is not on PATH; install git first')
    throw new Refusal('git ' + args.join(' ') + ' failed', err.stderr, 1)
  }
}

const normalize = (source) => String(source).replace(/\.git$/, '').replace(/^https:\/\/github\.com\//, '')

// 'absent' | 'at-pin' | 'behind' (clean checkout of the right repo at another commit); anything that is not a
// clean checkout of the pinned repo throws, so setup never overwrites work it does not own.
export function coreState(H, pin) {
  const dir = coreDir(H)
  let st
  try { st = fs.lstatSync(dir) } catch (e) { if (e.code === 'ENOENT') return { state: 'absent', head: null }; throw e }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Refusal(dir + ' is not an img2-managed checkout', 'move it aside; setup will not overwrite it')
  let head, origin
  try {
    head = git(['rev-parse', 'HEAD'], dir)
    origin = git(['config', '--get', 'remote.origin.url'], dir) // raw: get-url would apply insteadOf rewrites
  } catch { throw new Refusal(dir + ' exists but is not a Git checkout of the core', 'move it aside; setup will not overwrite it') }
  if (normalize(origin) !== normalize(pin.repo)) throw new Refusal(dir + ' has origin ' + origin + ', not ' + pin.repo, 'move it aside; setup will not overwrite it')
  const executable = executableLocalConfig(dir)
  if (executable.length) throw new Refusal(dir + ' has Git configuration that runs programs (' + executable.join(', ') + ')', 'move it aside; setup will not verify or overwrite it')
  if (isDirty(dir)) throw new Refusal('setup will not overwrite dirty core checkout ' + dir, 'preserve your changes before rerunning setup')
  return { state: head === pin.commit ? 'at-pin' : 'behind', head }
}

function fetchPinned(dir, pin) {
  try {
    git(['fetch', '-q', '--depth', '1', 'origin', pin.commit], dir)
  } catch {
    git(['fetch', '-q', 'origin', pin.branch], dir)
  }
}

// The tree the pinned commit object declares, read from the object itself (replace refs are off).
const treeOfCommit = (dir, commit) => {
  const m = /^tree ([0-9a-f]{40}|[0-9a-f]{64})$/m.exec(git(['cat-file', 'commit', commit], dir))
  if (!m) throw new Refusal('pinned core commit ' + commit + ' has no readable tree')
  return m[1]
}

function verified(dir, pin) {
  const head = git(['rev-parse', 'HEAD'], dir)
  if (head !== pin.commit) throw new Refusal('core checkout is at ' + head + ', not the pinned ' + pin.commit)
  const tree = git(['rev-parse', 'HEAD^{tree}'], dir)
  const wanted = treeOfCommit(dir, pin.commit)
  if (tree !== wanted) throw new Refusal('core checkout tree ' + tree + ' does not match the pinned commit tree ' + wanted)
  if (isDirty(dir)) throw new Refusal('core checkout differs from the pinned tree ' + wanted, 'move it aside; setup will not overwrite it')
  if (!fs.existsSync(path.join(dir, 'forge', 'route.py'))) throw new Refusal('core checkout at ' + pin.commit + ' has no forge/route.py')
  return head
}

// Clones or advances the core to pin.commit and proves it. Returns { action, head }.
export function ensureCoreCheckout(H, pin, { offline = false } = {}) {
  const dir = coreDir(H)
  const current = coreState(H, pin)
  if (current.state === 'at-pin') return { action: 'kept', head: verified(dir, pin) }
  if (offline) throw new Refusal('--offline requires the core at its lock pin ' + pin.commit, 'Git downloads are disabled; found ' + (current.head ?? 'no core checkout'))
  if (current.state === 'behind') {
    fetchPinned(dir, pin)
    git(['checkout', '-q', '--detach', pin.commit], dir)
    return { action: 'updated', head: verified(dir, pin) }
  }
  const staging = dir + '.staging-' + process.pid
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    git(['init', '-q'], staging)
    git(['remote', 'add', 'origin', pin.repo], staging)
    fetchPinned(staging, pin)
    git(['checkout', '-q', '--detach', pin.commit], staging)
    verified(staging, pin)
    fs.renameSync(staging, dir)
  } finally { fs.rmSync(staging, { recursive: true, force: true }) }
  return { action: 'cloned', head: verified(dir, pin) }
}
