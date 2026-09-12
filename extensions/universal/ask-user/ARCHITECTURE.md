# ask-user — Architecture

> 功能分级：P0（依据见 [docs/feature-priorities.md](../../../docs/feature-priorities.md) §6 边界判例 #3——agent↔用户交互闭环的唯一通道，2026-09-12 用户裁决升 P0）。

Internals reference for maintainers. For the usage contract (what the tool does, when an agent should call it), see [README.md](./README.md). This document covers how the code is structured, the state machine, the defensive execute flow, and where each design invariant is enforced — so a change does not silently break an invariant.

Source: 10 files in `src/`, ~1970 lines total.

## File dependency graph

```
                          ┌─────────────┐
                          │  types.ts   │  ← shared leaf; imports only typebox
                          │ Schema +    │     holds QuestionState / ThemeLike /
                          │ shared      │     AnswerValue / createQuestionState
                          │ state types │     here (NOT in component.ts) to break
                          └──────▲──────┘     the cycle
                                 │ imported by all
              ┌──────────────────┼─────────────────────┬─────────────────┐
              │                  │                     │                 │
       ┌──────┴──────┐    ┌──────┴──────┐    ┌─────────┴──────┐  ┌───────┴────────┐
       │ validate.ts │    │question-view│    │  submit-view   │  │  answer-codec  │
       │ pure check  │    │ pure render │    │  pure render   │  │ AnswerValue →  │
       └──────▲──────┘    └──────▲──────┘    │  + buildResult  │  │ proto entries  │
              │                  │           └──────▲─────────┘  └───────▲────────┘
              │           ┌──────┴──────────────────┘                    │
              │           │                                              │
       ┌──────┴───────────┴──┐    ┌────────────────────┐                 │
       │   component.ts      │◀───│   editor-ops.ts    │                 │
       │  state machine +    │    │ editor pure ops    │                 │
       │  input routing +    │    │ (insert/delete/    │                 │
       │  race guards        │    │  cursor/paste)     │                 │
       └──────────▲──────────┘    └────────────────────┘                 │
                  │                                                      │
                  │                 ┌────────────────────┐               │
                  ├────────────────▶│ channel-handler.ts │◀──────────────┘
                  │  (AskUserComp.) │ subagent passthru  │
                  │                 └─────────▲──────────┘
                  │                           │
                  │                 ┌─────────┴──────────┐
                  │                 │channel-registry-   │
                  │                 │register.ts         │
                  │                 │globalThis Symbol   │
                  │                 │handshake           │
                  │                 └────────────────────┘
           ┌──────┴───────────┐
           │     index.ts     │  ← Tool factory + execute (6-step flow) + renderCall/renderResult
           └──────────────────┘     imports component + validate + types + submit-view +
                                    channel-handler + channel-registry-register
```

**No cycles.** All imports flow one direction; `types.ts` is the single leaf depended on by everyone.

**Why `QuestionState` / `ThemeLike` live in `types.ts`, not `component.ts`** (see the comment in `types.ts`): `question-view.ts` and `submit-view.ts` are pure render functions that read/write `QuestionState` and need the `ThemeLike` interface. If those types lived in `component.ts`, the render views would import `component.ts`, and `component.ts` imports the render views — a cycle. Sinking the shared types to the dependency-free leaf keeps every arrow monotone. **Do not move these types back** without reintroducing the cycle.

## Answer model & protocol boundary (D1)

`AnswerValue` (`types.ts`) is the single structured answer model — `{ selected: string[]; other: string | null }`. The old internal/proto double model is gone: proto `AskUserOption.value` equaled `label` (both were the same string), so the proto layer consumes the same single model (`Result.answers: Record<string, AnswerValue>`, key = question text).

Serialization happens **once, at the protocol boundary**: `encodeAnswer(value, { key, multiSelect })` in `answer-codec.ts` converts an `AnswerValue` into proto answers entries, byte-aligned with `@xyz-agent/extension-protocol` helpers' decode contract (`getAskUserAnswer` / `getAskUserOther`):

- 单选：`answers[key] = selected[0]`
- 多选：`answers[key] = JSON.stringify(selected)`
- Other：`answers[`${key}__other`] = other`（仅在 other 非空时写入）

Encoding is **one-way** — the old `parseAnswerParts` text reverse-parsing was deleted with the double model; there is no decode counterpart inside the extension. `channel-handler.ts` reads `AnswerValue` directly and calls `encodeAnswer` when forwarding to subagents.

## `execute` defensive flow (6 steps)

`execute` in `src/index.ts` runs six ordered checks. Order is not arbitrary — each early step is cheaper than the next and some have side effects that must precede the rest.

| Step | Check | Returns | Why this order |
|------|-------|---------|----------------|
| 1 | `validateInput(questions)` | `throw` (Pi marks `isError:true`, empty `details`) + fix hint | Pure function, no side effects — cheapest gate. Reject before any UI/state work. |
| 2 | `ctx.mode !== "tui" && ctx.mode !== "rpc"` (headless) | `throw` + **`setActiveTools` removes ask_user** | Must run before the agent can retry. Physically removing the tool breaks a function-calling retry loop that a thrown error cannot. |
| 3 | `signal?.aborted` | `cancelled:true` | O(1) short-circuit before the expensive blocking `ctx.ui.custom` call. |
| 4 | `try { ctx.ui.custom(...) } catch` | `throw` (Pi marks `isError:true`, empty `details`) | `ctx.ui.custom` is the only call that runs user interaction / editor construction / theme reads — the largest blast radius, so it is the only thing wrapped. |
| 5 | `result === null \|\| result.cancelled` | `cancelled:true` | Component resolved to cancel. |
| 6 | normal | `{ answers }` | Compose the summary. |

**The order is load-bearing**: swapping 1↔2 wastes a UI check on invalid params; swapping 2↔3 lets an aborted agent enter a blocking UI; moving 4's try/catch wider catches nothing extra. Business outcomes (answers / cancellation) are returned as normal results — only validation failures and unexpected exceptions `throw` (Pi converts a throw into an `isError:true` tool result with empty `details`). The headless branch's `setActiveTools` is the key insight — even an `isError` tool result does not stop an LLM from calling the tool again in the same turn, so the tool is removed from the session's active set and the error text says "do not retry".

## `QuestionState` machine

Each question has a `QuestionState` (`types.ts`). Its `mode` field is a two-state machine:

```
                     Enter (on Other row)
            ┌────────────────────────────────────────┐
            ▼                                        │
     ┌─────────────┐   Enter (text → save +          ┌──────────────┐
     │   options   │   afterConfirm + advance) ────▶ │   freeform   │
     │  (default)  │ ◀───────────────────────────────│  (editor)    │
     └─────┬───▲───┘  Esc (save draft → back) /      └──────┬───▲───┘
           │   │      Enter empty (clear value → back)      │   │
   Enter   │   │ Esc (back to previous tab;                 │   │
   (normal     on first tab → confirm-cancel overlay)       │   │
    option)                                                 │   │
           ▼                                                 │
   afterConfirm → advance (next tab / Submit tab)            │
                                                             │
           └─────────────────────────────────────────────────┘
```

Transitions live in `component.ts`: `options → freeform` (Enter on the Other row — the last option — prefills `draftText` from `freeTextValue ?? freeDraft`), `freeform → options` (Enter saves trimmed text into `freeTextValue` and calls `afterConfirm`; Enter on empty text clears `freeTextValue`; Esc saves the draft into `freeDraft` and returns to the list, restoring the saved options cursor). There is **no comment mode** — the freeform editor is the only text input; `QuestionMode = "options" | "freeform"`.

### `confirmed` invariant

> **`confirmed === true` ⟹ the question has at least one answer.**
> I.e. `multiSelect ? selectedIndices.size > 0 : selectedIndex !== null`, **or** `freeTextValue !== null`.

This invariant is what makes the Submit gate (`allConfirmed()`) sound — if it ever fails, Submit lets through a question whose answer is missing, and the LLM receives `(no answer)`.

Four assignment sites maintain it (`component.ts`):

| Site | Sets | Why safe / necessary |
|------|------|----------------------|
| `afterConfirm()` | `true` | Safe: caller has already set `selectedIndex` / `selectedIndices` / `freeTextValue`. |
| `autoConfirmIfAnswered()` | `true` | Safe: guarded by `if (hasAnswer)` — never sets `true` without an answer. |
| `toggleIndex()` when multi-select empties | `false` | Necessary: un-checking the last option (with no free text) must drop `confirmed` to preserve the contrapositive. |
| `handleEditorEnter` freeform empty-Enter | `false` | Necessary: clearing `freeTextValue` with no other answer must drop `confirmed`. |

If you add a new path that changes the answer set, audit both directions of this invariant.

### `autoConfirmIfAnswered` trigger

Called only from `gotoTab()` — when the user navigates between tabs via `←/→` (Tab is not a tab-navigation key: on the Submit tab it toggles Submit/Cancel focus, and `Shift+Tab` is deliberately unused because Pi's global `app.thinking.cycle` intercepts it). It promotes an implicitly-answered tab (toggled but not confirmed) to `confirmed`. A navigation intent should not force a confirm prompt — only the Enter path confirms via `afterConfirm`.

## Race guards

Three independent guards protect against three different races. They are dimensionally orthogonal but easy to confuse — keep them distinct.

| Guard | Kind | Location | Prevents | Mechanism |
|-------|------|----------|----------|-----------|
| `_resolved` | `boolean` field | `component.ts` | **Double `done()`**: user already submitted/cancelled, then a signal-abort listener or a late keypress fires `done` again → Pi receives two resolves. | `submit()`/`cancel()` set `_resolved = true` before `done(...)`; **both `handleInput` and `cancel()` itself early-return if already set** — so a signal-abort firing after resolution (the listener calls `comp.cancel()`) is a no-op (see `execute` step 4). |
| `pendingCancel` | `boolean` field | `component.ts` | **Accidental cancel losing answers**: Esc on the first question (or single question) cancelling outright would discard everything. | Two-step confirm: first Esc sets `pendingCancel = true` and shows an overlay; a second Esc truly cancels; any other key exits the overlay and keeps the form. The Submit-tab Cancel button bypasses this (already at the terminus). |
| `autoConfirmIfAnswered` | **method** (not a field) | `component.ts` | **Zombie unanswered tab**: in multi-question mode, toggling an option then navigating away (`←/→`) leaves a tab "answered but not confirmed", so the Submit gate (`allConfirmed()`) stays false and the user cannot tell why Submit is blocked. | `gotoTab()` calls it before switching; if the current state has an answer but `!confirmed`, it sets `confirmed = true`. |

## Three-layer rendering

Three independent render paths with non-overlapping jobs. Changing one layer never affects the others (unless you change the `details` schema, which feeds `renderResult`).

| Layer | When | Location | Job | Returns |
|-------|------|----------|-----|---------|
| `renderCall` | tool invoked, while `execute` is running (during interaction) | `index.ts` | Compact title: `ask_user <headers>` — tells the user what the agent is asking. | one `TruncatedText` |
| inline render (execute) | after `ctx.ui.custom` returns the component, the runtime loops `comp.render(width)` | factory in `index.ts`, render in `component.ts` | The live interactive TUI: option list / editor / tab bar / button bar / cancel overlay. | `string[]` (one per line) |
| `renderResult` | after `execute` returns | `index.ts` | Final result display. Compact: `✓ header: answer`; when `options.expanded`: all options with `●`/`○` selection marks. | `Box` of `TruncatedText`s |

## Split-pane adaptive layout

`getSplitPaneWidths(width)` in `question-view.ts` is a pure function with three-level degradation:

```
width < 84                                    → null  (single column)
available = width - len(" │ ")                // separator overhead
available < 32 + 28 (= 60)                    → null  (too narrow)
preferredLeft = floor(available * 0.42)
left  = clamp(preferredLeft, 32, available - 28)
right = available - left
right < 28                                    → null  (fallback)
```

So the **left column (option list) takes 42%, the right column (option detail) takes 58%**, with floors of 32 and 28 respectively, and a total split threshold of 84 columns. `buildSplitPane` pads the shorter column to `max(leftLines, rightLines, 8)` so the two stay aligned row-for-row.

Constants: `SPLIT_PANE_MIN_WIDTH = 84`, `SPLIT_PANE_LEFT_MIN = 32`, `SPLIT_PANE_RIGHT_MIN = 28`, `SPLIT_PANE_SEPARATOR = " │ "` (all in `types.ts`).

## Spec cross-reference

The original spec files (`.xyz-harness/2026-06-15-ask-user/`) are no longer in the repo — this table is self-contained (FR = functional requirement from the original spec). Implementation anchors:

| Spec | Implemented in |
|------|----------------|
| FR-2 (param schema/validation) | `types.ts` schema + `validate.ts` |
| FR-3 (inline render, no overlay) | `execute` → `ctx.ui.custom` without `options` |
| FR-4 (question view) | `question-view.ts` `renderQuestionView` |
| FR-6 (input handling) | `component.ts` `handleInput` / `handleOptionsInput` / `handleEditorInput` |
| FR-8 (headless disable) | `execute` step 2 |
| FR-9 (custom render) | `renderCall` / `renderResult` |
| FR-10 (signal abort) | `execute` step 3 + step 4 abort listener |
| FR-12 (re-entry guard) | `_resolved` field + `cancel()` shared by abort listener |
| FR-13 (error catch-all) | `execute` step 4 try/catch |

When you change one of these behaviors, update both the code comment (which cites the FR/AC) and this table.

## Resolved gaps

Previously surfaced by review, now fixed (kept as a maintenance trail):

- **Abort-vs-cancel text collision** (FR-10) — resolved: `execute` step 3 now returns `"Agent aborted..."`, distinct from step 5's user-cancel text. — `src/index.ts`.
- **`question` length limit not in schema** — resolved: the `QuestionSchema` description now states "≤1000 chars". — `src/types.ts`.
- **`header` >12 chars silently truncated** — resolved: `validate.ts` now rejects headers over `HEADER_MAX_CHARS` instead of silently truncating in the UI. — `src/validate.ts`.
- **`cancel()` re-entry race** (FR-12) — resolved: `cancel()` now guards with `_resolved`; a signal abort firing after submit/cancel no longer calls `done` twice. — `src/component.ts`.
