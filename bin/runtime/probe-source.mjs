// Node probe programs live as data under runtime-probes/ and are handed to the provisioned node as `-e`
// text. Keeping them out of bin/ keeps the launcher's static import closure free of dynamic loading.
import fs from 'node:fs'

const DIR = new URL('../../runtime-probes/', import.meta.url)

// Returns the program text with its __PARAMS__ placeholder replaced by the JSON of `params`.
export function probeSource(name, params) {
  const text = fs.readFileSync(new URL(name, DIR), 'utf8')
  return params === undefined ? text : text.replace('__PARAMS__', () => JSON.stringify(params))
}
