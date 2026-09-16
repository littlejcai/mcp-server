import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def pytest_sessionfinish(session, exitstatus):
    """Force-exit when fastmcp/TestClient leave lingering non-daemon threads.

    The suite is green by this point; fastmcp's in-memory transport and the
    starlette TestClient portal occasionally keep a non-daemon thread alive
    on Windows, which would hang pytest after a passing run.
    """
    import os
    import threading

    leftover = [
        t.name
        for t in threading.enumerate()
        if t is not threading.main_thread() and not t.daemon and t.is_alive()
    ]
    if leftover:
        print(f"\n[conftest] forcing exit; lingering threads: {leftover}", flush=True)
        os._exit(0 if exitstatus in (0, None) else int(exitstatus))
