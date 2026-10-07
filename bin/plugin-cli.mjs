import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CliError, EXIT, HOSTS, findRow, readRegistry, resolveImg2Home, resolveSource } from './img2.mjs'
import { ui } from './ui.mjs'

const REF = /^(?:[0-9a-f]{40}|v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/
const SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const FLAGS = {
  install: ['--home', '--ref', '--yes', '--force', '--dry-run'],
  update: ['--home', '--yes', '--check'],
  remove: ['--home', '--yes'],
  doctor: ['--home', '--json'],
  version: ['--json'],
  help: [],
}
const HELP = `Usage: <plugin-cli> <command> [options]
  install [--ref <vX.Y.Z|40-char SHA>] [--home <absolute path>] [--yes] [--force] [--dry-run]
  update [--home <absolute path>] [--yes] [--check]
  remove [--home <absolute path>] [--yes]
  doctor [--home <absolute path>] [--json]
  version [--json]
  help

--version prints the installer version; --help displays this help.
--force replaces only this plugin's registered ref, never a local link or another source.
--dry-run previews installation without downloads, subprocesses or writes.
Doctor reports the entire img2 harness, not a reconstruction acceptance result.
`

function parse(argv) {
  const [first = 'help', ...rest] = argv
  const command = ({ '--version': 'version', '-v': 'version', '--help': 'help', '-h': 'help' })[first] || first
  if (!Object.hasOwn(FLAGS, command)) throw new CliError(EXIT.REFUSED, 'unknown command: ' + first)
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (flag === '--help' || flag === '-h') {
      opts.help = true
      continue
    }
    if (!FLAGS[command].includes(flag)) throw new CliError(EXIT.REFUSED, 'unknown option for ' + command + ': ' + flag)
    if (Object.hasOwn(opts, flag)) throw new CliError(EXIT.REFUSED, 'duplicate option: ' + flag)
    if (flag === '--home' || flag === '--ref') {
      const value = rest[++i]
      if (!value || value.startsWith('-')) throw new CliError(EXIT.REFUSED, flag + ' requires a value')
      opts[flag] = value
    } else opts[flag] = true
  }
  return { command, opts }
}

function sourceKey(spec) {
  return resolveSource(spec, true).url.replace(/(?:\.git)?\/$|\.git$/, '').toLowerCase()
}

function runHarness(args) {
  const bin = fileURLToPath(new URL('./img2.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? EXIT.FAIL
}

async function consent(message, yes) {
  if (yes) return
  if (!process.stdin.isTTY) throw new CliError(EXIT.NEEDS_INPUT, 'confirmation requires a terminal; pass --yes')
  const terminal = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await terminal.question(ui.prompt(message, process.stderr))
    if (!/^(y|yes)$/i.test(answer.trim())) throw new CliError(EXIT.REFUSED, 'cancelled; nothing changed')
  } finally {
    terminal.close()
  }
}

export async function runPluginCli({ packageUrl, argv = process.argv.slice(2) } = {}) {
  try {
    const { command, opts } = parse(argv)
    if (command === 'help' || opts.help) {
      process.stdout.write(HELP)
      return EXIT.OK
    }
    if (!packageUrl) throw new CliError(EXIT.FAIL, 'packageUrl is required')
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(packageUrl), 'utf8'))
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') throw new CliError(EXIT.FAIL, 'package.json requires name and version')
    const meta = pkg.img2Plugin
    if (!meta || typeof meta.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(meta.id)) throw new CliError(EXIT.FAIL, 'invalid img2Plugin.id')
    if (typeof meta.source !== 'string' || !SOURCE.test(meta.source)) throw new CliError(EXIT.FAIL, 'img2Plugin.source must be canonical org/repo')
    if (meta.ref !== undefined && (typeof meta.ref !== 'string' || !REF.test(meta.ref))) throw new CliError(EXIT.FAIL, 'img2Plugin.ref must be vX.Y.Z or a full git SHA')
    const ref = opts['--ref'] ?? meta.ref
    if (ref !== undefined && !REF.test(ref)) throw new CliError(EXIT.REFUSED, '--ref must be vX.Y.Z or a full git SHA')
    if (command === 'version') {
      process.stdout.write(opts['--json'] ? JSON.stringify({ name: pkg.name, version: pkg.version, plugin: meta }) + '\n' : pkg.name + ' ' + pkg.version + '\n')
      return EXIT.OK
    }

    const home = resolveImg2Home(opts['--home'])
    if (command === 'doctor') {
      const args = ['doctor', '--home', home]
      if (opts['--json']) args.push('--json')
      return runHarness(args)
    }
    const row = findRow(readRegistry(home), meta.id)
    if (row) {
      if (typeof row.repo !== 'string') throw new CliError(EXIT.FAIL, 'registered plugin has no source: ' + meta.id)
      if (row.repo.startsWith('link:') || sourceKey(row.repo) !== sourceKey(meta.source)) {
        throw new CliError(EXIT.REFUSED, meta.id + ' is registered as a local link or another source; refusing to change it')
      }
    }

    if (command === 'install') {
      const matches = row && (ref === undefined || row.ref === ref || row.resolvedSha === ref)
      if (row && !matches && !opts['--force']) throw new CliError(EXIT.REFUSED, 'different registered ref; use --force to replace this source')
      if (opts['--dry-run']) {
        const hosts = Object.values(HOSTS).filter(host => fs.existsSync(host.configRoot())).map(host => host.label)
        ui.heading('Preview plugin install')
        ui.detail('Plugin', meta.id)
        ui.detail('Source', meta.source)
        ui.detail('Ref', ref || 'newest semantic tag; HEAD if untagged')
        ui.detail('Home', ui.path(home))
        ui.detail('Hosts', hosts.join(', ') || 'none detected')
        ui.info(matches ? 'Already registered; this install would keep the current ref' : 'Preview only; no downloads, subprocesses or filesystem changes')
        const next = matches
          ? ['npx', pkg.name, 'doctor', '--home', home]
          : ['npx', pkg.name, 'install', '--home', home, ...(opts['--ref'] ? ['--ref', ref] : []), ...(opts['--force'] ? ['--force'] : []), '--yes']
        ui.next(next, matches ? 'Check the existing installation:' : 'Run when ready to install:')
        return EXIT.OK
      }
      if (matches) {
        ui.heading('Plugin already registered')
        ui.detail('Plugin', meta.id)
        ui.detail('Ref', row.ref)
        ui.detail('Home', ui.path(home))
        ui.info('Nothing changed; registration alone does not verify installation health')
        ui.next(['npx', pkg.name, 'doctor', '--home', home], 'Check the existing installation:')
        return EXIT.OK
      }
      await consent('Install ' + meta.id + ' from ' + meta.source + ' into ' + home + '?', opts['--yes'])
      if (!fs.existsSync(path.join(home, 'harness', '.git'))) {
        const status = runHarness(['install', '--home', home, '--yes'])
        if (status !== EXIT.OK) return status
      }
      const args = ['add', meta.source, '--plugin', meta.id, '--home', home, '--yes']
      if (!resolveSource(meta.source, true).defaultOrg) args.push('--allow-any-source')
      if (ref) args.push('--ref', ref)
      if (opts['--force']) args.push('--force')
      return runHarness(args)
    }

    if (!row) {
      if (command === 'remove') {
        process.stdout.write(meta.id + ' is not registered; nothing changed\n')
        return EXIT.OK
      }
      throw new CliError(EXIT.FAIL, meta.id + ' is not registered; install it first')
    }
    if (command === 'update') {
      if (!opts['--check']) await consent('Update ' + meta.id + ' from ' + meta.source + '?', opts['--yes'])
      const args = ['update', meta.id, '--home', home, '--yes']
      if (opts['--check']) args.push('--check')
      if (!resolveSource(meta.source, true).defaultOrg) args.push('--allow-any-source')
      return runHarness(args)
    }
    await consent('Remove ' + meta.id + ' from ' + home + '?', opts['--yes'])
    return runHarness(['remove', meta.id, '--home', home])
  } catch (error) {
    ui.error('plugin-cli', error.message, error.detail)
    return error instanceof CliError ? error.code : EXIT.FAIL
  }
}
