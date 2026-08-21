import os
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest import mock

from img2_core.paths import resolve_img2_home, resolve_workspace


class ResolveImg2HomeTest(unittest.TestCase):
    def test_img2_home_env_wins(self):
        with mock.patch.dict(os.environ, {"IMG2_HOME": "/x/.img2", "IMG2THREEJS_HOME": "/y/legacy"}):
            self.assertEqual(resolve_img2_home(), Path("/x/.img2"))

    def test_legacy_env_honoured_with_deprecation_warning(self):
        env = {k: v for k, v in os.environ.items() if k not in ("IMG2_HOME", "IMG2THREEJS_HOME")}
        env["IMG2THREEJS_HOME"] = "/y/legacy"
        with mock.patch.dict(os.environ, env, clear=True):
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                self.assertEqual(resolve_img2_home(), Path("/y/legacy"))
            self.assertTrue(any(issubclass(w.category, DeprecationWarning) for w in caught))

    def test_default_is_home_dot_img2(self):
        env = {k: v for k, v in os.environ.items() if k not in ("IMG2_HOME", "IMG2THREEJS_HOME")}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(resolve_img2_home(), Path.home() / ".img2")


class ResolveWorkspaceTest(unittest.TestCase):
    def test_explicit_workspace_resolves(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / "img2home").mkdir()
            (root / "project").mkdir()
            with mock.patch.dict(os.environ, {"IMG2_HOME": str(root / "img2home")}):
                self.assertEqual(resolve_workspace(root / "project"), root / "project")

    def test_workspace_inside_img2_home_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            checkout = root / "img2home" / "harness"
            checkout.mkdir(parents=True)
            with mock.patch.dict(os.environ, {"IMG2_HOME": str(root / "img2home")}):
                with self.assertRaises(ValueError):
                    resolve_workspace(checkout)
                with self.assertRaises(ValueError):
                    resolve_workspace(root / "img2home")


if __name__ == "__main__":
    unittest.main()
