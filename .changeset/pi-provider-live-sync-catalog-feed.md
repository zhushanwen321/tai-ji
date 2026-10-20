---
"@zhushanwen/pi-provider-live-sync": minor
---

新增目录投喂职责：taiji 模型目录缓存（provider-catalog-overlay.json）经 pi.registerProvider 在扩展工厂体内注入运行中注册表，并作为第三个监视条目（mtime 比较）挂进既有 2s 轮询——上游目录新增模型在 pi 执行侧实时可见，修复 rename 静默跳过 / set_model 报 ENGINE_MODEL_MISSING / spawn --model 近似回退等 8 个同根因症状。
