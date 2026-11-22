// Installs an npm root from pinned, hash-verified tarballs. The lock is flat (name, version, tarball);
// the tree is derived from each package.json exactly the way npm hoists: first come keeps the root.
import fs from 'node:fs'
import path from 'node:path'
import { StepError } from './errors.mjs'
import { extractTarGz } from './extract.mjs'
import { atomicWriteJson, ensureDir, isUnder, rmrf } from './fsx.mjs'
import { compareVersions, satisfies } from './semver.mjs'

const SCRIPT_KEYS = ['preinstall', 'install', 'postinstall']

function parseEdge(dir, spec, optional) {
  const alias = /^npm:(@?[^@]+)(?:@(.+))?$/.exec(spec)
  return alias ? { dir, name: alias[1], range: alias[2] ?? '*', optional } : { dir, name: dir, range: spec, optional }
}

function edgesOf(pkg) {
  const out = []
  for (const [n, r] of Object.entries(pkg.dependencies ?? {})) out.push(parseEdge(n, r, false))
  for (const [n, r] of Object.entries(pkg.optionalDependencies ?? {})) {
    const i = out.findIndex((e) => e.dir === n)
    const e = parseEdge(n, r, true)
    if (i >= 0) out[i] = e; else out.push(e)
  }
  return out
}

const safeDirName = (name) => /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name) && !name.includes('..')

// packages: [{ name, version, file, scriptsReviewed }]; rootDeps: [{ name, version }] (exact pins).
// Returns { placements:[{ dir, name, version }], scriptsSkipped:[...], scriptsRun:[...] }.
export async function installNpmRoot({ root, packages, rootDeps, runScript, label = root }) {
  ensureDir(root)
  const store = path.join(root, '.store')
  rmrf(store)
  ensureDir(store)
  const byName = new Map()
  const meta = new Map() // `${name}@${version}` -> { dir, pkg, file, reviewed }
  try {
    for (const p of packages) {
      if (!safeDirName(p.name)) throw new StepError('refusing unsafe package name ' + JSON.stringify(p.name) + ' in ' + label)
      const key = p.name + '@' + p.version
      if (meta.has(key)) continue
      const dir = path.join(store, String(meta.size))
      await extractTarGz(p.file, dir, { strip: 1 })
      let pkg
      try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch (e) {
        throw new StepError('tarball for ' + key + ' has no readable package.json', e.message)
      }
      if (pkg.name !== p.name || pkg.version !== p.version) {
        throw new StepError('tarball identity mismatch for ' + key, 'package.json says ' + pkg.name + '@' + pkg.version)
      }
      meta.set(key, { dir, pkg, reviewed: p.scriptsReviewed === true })
      if (!byName.has(p.name)) byName.set(p.name, [])
      byName.get(p.name).push(p.version)
    }

    const rootNode = { dir: '', children: new Map(), parent: null }
    const placements = []
    const queue = []
    const attach = (parent, dirName, name, version) => {
      const node = { dir: parent.dir ? parent.dir + '/node_modules/' + dirName : 'node_modules/' + dirName, name, version, children: new Map(), parent, edgeDir: dirName }
      parent.children.set(dirName, node)
      placements.push(node)
      queue.push(node)
      return node
    }
    const pick = (name, range, primary) => {
      const versions = (byName.get(name) ?? []).filter((v) => satisfies(v, range))
      if (!versions.length) return null
      if (primary && versions.includes(primary)) return primary
      return versions.sort(compareVersions).at(-1)
    }
    const primaryOf = new Map(rootDeps.map((d) => [d.name, d.version]))

    for (const d of rootDeps) {
      if (!meta.has(d.name + '@' + d.version)) throw new StepError('root dependency ' + d.name + '@' + d.version + ' has no tarball in the lock')
      if (!rootNode.children.has(d.name)) attach(rootNode, d.name, d.name, d.version)
    }
    while (queue.length) {
      const node = queue.shift()
      const { pkg } = meta.get(node.name + '@' + node.version)
      for (const edge of edgesOf(pkg)) {
        let satisfied = false
        for (let n = node; n; n = n.parent) {
          const c = n.children.get(edge.dir)
          if (c) { satisfied = c.name === edge.name && satisfies(c.version, edge.range); break }
        }
        if (satisfied) continue
        const version = pick(edge.name, edge.range, primaryOf.get(edge.name))
        if (!version) {
          if (edge.optional) continue
          throw new StepError('lock for ' + label + ' cannot satisfy ' + node.name + '@' + node.version + ' -> ' + edge.name + '@' + edge.range,
            'the lock lists ' + (byName.get(edge.name) ?? []).join(', ') + ' for ' + edge.name)
        }
        if (!safeDirName(edge.dir)) throw new StepError('refusing unsafe dependency name ' + JSON.stringify(edge.dir))
        // hoist to the root unless something else already owns that name there
        const target = rootNode.children.has(edge.dir) ? node : rootNode
        if (target.children.has(edge.dir)) continue
        attach(target, edge.dir, edge.name, version)
      }
    }

    const finalRoot = path.join(root, 'node_modules')
    rmrf(finalRoot)
    for (const node of placements) {
      const m = meta.get(node.name + '@' + node.version)
      const dest = path.join(root, node.dir)
      if (!isUnder(root, dest)) throw new StepError('placement escapes the root: ' + node.dir)
      ensureDir(path.dirname(dest))
      fs.cpSync(m.dir, dest, { recursive: true, verbatimSymlinks: true })
    }
    linkBins(root, placements, meta)

    const scriptsSkipped = []
    const scriptsRun = []
    for (const node of placements) {
      const { pkg, reviewed } = meta.get(node.name + '@' + node.version)
      const hasScript = SCRIPT_KEYS.some((k) => pkg.scripts?.[k]) || fs.existsSync(path.join(root, node.dir, 'binding.gyp'))
      if (!hasScript) continue
      if (!reviewed) { scriptsSkipped.push(node.name + '@' + node.version); continue }
      await runScript({ root, node })
      scriptsRun.push(node.name + '@' + node.version)
    }
    atomicWriteJson(path.join(root, 'package.json'), {
      name: 'img2-provisioned-root', version: '0.0.0', private: true,
      dependencies: Object.fromEntries(rootDeps.map((d) => [d.name, d.version]).sort()),
    }, 0o644)
    const installed = placements.map((n) => ({ dir: n.dir, name: n.name, version: n.version }))
    atomicWriteJson(path.join(root, '.img2-installed.json'), installed, 0o644)
    return { placements: installed, scriptsSkipped, scriptsRun }
  } finally {
    rmrf(store)
  }
}

function linkBins(root, placements, meta) {
  for (const node of placements) {
    const { pkg } = meta.get(node.name + '@' + node.version)
    let bins = pkg.bin
    if (typeof bins === 'string') bins = { [node.name.split('/').pop()]: bins }
    if (!bins || typeof bins !== 'object') continue
    const pkgDir = path.join(root, node.dir)
    for (const [name, rel] of Object.entries(bins)) {
      if (typeof rel !== 'string' || !/^[A-Za-z0-9@._-]+$/.test(name)) continue
      const target = path.resolve(pkgDir, rel)
      if (!isUnder(pkgDir, target) || !fs.existsSync(target)) continue
      const dir = path.join(nodeModulesOf(root, node.dir), '.bin')
      ensureDir(dir, 0o755)
      const link = path.join(dir, name)
      rmrf(link)
      fs.symlinkSync(path.relative(dir, target), link)
      fs.chmodSync(target, 0o755)
    }
  }
}

// `node_modules/@s/p` and `node_modules/p` both live in `node_modules`.
function nodeModulesOf(root, dir) {
  const parts = dir.split('/')
  const i = parts.lastIndexOf('node_modules')
  return path.join(root, ...parts.slice(0, i + 1))
}
