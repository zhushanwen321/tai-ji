# Release Notes 写作规范（xyz-agent 特化补充）

> **通用写作规范 SSOT 已上移全局**：`~/.agents/guide/release-notes.md`（受众定位、三节结构、条目写法、双语格式 [MANDATORY] 的权威源）。merge 流程阶段 5 撰写 notes 前必读全局指引 + 本文档。
>
> 本文档只保留 xyz-agent 特有部分，与全局指引互补不重复。

## 展示位（本项目消费场景）

Release note 面向**应用使用者**，两个消费场景共用同一份 body：

- 升级按钮 hover 浮层（Sidebar UpdateButton，360px 宽、最高 360px、12px 字号，超长即滚动）——`useAppUpdate` 按用户语言提取 `<!-- LANG:xx -->` 段后渲染
- GitHub Release 页面

## 与工具的关系

`merge/scripts/release.sh` 不指定 `--notes` 时会自动生成草稿：双语三节骨架与全局规范一致，但条目是 conventional commit 原文直出（feat → 新增功能、perf → 功能优化、fix → 修复缺陷、breaking → 重大变更），**没有**全局规范的模糊化、30 字、排序与合并约束，chore/test/docs 类被过滤。脚本会在生成后提醒定稿：按全局规范手写后用 `gh release edit <tag> --notes-file <双语文件>` 覆盖。

## 待发布草稿

> 本节存放**待随下次发版并入正式 release note 的条目草稿**（设计文档验收条款要求的指引先落于此，merge skill 阶段 5 定稿时按全局规范并入，并入后清空本节）。npm 包侧（CHANGELOG / deprecate 文案）随发版流程另行处理，不在本节。

（空——2026-09-02 v0.9.12 发布时已将 base-tool-enhance 卸载指引草稿并入正式 note，来源 architecture/file-lock-unification-and-reaper-sink.md §3.3 D2）
