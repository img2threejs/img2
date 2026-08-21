import unittest

from img2_core import CORE_API_VERSION, require_core_api


class RequireCoreApiTest(unittest.TestCase):
    def test_matching_version_passes(self):
        self.assertIsNone(require_core_api(CORE_API_VERSION))

    def test_mismatch_raises_naming_both_versions(self):
        with self.assertRaises(RuntimeError) as ctx:
            require_core_api(2)
        message = str(ctx.exception)
        self.assertIn("2", message)
        self.assertIn(str(CORE_API_VERSION), message)


if __name__ == "__main__":
    unittest.main()
