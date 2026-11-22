// A plan is data: units to build (each one an atomic directory), skips, sizes. Printing never writes.
import path from 'node:path'
import { Refusal } from './errors.mjs'
import { artifactsOf, describeSize, fmtBytes, isBrowser, sizesOf, weakArtifacts } from './lock.mjs'

// Environments of kind `dir` and the MCP environment are one unit per dependency; every other
// environment is one unit (a venv and/or an npm root inside it).
const perDependency = (name, kind) => kind === 'dir' || name === 'mcp'

export function unitName(entry, lock) {
  const env = entry.environment
  return perDependency(env, lock.environments[env]?.kind) ? env + '/' + entry.id : env
}

export function buildUnits(selection, lock) {
  const units = new Map()
  for (const d of selection.deps) {
    if (d.status !== 'install') continue
    const name = unitName(d.entry, lock)
    if (!units.has(name)) units.set(name, { name, environment: d.entry.environment, deps: [], needs: new Set() })
    units.get(name).deps.push(d)
  }
  const unitOf = new Map([...units.values()].flatMap((u) => u.deps.map((d) => [d.id, u.name])))
  for (const u of units.values()) {
    for (const d of u.deps) for (const r of d.entry.requires) { const n = unitOf.get(r); if (n && n !== u.name) u.needs.add(n) }
    // a browser unit installs through the pinned Playwright package that requires it
    for (const d of u.deps) if (isBrowser(d.entry)) {
      const owner = playwrightOwner(d.entry, selection, lock)
      if (owner) { u.cliDep = owner }
    }
  }
  const out = []
  const seen = new Set()
  const visit = (name, stack) => {
    if (seen.has(name)) return
    if (stack.includes(name)) throw new Refusal('unit cycle: ' + [...stack, name].join(' > '))
    for (const n of units.get(name).needs) visit(n, [...stack, name])
    seen.add(name)
    out.push(units.get(name))
  }
  for (const name of units.keys()) visit(name, [])
  return out
}

// The npm dependency (any status) whose requires mention this browser: its tarballs provide the CLI.
export function playwrightOwner(browser, selection, lock) {
  return lock.dependencies.find((e) => e.kind === 'npm' && e.requires.includes(browser.id)) ?? null
}

export function unitSizes(unit, platform, lock) {
  const s = { download: 0, downloadUnknown: 0, expanded: 0, expandedUnknown: 0 }
  const add = (x) => { for (const k of Object.keys(s)) s[k] += x[k] }
  for (const d of unit.deps) add(sizesOf(d.entry, platform))
  if (unit.cliDep) add(sizesOf(unit.cliDep, platform))
  return s
}

export function makePlan({ selection, lock, platform, root, lockDigest, opts }) {
  const units = buildUnits(selection, lock)
  const weak = []
  for (const u of units) {
    for (const d of u.deps) weak.push(...weakArtifacts(d.entry, platform).map((w) => ({ ...w, unit: u.name })))
  }
  const rows = units.map((u) => ({
    unit: u.name,
    path: path.join(root, lockDigest.slice(0, 12), u.name),
    dependencies: u.deps.map((d) => d.id),
    needs: [...u.needs],
    ...unitSizes(u, platform, lock),
    weak: u.deps.flatMap((d) => weakArtifacts(d.entry, platform)).length,
  }))
  const total = rows.reduce((a, r) => ({
    download: a.download + r.download, downloadUnknown: a.downloadUnknown + r.downloadUnknown,
    expanded: a.expanded + r.expanded, expandedUnknown: a.expandedUnknown + r.expandedUnknown,
  }), { download: 0, downloadUnknown: 0, expanded: 0, expandedUnknown: 0 })
  return {
    platform, profile: selection.profile, selectedPlugins: selection.selectedPlugins,
    lockDigest, runtimeRoot: path.join(root, lockDigest.slice(0, 12)),
    units: rows, skipped: selection.skipped.map((d) => ({ id: d.id, reason: d.reason })),
    weak, total, offline: !!opts.offline, allowWeakHash: !!opts.allowWeakHash,
  }
}

export function planLines(plan) {
  const out = []
  out.push('img2 provision plan  (platform ' + plan.platform + ', profile ' + plan.profile + ')')
  out.push('plugins : ' + plan.selectedPlugins.join(', '))
  out.push('runtime : ' + plan.runtimeRoot)
  out.push('')
  const head = ['environment', 'contents', 'download', 'expanded']
  const rows = plan.units.map((u) => [u.unit, u.dependencies.join(' '), describeSize(u.download, u.downloadUnknown), describeSize(u.expanded, u.expandedUnknown)])
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
  const cap = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  const fmt = (r) => r.map((c, i) => (i === 1 ? cap(String(c), 60).padEnd(Math.min(w[1], 60)) : String(c).padEnd(w[i]))).join('  ')
  out.push(fmt(head))
  for (const r of rows) out.push(fmt(r))
  out.push('')
  out.push('total download : ' + describeSize(plan.total.download, plan.total.downloadUnknown))
  out.push('total expanded : ' + describeSize(plan.total.expanded, plan.total.expandedUnknown) + '  (sizes the lock does not publish are labelled unknown)')
  out.push('peak disk      : ' + describeSize(plan.total.download + plan.total.expanded, plan.total.downloadUnknown + plan.total.expandedUnknown) + '  (cache + staging; estimate)')
  out.push('time           : not measured; depends on bandwidth (the first run downloads everything above)')
  if (plan.skipped.length) {
    out.push('')
    out.push('disabled (' + plan.skipped.length + '):')
    for (const s of plan.skipped) out.push('  ' + s.id + ': ' + s.reason)
  }
  if (plan.weak.length) {
    out.push('')
    out.push('weak integrity (' + plan.weak.length + '): the lock pins no SHA-256 for these; `provision` refuses unless --allow-weak-hash')
    out.push('(a locally computed SHA-256 is then recorded in the receipt):')
    for (const w2 of plan.weak.slice(0, 12)) out.push('  ' + w2.dep + ' ' + w2.file + ' [' + w2.kind + ']')
    if (plan.weak.length > 12) out.push('  ... and ' + (plan.weak.length - 12) + ' more')
  }
  out.push('')
  out.push('nothing was written (--plan)')
  return out
}

export { fmtBytes, artifactsOf }
