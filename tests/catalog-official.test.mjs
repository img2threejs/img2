import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { getCatalog } from '../bin/catalog.mjs'

const APPROVED = ['character', 'cs2', 'interior', 'jev', 'pixi2d']
const PENDING = []

const text = fs.readFileSync(new URL('../catalog.json', import.meta.url), 'utf8')
const catalog = () => getCatalog({ fetchImpl: async () => new Response(text, { status: 200 }) })

test('official catalog validates and lists only approved plugins', async () => {
  const r = await catalog()
  assert.equal(r.status, 'ok')
  const ids = r.plugins.map(p => p.id)
  assert.deepEqual(ids.filter(id => !APPROVED.includes(id)), [], 'unapproved plugin id in catalog.json')
  assert.deepEqual(ids, APPROVED.filter(id => !PENDING.includes(id)).sort())
  assert.equal(r.counts.total, ids.length)
})

test('official catalog sources follow the plugin-<id> repository convention', async () => {
  for (const p of (await catalog()).plugins) assert.equal(p.source, 'img2threejs/plugin-' + p.id)
})
