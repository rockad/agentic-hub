---
description: Run clarify in Explain-Like-I'm-Five mode (Mode B with everyday analogies). Same as /clarify --eli5.
argument-hint: "[design target]"
disable-model-invocation: true
---

Invoke the `clarify` skill now and run it in **Mode B: Plain English & Intuitive Mode** with the ELI5 framing, exactly as if the user had typed `/clarify --eli5`. Treat `$ARGUMENTS` as the design target; if it is empty, resolve the target with the skill's cascade.

Do not re-implement the clarify protocol here; the skill owns it.
