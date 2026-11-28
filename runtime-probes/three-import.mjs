import * as T from "three"
import fs from "node:fs"
const v = JSON.parse(fs.readFileSync("node_modules/three/package.json", "utf8")).version
console.log(JSON.stringify({ revision: T.REVISION, version: v, mesh: typeof T.Mesh }))
