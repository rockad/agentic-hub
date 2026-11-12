# Case study: choosing models for a multi-stream docs workflow (2026-11-09)

This case study moved. It now lives next to the Jev code it describes, in `rockad/cognitive-engine`, together with a note that maps each finding to the fix that landed:

- [`packages/jev/docs/case-studies/2026-11-09-model-tier-for-multi-stream-workflow.md`](https://github.com/rockad/cognitive-engine/blob/main/packages/jev/docs/case-studies/2026-11-09-model-tier-for-multi-stream-workflow.md)

Why it moved: the advisor port (UserPromptSubmit hook, findings 5.1 to 5.11 except 5.8) and the guard hardening landed in cognitive-engine as `packages/jev` 2.4.0 (PRs #20 and #22, merged 2026-11-12, main at `c260bf5`). The agentic-hub `jev` plugin keeps its own 2.3.x line; the later case study [`2026-11-11-pretooluse-dialog-on-pinned-model.md`](2026-11-11-pretooluse-dialog-on-pinned-model.md) stays here because it describes the 2.3.2 fix in this plugin.

The previous full text is in git history of this file (the last commit before this pointer).
