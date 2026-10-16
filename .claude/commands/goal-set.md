---
description: Give Claude a goal to finish; a Stop hook reminds it at most 3 times, then lets it stop
argument-hint: [--max N] <goal>
---
Register this goal for the current session, then work on it until it is met:

$ARGUMENTS

Register it with this repository's `.claude/hooks/goal.py`, passing the goal text on stdin so quotes in it are safe. If the arguments start with `--max N`, pass `--max N` to `set` and leave it out of the text:

```bash
python3 .claude/hooks/goal.py set <<'GOAL'
<goal text>
GOAL
```

Then work toward the goal. Each time you stop while it is active, the Stop hook blocks the stop and repeats the goal, at most 3 times (or N); the next stop is allowed and the goal expires. When the goal is met, or it cannot be met without the user's decision, end it with `python3 .claude/hooks/goal.py done "<one line: what was done or what is blocking>"` and finish your turn.
