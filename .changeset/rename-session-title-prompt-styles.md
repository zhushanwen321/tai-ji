---
"@zhushanwen/pi-rename-session": minor
---

feat: support configurable title prompt styles (slug / sentence / emoji / custom)

新增 style + customInstruction 配置面（rename-prompt-config 设计）：非 custom 枚举风格映射内置词表（slug 现状行为 / sentence 完整短句 ≤20 字 / emoji 点缀开头 ≤15 字），custom 消费用户自定义自由文本（空串回落内置 slug 默认，systemPrompt 降级为输出契约骨架以消解双处风格冲突）。GUI 配置页经 runtime config.get/setRenamePrompt 读写，pi CLI 用户可直接改配置文件。maxTitleLength 语义不变。
