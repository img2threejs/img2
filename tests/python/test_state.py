import json
import os
import subprocess
import sys
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
    update_plugin_state,
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


INCREMENT_WORKER = """\
import sys
sys.path.insert(0, sys.argv[2])
from img2_core.state import update_plugin_state

def bump(subtree):
    subtree["n"] = subtree.get("n", 0) + 1

for _ in range(20):
    update_plugin_state(sys.argv[1], "counter", bump)
"""


class UpdatePluginStateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name).resolve()
        self.addCleanup(self._tmp.cleanup)

    def test_mutation_in_place_is_saved(self):
        update_plugin_state(self.workspace, "p", lambda sub: sub.update({"x": 1}))
        self.assertEqual(load_state(self.workspace)["plugins"]["p"], {"x": 1})
        self.assertFalse((self.workspace / ".img2" / ".lock").exists())

    def test_returned_dict_replaces_subtree(self):
        update_plugin_state(self.workspace, "p", lambda sub: sub.update({"x": 1, "y": 2}))
        update_plugin_state(self.workspace, "p", lambda sub: {"x": sub["x"] + 1})
        self.assertEqual(load_state(self.workspace)["plugins"]["p"], {"x": 2})

    def test_non_dict_return_is_refused(self):
        with self.assertRaises(RuntimeError):
            update_plugin_state(self.workspace, "p", lambda sub: 7)
        self.assertFalse((self.workspace / ".img2" / ".lock").exists())

    def test_only_named_subtree_changes(self):
        update_plugin_state(self.workspace, "other", lambda sub: sub.update({"keep": True}))
        update_plugin_state(self.workspace, "p", lambda sub: sub.update({"x": 1}))
        self.assertEqual(load_state(self.workspace)["plugins"]["other"], {"keep": True})

    def test_lock_released_when_fn_raises(self):
        with self.assertRaises(ValueError):
            update_plugin_state(self.workspace, "p", lambda sub: (_ for _ in ()).throw(ValueError("boom")))
        self.assertFalse((self.workspace / ".img2" / ".lock").exists())

    def test_fresh_foreign_lock_raises_after_timeout(self):
        lock = self.workspace / ".img2" / ".lock"
        lock.parent.mkdir(parents=True)
        lock.write_text(json.dumps({"pid": 1}))
        with self.assertRaises(LockHeldError):
            update_plugin_state(self.workspace, "p", lambda sub: sub.update({"x": 1}), timeout=0.1)

    def test_concurrent_increments_are_not_lost(self):
        # update_plugin_state holds the workspace lock across the whole
        # read-modify-write and, on contention, retries acquisition until a
        # deadline (blocking acquire) rather than failing on the first
        # LockHeldError -- so two writers serialize and no increment is lost.
        core_root = str(Path(__file__).resolve().parents[2])
        procs = [
            subprocess.Popen(
                [sys.executable, "-c", INCREMENT_WORKER, str(self.workspace), core_root],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            for _ in range(2)
        ]
        for proc in procs:
            _, stderr = proc.communicate(timeout=120)
            self.assertEqual(proc.returncode, 0, stderr.decode())
        self.assertEqual(load_state(self.workspace)["plugins"]["counter"]["n"], 40)


if __name__ == "__main__":
    unittest.main()
