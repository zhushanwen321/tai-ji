---
"@zhushanwen/pi-ask-user": patch
---

跨包握手标识与 subagent-core 对齐：channel registry 的 `Symbol.for` slot key 由 `@zhushanwen/pi-subagents.channelHandshake` 改为 `@zhushanwen/subagent-core.channelHandshake`（core `GLOBAL_SLOT_KEYS` 同值）。需与 subagent-core / subagent-workflow 同批升级；混装旧版时两侧 slot 不共享，握手会降级 warn 并重建通道。
