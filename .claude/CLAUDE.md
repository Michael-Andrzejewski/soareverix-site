# Goal loops

A Stop hook (`.claude/hooks/goal_limit.py`) caps the built-in `/goal`: after 3 forced
continuations in a row it ends the turn. If a `/goal` condition is met, or cannot be met
without the user's decision, end the loop yourself instead of waiting it out:

    python3 .claude/hooks/goal_limit.py release "<what was done, or what the user must decide>"

Then finish your turn and tell the user they can run `/goal clear`.
