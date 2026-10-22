# @zhushanwen/pi-provider-live-sync

## 0.3.0

### Minor Changes

- df839883b: 新增目录投喂职责：taiji 模型目录缓存（provider-catalog-overlay.json）经 pi.registerProvider 在扩展工厂体内注入运行中注册表，并作为第三个监视条目（mtime 比较）挂进既有 2s 轮询——上游目录新增模型在 pi 执行侧实时可见，修复 rename 静默跳过 / set_model 报 ENGINE_MODEL_MISSING / spawn --model 近似回退等 8 个同根因症状。

## 0.2.1

### Patch Changes

- 802af968f: Pin the pi peer dependency range to ^1.0.0 (smart-context also pins typebox; stale pi implementation anchors in comments refreshed to 1.0.0). No behavior change.

## 0.2.0

### Minor Changes

- 43a50ae2e: New package: live model-state sync for running pi processes. Polls the running pi process's provider/model snapshot every 2 seconds (content comparison, no network calls) and refreshes the host-side registry via `modelRegistry.refresh({allowNetwork:false})`, so model switches made inside a live session show up in the host UI in near real time — no session restart or manual refresh needed.
