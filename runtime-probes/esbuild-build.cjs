const e = require("esbuild")
const r = e.buildSync({ stdin: { contents: "export const x = 1" }, bundle: true, write: false, format: "esm" })
console.log(JSON.stringify({ version: e.version, out: r.outputFiles[0].text.length > 0 }))
