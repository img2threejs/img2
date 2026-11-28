// Offline stand-in for the core skill repository: a local Git repo with forge/route.py, a copy of the CLI whose
// plugins.lock.json pins one of its commits, and the Git insteadOf entry that routes the core URL to it.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CORE_REPO } from '../bin/runtime/locks.mjs'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export { CORE_REPO }

export const gitIn = (dir, args, env) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' }).trim()

export function makeCoreSource(root, env, commits = 1) {
  const source = path.join(root, 'core-source')
  fs.mkdirSync(path.join(source, 'forge'), { recursive: true })
  const author = { ...env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.test' }
  gitIn(source, ['init', '-q', '-b', 'main'], author)
  const shas = []
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(source, 'forge/route.py'), '# router v' + i + '\n')
    gitIn(source, ['add', '.'], author)
    gitIn(source, ['commit', '-qm', 'v' + i], author)
    shas.push(gitIn(source, ['rev-parse', 'HEAD'], author))
  }
  return { source, shas }
}

// Copies bin/ and the lock files to <root>/cli with the core pinned to `commit` on branch main.
export function copyCli(root, commit) {
  const cli = path.join(root, 'cli')
  fs.mkdirSync(cli)
  fs.cpSync(path.join(ROOT, 'bin'), path.join(cli, 'bin'), { recursive: true })
  for (const file of ['package.json', 'dependencies.lock.json', 'catalog.json']) fs.copyFileSync(path.join(ROOT, file), path.join(cli, file))
  const pins = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins.lock.json'), 'utf8'))
  Object.assign(pins.core, { commit, branch: 'main' })
  fs.writeFileSync(path.join(cli, 'plugins.lock.json'), JSON.stringify(pins))
  return cli
}

// Git config env entries (insteadOf) that send CORE_REPO to the fixture; `index` is the first free GIT_CONFIG slot.
export const coreInsteadOf = (source, index) => ({ ['GIT_CONFIG_KEY_' + index]: 'url.' + source + '.insteadOf', ['GIT_CONFIG_VALUE_' + index]: CORE_REPO })
