# docs 目录

xyz-agent 的文档统一存放于 `docs/`。按内容性质分目录，全项目共享。

> 文档分层理念（2026-09-13 docs 清理确立）：**局部信息进代码**——注释只写「为什么做/有什么坑/有什么好处」，不写「做了什么」；机器可校验的规则进 constraints.json / lint / hook，文档只留入口指针；docs/ 只保留全局视角内容（跨模块串联、决策史、行为规范）。行级为什么进代码注释，决策级为什么进 ADR（代码内挂 `// ADR-xxxx` 锚点回链）。

## 目录结构

```
docs/
├── README.md              ← 本文件，目录索引 + 治理规则
├── architecture.md        ← 系统架构总览（Electron 主进程 / Runtime / 渲染进程三层）
├── standards.md           ← 前端编码规范（原则层；lint 已强制的规则不重复转述）
├── troubleshooting.md     ← 问题排查（症状 + 命令 + 指针；机制细节归代码注释）
├── design-evolution.md    ← UI 设计演变史（Warm&Soft → v3 → v6 → 太极纯灰）
├── release-notes.md       ← 发布 notes 写作规范 + 待发布草稿暂存
│
├── adr/                   ← 架构决策记录（决策级「为什么」唯一家园；统一编号 + README 索引）
├── architecture/          ← 全局架构与契约（分层/数据治理/跨模块协议；被取代设计即删，git 可追溯）
├── extensions/            ← pi 扩展跨包约定（开发指南/强约束/日志规范/术语表/adr/）
├── page-design/           ← 前端设计 SSOT（v6-tokens.css 值权威 + v6-master-spec.md 范式权威）
├── testing/               ← 测试手册（分层策略/手工冒烟清单/mock 盲区表）
├── todo/                  ← 有效待办 + ext-simplify/ 待决策设计集
└── feature-map/           ← 功能规划全景（只留最新一份滚动）
```

## 文档归属判定

| 问题 | 去向 |
|------|------|
| 全项目通用的架构/规范/排错？ | 根级 `*.md` |
| 不可逆的架构/技术决策（被否方案/事故/外部约束）？ | `adr/`（ADR，带日期 + 状态 + 背景 + 裁决） |
| 跨 ≥2 个 package 的运行时机制/架构？ | `architecture/`（2026-09-13 design/ 并入：机制域规格与拓扑规格同目录，README 分组索引导航） |
| 单模块/单包的实现设计？ | **不进 docs/**——「为什么/坑」蒸馏进该模块代码注释（挂 `// ADR-xxxx` 锚点），已实施的过程内容删除（git 可追溯） |
| review/impl-plan/acceptance 等工作流产物？ | **不进 docs/ 也不进 git**——落本地 `.xyz-harness/<date>-<slug>/`（gitignored；2026-09-13 裁决：仓内不留决策档案，追溯靠 commit message 与 docs） |
| 竞品/技术调研？ | `~/Documents/xyz-agent-archive/`（不进 git） |
| 前端视觉/组件/页面设计？ | `page-design/`（值权威 = v6-tokens.css，hook 守卫） |
| pi 扩展跨包约定？ | `extensions/`；单 extension 行为文档进该包内 `docs/` 或 README |
| UI 设计演变历史？ | `design-evolution.md`（单篇汇总） |

**删除已收录文档的纪律**：删除任何 docs/ 文档前，先全仓 grep 引用（md 链接 / constraints.json authority / scripts / 源码注释），活引用改为「git 历史可追溯」标注或改指存活权威（代码/ADR/约束），同 commit 完成。`node scripts/check-doc-symbol-drift.mjs` 守卫文档-代码符号一致性。

## 关键文档入口

- [constraints.md](./constraints.md) — **架构约束登记表人读视图**（机器权威 = constraints.json；CR 动态加载经 `node scripts/select-constraints.mjs --base main`）
- [architecture.md](./architecture.md) — 系统架构总览
- [standards.md](./standards.md) — 前端编码规范
- [troubleshooting.md](./troubleshooting.md) — 问题排查指南
- [design-evolution.md](./design-evolution.md) — UI 设计演变史
- [adr/README.md](./adr/README.md) — ADR 索引（含旧→新编号映射）
- [page-design/README.md](./page-design/README.md) — 前端设计 SSOT 索引
- [architecture/README.md](./architecture/README.md) — 架构文档目录规范
- [extensions/local-dev-guide.md](./extensions/local-dev-guide.md) — pi extension 本地开发调试
- [extensions/gui-protocol-guide.md](./extensions/gui-protocol-guide.md) — extension GUI 协议接入

## 禁止放入 docs/

- xyz-harness 工作流产出物（spec / plan / test / retrospect / review / impl-plan）→ 本地 `.xyz-harness/<date>-<slug>/`（gitignored，不入库）
- 单模块设计文档 → 蒸馏进代码注释后删除（见上文归属判定）
- 一次性审查日志、已完成的修复记录 → 完成后删除（git 可追溯）
- UI demo / HTML 设计稿 → `page-design/`（禁止散落项目根或 `demos/`、`impeccable/` 目录）
- 竞品/技术调研资料 → 移到 `~/Documents/xyz-agent-archive/`（不进 git）
