---
'@zhushanwen/extension-protocol': patch
---

Widen the custom widget icon path whitelist to the complete SVG `d` command set:

- `validateWidgetIconPaths` now accepts `S`/`s`/`T`/`t` (smooth cubic /
  quadratic curve commands) on top of the previous `MLCQAZHV` command letters.
  The old charset rejected 58 of the 5869 `d` strings across the 1746
  `@lucide/vue` icons (~1%), so about 1% of valid shapes silently fell back to
  a built-in icon plus a warn. Visible to extension authors: a `{ paths }`
  value previously rejected as `illegal-char` may now validate.
- No other character is added — `e`/`E` (exponent notation) and every other
  non-command character stay rejected; the limits (at most 8 paths, 512 chars
  per path, 2048 chars in total) are unchanged.
