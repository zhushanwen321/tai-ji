---
name: taiji-renderer-optimize
description: >-
  Use when 简化或优化 taiji 前端（renderer）代码：前端性能优化、渲染性能、
  消息列表/聊天流卡顿、streaming 卡顿、组件简化、清理 renderer 重复代码、
  renderer 简化/性能审查、taiji-renderer-optimize、前端简化。特化范围 =
  packages/renderer + packages/core（domain chat / foundation）+
  packages/ui（features/chat）。内置项目既有性能范式清单（virtua 虚拟滚动 /
  三层节流 / shallowRef 分区 / 增量 markdown），防止重复提议已实现的优化、
  防止"优化"破坏既有范式。用户只要"找机会/哪里能简化"时按 scan 模式只产候选清单。
  taiji renderer 范围内的简化/性能请求本 skill 优先于 code-simplify。

  Not for 找 bug、架构重构（用 improve-codebase-architecture）、
  跨项目通用简化（用 code-simplify）、runtime / pi extension / Electron main 层优化。
---

# Taiji Renderer Optimize

taiji 前端（Vue 3 + Pinia + Tailwind v3 + @taiji/ui 太极设计系统）的特化代码简化与局部性能优化。继承 code-simplify 的铁律，叠加项目范式守护。

## 核心原则

1. **先理解再改**：动任何一行前先弄清"为什么这么写"（Chesterton's Fence，查 git blame / ADR / 代码注释中的 `[HISTORICAL]`）。本项目大量代码形态是事故换来的（ADR-0039 shallowRef、ADR-0049 Map 分区、standards §2.2 refCount），看着"绕"的写法大概率有历史原因。
2. **行为严格不变**：只改"怎么做"，不改"做什么"。要改测试才能过的简化 = 改坏了行为，撤销。
3. **清晰 > 简洁**：目标是"新成员看懂更快"，不是行数变少。
4. **不破坏既有性能范式**：优化建议命中「已有范式，勿重复提议」清单（`references/renderer-map.md` §3）= 误报，直接丢弃。
5. **范围收敛 + 确认后改**：默认只动用户指定范围，不做路过重构；先报告，用户确认才动手。

## 路由

| 用户意图 | 应加载的文档 | 备注 |
|---------|------------|------|
| 开场（被触发时） | `references/workflow.md` | fix 模式（默认）：定范围 → 审查 → 报告 → 确认后改 |
| 只要找候选（"找找哪里能简化"/"找死代码"/"前端哪里能优化"） | `references/workflow.md` 步骤 0 的 scan 模式 | 只产候选清单，不改代码 |
| 审查该看什么信号（简化向） | `references/simplify-signals.md` | 项目特化简化信号：范式一致性 / 样式三层 / 组件规范 |
| 审查该看什么信号（性能向） | `references/perf-signals.md` | 项目特化性能信号 + A/B 行为分档 + 测量与覆盖率护栏 |
| 需要结构地图 / 判断某建议是否重复造轮子 | `references/renderer-map.md` | 渲染链路、既有性能范式、深度 watch 清单、验证命令 |

## 关键约束

- [MANDATORY] 被触发后**必须 read** `references/workflow.md` 判模式并执行，禁止凭正文直接开改。
- [MANDATORY] 审查者（无论单 agent 还是并行）**必须 read** 对应的 signals 文件 + `references/renderer-map.md` §3（已有范式清单），禁止凭通用前端经验提议——本项目的消息流已是 virtua 虚拟滚动 + 三层节流 + 增量 markdown，通用建议（"加虚拟滚动"/"加节流"/"markdown 加缓存"）全是误报。
- [MANDATORY] 先报告、确认后改。报告命中后等用户确认再应用修改。
- [MANDATORY] 简化不得削弱项目范式：per-session 状态必须走 `useSessionScopedState` Map 分区（ADR-0049）、多实例事件订阅必须走模块级 refCount（standards §2.2）、消息体必须 shallowRef 不可变替换（ADR-0039）。"把 Map 分区简化成单实例"、"把 shallowRef 换成 reactive 更直观" 这类建议 = 破坏范式，禁止提出。
- [MANDATORY] 性能优化只做局部（函数/组件/语句级），架构级改动（改渲染链路、改 store 结构、改事件通道）不在本 skill 范围，发现架构级问题只记录并指向 `improve-codebase-architecture`。
- [MANDATORY] 任何纯删除类简化必须评估覆盖率 gate 影响（renderer vitest coverage 阈值 lines 68 / stmts 66 / branches 56 / funcs 60，删代码会拉低覆盖率），见 `references/perf-signals.md` 护栏节。

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 来自实际事故的规则 | **不允许删除或削弱**。只能补充，不能降低要求 |
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可按需调整 |

「先理解 / 行为不变 / 不破坏既有范式」三条为 [MANDATORY] 铁律，任何模式下不可关闭。
