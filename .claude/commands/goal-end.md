---
description: End the current goal now so the Stop hook stops reminding
argument-hint: [reason]
---
End the active goal for this session by running:

```bash
python3 .claude/hooks/goal.py done "$ARGUMENTS"
```

Use "ended by the user" as the reason if none was given. Then report the command's output in one line.
