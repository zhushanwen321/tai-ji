---
'@zhushanwen/extension-protocol': minor
---

Composer task tray protocol fields (all additive, backward compatible):

- `WidgetMeta` gains optional `icon?: string | { paths: string[] }` and
  `badge?: string`: a tray icon reference (host-resolved lucide key, or
  extension-defined shape as path `d` strings) and a short
  extension-formatted badge text (host truncates to 6 chars, full text in
  title). Shape belongs to the extension, style stays host-locked (the
  renderer fixes stroke width/color/size, so custom shapes are always the
  same thin-line family as lucide icons). Old hosts/old extensions are
  unaffected — both fields are optional and the `isGuiRenderResult` guard
  does not inspect meta shape.
- `tab-bar` props gain optional `sections?: GuiComponent[][]` (same length
  as `tabs`): section i is the subtree rendered while `tabs[i]` is active.
  Omitted keeps the current display-only tab-bar; the host owns the active
  index locally (a push never resets the user's local tab choice), and a
  length mismatch degrades to display-only plus a warn.
- New `validateWidgetIconPaths` helper (`WidgetIconPathsValidation` /
  `WidgetIconPathsRejection`): whitelist validation for custom icon path
  `d` strings (charset `^[MLCQAZHVmlcqazhv0-9 ,.\-]+$`, at most 8 paths,
  at most 512 chars per path, at most 2048 chars in total). Never throws —
  it returns the validated paths copy or a rejection reason so the host can
  fall back to a built-in icon and warn.
