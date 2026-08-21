import argparse
import json
import shlex
import subprocess
import sys
from pathlib import Path

KIND_VERDICT = "img2.gate-verdict"
KIND_RUN = "img2.gate-run"
RUN_VERSION = 1
EXPECTED_EXIT = {"pass": 0, "fail": 1, "error": 2}


def load_gates(plugin_dir):
    path = Path(plugin_dir) / "gates.json"
    if not path.exists():
        raise ValueError("no gates.json in %s" % plugin_dir)
    rows = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        raise ValueError("gates.json must be a top-level JSON array of gate rows")
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            raise ValueError("every gate row needs a string 'id'")
        if not isinstance(row.get("command"), str) or not row["command"].strip():
            raise ValueError("gate %r needs a string 'command'" % row["id"])
        if "blocking" in row and not isinstance(row["blocking"], bool):
            raise ValueError("gate %r: 'blocking' must be a boolean" % row["id"])
        after = row.get("after", [])
        if not isinstance(after, list) or any(not isinstance(a, str) for a in after):
            raise ValueError("gate %r: 'after' must be an array of gate ids" % row["id"])
    return rows


def topo_sort(rows):
    ids = {row["id"] for row in rows}
    if len(ids) != len(rows):
        raise ValueError("gates.json declares duplicate gate ids")
    for row in rows:
        for dep in row.get("after", []):
            if dep not in ids:
                raise ValueError("gate %r comes after unknown gate %r" % (row["id"], dep))
    remaining = {row["id"]: set(row.get("after", [])) for row in rows}
    order = []
    while remaining:
        ready = [row for row in rows if row["id"] in remaining and not (remaining[row["id"]] & remaining.keys())]
        if not ready:
            raise ValueError("gates.json has a dependency cycle among: %s" % ", ".join(sorted(remaining)))
        for row in ready:
            order.append(row)
            del remaining[row["id"]]
    return order


def parse_verdict(stdout):
    try:
        doc = json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        return "error", ["stdout is not a single JSON verdict envelope"], None
    if not isinstance(doc, dict) or doc.get("kind") != KIND_VERDICT:
        return "error", ["stdout JSON is not an %s envelope" % KIND_VERDICT], None
    if doc.get("version") != 1:
        return "error", ["verdict envelope version %r is not 1" % doc.get("version")], None
    status = doc.get("status")
    if status not in EXPECTED_EXIT:
        return "error", ["verdict status %r is not pass|fail|error" % status], None
    reasons = doc.get("reasons")
    if not isinstance(reasons, list):
        reasons = []
    if status != "pass" and not reasons:
        reasons = ["gate reported %s with no reasons" % status]
    return status, reasons, doc


def run_gates(plugin_dir, workspace):
    plugin_dir = str(Path(plugin_dir).resolve())
    workspace = str(Path(workspace).resolve())
    ordered = topo_sort(load_gates(plugin_dir))
    results = []
    stopped = False
    for row in ordered:
        blocking = bool(row.get("blocking", True))
        if stopped:
            results.append({
                "gate": row["id"],
                "status": "skipped",
                "blocking": blocking,
                "reasons": ["not run: an earlier blocking gate did not pass"],
            })
            continue
        argv = [
            token.replace("{workspace}", workspace).replace("{plugin_dir}", plugin_dir)
            for token in shlex.split(row["command"])
        ]
        try:
            proc = subprocess.run(argv, cwd=workspace, capture_output=True, text=True)
        except (FileNotFoundError, PermissionError) as err:
            results.append({
                "gate": row["id"],
                "status": "error",
                "blocking": blocking,
                "exitCode": None,
                "reasons": ["could not spawn gate command: %s" % err],
            })
            if blocking:
                stopped = True
            continue
        status, reasons, envelope = parse_verdict(proc.stdout)
        if envelope is not None and proc.returncode != EXPECTED_EXIT[status]:
            reasons = [
                "exit code %d is inconsistent with status %r (contract expects %d)"
                % (proc.returncode, status, EXPECTED_EXIT[status])
            ] + list(reasons)
            status = "error"
        result = {
            "gate": row["id"],
            "status": status,
            "blocking": blocking,
            "exitCode": proc.returncode,
            "reasons": reasons,
        }
        if envelope is not None:
            result["envelope"] = envelope
        if status == "error" and proc.stderr.strip():
            result["stderr"] = proc.stderr[-2000:]
        results.append(result)
        if blocking and status != "pass":
            stopped = True
    return {"kind": KIND_RUN, "version": RUN_VERSION, "results": results, "stopped": stopped}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python3 -m img2_core.gate_runner")
    parser.add_argument("--plugin-dir", required=True)
    parser.add_argument("--workspace", required=True)
    args = parser.parse_args(argv)
    try:
        aggregate = run_gates(args.plugin_dir, args.workspace)
    except (ValueError, json.JSONDecodeError) as err:
        print(json.dumps({
            "kind": KIND_RUN,
            "version": RUN_VERSION,
            "results": [],
            "stopped": True,
            "error": str(err),
        }, indent=2))
        return 2
    print(json.dumps(aggregate, indent=2))
    return 1 if aggregate["stopped"] else 0


if __name__ == "__main__":
    sys.exit(main())
