// `img2 doctor --runtime`: proves every provisioned piece with bounded probes. Skipped, user-authentication
// and licensed-input conditions are reported apart from runtime failures; only failures make the exit non-zero.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXIT } from './errors.mjs'
import { cleanEnv } from './exec.mjs'
import { assertSupported, loadLocks, detectPlatform, resolveSelection } from './lock.mjs'
import { buildUnits } from './plan.mjs'
import { runProbes } from './probes.mjs'
import { pctxFor, runtimeRootOf, makeProbeCtx } from './provision.mjs'
import { validateSelectorsFile, selectorsPath } from './selectors.mjs'

const KEYCHAIN = { service: 'ai.typesafe.api-key', account: 'jev' }

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

const row = (status, id, dependency, expected, actual, extra = {}) => ({ status, id, dependency, expected, actual, ...extra })

async function jevLogin(deps, platform) {
  if ((deps.env ?? process.env).TYPESAFE_API_KEY?.trim()) return row('auth', 'jev-login', 'jev', 'a TypeSafe API key', 'TYPESAFE_API_KEY is set')
  if (!platform.startsWith('darwin-')) {
    return row('auth', 'jev-login', 'jev', 'a TypeSafe API key', 'Keychain login is unavailable on this platform', { remedy: 'set TYPESAFE_API_KEY, or choose the explicit user-attested no-account mode' })
  }
  const r = await deps.run('/usr/bin/security', ['find-generic-password', '-a', KEYCHAIN.account, '-s', KEYCHAIN.service], { env: cleanEnv(), timeout: 15_000 })
  if (r.code === 0 && !r.error) return row('pass', 'jev-login', 'jev', 'a TypeSafe API key in the macOS Keychain', 'present (value not read)')
  return row('auth', 'jev-login', 'jev', 'a TypeSafe API key in the macOS Keychain', 'no Jev login found', { remedy: 'log in to Jev (img2 jev login); without an account a model decides, explicitly and journalled' })
}

function cs2Vpk(deps, platform) {
  const home = deps.home ?? os.homedir()
  const rel = 'steamapps/common/Counter-Strike Global Offensive/game/csgo/pak01_dir.vpk'
  const roots = platform.startsWith('darwin-') ? [path.join(home, 'Library/Application Support/Steam')]
    : [path.join(home, '.steam/steam'), path.join(home, '.local/share/Steam'), path.join(home, '.steam/root')]
  const hit = roots.map((r) => path.join(r, rel)).find((p) => fs.existsSync(p))
  return hit ? row('pass', 'cs2-vpk', 'cs2', 'a user-supplied CS2 pak01_dir.vpk', hit)
    : row('licensed-input', 'cs2-vpk', 'cs2', 'a user-supplied CS2 pak01_dir.vpk', 'not found under the default Steam roots', { remedy: 'install CS2 through Steam, or pass --vpk to the CS2 tool; img2 never provisions it' })
}

export async function runDoctorRuntime({ home, json = false, deps }) {
  const out = deps.out ?? (() => {})
  const runtimeRoot = runtimeRootOf(home)
  const results = []
  const add = (r) => results.push(r)
  let platform
  let locked
  try {
    platform = assertSupported(deps.platform ?? detectPlatform())
    locked = loadLocks(deps.lockRoot)
  } catch (e) {
    add(row('fail', 'harness', 'harness', 'a supported platform and valid lock files', e.message, { stderr: e.detail }))
    return finish(results, json, out, null)
  }
  const { lock, lockDigest, plugins } = locked
  const summary = readJson(path.join(runtimeRoot, 'provision.json'))
  const selectors = readJson(selectorsPath(runtimeRoot))
  if (!selectors || !summary || summary.status !== 'ok') {
    add(row('fail', 'provision', 'harness', 'a completed `img2 provision`',
      !summary ? 'no provision.json under ' + runtimeRoot : summary.status !== 'ok' ? 'last provision ended ' + summary.status : 'selectors.json is missing',
      { remedy: 'img2 provision' }))
    return finish(results, json, out, null)
  }
  const problems = validateSelectorsFile(runtimeRoot, { lockDigest })
  add(row(problems.length ? 'fail' : 'pass', 'selectors', 'harness', 'selectors.json valid (mode 600, paths inside the runtime tree, matching lock digest)', problems.length ? problems.join('; ') : 'valid', { path: selectorsPath(runtimeRoot), remedy: problems.length ? 'img2 provision' : undefined }))

  let selection
  try {
    selection = resolveSelection({ lock, pluginsLock: plugins, profile: summary.profile ?? 'full', plugins: selectors.selectedPlugins, skip: summary.skipRequested ?? [], platform })
  } catch (e) {
    add(row('fail', 'selection', 'harness', 'the recorded selection resolves against the lock', e.message, { remedy: 'img2 provision' }))
    return finish(results, json, out, null)
  }
  for (const d of selection.skipped) add(row('skipped', 'skipped', d.id, 'installed', d.reason))

  const rtDir = path.join(runtimeRoot, lockDigest.slice(0, 12))
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img2-doctor-'))
  const ctx = makeProbeCtx({ deps, rtDir, tmpDir })
  try {
    for (const unit of buildUnits(selection, lock)) {
      const unitDir = path.join(rtDir, ...unit.name.split('/'))
      if (!fs.existsSync(path.join(unitDir, '.img2-unit.json'))) {
        for (const d of unit.deps) add(row('fail', d.entry.probe, d.id, 'installed under ' + unitDir, 'not installed', { path: unitDir, remedy: 'img2 provision' }))
        continue
      }
      for (const c of await runProbes(pctxFor(ctx, unitDir, selection), unit.deps)) add({ ...c, unit: unit.name })
    }
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }

  if (selection.selectedPlugins.includes('jev')) add(await jevLogin(deps, platform))
  if (selection.selectedPlugins.includes('cs2') && selection.deps.some((d) => d.id === 'cs2-source2viewer-cli' && d.status === 'install')) add(cs2Vpk(deps, platform))
  return finish(results, json, out, { platform, lockDigest, selectedPlugins: selection.selectedPlugins, profile: summary.profile })
}

function finish(results, json, out, meta) {
  const count = (s) => results.filter((r) => r.status === s).length
  const failed = count('fail')
  if (json) {
    out(JSON.stringify({ ok: failed === 0, ...meta, counts: { pass: count('pass'), fail: failed, skipped: count('skipped'), auth: count('auth'), 'licensed-input': count('licensed-input') }, checks: results }, null, 2))
  } else {
    const label = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIP', auth: 'AUTH', 'licensed-input': 'LICENSED-INPUT' }
    for (const r of results) {
      out(label[r.status].padEnd(14) + ' ' + r.id + ' [' + r.dependency + ']')
      if (r.status === 'pass') { out('               ' + r.actual); continue }
      out('               expected: ' + r.expected)
      out('               actual  : ' + r.actual)
      if (r.path) out('               path    : ' + r.path)
      if (r.stderr) for (const l of String(r.stderr).split('\n').slice(-6)) out('               stderr  : ' + l)
      if (r.remedy) out('               remedy  : ' + r.remedy)
    }
    out('')
    out(count('pass') + ' passed, ' + failed + ' failed, ' + count('skipped') + ' skipped, ' + count('auth') + ' need login, ' + count('licensed-input') + ' need a licensed input')
    if (count('auth') || count('licensed-input')) out('(login and licensed-input conditions are not runtime failures)')
  }
  return failed ? EXIT.FAIL : EXIT.OK
}
