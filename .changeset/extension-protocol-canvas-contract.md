---
"@zhushanwen/extension-protocol": minor
---

Add the problem-solving canvas protocol contract as a new `extensions/canvas` module: CANVAS_MARKER request envelope with guards, the 16-action canvas vocabulary with a per-action × actor permission matrix, the six-tool mapping, CanvasState / CanvasNode / CanvasEdge / ReviewReport schemas, the domain event vocabulary with ACTION_EVENT_MAP, an error-code table with recovery hints, and per-action params runtime guards (including argument polarity and materiality checks). Single source shared by the pi-canvas extension (writer), the runtime CanvasService, and the renderer canvas views.
