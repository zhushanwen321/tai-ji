# reload // /new 替换窗真机复验 + supervisor 重启循环归因

状态：待复验（机制修复已落地并单测锁定，真机未复跑）。来源：subagent-workflow 体系登记 §1.4 / §6.1（notify 陈旧上下文崩溃，2026-09-30 三段组合修复；原文见该文件 git 历史）。

## 背景（现行机制）

pi 在会话替换（newSession / fork / switchSession / reload）时把旧 runner 标记失效（pi 语义断言 PS-30，探针随 pi 版本门禁重验）；轮终收尾链的 fire-and-forget promise 抛错曾因 pi rpc 模式无未处理拒绝处理器升格为进程 exit 1。三段修复已落地：根源消窗口（SessionBaselines pi 绑定代际 + 作废句柄读侧收 null）、通知/条目通道 best-effort 化（`isPiStaleCtxError` 分诊 + `bestEffortPiCall` 13 处）、轮终链断头 promise 消灭（`voidRoundFinalChain` 四处包装）。单测已锁窗口语义（session-baselines-pi-generation / best-effort-pi-call / conversation-continuation / chat-rounds-window-dispose 等测试锚点）。

## 待做

1. **真机复验替换窗**：在途 run 运行中触发 reload 与 `/new`（pi 替换与 taiji 侧 /new 命令两种入口），核对轮终条目落进替换后的新权威 session、无未处理拒绝、无进程退出。
2. **supervisor 重启循环归因**：原登记记录过「supervisor 重启循环约 6 分钟」现象，归因未核实（现场证据目录已不在盘上）。若真机复验中复现，按 pi stdout tee 日志（`<数据目录>/logs/pi-<date>-<sessionId>.jsonl`）取证归因；不复现则随本文件关闭销项。

## 关联

- reload 分支语义（只作废句柄判定、不动在途 run 纳管，adoption 接管设计不变）：见原登记 §1.4 修复 (a)（git 历史）。
- 日志落盘纪律：AGENTS.md「Runtime/pi 日志必须落盘 + 轮转」。
