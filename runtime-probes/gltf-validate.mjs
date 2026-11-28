const P = __PARAMS__
const v = await import("gltf-validator")
const api = v.default ?? v
const bytes = new Uint8Array(Buffer.from(P.b64, "base64"))
const report = await api.validateBytes(bytes)
console.log(JSON.stringify({ errors: report.issues.numErrors, warnings: report.issues.numWarnings, version: report.validatorVersion }))
