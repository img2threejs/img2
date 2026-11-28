// Common identity/platform/TLS environment. Credentials are opt-in only for the core/Jev caller.
const PASS = new Set([
  'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TMPDIR', 'TZ', 'NO_COLOR', 'PATH',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
])

export function childEnv(base, { credentials = false } = {}) {
  const env = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && (PASS.has(key) || /^LC_[A-Z_]+$/.test(key) || (credentials && key === 'TYPESAFE_API_KEY'))) env[key] = value
  }
  return env
}
