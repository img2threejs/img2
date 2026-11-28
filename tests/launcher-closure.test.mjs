// Guards the launcher's static import closure the way the core router's HarnessPin._imports proves it
// (forge/route.py): every tracked bin/ script is plain static ESM, no dynamic loading, imports only
// node: builtins or sibling ./*.mjs files that exist. Regressing any rule makes the router refuse the
// harness with harness-import-closure-unproven.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DYNAMIC = /\b(?:import|require|eval|Function)\s*\(/
const DECLARATION = /^\s*import\b[^\n]*/gm
const FORM = /^\s*import\s+(?:[^;'"\n]+\s+from\s+)?['"]([^'"\n]+)['"]\s*;?\s*$/

function binScripts(dir = 'bin') {
  const out = []
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name
    if (entry.isDirectory()) out.push(...binScripts(rel))
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(rel)
  }
  return out.sort()
}

// Returns the problems the core check would reject for one file's text.
export function closureProblems(relative, text, exists) {
  const problems = []
  if (DYNAMIC.test(text)) problems.push(relative + ': dynamic import()/require()/eval()/Function()')
  for (const declaration of text.match(DECLARATION) ?? []) {
    const match = FORM.exec(declaration)
    if (!match) { problems.push(relative + ': unparsable import declaration: ' + declaration.trim()); continue }
    const specifier = match[1]
    if (specifier.startsWith('node:')) continue
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))
    if (!specifier.startsWith('./') || !target.endsWith('.mjs') || !exists(target)) {
      problems.push(relative + ': import ' + specifier + ' leaves the allowed closure')
    }
  }
  return problems
}

test('every bin/ script is inside the provable static import closure', () => {
  const exists = (rel) => fs.existsSync(path.join(ROOT, rel))
  const problems = binScripts().flatMap((rel) => closureProblems(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'), exists))
  assert.deepEqual(problems, [])
})

test('the closure scan flags each rule it exists to enforce', () => {
  const exists = () => true
  assert.equal(closureProblems('bin/a.mjs', 'const m = await import("x")', exists).length, 1)
  assert.equal(closureProblems('bin/a.mjs', 'const m = require("x")', exists).length, 1)
  assert.equal(closureProblems('bin/a.mjs', 'import { x } from "../locks.mjs"', exists).length, 1)
  assert.equal(closureProblems('bin/a.mjs', 'import { x } from "lodash"', exists).length, 1)
  assert.equal(closureProblems('bin/a.mjs', 'import { x } from "./b.js"', exists).length, 1)
  assert.equal(closureProblems('bin/a.mjs', 'import { x } from "./gone.mjs"', () => false).length, 1)
  assert.equal(closureProblems('bin/a.mjs', 'import {\n  x,\n} from "./b.mjs"', exists).length, 1)
  assert.deepEqual(closureProblems('bin/a.mjs', 'import fs from "node:fs"\nimport { x } from "./b.mjs"\nconst u = import.meta.url', exists), [])
})

test('package.json carries no dependency or import map the core would reject', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@img2threejs/img2')
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'imports']) assert.ok(!pkg[key], key)
  assert.ok(fs.existsSync(path.join(ROOT, 'img2_core/__init__.py')))
  assert.ok(pkg.files.includes('runtime-probes'))
})
