// Exit codes of `img2 provision` / `img2 doctor --runtime` (contract: 0 ok, 1 failed, 2 refused, 3 declined).
export const EXIT = { OK: 0, FAIL: 1, REFUSED: 2, DECLINED: 3 }

// Refused before any mutation: bad arguments, unsupported platform, weak hash, incomplete cache.
export class Refusal extends Error {
  constructor(message, detail, code = EXIT.REFUSED) {
    super(message)
    this.detail = detail
    this.code = code
  }
}

// A step that ran and failed (hash mismatch, installer exit code, probe failure).
export class StepError extends Error {
  constructor(message, detail, extra = {}) {
    super(message)
    this.detail = detail
    this.extra = extra
  }
}
