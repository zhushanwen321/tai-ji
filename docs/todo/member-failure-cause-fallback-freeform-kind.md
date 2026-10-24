# memberFailureCauseOf 回落分支产出自由文本 kind

状态：待裁决（2026-10-24 登记，A11 第三轮 S3a 实测发现）。

## 现象

`packages/subagent-core/src/orchestration/run-member-settlement.ts` 的 `memberFailureCauseOf`：`result.failure` 缺席时回落 `engine.<error 冒号前段>`——错误文本无冒号前缀协议码时产出**自由文本 kind**（S3a 实测：坏 agent 路径 → cause = `engine.Agent file not found or unreadable`，含空格）。

## 与契约的差距

函数注释承诺「error 前缀**引擎协议码**（`engine.<code>`）」；设计 §3.3.8 的 failedMembers[].cause 为受控点拼形态 `<class>.<kind>`。自由文本 kind 使下游按受控词表消费 cause 的形态失守（展示面可读性可接受，机读面不可判别）。

## 待裁决选项

1. 受控词表化：无冒号前缀协议码时 kind 收敛为 `unknown`（原文保真进 failure.raw / 通知正文，机读面不产自由文本）——与 FailureCause 的 unknown 保守缺省同方向。
2. 维持现状：展示面受益于自由文本可读性，机读面消费方登记豁免。

## 附带登记

main supervisor 的 runtime health 等待窗（`HEALTH_RETRY_COUNT=30 × 200ms` ≈ 6s）对 tsx 冷启动过紧——机器高负载（load ~29）时 runtime.port 超窗不落，真机批次间歇性启动失败。正常负载无碍；若后续再发，校准方向 = 窗口放宽或健康探测改条件轮询。
