"""Make ``scripts/fetch_and_score.py`` importable as ``fetch_and_score`` and
expose a helper for loading fixture files."""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


def fixture(name: str) -> str:
    return (FIXTURES_DIR / name).read_text(encoding="utf-8")
