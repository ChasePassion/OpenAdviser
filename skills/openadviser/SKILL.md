---
name: openadviser
description: Consult ChatGPT Web, Grok, or another OpenAdviser-supported web AI provider as an external adviser using a manually prepared compact-style decision brief. Use when an AI agent is stuck, faces an engineering/product/design decision, needs a second opinion, needs current web-facing research, or should validate an approach before continuing; the caller must write the context brief explicitly instead of reading hidden session files.
---

# OpenAdviser

Use this skill to ask an external web AI adviser through the `openadviser` CLI and Chrome extension.

Default provider is `chatgpt`. Pass `--provider grok` to use Grok after that Chrome profile is logged in. The skill is agent-agnostic: Codex, Claude Code, OpenCode, Cursor, and other local agents can use the same context contract.

Do not read rollout JSONL, `state_5.sqlite`, session metadata, encrypted reasoning, or other agent-internal hidden state. This skill intentionally avoids automatic context reconstruction. The calling model must decide what context matters and provide it explicitly.

## Prerequisites

The human user must have:

1. Installed the CLI: `npm install -g openadviser`
2. Started the bridge: `openadviser server`
3. Loaded the Chrome extension from `openadviser extension-path`
4. Logged in to the selected provider in Chrome

If the bridge is not already running, `scripts/openadviser.js` tries to start it automatically.

## Required Workflow

1. Use the `compact` skill's section structure as the source inventory.
2. Rewrite that inventory into a decision brief for an external expert. The brief must describe the user's real situation, not the act of calling OpenAdviser.
3. Put the real user goal and the exact adviser judgment in `Goal`. Never write `Primary task: ask adviser...`, `test adviser...`, or `success criteria: adviser returns an answer` unless the user's actual task is to debug this skill.
4. Separate verified facts, primary evidence, caller assessment, assumptions/hypotheses, decisions, risks, and unknowns.
5. Include enough information for the adviser to disagree intelligently: constraints, failed attempts, test results, exact errors, relevant files, source links, dates, version numbers, screenshots, observed page/DOM facts, and unresolved tradeoffs.
6. Add anti-bias context when useful: the best argument against the caller's preferred approach, what is not verified, and what would change the decision.
7. Exclude skill catalogs, encrypted reasoning, hidden system text, raw transcript dumps, and low-signal tool chatter.
8. Ask one focused adviser question with a decision frame.
9. Send the context brief plus question with `scripts/openadviser.js send`, wait as needed, then read snapshots with `scripts/openadviser.js read`.
10. Treat the answer as advice, not authority; reconcile it against primary evidence and continue locally.

Before first use, or whenever context quality is uncertain, read `references/context-brief-method.md`. For the design rationale and local limitations, read `references/adviser-strategy.md`.

## Context Brief Contract

Use the compact sections below, but write them as a decision brief. The section content matters more than the labels: `Goal` must be the real user goal, `Current State` must contain verified state, and `Critical Technical Context` must separate facts from interpretations.

```markdown
## Goal
- Primary task: [user's actual desired outcome]
- Secondary task(s):
- Success criteria:
- Adviser decision needed: [the exact judgment you want]

## Constraints & Preferences
- Verified constraints:
- User preferences:
- Exclusions / must not do:

## Current State
### Done
- [x] Fact: [completed work / confirmed finding / evidence]

### In Progress
- [ ] [Work currently underway]

### Blocked
- Fact:
- Assumption/Hypothesis:
- If none, write `(none)`

## Key Decisions
- **Decided**: [decision] - [reason/evidence]
- **Proposed**: [candidate decision] - [why under consideration]
- **Rejected / avoided**: [approach] - [why rejected]

## Important Files & Code Locations
- `path/to/file`: [Why it matters]

## Critical Technical Context
- Verified facts:
  - [fact + evidence]
- Caller assessment / hypotheses:
  - [interpretation that may be wrong]
- Key functions / classes / modules:
  - `[symbol]`: [role]
- Important commands:
  - `[command]`: [purpose / result]
- Important errors:
  - `[exact error message]`
- Important config / API / environment details:
  - [detail]
- Important data / examples / references needed later:
  - [detail]
- If none, write "(none)"

## Validation Status
- Verified:
  - [What was tested / confirmed]
- Not yet verified:
  - [What still needs testing]
- Test / validation gaps:
  - [Any risky unverified areas]

## Risks & Open Questions
- [Known risks]
- [Unknowns that may affect next steps]
- [Potential places easy to make mistakes]

## Next Steps
1. [Most logical next action]
2. [Next action after that]
3. [Next action after that]

## Handoff Instructions for the Next Model
- Read first:
- Do not repeat:
- Check / verify first:
- Then continue with:
```

Bad context: `Primary task: Ask adviser to research X`. This describes the tool call.

Good context: `Primary task: Decide how to redesign X under constraints Y; Adviser decision needed: whether approach A or B is safer`. This describes the situation.

For broad research requests such as `调研 skills`, do not brief the adviser as if the answer itself is the goal. Brief the real local decision: why the research matters, what artifact or implementation it should inform, what is already known, what constraints apply, and what recommendation is needed.

## Commands

Send a manually prepared context file:

```bash
node path/to/skills/openadviser/scripts/openadviser.js send "your focused question" --context-file ./adviser-context.md
```

Pipe context through stdin:

```bash
cat ./adviser-context.md | node path/to/skills/openadviser/scripts/openadviser.js send "your focused question"
```

Use Grok instead of the default ChatGPT provider:

```bash
cat ./adviser-context.md | node path/to/skills/openadviser/scripts/openadviser.js send "your focused question" --provider grok
```

The `send` command starts the local bridge if needed, submits the prompt to the selected web AI provider, and prints a bridge task JSON containing `result.runId`. It does not wait for the answer.

Read the current answer snapshot later:

```bash
node path/to/skills/openadviser/scripts/openadviser.js read --run-id <runId> --json
```

Call `read` repeatedly after waiting if `result.status` is `waiting` or `streaming`. The caller decides whether the current answer is complete enough. The script does not use the clipboard unless `--copy-button` is explicitly passed.

The built-in adviser prompt tells the web AI provider: "Before answering, first analyze your task, examine the problem structure from multiple angles, then search the web for relevant information to support your judgment."

## Useful Options

- `--context-file <path>`: Compact-style context file.
- `--context <text>`: Inline compact-style context.
- `--question-file <path>`: Adviser question file.
- `--provider <chatgpt|grok>`: Web AI provider. Default `chatgpt`.
- `--url <url>`: Override provider URL for the send action.
- `--strict-context`: Fail before sending if core compact/adviser signals are missing.
- `--json`: Print the full bridge task object.
- `--timeout <ms>`: Atomic bridge action wait timeout. Default `120000`.
- `--page-load-timeout <ms>`: Soft provider page-load wait before continuing to inject/send. Default `15000`.
- `--input-timeout <ms>`: Provider composer wait timeout before send.
- `--run-id <id>`: Run id returned by `send`; required for `read`.
- `--read-timeout <ms>`: Page read timeout. Default `15000`.
- `--copy-button`: On `read`, also try the provider's Copy response button. Default is DOM extraction only.
- `--openadviser-bin <command>`: OpenAdviser executable. Default `openadviser`.

## Adviser Question Style

Ask focused questions:

- `基于这些约束，哪个实现路线风险最低？`
- `这个 bug 的下一步最有效验证是什么？`
- `请审查这个设计是否存在明显遗漏。`
- `请调研当前网络信息，并给出事实、推断和建议。`

Do not ask broad questions without a decision frame. If the user asks a broad research question, first brief the current situation and why the research matters.

Prefer question forms like:

- `基于这些事实和约束，这个 context contract 是否足够，哪里会误导外部顾问？`
- `请区分当前公开事实、你的推断和建议，评估方案 A/B 哪个更适合本项目。`
- `如果你是外部 reviewer，你会要求我先补哪些证据再做决定？`
