---
"@zhushanwen/pi-subagent-cli": minor
---

Prompt 送达回执制度化 + fd3 raw 镜像（relay-spawn-transport M2/M3，ADR-0145）：

- 新增 prompt-ack tracker：pi 的 prompt response 是唯一成功回执（`success:true` + disposition `started` / `queued` / `handled` 三态皆受理），stdout 活性只取消「写入后 30s 完全零输出」计时器（`TAIJI_SUBAGENT_PROMPT_ACK_TIMEOUT_MS` 可覆盖/关闭）——零输出 → `engine_prompt_not_delivered`、`success:false` → `engine_prompt_rejected`（带 pi error 文本）、stdin 不可用 / EPIPE 立即失败；**不自动重试**（prompt 可能已产生副作用）。
- 新增 fd3 raw stdout 镜像写入：`TAIJI_ENGINE_RAW_MIRROR=1` 宣告后按字节层行切分写 `{v,recordId,seq,b64}` NDJSON 到 fd3，per-recordId 进程级单调 seq，写失败/队列超限丢弃计数（不阻塞主链，live 流是派生视图）。
- spawn 环境形状随之调整：control env 取代 relay env，任务 pi env 出站契约与 `TAIJI_ENGINE_RAW_MIRROR` 剥除由测试锁定。
