---
"@zhushanwen/pi-llm-shared": minor
---

新增目录缓存判据模块 catalog-overlay：taiji 目录缓存与 pi store 两份缓存文件的解析、条目级新者胜合并、三态判定（fresh / expired / never-seen）与注入集并集计算，纯函数零 IO——扩展侧目录投喂的判据单点；导出面新增 getTaijiOverlayCachePath / getPiStorePath / getCatalogOverlayState / getCatalogGeneratedAt / mergeEntriesNewerWins / parseOverlayCache / computeInjectionSet 及配套类型。
