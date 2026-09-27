# @zhushanwen/pi-todo

## 0.9.5

### Patch Changes

- a59739edb: The todo widget body is now a two-section tab bar (`待办 N` / `已完成 M`): the

  first section lists open items, the second lists completed ones, and the host
  switches between them locally — the extension keeps pushing the full list every
  time and no extra round trip is needed. Both sections are numbered list-trees,
  so item numbering and status dots are unchanged.

  The widget meta now pushes an explicit tray icon (`icon: "list-checks"`, the
  lucide key the host maps `todo` to by default) and a badge carrying the number
  of open items. The clear-widget path is untouched: an empty list still clears
  the widget instead of pushing an empty panel.
