import os
import warnings
from pathlib import Path


def resolve_img2_home():
    raw = os.environ.get("IMG2_HOME")
    if raw:
        return Path(raw).expanduser()
    legacy = os.environ.get("IMG2THREEJS_HOME")
    if legacy:
        warnings.warn(
            "IMG2THREEJS_HOME is deprecated; set IMG2_HOME instead",
            DeprecationWarning,
            stacklevel=2,
        )
        return Path(legacy).expanduser()
    return Path.home() / ".img2"


def resolve_workspace(arg=None):
    workspace = Path(arg).expanduser().resolve() if arg else Path.cwd().resolve()
    root = resolve_img2_home().resolve()
    if workspace == root or root in workspace.parents:
        raise ValueError(
            "workspace %s is inside the img2 home %s; tools take --workspace pointing at "
            "the user's project directory, never a checkout" % (workspace, root)
        )
    return workspace
