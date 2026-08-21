CORE_API_VERSION = 1


def require_core_api(n):
    if n != CORE_API_VERSION:
        raise RuntimeError(
            "img2 core API mismatch: caller requires coreApi %r, this harness provides coreApi %d "
            "- update the harness (`img2 install`) or the plugin (`img2 add ... --force`)"
            % (n, CORE_API_VERSION)
        )
