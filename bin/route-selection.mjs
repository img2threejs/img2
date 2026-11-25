// Conservative download selection, not routing/execution authority. Labels never select a source.
import fs from 'node:fs'
import path from 'node:path'
import { Refusal } from './runtime/errors.mjs'
import { isUnder } from './runtime/fsx.mjs'

export function routeInstallRequest(args) {
  const values = flag => args.flatMap((arg, i) => arg === flag ? [args[i + 1]] : arg.startsWith(flag + '=') ? [arg.slice(flag.length + 1)] : [])
  const image = values('--image')[0], objects = values('--objects')[0]
  const intents = [...values('--intent'), ...values('--explicit-route')]
  if (args.includes('--help') || args.includes('-h') || args.includes('--complete-child')
    || !image || image.startsWith('--') || !objects || objects.startsWith('--')
    || (values('--expected-output')[0] ?? '3d') !== '3d'
    || intents.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,95}$/.test(value))) return null
  return { intents, objects, workspace: path.resolve(values('--workspace')[0] ?? process.cwd()) }
}

function allowed(value, options) {
  if (value === undefined || value === null || value === 'unknown') return false
  return options.some(option => typeof option === 'string' && /^>[0-9]+$/.test(option)
    ? typeof value === 'number' && Number.isFinite(value) && value > Number(option.slice(1))
    : typeof value === typeof option && value === option)
}

function matches(card, object, intents) {
  const requires = card.requires ?? {}, excluded = card.notFor ?? {}
  for (const [key, actual] of [['roles', [object.role]], ['intent', intents]]) {
    if (!(requires[key] ?? []).every(value => actual.includes(value)) || (excluded[key] ?? []).some(value => actual.includes(value))) return false
  }
  for (const [rules, exclusion] of [[requires.observations ?? {}, false], [excluded.observations ?? {}, true]]) {
    for (const [key, options] of Object.entries(rules)) {
      const value = object.observations?.[key]
      if (value === undefined || value === null || value === 'unknown' || allowed(value, options) === exclusion) return false
    }
  }
  return true
}

export function routeInstallPins(lock, request) {
  if (!lock.plugins.some(pin => pin.routing)) throw new Refusal('the installed lock has no trusted routing snapshots', 'upgrade/setup explicitly; no plugin was installed')
  const workspace = fs.realpathSync(request.workspace)
  const file = path.resolve(workspace, request.objects)
  if (path.isAbsolute(request.objects) || !isUnder(workspace, file) || fs.realpathSync(file) !== file
    || !fs.lstatSync(file).isFile() || fs.statSync(file).size > 256 * 1024) throw new Refusal('invalid workspace-relative object proposals')
  const proposal = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (proposal?.kind !== 'img2.object-proposals' || proposal.version !== 1 || !Array.isArray(proposal.objects)
    || proposal.objects.some(object => !object || typeof object.role !== 'string' || !/^[a-z][a-z0-9-]{0,95}$/.test(object.role))) throw new Refusal('invalid typed object proposals')
  const selected = []
  for (const pin of lock.plugins) {
    const explicit = request.intents.includes(pin.id)
    if (!pin.routing) {
      if (explicit) throw new Refusal('the requested plugin has no pinned routing snapshot: ' + pin.id)
      continue
    }
    const card = pin.routing.card
    const requires = card.requires ?? {}
    const positive = (requires.roles?.length ?? 0) + (requires.intent?.length ?? 0) + Object.keys(requires.observations ?? {}).length > 0
    const match = card.outputKind !== '2d-scene' && ['local', 'heavy'].includes(card.costClass)
      && (explicit || positive) && proposal.objects.some(object => matches(card, object, request.intents))
    if (explicit && !match) throw new Refusal('the requested pinned producer does not support these typed 3D facts: ' + pin.id)
    if (match) selected.push(pin)
  }
  return selected
}
