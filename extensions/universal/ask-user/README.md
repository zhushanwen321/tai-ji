# @zhushanwen/pi-ask-user

Inline adaptive `ask_user` tool for the Pi coding agent. Resolves ambiguity the agent cannot resolve itself — a single question (no tab bar) or 1-4 questions (tabbed view + submit), with split-pane option preview on wide terminals and an inline free-text editor. There is no comment feature: the free-text "Other" editor is the only free-form input.

The tool's primary caller is the LLM. This README covers both **how an agent should use it** (top sections) and **how a maintainer reads the code** (File structure → Design notes).

## Install

```bash
pi install npm:@zhushanwen/pi-ask-user
```

> **Dev-only symlink**: during local development you may symlink this package into `~/.pi/agent/extensions/` for debugging, but **never use the symlinked copy for daily work**. Local directory discovery has an `index.ts` fallback that masks a missing `pi` manifest field — npm-installed copies then silently fail to load. See `docs/extensions/extension-conventions.md` "扩展安装红线".

## When to use

Call `ask_user` **only when all three hold**:

1. The request has ≥2 reasonable approaches.
2. You have already gathered context (read/grep) and the answer is still genuinely ambiguous.
3. Picking wrong means redoing real work.

If you can form a defensible recommendation from the codebase, **proceed and state your choice** — do not ask. Models over-ask because asking feels safer than deciding; resist this.

## When NOT to use

- **Trivia answerable by reading code/docs** — plain text suffices.
- **Simple confirmations** ("I'll delete X") — plain text suffices.
- **Outsourcing judgment you should make** — if context makes the answer clear, decide.
- **Free-form requirements / long-form feedback** — this tool returns short selections only.
- **High-frequency grilling** — do not chain `ask_user` calls as a default fallback when stuck. If you have no context to pass, you are not ready to ask — read code first.
- **Reversible decisions** — if a wrong guess is cheap to roll back, just decide.

If you recommend an option, prefix its label with `(Recommended)` and list it first.

## Parameters

```typescript
{
  questions: Array<{
    question: string;        // one self-contained decision; ≤1000 chars; no control chars (incl. \n)
    header?: string;         // tab label ≤12 chars; REQUIRED (non-empty) when questions.length > 1
    context?: string;        // 1-3 sentences of what you learned; shown above the question
    options: Array<{         // 2-4 mutually exclusive options; do NOT add an 'Other' — it is automatic
      label: string;         // ≤ ~40 chars (longer overflows the split-pane UI); also the answer value
      description?: string;  // short rationale shown under the label and in the preview pane
    }>;
    multiSelect?: boolean;   // default false; true only when several options can validly apply
  }>
}  // questions: 1-4 entries
```

**Constraints at a glance**

| Field | Constraint | Enforced by |
|-------|-----------|-------------|
| `questions` | 1-4 entries | schema (`minItems`/`maxItems`) |
| `options` | 2-4 entries | schema |
| `question` | ≤1000 chars, no control chars (incl. `\n`), unique within the call | schema description + `validate.ts` |
| `header` | ≤12 chars (always); non-empty and unique when `questions.length > 1` | `validate.ts` (length; non-empty + uniqueness in multi-question mode) |
| `options[].label` | non-empty, unique within the question | `validate.ts` |

Validation failures make the tool `throw` with a message that names the violation and tells you how to fix it — correct the parameters and retry. (Pi converts a thrown error into an `isError: true` tool result; business outcomes like answers and cancellation are returned normally.)

## Result format

On success the tool returns the answers joined as `"question" = "answer"` lines. Answer composition rules:

- **Single-select**: the chosen `label`.
- **Multi-select**: selected labels joined with `, ` (e.g. `A, B`).
- **Free-text (Other)**: whatever the user typed (appended to the selection with `, ` when both exist).

A question with no answer reports as `(no answer)`.

## Behavior on failure / cancellation

| Situation | Return | What the agent should do |
|-----------|--------|--------------------------|
| Parameter validation fails | `throw` (Pi shows it as `isError: true`) + fix hint | Correct params and retry |
| No interactive UI (headless) | `throw`, tool **disabled for the session** | Proceed with a defensible decision stated in text, or wait for the user — **do not retry** |
| Agent aborted (goal cancelled / context compacted) | `cancelled: true` | The text identifies it as an agent abort, not a user cancel. Do not assume an answer; do not retry ask_user — propagate the abort, or wait for new instructions if the decision is still required. |
| User cancels (Esc → confirm, or Cancel button) | `cancelled: true` | Wait for new instructions, or re-ask with refined options if the decision is still required |
| Unexpected error during interaction (TUI) | `throw` (Pi shows it as `isError: true`) | Tool stays enabled — retry with corrected parameters, or proceed with a defensible decision |
| Unexpected error during interaction (RPC/GUI) | `throw` + tool **disabled for the session** | Same as the headless row — do not retry |

Business outcomes (answers / cancellation) are returned as normal results; only validation failures and unexpected exceptions `throw` — Pi marks a thrown error `isError: true` with empty `details`.

The headless and RPC-failure branches physically remove the tool from the session (`setActiveTools`) — this is deliberate, so a function-calling loop cannot keep retrying `ask_user` in a non-interactive context. The TUI branch does not disable: an interaction failure there is usually transient, so the tool stays enabled for a retry.

## Features

- **Adaptive layout**: single question → no tab bar; 1-4 questions → tabbed view + Submit tab.
- **Split-pane preview** (≥84 cols): option list left, selected option detail right. The right pane is **plain-text** option detail (label + description), not a Markdown renderer.
- **Inline free-text editor**: select "Other" → Enter → type a custom answer. Multi-line aware, soft-wrapped. No comment mode — this editor is the only free-form input.
- **Multi-select**: `multiSelect: true` → toggle checkboxes with Space, Enter to confirm.
- **Esc confirm-to-cancel**: in options mode, Esc on the first question opens a confirm overlay (a second Esc cancels; any other key stays). Elsewhere Esc means back, not cancel: on later question tabs it steps back one tab, on the Submit tab it returns to the last question, and in the Other editor it saves the draft and returns to the option list.
- **Headless-safe**: disables the tool and throws when no UI is available.

## File structure

```
extensions/universal/ask-user/
├── index.ts                  # re-export entry (Pi loads via package.json pi.extensions)
├── package.json
├── README.md                 # this file — usage contract for LLM callers + overview
├── ARCHITECTURE.md           # internals: dependency graph, state machine, defensive flow
├── vitest.config.ts
├── tsconfig.json             # typecheck config (not in the npm files allowlist)
└── src/
    ├── index.ts              # Tool factory: registerTool + execute (6-step defensive flow) + renderCall/renderResult
    ├── types.ts              # Input schema, Result schema, shared state types (QuestionState/ThemeLike) — dependency leaf
    ├── validate.ts           # pure parameter validation; error messages aimed at LLM fixability
    ├── component.ts          # AskUserComponent: state machine, input routing, race guards
    ├── question-view.ts      # pure render: option list, split-pane, inline editor
    ├── submit-view.ts        # pure render: Submit tab, answer summary, buildResult
    ├── answer-codec.ts       # pure encode: AnswerValue → proto answers entries (protocol boundary)
    ├── channel-handler.ts    # subagent channel passthru: RPC forward / TUI re-render → proto answers
    ├── channel-registry-register.ts  # globalThis Symbol slot handshake (handler registration)
    └── editor-ops.ts         # pure editor ops: insert/delete/cursor/paste (UTF-16 surrogate aware)
```

`types.ts` is intentionally the shared dependency leaf — it holds `QuestionState`/`ThemeLike` (not `component.ts`) so the two pure-render views depend only on the leaf, breaking a would-be `component → view → component` cycle. See ARCHITECTURE.md for the full graph.

## Steer mechanism

The tool registers three steering channels to discourage over-asking:

- **`description`** — the long tool description shown in the agent's tool catalog (the three preconditions + negative cases).
- **`promptSnippet`** — one-line summary injected into the system prompt.
- **`promptGuidelines`** — six focused rules reinforcing: gather context first, one decision per question, no trivia, don't outsource judgment, don't add an `Other` option.

All three are consistent and point the same direction. If you tune behavior, edit all three together in `src/index.ts` to avoid drift.

## Design notes

- **Why inline, not overlay** (`execute` → `ctx.ui.custom` without `options`): the question belongs in the conversation flow, not a modal that obscures context.
- **Why `Other` is auto-appended, not in the schema**: free-text input is the user's escape hatch and must not be something the LLM can omit or mislabel. Keeping it out of `options` guarantees it is always present and always last.
- **Why `←/→` switches tabs but `Tab` does not**: arrow keys move between question tabs (and wrap on the Submit tab), so tab navigation never conflicts with the option-list cursor (`↑/↓`) or text editing. On the Submit tab, `Tab` alone toggles focus between Submit and Cancel — a deliberate single-key bidirectional toggle; `Shift+Tab` is intentionally unused because Pi's global `app.thinking.cycle` intercepts it.
- **Why validation messages are verbose**: every message names the violation and gives a fix path, because the reader is an LLM that will retry.

## Spec reference

Design spec files are not kept in this repo. The FR cross-reference table in ARCHITECTURE.md is self-contained: each entry names the behavior and where it is implemented in this codebase.

## License

MIT
