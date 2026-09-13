# Plugin System Documentation

插件系统全部设计、实现和规划文档的索引。

**plugin 渲染体系已落地**（renderer-rebuild-v2 P4/P5 + 2026-08 M17 wave 全部交付）。现行权威入口：

- 协议 SSOT：[extension-gui-protocol.md](../../extension-gui-protocol.md)（§4 五个渲染入口的 GUI 镜像 / §4.3 widget → M17 对话流面板 / §15 挂载实现现状）
- 架构：[renderer-rebuild-architecture.md](../../renderer-rebuild-architecture.md) §6（ExtensionHost / 挂载点注册表 / contribution schema v2）
- 视觉规格：`docs/page-design/v6-spec-plugin-rendering.html`（组件级权威）与 `docs/page-design/v6-plugin-max-demo.html`（全景 mockup）

2026-08 的执行设计集（原 `plugin-rendering/` 目录，六文件：挂载点/view 概念分离、drawer 旧 widget 适配废弃、slash 收编、M16 接线、M17 widget 面板）已全部交付并删除，git 可追溯；关键决策记录见 extension-gui-protocol.md §13 决策日志（含 M17 挂载点定稿）。本目录保留 2026-05 期的融合设计；进度类文档（status / roadmap / remaining-work / extension-audit，原归档于 history/）与外部参考分析（pi-extension-analysis.md / vscode-extension-analysis.md）已于 2026-09-13 删除，git 可追溯。

## 阅读顺序（新成员推荐）

1. plan.md（已删除，git 可追溯）— 分阶段实施计划
2. design-part1.md（已删除，git 可追溯）— 架构设计（Worker 隔离、RPC、生命周期）
3. design-part2.md（已删除，git 可追溯）— API 设计、contributes、安全模型
4. [built-in-plugin-guide.md](built-in-plugin-guide.md) — 内置插件开发指南

## 相关 ADR

插件系统的关键架构决策记录在 [`../../../adr/`](../../../adr/) 目录：
- ADR-0007 ~ ADR-0013
