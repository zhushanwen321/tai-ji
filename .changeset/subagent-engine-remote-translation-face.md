---
"@zhushanwen/subagent-core": patch
---

补齐 staged 引擎 cli 形态的翻译面缺口（ADR-0142）：引擎 manifest 新增可选 modelTranslation 段，RemoteEngine 按声明装配/摘除 translateModelRef 成员（纯查表改写，与 capabilities/modelCatalog 同款注册期快照模式）——此前该成员仅在 in-process 引擎类实装，桌面端派发层翻译整体静默失效，偏好层死值直穿引擎侧报错；派发层编排新增生效回执：翻译面缺席按引擎一次告警，不再静默。
