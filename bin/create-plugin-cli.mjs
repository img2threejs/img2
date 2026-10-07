#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError, EXIT, validateManifest } from './img2.mjs'

const NAME = /^[a-z][a-z0-9-]*$/
const SHA = /^[0-9a-f]{40}$/
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const REF = /^(?:[0-9a-f]{40}|v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/
const SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const HELP = `create-img2-plugin-cli --directory <plugin repo> --source <org/repo>
  --workflow-ref <reviewed ci-workflows 40-char SHA>
  [--name <npm CLI name>] [--ref <vX.Y.Z|40-char SHA>]
  [--cli-version <X.Y.Z>] [--private-repo]

Requires an existing plugin.json and SKILL.md. Creates cli/, a CLI release workflow,
and CLI_QUICKSTART.md without overwriting existing output or following symlinked parents.
Use --private-repo for a private GitHub source; the npm installer remains public.
`

function parse(argv) {
  const opts = { cliVersion: '0.1.0', privateRepo: false }
  const keys = { '--directory': 'directory', '--source': 'source', '--workflow-ref': 'workflowRef', '--name': 'name', '--ref': 'ref', '--cli-version': 'cliVersion' }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (seen.has(arg)) throw new CliError(EXIT.REFUSED, 'duplicate option: ' + arg)
    seen.add(arg)
    if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--private-repo') opts.privateRepo = true
    else if (Object.hasOwn(keys, arg)) {
      const value = argv[++i]
      if (!value || value.startsWith('-')) throw new CliError(EXIT.REFUSED, arg + ' requires a value')
      opts[keys[arg]] = value
    } else throw new CliError(EXIT.REFUSED, 'unknown option: ' + arg)
  }
  return opts
}

function template(name, vars) {
  const text = fs.readFileSync(path.join(ROOT, 'templates', 'plugin-cli', name), 'utf8')
  return text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, key) => {
    if (!Object.hasOwn(vars, key)) throw new CliError(EXIT.FAIL, 'unknown template token: ' + key)
    return String(vars[key])
  })
}

function generate(argv) {
  const opts = parse(argv)
  if (opts.help || !argv.length) {
    process.stdout.write(HELP)
    return EXIT.OK
  }
  if (!opts.directory) throw new CliError(EXIT.REFUSED, '--directory is required')
  if (!opts.source || !SOURCE.test(opts.source)) throw new CliError(EXIT.REFUSED, '--source must be canonical org/repo')
  if (!opts.workflowRef || !SHA.test(opts.workflowRef)) throw new CliError(EXIT.REFUSED, '--workflow-ref requires a full lowercase git SHA')
  if (!VERSION.test(opts.cliVersion)) throw new CliError(EXIT.REFUSED, '--cli-version requires strict X.Y.Z')
  if (opts.ref !== undefined && !REF.test(opts.ref)) throw new CliError(EXIT.REFUSED, '--ref requires vX.Y.Z or a full git SHA')

  const repo = fs.realpathSync(path.resolve(opts.directory))
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'plugin.json'), 'utf8'))
  validateManifest(manifest, repo)
  if (!fs.statSync(path.join(repo, 'SKILL.md')).isFile()) throw new CliError(EXIT.FAIL, 'SKILL.md must be a file')
  const name = opts.name ?? 'img2-' + manifest.name
  if (!NAME.test(name)) throw new CliError(EXIT.REFUSED, '--name requires a lowercase CLI name')
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  if (typeof version !== 'string' || !VERSION.test(version)) throw new CliError(EXIT.FAIL, 'harness package has no valid version')

  // Preflight every existing output and parent before writing anything. lstat also sees dangling links.
  for (const rel of ['cli', 'CLI_QUICKSTART.md', '.github/workflows/cli-publish.yml']) {
    if (fs.lstatSync(path.join(repo, rel), { throwIfNoEntry: false })) throw new CliError(EXIT.REFUSED, rel + ' already exists; refusing overwrite')
  }
  for (const rel of ['.github', '.github/workflows']) {
    const entry = fs.lstatSync(path.join(repo, rel), { throwIfNoEntry: false })
    if (entry && !entry.isDirectory()) throw new CliError(EXIT.REFUSED, rel + ' is not a real directory; refusing traversal')
  }
  const metadata = { id: manifest.name, source: opts.source }
  if (opts.ref) metadata.ref = opts.ref
  const vars = {
    CLI_NAME: name, CLI_VERSION: opts.cliVersion, PLUGIN_ID: manifest.name,
    SOURCE: opts.source, HARNESS_VERSION: version, WORKFLOW_SHA: opts.workflowRef,
    PROVENANCE: !opts.privateRepo, IMG2_PLUGIN: JSON.stringify(metadata),
  }
  const mappings = {
    'cli/package.json': 'package.json', 'cli/bin/cli.mjs': 'bin-cli.mjs',
    'cli/tests/cli.test.mjs': 'test-cli.mjs', 'cli/README.md': 'cli-README.md',
    'cli/.gitignore': 'gitignore', '.github/workflows/cli-publish.yml': 'cli-publish.yml',
    'CLI_QUICKSTART.md': 'CLI_QUICKSTART.md',
  }
  const outputs = Object.entries(mappings).map(([file, input]) => [file, template(input, vars)])
  const renderedPackage = outputs.find(([file]) => file === 'cli/package.json')
  renderedPackage[1] = JSON.stringify(JSON.parse(renderedPackage[1]), null, 2) + '\n'
  outputs.push(['cli/LICENSE', fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8')])
  for (const [file, content] of outputs) {
    const target = path.join(repo, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, { flag: 'wx' })
  }
  fs.chmodSync(path.join(repo, 'cli', 'bin', 'cli.mjs'), 0o755)
  process.stdout.write('Created ' + name + ' in ' + path.join(repo, 'cli') + '\nRead ' + path.join(repo, 'CLI_QUICKSTART.md') + '\n')
  return EXIT.OK
}

try {
  process.exitCode = generate(process.argv.slice(2))
} catch (error) {
  console.error('create-img2-plugin-cli: ' + error.message)
  if (error.detail) console.error(error.detail)
  process.exitCode = error instanceof CliError ? error.code : EXIT.FAIL
}
