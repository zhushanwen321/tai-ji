# ADR-0015: statusline plugin 封装 pi extension setStatus

- 状态：Accepted

> **编号说明**：原误用 0014 编号，与 [ADR-0014 SessionData 本地文件持久化](archive-digest.md#adr-0014)（archive-digest）碰撞。2026-06-20 顺移至 0023（与 0013 SessionData over pi appendEntry 主题不同的独立决策，session-data 系列保留 0013/0014 连续编号）。

## 上下文

pi extension 的 `ctx.ui.setStatus()` 事件需要到达 xyz-agent 前端渲染 statusline。有两条路径：直接在 event-adapter 翻译后发给前端，或通过 xyz-agent plugin 系统中转。

## 决策

新建 statusline built-in plugin 作为适配层：event-adapter 将 setStatus 翻译为 `extension.status_update` → plugin 监听此事件 → 解析文本 → 通过 `api.ui.updateStatusBarItem()` 转发到前端。前端不直接消费 pi 的 setStatus 原始数据。

## 理由

1. **关注点分离**：pi extension 不知道 xyz-agent 存在，xyz-agent plugin 负责翻译和丰富数据
2. **可扩展性**：未来新 pi extension 的 setStatus 自动被 plugin 系统感知，无需改前端
3. **一致性**：所有 statusline 数据（无论来自 pi 还是 xyz-agent plugin）走同一 `plugin:statusBarUpdate` 通道，前端只需一套渲染逻辑
