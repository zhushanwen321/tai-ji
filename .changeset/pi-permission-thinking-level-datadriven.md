---
"@zhushanwen/pi-permission": minor
---

classifier thinkingLevel 配置契约放宽并数据驱动：配置归一不再做七值白名单校验（非空字符串即采信，`ClassifierConfig.thinkingLevel` 类型放宽为 string）；LLM 分类调用时档位按该模型 supportedLevels 判定（pi-ai `getSupportedThinkingLevels`），模型不支持的档位按「不传 reasoning」处理并 warn 留痕，不再静默换档。
