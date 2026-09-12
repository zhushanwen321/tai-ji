# Plugin System Documentation

插件系统全部设计、实现和规划文档的索引。

**当前落地设计**见 [plugin-rendering/](../../plugin-rendering/README.md)（2026-08 总纲）；本目录保留 2026-05 期的融合设计与外部参考分析，进度类文档（status / roadmap / remaining-work / extension-audit）已归档至 [history/refactor-2026-06/subsystems-plugin/](../../history/refactor-2026-06/subsystems-plugin/)。

## 阅读顺序（新成员推荐）

1. plan.md（已删除，git 可追溯）— 分阶段实施计划
2. design-part1.md（已删除，git 可追溯）— 架构设计（Worker 隔离、RPC、生命周期）
3. design-part2.md（已删除，git 可追溯）— API 设计、contributes、安全模型
4. [built-in-plugin-guide.md](built-in-plugin-guide.md) — 内置插件开发指南

## 参考分析

- [pi-extension-analysis.md](pi-extension-analysis.md) — pi extension 系统逆向分析
- [vscode-extension-analysis.md](vscode-extension-analysis.md) — VS Code extension 系统参考

## 相关 ADR

插件系统的关键架构决策记录在 [`../../../adr/`](../../../adr/) 目录：
- ADR-0007 ~ ADR-0013
