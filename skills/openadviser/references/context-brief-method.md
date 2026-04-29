# OpenAdviser Context Brief Method

Use this method before calling the external adviser. The goal is not to summarize the conversation mechanically; it is to brief a senior expert so they can make a better decision than the caller can make alone.

## Principles

- Treat `compact` as the source inventory. The final context sent to the web AI adviser is a decision brief, not a mechanical continuation summary.
- Write for an external reviewer or boss who has no hidden transcript access and must decide from the brief alone.
- The `Goal` is the user's real objective or decision, not "ask the adviser", "test the tool", or "make the web AI provider return an answer".
- Preserve enough context for judgment: constraints, current state, evidence, failed attempts, validation, risks, and next actions.
- Separate facts from caller interpretation. Label facts, assumptions, hypotheses, preferences, and proposed decisions explicitly.
- Include primary evidence where it matters: file paths, function names, command outputs, error text, links, dates, version numbers, screenshots, observed DOM facts.
- Exclude unusable or misleading context: skill catalogs, hidden reasoning, encrypted blobs, raw transcripts, repeated tool logs, and meta chatter.
- Do not over-steer the adviser. Give the adviser's question and constraints, but do not pre-answer it inside the context.

## Two-Pass Briefing Method

1. Inventory the situation with the `compact` contract: goal, constraints, state, decisions, technical context, validation, risks, and next steps.
2. Rewrite for adviser judgment:
   - Replace meta-goals with the real user outcome.
   - Add `Adviser decision needed`.
   - Move evidence into `Fact:` bullets.
   - Move uncertain interpretation into `Assumption/Hypothesis:` bullets.
   - Add what would disprove the current approach.
   - Remove tool-call ceremony and low-signal history.

The brief should feel like a case file for a senior decision, not a test report for the adviser tool.

## Evidence Calibration

Use explicit labels so the external adviser can weigh the brief correctly:

- `Fact`: Directly observed, tested, or quoted from a source. Include evidence when the fact matters.
- `Source`: A link, file path, screenshot path, command, date, exact error, or version.
- `Caller assessment`: The calling model's interpretation of facts. This can be wrong.
- `Assumption/Hypothesis`: A plausible explanation not yet verified.
- `Preference`: A user-stated preference or project convention.
- `Decision`: A choice already made; include why.
- `Rejected / avoided`: An option not being used; include why it failed or is disallowed.

If current ecosystem knowledge matters, include the date of the local search and any sources already checked. Ask the adviser to separate externally checked facts, inferences, and recommendations.

## Context Size Judgment

Provide enough information for a strong model to disagree intelligently:

- Include the facts that would let the adviser falsify your current hypothesis.
- Include the constraints that would make an otherwise-good solution unacceptable.
- Include the best arguments against your intended approach.
- Include unknowns and what has not been verified.
- Omit low-signal history that only explains how the conversation got here.

## Required Shape

Use the compact headings, but write them as a decision brief:

```markdown
## Goal
- Primary task: [user's actual desired outcome]
- Secondary task(s): [related objectives]
- Success criteria: [observable end state]
- Adviser decision needed: [the exact judgment you want]

## Constraints & Preferences
- Verified constraints: [hard facts, policies, environment limits]
- User preferences: [explicit preferences, tone, scope]
- Exclusions: [what must not be done]

## Current State
### Done
- [x] Fact: [confirmed work or observation, with evidence if important]

### In Progress
- [ ] [current work state]

### Blocked
- Fact: [blocker]
- Assumption/Hypothesis: [current interpretation of blocker]

## Key Decisions
- **Decided**: [decision] - [reason/evidence]
- **Proposed**: [candidate decision] - [why under consideration]
- **Rejected / avoided**: [approach] - [why rejected]

## Important Files & Code Locations
- `path`: [role, relevant symbols, why it matters]

## Critical Technical Context
- Verified facts:
  - [fact + evidence]
- Caller assessment / hypotheses:
  - [interpretation that may be wrong]
- Important commands and results:
  - `[command]`: [result]
- Important errors:
  - `[exact error]`
- External/current information already checked:
  - [source, date, conclusion]

## Validation Status
- Verified:
  - [tested behavior]
- Not yet verified:
  - [gap]
- Test / validation gaps:
  - [risk]

## Risks & Open Questions
- [risk or uncertainty that could change the answer]

## Next Steps
1. [likely next action if adviser agrees]
2. [alternative / validation action]

## Handoff Instructions for the Next Model
- Read first: [files/docs]
- Do not repeat: [wasted paths]
- Check / verify first: [highest-value verification]
- Then continue with: [local execution plan after advice]
```

## Bad Context Pattern

Do not write:

```markdown
## Goal
- Primary task: Ask an external adviser to research "skills".
- Success criteria: Adviser returns an answer.
```

This briefs the tool test, not the user's situation.

## Better Context Pattern

Write:

```markdown
## Goal
- Primary task: Decide how to redesign the local OpenAdviser skill so a web AI provider can provide useful second opinions.
- Success criteria: The skill reliably sends a decision brief with verified facts, assumptions, constraints, and open questions; it must not read hidden session state.
- Adviser decision needed: What context contract should the skill enforce, and how should we validate it?
```

This tells the adviser what decision is needed and why.

## Research Request Pattern

If the user asks a broad research question, preserve the user's wording but add the local decision frame:

```markdown
## Goal
- Primary task: Improve the local OpenAdviser skill's context contract for AI coding-agent work.
- Secondary task(s): Use the user's requested research topic `调研 skills` only insofar as it informs the context-contract design.
- Success criteria: The returned advice helps decide concrete skill design, validation, and usage rules.
- Adviser decision needed: Based on current agent-skill patterns and the local constraints, what should this skill require from the caller before consulting an external web AI provider?
```

This prevents the external adviser from answering an abstract encyclopedia question when the actual need is an implementation decision.
