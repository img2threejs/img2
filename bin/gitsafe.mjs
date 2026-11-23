// The one way the harness runs Git. A checkout under $IMG2_HOME is untrusted input: its .git/config, the user's and
// the system's Git configuration and inherited GIT_* variables can all make Git execute programs (core.fsmonitor,
// hooks, ssh/pager commands, filters, external diff). Every invocation therefore neutralizes them, and cleanliness is
// proved with plumbing that cannot start an external program instead of `git status`.
import { execFileSync } from 'node:child_process'

// -c entries are command scope: they beat the repository's .git/config.
export const GIT_HARDENING = [
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=',
  '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=user', '-c', 'core.pager=cat',
  '-c', 'core.gitProxy=', '-c', 'core.editor=true', '-c', 'core.askPass=', '-c', 'credential.helper=',
  '-c', 'diff.external=', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false',
]

// Variables that redirect Git to other repositories, programs or configuration.
const STRIPPED_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
  'GIT_EXEC_PATH', 'GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PROXY_COMMAND',
  'GIT_PAGER', 'GIT_EDITOR', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_NAMESPACE', 'GIT_REPLACE_REF_BASE', 'GIT_TRACE', 'GIT_TRACE2', 'GIT_TRACE_CURL',
]

export function gitEnv(base = process.env) {
  const env = { ...base }
  for (const key of STRIPPED_ENV) delete env[key]
  return {
    ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: 'https:file',
  }
}

export class GitError extends Error {
  constructor(args, err) {
    super('git ' + args.join(' ') + ' failed')
    this.notFound = err.code === 'ENOENT'
    this.status = typeof err.status === 'number' ? err.status : null
    this.stderr = String(err.stderr || '').trim()
  }
}

// Trimmed stdout (untrimmed with { raw: true }); throws GitError on a non-zero exit or a missing git.
export function runGit(args, cwd, { raw = false } = {}) {
  try {
    const out = execFileSync('git', [...GIT_HARDENING, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
    })
    return raw ? out : out.trim()
  } catch (err) { throw new GitError(args, err) }
}

// True when the working tree differs from HEAD in any tracked or untracked (non-ignored) file. Only plumbing that
// reads files and the object store: no `git status` (which consults core.fsmonitor), no filters beyond what the index
// stat check needs, submodules never entered.
export function isDirty(dir) {
  runGit(['update-index', '-q', '--refresh', '--ignore-submodules'], dir)
  try {
    runGit(['diff-index', '--quiet', '--ignore-submodules=all', 'HEAD', '--'], dir)
  } catch (err) {
    if (err.status === 1) return true
    throw err
  }
  return runGit(['ls-files', '--others', '--exclude-standard'], dir) !== ''
}

// Keys in the checkout's own .git/config through which Git would run a program or reach elsewhere.
const EXECUTABLE_KEY = /^(?:core\.(?:fsmonitor|hookspath|sshcommand|pager|editor|gitproxy|askpass|worktree)|filter\..+\.(?:clean|smudge|process)|diff\..+\.(?:command|textconv)|credential\..*helper|include(?:if\..+)?\.path)$/
export function executableLocalConfig(dir) {
  const out = runGit(['config', '--local', '--list', '-z'], dir)
  return out.split('\0').filter(Boolean).map((entry) => entry.split('\n', 1)[0]).filter((key) => EXECUTABLE_KEY.test(key.toLowerCase()))
}
