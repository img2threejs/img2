import json
import os
import time
from contextlib import contextmanager
from pathlib import Path

STATE_VERSION = 1
LOCK_STALE_SECONDS = 60 * 60
UPDATE_LOCK_TIMEOUT_SECONDS = 30
UPDATE_LOCK_RETRY_SECONDS = 0.02


class LockHeldError(RuntimeError):
    pass


def _state_dir(workspace):
    return Path(workspace) / ".img2"


def _state_path(workspace):
    return _state_dir(workspace) / "state.json"


def _lock_path(workspace):
    return _state_dir(workspace) / ".lock"


@contextmanager
def workspace_lock(workspace):
    lock = _lock_path(workspace)
    lock.parent.mkdir(parents=True, exist_ok=True)
    fd = None
    for _ in range(3):
        try:
            fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            break
        except FileExistsError:
            try:
                age = time.time() - lock.stat().st_mtime
            except FileNotFoundError:
                continue
            if age < LOCK_STALE_SECONDS:
                raise LockHeldError(
                    "another img2 run holds %s (age %ds); remove the file if that run is dead"
                    % (lock, int(age))
                )
            lock.unlink(missing_ok=True)
    if fd is None:
        raise LockHeldError("could not acquire %s" % lock)
    try:
        os.write(fd, json.dumps({"pid": os.getpid(), "at": time.time()}).encode())
        os.close(fd)
        yield
    finally:
        lock.unlink(missing_ok=True)


def fresh_state(workspace):
    return {
        "version": STATE_VERSION,
        "workspace": str(Path(workspace).resolve()),
        "plugins": {},
    }


def load_state(workspace):
    path = _state_path(workspace)
    if not path.exists():
        return fresh_state(workspace)
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("version") != STATE_VERSION:
        raise RuntimeError(
            "state envelope %s has version %r; this core reads version %d"
            % (path, data.get("version") if isinstance(data, dict) else None, STATE_VERSION)
        )
    if not isinstance(data.get("plugins"), dict):
        raise RuntimeError("state envelope %s is malformed: 'plugins' must be an object" % path)
    return data


def _write_state(workspace, state):
    if not isinstance(state, dict) or state.get("version") != STATE_VERSION:
        raise RuntimeError(
            "refusing to save a state envelope whose version is not %d" % STATE_VERSION
        )
    if not isinstance(state.get("plugins"), dict):
        raise RuntimeError("refusing to save a state envelope without a 'plugins' object")
    state["workspace"] = str(Path(workspace).resolve())
    path = _state_path(workspace)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return state


def save_state(workspace, state):
    with workspace_lock(workspace):
        return _write_state(workspace, state)


def plugin_state(state, plugin_id):
    return state.setdefault("plugins", {}).setdefault(plugin_id, {})


def update_plugin_state(workspace, plugin_id, fn, timeout=UPDATE_LOCK_TIMEOUT_SECONDS):
    deadline = time.monotonic() + timeout
    while True:
        try:
            with workspace_lock(workspace):
                state = load_state(workspace)
                subtree = plugin_state(state, plugin_id)
                replacement = fn(subtree)
                if replacement is not None:
                    if not isinstance(replacement, dict):
                        raise RuntimeError(
                            "update_plugin_state fn must mutate the subtree or return a dict, got %r"
                            % type(replacement).__name__
                        )
                    state["plugins"][plugin_id] = replacement
                return _write_state(workspace, state)
        except LockHeldError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(UPDATE_LOCK_RETRY_SECONDS)
