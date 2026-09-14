---
'@zhushanwen/pi-scheduler': minor
---

scheduler: dispatch model simplified to steer direct-send (breaking):

- Scheduled messages now dispatch immediately via steer — they interrupt the
  agent's current turn instead of waiting for it to finish; delivery is no
  longer delayed or batched
- The `force` tool parameter is removed (all tasks share the same
  immediate-dispatch semantics; passing force now fails parameter validation)
- Fixes a defect where messages during agent idle periods were delayed by
  exactly ~10 minutes (dispatch-tracking marker never cleared due to a
  settle-before-mark timing inversion); the entire delayed-delivery path is
  removed along with its bug surface
