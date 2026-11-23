const P = __PARAMS__
const fs = require("node:fs")
const v = JSON.parse(fs.readFileSync("node_modules/" + P.name + "/package.json", "utf8")).version
if (P.name === "playwright") require("playwright")
console.log(JSON.stringify({ version: v }))
