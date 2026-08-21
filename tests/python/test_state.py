import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from img2_core.state import (
    STATE_VERSION,
    LockHeldError,
    fresh_state,
    load_state,
    plugin_state,
    save_state,
    workspace_lock,
)


class StateEnvelopeTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name).resolve()
        self.addCleanup(self._tmp.cleanup)

    def test_load_missing_returns_fresh_envelope(self):
        state = load_state(self.workspace)
        self.assertEqual(state["version"], STATE_VERSION)
        self.assertEqual(state["workspace"], str(self.workspace))
        self.assertEqual(state["plugins"], {})

    def test_save_and_load_roundtrip(self):
        state = fresh_state(self.workspace)
        plugin_state(state, "hello-cube")["last_run"] = "gate-1"
        save_state(self.workspace, state)
        loaded = load_state(self.workspace)
        self.assertEqual(loaded["plugins"]["hello-cube"], {"last_run": "gate-1"})
        self.assertEqual(loaded["workspace"], str(self.workspace))
        self.assertFalse((self.workspace / ".img2" / ".lock").exists())

    def test_plugin_state_scopes_to_own_subtree(self):
        state = fresh_state(self.workspace)
        plugin_state(state, "a")["x"] = 1
        plugin_state(state, "b")["y"] = 2
        self.assertEqual(state["plugins"], {"a": {"x": 1}, "b": {"y": 2}})
        self.assertEqual(plugin_state(state, "a"), {"x": 1})

    def test_load_refuses_future_version(self):
        state_dir = self.workspace / ".img2"
        state_dir.mkdir()
        (state_dir / "state.json").write_text(json.dumps({"version": 2, "plugins": {}}))
        with self.assertRaises(RuntimeError) as ctx:
            load_state(self.workspace)
        self.assertIn("version", str(ctx.exception))

    def test_save_refuses_wrong_envelope(self):
        with self.assertRaises(RuntimeError):
            save_state(self.workspace, {"version": 2, "plugins": {}})
        with self.assertRaises(RuntimeError):
            save_state(self.workspace, {"version": STATE_VERSION, "plugins": []})


class LockTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name).resolve()
        self.lock = self.workspace / ".img2" / ".lock"
        self.addCleanup(self._tmp.cleanup)

    def test_fresh_lock_blocks_save(self):
        self.lock.parent.mkdir(parents=True)
        self.lock.write_text(json.dumps({"pid": 1}))
        with self.assertRaises(LockHeldError):
            save_state(self.workspace, fresh_state(self.workspace))

    def test_stale_lock_is_broken(self):
        self.lock.parent.mkdir(parents=True)
        self.lock.write_text(json.dumps({"pid": 1}))
        stale = time.time() - 2 * 60 * 60
        os.utime(self.lock, (stale, stale))
        save_state(self.workspace, fresh_state(self.workspace))
        self.assertTrue((self.workspace / ".img2" / "state.json").exists())
        self.assertFalse(self.lock.exists())

    def test_lock_is_released_on_exit(self):
        with workspace_lock(self.workspace):
            self.assertTrue(self.lock.exists())
        self.assertFalse(self.lock.exists())

    def test_lock_is_released_on_error(self):
        with self.assertRaises(RuntimeError):
            with workspace_lock(self.workspace):
                raise RuntimeError("boom")
        self.assertFalse(self.lock.exists())


if __name__ == "__main__":
    unittest.main()
