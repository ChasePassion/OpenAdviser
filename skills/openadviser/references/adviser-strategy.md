# OpenAdviser Strategy Notes

Source inspiration:

- https://claude.com/blog/the-advisor-strategy
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
- Context engineering principle: the model's answer depends on what relevant instructions, facts, examples, and constraints are placed in context. For this local skill, context quality is the main product surface.

Local implementation:

- Use the `openadviser` CLI and Chrome extension as an agent-to-web-provider bridge.
- Default provider is ChatGPT Web; Grok can be selected with `--provider grok`.
- The calling model writes a compact-style decision brief manually.
- Do not read rollout JSONL, session state, or encrypted reasoning.
- Return adviser output through stdout; do not rely on clipboard.

Operational pattern:

1. Pause before a high-impact decision, difficult debugging step, architecture choice, or research-heavy answer.
2. Write the relevant context using the compact handoff sections, but frame it as a decision brief: facts, evidence, assumptions, constraints, decisions, unknowns, and the exact judgment needed.
3. Ask the selected web AI provider a focused question with that context.
4. Inspect the answer.
5. Continue locally with the final decision.

Method notes:

- Anthropic's advisor tool works because the server forwards the full transcript automatically and the adviser is read-only. This local web-provider adviser does not have automatic transcript access, so the model must curate the context deliberately.
- For coding and agent tasks, adviser calls are most useful after enough orientation to have evidence, but before committing to an approach.
- If adviser advice conflicts with primary evidence, reconcile the conflict explicitly instead of silently switching.
- The context brief is not a prompt wrapper around a question. It is the evidence packet the external adviser uses to understand the situation, identify weak assumptions, and make a better recommendation.
