const P = __PARAMS__
const { build, version } = await import("vite")
await build({ root: P.root, logLevel: "silent", configFile: false, build: { outDir: P.out, emptyOutDir: true } })
const fs = await import("node:fs")
const files = fs.readdirSync(P.assets)
console.log(JSON.stringify({ vite: version, assets: files }))
