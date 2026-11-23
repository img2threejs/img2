const P = __PARAMS__
;(async () => {
  const pw = require(P.mod)
  const t = pw[P.type]
  const b = P.chromium
    ? await t.launch({ headless: true, ...(P.channel ? { channel: P.channel } : {}), args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] })
    : await t.launch({ headless: true })
  const p = await b.newPage()
  await p.goto("data:text/html,<title>img2-runtime-probe</title>")
  const title = await p.title()
  let r = {}
  if (P.chromium) {
    await p.setContent("<canvas id=c width=16 height=16></canvas>")
    r = await p.evaluate(() => {
      const gl = c.getContext("webgl2") || c.getContext("webgl")
      if (!gl) return { error: "no WebGL context" }
      gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT)
      const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      return { gl: gl.getParameter(gl.VERSION), px: Array.from(px) }
    })
  }
  const version = b.version()
  await b.close()
  console.log(JSON.stringify({ version, title, ...r }))
})().catch((e) => { console.error(String(e && e.stack || e).slice(0, 1500)); process.exit(1) })
