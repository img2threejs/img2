import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildArchitectureDoc } from '../docs/build-plugin-architecture.mjs'

// docs/PLUGIN_ARCHITECTURE.md is a generated single-page build of docs/plugin-wiki/ -- there is no
// build step that runs automatically, so nothing else catches a hand-edit to one side drifting from
// the other. This is the "dump == mount" check task 6.7 asks for, the same idiom `img2 sync --check`
// already applies to a plugin's generated artifacts (bin/img2.mjs's computeGenerated/syncTargets).
test('PLUGIN_ARCHITECTURE.md matches a fresh build from docs/plugin-wiki/', () => {
  const committed = fs.readFileSync(fileURLToPath(new URL('../docs/PLUGIN_ARCHITECTURE.md', import.meta.url)), 'utf8')
  const fresh = buildArchitectureDoc()
  assert.equal(
    committed,
    fresh,
    'docs/PLUGIN_ARCHITECTURE.md is stale -- run `node docs/build-plugin-architecture.mjs` after editing docs/plugin-wiki/',
  )
})
