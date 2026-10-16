#!/usr/bin/env python3
"""goal_limit.py: let the built-in /goal (or any Stop hook) keep Claude going at most N times.

/goal keeps Claude working by blocking each stop until its condition holds. If the
condition can never hold, it blocks forever. This Stop hook caps that loop.

As a Stop hook (registered in .claude/settings.json):
    goal_limit.py hook
  Every Stop event carries stop_hook_active: true when Claude is only still running
  because a Stop hook blocked the previous stop. This hook counts those forced
  continuations in a row; when another hook has forced MAX of them (default 3, or
  GOAL_HOOK_MAX), it answers {"continue": false}, which overrides every block, so the
  turn ends. A stop that was not forced resets the count. The goal itself stays set;
  run /goal clear to remove it.

As a command (for Claude, when the goal is met or cannot be met without the user):
    goal_limit.py release ["why"]   end the goal loop at the next stop, whatever /goal says
    goal_limit.py status            show the count for this session

State lives in ~/.claude/goal-limit/<session>.json (session from the hook input, or
CLAUDE_CODE_SESSION_ID for commands), so it works locally and in cloud sessions.
"""
import json
import os
import sys
import time
from pathlib import Path

MAX = int(os.environ.get("GOAL_HOOK_MAX", "3"))
STATE_DIR = Path(os.environ.get("GOAL_LIMIT_DIR", Path.home() / ".claude" / "goal-limit"))


def path(session):
    safe = "".join(c for c in (session or "default") if c.isalnum() or c in "-_") or "default"
    return STATE_DIR / f"{safe}.json"


def load(session):
    try:
        return json.loads(path(session).read_text())
    except (OSError, ValueError):
        return {"count": 0}


def save(session, st):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path(session).with_suffix(".tmp")
    tmp.write_text(json.dumps(st))
    tmp.replace(path(session))


def hook():
    try:
        ev = json.load(sys.stdin)
    except ValueError:
        ev = {}
    session = ev.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID") or "default"
    st = load(session)
    out = None
    if st.get("release"):
        why = st.get("reason") or "goal met or needs the user"
        out = {"continue": False, "stopReason": f"Goal loop released by Claude: {why}. Run /goal clear to remove the goal."}
        st.update(count=0, release=False, reason="")
    elif not ev.get("stop_hook_active"):
        st["count"] = 0
    else:
        st["count"] = st.get("count", 0) + 1
        if st["count"] >= MAX:
            out = {"continue": False,
                   "stopReason": f"Stopped after {MAX} goal reminders in a row. Run /goal clear to remove the goal."}
            st["count"] = 0
    st["updated"] = time.time()
    save(session, st)
    if out:
        print(json.dumps(out))
    return 0


def main(argv):
    cmd = argv[0] if argv else "help"
    if cmd == "hook":
        return hook()
    session = os.environ.get("CLAUDE_CODE_SESSION_ID") or "default"
    if cmd == "release":
        st = load(session)
        st.update(release=True, reason=" ".join(argv[1:]).strip())
        save(session, st)
        print(f"The goal loop ends at the next stop (session {session}). The user can run /goal clear to remove the goal.")
        return 0
    if cmd == "status":
        st = load(session)
        print(f"session {session}: {st.get('count', 0)} forced continuation(s) in a row of {MAX} allowed"
              + ("; release pending" if st.get("release") else ""))
        return 0
    print(__doc__.strip())
    return 0 if cmd in ("help", "-h", "--help") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
