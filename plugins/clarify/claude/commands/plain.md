---
description: Run clarify in Plain English mode (Mode B): everyday analogies, no jargon. Same as /clarify --plain.
argument-hint: "[design target]"
disable-model-invocation: true
---

Invoke the `clarify` skill now and run it in **Mode B: Plain English & Intuitive Mode**, exactly as if the user had typed `/clarify --plain`. Treat `$ARGUMENTS` as the design target; if it is empty, resolve the target with the skill's cascade.

Do not re-implement the clarify protocol here; the skill owns it.
