#!/usr/bin/env python3
"""goal.py: a goal Claude keeps working toward, with a hard limit on reminders.

As a Stop hook (registered in .claude/settings.json):
    goal.py hook          reads the Stop event on stdin. With an active goal it blocks
                          the stop and reminds Claude of the goal, at most `max` times
                          (default 3). The next stop is allowed and the goal expires.

As a command (Claude or you):
    goal.py set [--max N] "text"      start a goal for this session (text may come on stdin)
    goal.py done ["why"]              end the goal now: met, or needs the user's decision
    goal.py status                    show the goal, reminders used, and state
    goal.py clear                     forget the goal without marking it done

Goals are per session (CLAUDE_CODE_SESSION_ID in commands, session_id in hook input),
stored in ~/.claude/goals/<session>.json, so they work locally and in cloud sessions.
"""
import json
import os
import sys
import time
from pathlib import Path

DEFAULT_MAX = 3
STATE_DIR = Path(os.environ.get("CLAUDE_GOAL_DIR", Path.home() / ".claude" / "goals"))
SCRIPT = Path(__file__).resolve()
# Two copies of the hook firing for one stop (e.g. registered by two repos) count once.
DEDUP_SECONDS = float(os.environ.get("CLAUDE_GOAL_DEDUP_SECONDS", "1.5"))


def state_path(session):
    safe = "".join(c for c in (session or "default") if c.isalnum() or c in "-_") or "default"
    return STATE_DIR / f"{safe}.json"


def load(session):
    p = state_path(session)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except (OSError, ValueError):
            return None
    return None


def save(session, st):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    p = state_path(session)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, indent=1))
    tmp.replace(p)


def env_session():
    return os.environ.get("CLAUDE_CODE_SESSION_ID") or "default"


def reminder_text(st):
    n, m = st["reminders"], st["max"]
    left = m - n
    lines = [
        f"GOAL (reminder {n} of {m}): {st['goal']}",
        "",
        "Keep working toward this goal before ending your turn.",
        "When it is fully met, or it cannot be met without the user's decision, end it with:",
        f'  python3 "{SCRIPT}" done "<one line: what was done or what is blocking>"',
        "then finish your turn.",
    ]
    lines.append(f"If you stop again without ending it, {left} more reminder(s) will follow; after that the goal expires."
                 if left else "This is the last reminder: the next stop is allowed and the goal expires.")
    return "\n".join(lines)


# ------------------------------------------------------------------ hook
def run_hook():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        event = {}
    session = event.get("session_id") or env_session()
    st = load(session)
    if not st or st.get("status") != "active":
        return 0
    now = time.time()
    last = st.get("last_event") or {}
    if now - last.get("t", 0) < DEDUP_SECONDS and last.get("out"):
        print(json.dumps(last["out"]))  # same stop seen twice: same answer, no extra count
        return 0
    if st["reminders"] >= st["max"]:
        st["status"] = "expired"
        st["ended_at"] = now
        out = {"systemMessage": f"Goal released after {st['max']} reminder(s): {st['goal']}"}
    else:
        st["reminders"] += 1
        out = {"decision": "block", "reason": reminder_text(st)}
    st["last_event"] = {"t": now, "out": out}
    save(session, st)
    print(json.dumps(out))
    return 0


# ------------------------------------------------------------------ commands
def cmd_set(args):
    mx = DEFAULT_MAX
    if args[:1] == ["--max"]:
        mx = int(args[1])
        args = args[2:]
    if args[:1] == ["--"]:
        args = args[1:]
    text = " ".join(args).strip() or (sys.stdin.read().strip() if not sys.stdin.isatty() else "")
    if not text:
        print("usage: goal.py set [--max N] \"goal text\"   (or pipe the text on stdin)", file=sys.stderr)
        return 1
    session = env_session()
    save(session, {"goal": text, "max": mx, "reminders": 0, "status": "active",
                   "set_at": time.time(), "session": session})
    print(f"Goal set for session {session} (up to {mx} reminder(s)):\n  {text}")
    print(f'End it with: python3 "{SCRIPT}" done "<why>"')
    return 0


def cmd_done(args, status="done"):
    session = env_session()
    st = load(session)
    if not st:
        print(f"No goal for session {session}.")
        return 0
    was = st.get("status")
    st.update(status=status, ended_at=time.time(), note=" ".join(args).strip())
    save(session, st)
    print(f"Goal {status} (was {was}): {st['goal']}" + (f"\n  note: {st['note']}" if st["note"] else ""))
    return 0


def cmd_status():
    session = env_session()
    st = load(session)
    if not st:
        print(f"No goal for session {session}.")
        return 0
    print(f"Goal [{st['status']}] reminders {st['reminders']}/{st['max']} (session {session}):\n  {st['goal']}")
    if st.get("note"):
        print(f"  note: {st['note']}")
    return 0


def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "hook":
        return run_hook()
    if cmd == "set":
        return cmd_set(rest)
    if cmd in ("done", "end"):
        return cmd_done(rest)
    if cmd == "clear":
        return cmd_done(rest, status="cleared")
    if cmd == "status":
        return cmd_status()
    print(f"unknown command {cmd!r}; try: goal.py help", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
