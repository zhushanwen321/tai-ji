# @zhushanwen/pi-provider-live-sync

## 0.2.0

### Minor Changes

- 43a50ae2e: New package: live model-state sync for running pi processes. Polls the running pi process's provider/model snapshot every 2 seconds (content comparison, no network calls) and refreshes the host-side registry via `modelRegistry.refresh({allowNetwork:false})`, so model switches made inside a live session show up in the host UI in near real time — no session restart or manual refresh needed.
