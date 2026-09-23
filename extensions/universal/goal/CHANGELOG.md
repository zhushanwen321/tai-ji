# @zhushanwen/pi-goal

## 0.14.6

### Patch Changes

- 8285841af: Route resume/set prompts through the sendContextMessage port: injected steering prompts now go out as custom messages instead of user messages, so the conversation stream no longer fabricates user bubbles. LLM-visible content is unchanged.

## 0.14.5

### Patch Changes

- a59739edb: Goal widget meta now pushes an explicit tray icon (`icon: "target"`, the

  lucide key the host maps `goal` to by default). The icon no longer relies on
  the host's built-in widgetKey fallback map, so host-side mapping changes
  cannot silently swap the goal icon. No `badge` is pushed: the tray derives
  the budget percentage from the existing `progress.label` (e.g. "42%"), so the
  percentage format keeps a single source of truth.
