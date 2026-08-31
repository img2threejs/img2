#!/usr/bin/env node
// Regenerates docs/PLUGIN_ARCHITECTURE.md from docs/plugin-wiki/ -- the wiki is the source, this file
// is the single-page build. No generator existed before this; run directly to regenerate after editing
// any wiki page, and tests/wiki-sync.test.mjs asserts the two never drift apart (dump == mount, the
// same idiom `img2 sync --check` already uses for a plugin's generated artifacts).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DOCS_DIR = path.dirname(fileURLToPath(import.meta.url))
export const WIKI_DIR = path.join(DOCS_DIR, 'plugin-wiki')

// Order matters: this is reading order, and it is also join order below.
const PAGES = [
  { file: '01-why.md', anchor: 'why-and-what-changed' },
  { file: '02-how-it-works.md', anchor: 'how-it-works' },
  { file: '03-cookbook.md', anchor: 'cookbook' },
  { file: '04-reference.md', anchor: 'reference' },
]

const BACK_LINK_RE = /^← \[wiki index\]\(README\.md\)\n\n/

// Every page in the wiki is read on its own, one level below where it sits in this single-page build
// (a page's own "# Title" becomes "## Title" here). Fenced code blocks are left untouched -- a shell or
// Python comment that happens to start with "# " inside a ``` block is not a heading.
function demoteHeadings(text) {
  let inFence = false
  return text
    .split('\n')
    .map((line) => {
      if (/^```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (!inFence && /^#{1,6} /.test(line)) return '#' + line
      return line
    })
    .join('\n')
}

// A link to another wiki page (numbered page or README itself) becomes a same-page anchor, since this
// build has only one page. A link carrying its own anchor keeps that anchor, dropping only the
// filename; a bare page link (no anchor) points at that page's own top-level section instead.
function rewriteLinks(text) {
  return text.replace(/\]\((0[1-4]-[a-z-]+\.md|README\.md)(#[a-z0-9-]+)?\)/g, (_match, file, anchor) => {
    if (anchor) return '](' + anchor + ')'
    const page = PAGES.find((p) => p.file === file)
    return '](#' + (page ? page.anchor : file) + ')'
  })
}

function transformPage(raw) {
  return rewriteLinks(demoteHeadings(raw.replace(BACK_LINK_RE, ''))).trim()
}

// The front matter below is this build's own -- it is not derived from any one wiki page (README.md
// keeps its own separate, shorter framing for the multi-page reading experience) -- so it is not
// regenerated from source; it is carried here verbatim and only ever hand-edited.
const FRONT_MATTER = `# img2threejs Plugin Wiki

Why the skill was refactored this way, how it works, how to write a plugin, how to change the
frame's behaviour, and what the frame refuses.

Single-page build of \`docs/plugin-wiki/\` — the wiki is the source, this is generated.`

export function buildArchitectureDoc() {
  const readme = fs.readFileSync(path.join(WIKI_DIR, 'README.md'), 'utf8')
  // README's own title and one-line intro are replaced by this build's own front matter above; the
  // page table onward (the table itself, the "PLUGIN_CONTRACT.md is normative" line, "Start here" and
  // "Quick start") is reused verbatim, transformed like any other section.
  const readmeBody = transformPage(readme.slice(readme.indexOf('| page |')))

  const pageBodies = PAGES.map(({ file }) => transformPage(fs.readFileSync(path.join(WIKI_DIR, file), 'utf8')))

  // No "---" between the front matter and README's own body -- they read as one continuous
  // introduction. A "---" separates README's body from the first page, and each page from the next.
  const intro = [FRONT_MATTER, readmeBody].join('\n\n')
  return [intro, ...pageBodies].join('\n\n---\n\n') + '\n'
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const outPath = path.join(DOCS_DIR, 'PLUGIN_ARCHITECTURE.md')
  fs.writeFileSync(outPath, buildArchitectureDoc())
  console.log('wrote ' + outPath)
}
