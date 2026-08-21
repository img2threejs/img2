import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from img2_core.gate_runner import topo_sort

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON = sys.executable if " " not in sys.executable else "python3"

PASS_GATE = """import json, os, sys
ok = len(sys.argv) > 1 and os.path.realpath(sys.argv[1]) == os.path.realpath(os.getcwd())
status = "pass" if ok else "fail"
print(json.dumps({"kind": "img2.gate-verdict", "version": 1, "gate": "%s", "plugin": "fixture",
                  "status": status, "reasons": [] if ok else ["workspace mismatch"], "evidence": {}}))
sys.exit(0 if ok else 1)
"""

FAIL_GATE = """import json, sys
print(json.dumps({"kind": "img2.gate-verdict", "version": 1, "gate": "%s", "plugin": "fixture",
                  "status": "fail", "reasons": ["deliberate failure"], "evidence": {}}))
sys.exit(1)
"""

MALFORMED_GATE = """print("gate %s prints no verdict envelope")
"""

LYING_GATE = """import json, sys
print(json.dumps({"kind": "img2.gate-verdict", "version": 1, "gate": "%s", "plugin": "fixture",
                  "status": "pass", "reasons": [], "evidence": {}}))
sys.exit(1)
"""


class GateRunnerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name).resolve()
        self.plugin_dir = root / "plugin"
        self.workspace = root / "workspace"
        (self.plugin_dir / "tools").mkdir(parents=True)
        self.workspace.mkdir()
        self.addCleanup(self._tmp.cleanup)

    def write_gate(self, name, body):
        (self.plugin_dir / "tools" / (name + ".py")).write_text(body % name)

    def write_gates_json(self, rows):
        (self.plugin_dir / "gates.json").write_text(json.dumps(rows))

    def gate_row(self, gate_id, blocking=True, after=()):
        return {
            "id": gate_id,
            "command": PYTHON + " {plugin_dir}/tools/" + gate_id + ".py {workspace}",
            "blocking": blocking,
            "after": list(after),
        }

    def run_runner(self):
        proc = subprocess.run(
            [sys.executable, "-m", "img2_core.gate_runner",
             "--plugin-dir", str(self.plugin_dir), "--workspace", str(self.workspace)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        aggregate = json.loads(proc.stdout)
        self.assertEqual(aggregate["kind"], "img2.gate-run")
        self.assertEqual(aggregate["version"], 1)
        return proc.returncode, aggregate

    def test_all_passing_gates_exit_zero(self):
        self.write_gate("g1", PASS_GATE)
        self.write_gate("g2", PASS_GATE)
        self.write_gates_json([self.gate_row("g2", after=["g1"]), self.gate_row("g1")])
        code, aggregate = self.run_runner()
        self.assertEqual(code, 0)
        self.assertFalse(aggregate["stopped"])
        self.assertEqual([r["gate"] for r in aggregate["results"]], ["g1", "g2"])
        self.assertEqual({r["status"] for r in aggregate["results"]}, {"pass"})

    def test_blocking_fail_stops_the_run_and_skips_later_gates(self):
        self.write_gate("g1", PASS_GATE)
        self.write_gate("g2", FAIL_GATE)
        self.write_gate("g3", PASS_GATE)
        self.write_gates_json([
            self.gate_row("g1"),
            self.gate_row("g2", after=["g1"]),
            self.gate_row("g3", after=["g2"]),
        ])
        code, aggregate = self.run_runner()
        self.assertEqual(code, 1)
        self.assertTrue(aggregate["stopped"])
        statuses = {r["gate"]: r["status"] for r in aggregate["results"]}
        self.assertEqual(statuses, {"g1": "pass", "g2": "fail", "g3": "skipped"})
        self.assertEqual(aggregate["results"][1]["reasons"], ["deliberate failure"])

    def test_non_blocking_fail_does_not_stop_the_run(self):
        self.write_gate("g1", FAIL_GATE)
        self.write_gate("g2", PASS_GATE)
        self.write_gates_json([self.gate_row("g1", blocking=False), self.gate_row("g2", after=["g1"])])
        code, aggregate = self.run_runner()
        self.assertEqual(code, 0)
        self.assertFalse(aggregate["stopped"])
        self.assertEqual([r["status"] for r in aggregate["results"]], ["fail", "pass"])

    def test_malformed_envelope_is_an_error(self):
        self.write_gate("g1", MALFORMED_GATE)
        self.write_gates_json([self.gate_row("g1")])
        code, aggregate = self.run_runner()
        self.assertEqual(code, 1)
        self.assertEqual(aggregate["results"][0]["status"], "error")
        self.assertTrue(aggregate["stopped"])

    def test_exit_code_inconsistent_with_status_is_an_error(self):
        self.write_gate("g1", LYING_GATE)
        self.write_gates_json([self.gate_row("g1")])
        code, aggregate = self.run_runner()
        self.assertEqual(code, 1)
        self.assertEqual(aggregate["results"][0]["status"], "error")
        self.assertIn("inconsistent", aggregate["results"][0]["reasons"][0])

    def test_malformed_gates_json_exits_two(self):
        (self.plugin_dir / "gates.json").write_text(json.dumps({"gates": []}))
        code, aggregate = self.run_runner()
        self.assertEqual(code, 2)
        self.assertTrue(aggregate["stopped"])
        self.assertIn("top-level JSON array", aggregate["error"])


class TopoSortTest(unittest.TestCase):
    def test_orders_by_after(self):
        rows = [
            {"id": "c", "command": "x", "after": ["b"]},
            {"id": "a", "command": "x", "after": []},
            {"id": "b", "command": "x", "after": ["a"]},
        ]
        self.assertEqual([r["id"] for r in topo_sort(rows)], ["a", "b", "c"])

    def test_unknown_reference_raises(self):
        with self.assertRaises(ValueError) as ctx:
            topo_sort([{"id": "a", "command": "x", "after": ["ghost"]}])
        self.assertIn("ghost", str(ctx.exception))

    def test_cycle_raises(self):
        rows = [
            {"id": "a", "command": "x", "after": ["b"]},
            {"id": "b", "command": "x", "after": ["a"]},
        ]
        with self.assertRaises(ValueError) as ctx:
            topo_sort(rows)
        self.assertIn("cycle", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
