---
"@zhushanwen/pi-llm-shared": minor
---

thinkingLevel 校验改为归一透传：移除 `isThinkingLevel` 七值白名单谓词，新增 `normalizeThinkingLevel`（非空字符串原样返回，其余返回 undefined）。不再自持档位词表——配置合法性的判定归属写入侧 UI 与 pi 运行时按模型 supportedLevels 判定，词表外档位不再被本层静默换成默认档。
