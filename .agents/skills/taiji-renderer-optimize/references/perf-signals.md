# Perf Signals — renderer 特化性能信号与护栏

只做组件/函数/语句级的局部性能优化，不碰架构。本文件只列 **renderer 特化**信号；通用性能信号（循环不变量外提、list→Set 索引化、中间集合削减、重复外部调用合并等）照常适用——完整通用清单在 `~/.agents/skills/code-simplify/references/perf-signals.md`，有权限时读它，读不到就按上述类别自行覆盖，不得因读不到而跳过通用信号审查。

## 边界

| 类别 | 内容 |
|------|------|
| 允许（局部） | 组件内计算缓存、watch/computed 粒度收窄、局部查找索引化、渲染函数内不变量外提、局部 Promise.allSettled 并行化 |
| 排除（架构级） | 改渲染链路（Virtualizer/delta-coalescer/markdown 增量）、改 store 结构（shallowRef 分区）、改事件通道、新增全局缓存模块、worker 化 |
| 灰区规则 | 同文件常量外提算局部；新建模块承载缓存算架构。发现架构级问题只记录并指向 improve-codebase-architecture |

## 行为分档

skill 铁律是"行为严格不变"，一部分性能优化天然改变可观察行为，先分档再动手——铁律覆盖简化与 A 档；B 档是唯一显式例外（须用户确认行为差异），B 档提案不属于"简化"范畴。

| 档 | 优化类型 | 处置 |
|----|---------|------|
| A 档（行为不变） | 纯计算消除重复、不变量外提、查找索引化、无副作用的合并 | 走 fix 流程 |
| B 档（行为敏感） | watch 触发性收窄（`deep` 改浅、`immediate` 去掉、flush 时机改）、节流/合帧参数调整、computed 惰性化（首次求值时点后移）、并行化（错误聚合粒度变）、keep-mounted/虚拟化参数调整 | 显式列出行为差异，用户确认后才可应用；无法确认时保持提案形态 |

**renderer 特有提醒**：watch/computed 的"简化"几乎都是 B 档——收窄监听范围改变了更新时机，属于可观察行为变化。

## 信号清单

### 响应式粒度

- **新增 deep watch**：本 skill 三包范围内已知 deep watch 仅 3 处（全仓 4 处，清单与口径见 `renderer-map.md` §4），范围内新增第 4 处必须论证必要性；能对浅 ref 替换监听就不用 deep。
- **把 shallowRef 换成 reactive / ref 深解包**：违反 ADR-0039（深响应式代理曾致 70-500MB 内存压力），是性能回退不是简化。
- **大对象放进 reactive()**：消息列表、turn 缓存等大集合必须 shallowRef + 不可变替换；reactive 大对象 = 深代理开销。
- **computed 里做 O(n) 以上昂贵计算且无缓存**：streaming 期间每 token 触发重算；先看是否能复用增量缓存（messageTurns/markdown 前缀段），不能再提局部 memo。
- **模板里调用方法（`{{ fmt(x) }}`）做昂贵计算**：每次 render 重算，候选改 computed（注意 computed 也是 B 档敏感——依赖未覆盖全时会少更新）。

### 列表与渲染

- **v-for 缺稳定 `:key`** 或用 index 做 key 的动态列表：patch 期间全量重排。
- **Virtualizer 子项 props 每次 streaming 都新建对象**：破坏引用恒等导致视口内历史 Turn 被 patch——应走 `toRenderItemsIncremental` 的缓存路径。
- **事件处理器内重复 DOM 查询 / 布局读写交错**：读写分离（通用信号，消息流滚动区尤甚）。
- **reka ScrollArea 横向滚动**：默认 `overflow-x: hidden`，需 `horizontal` prop；用 `:deep()` 覆盖是反模式（破坏 reka Root 渲染顺序）。

### 订阅与定时器

- **事件 handler 里做重活**（parse、stringify、大数组 filter）：`api/events.ts` 的 `safeForEach` 保证单 handler 抛错不中断，但慢 handler 会阻塞同事件其他订阅者——重活移出 handler（队列/idle）。
- **setInterval/setTimeout 未随 scope 清理**：split mode 多实例叠加触发；应 `onScopeDispose` 清理。
- **轮询**：renderer 原则上事件驱动，新增轮询是审查点（确认是否有对应事件通道可用）。

### 异步与 IO

- 独立数据源串行 await → `Promise.allSettled`（B 档：错误聚合粒度变）。
- 渲染路径上的 `JSON.stringify` 大对象（trace 展示除外）——检查是否每次 render 重复序列化。

### 反向信号（过度优化，不算候选）

- computed 包裹廉价计算（一次字符串拼接、单属性访问）。
- 给冷路径（设置页、一次性初始化）加缓存/惰性——牺牲可读性换不存在的性能。
- 对已实现三层节流的链路再叠一层节流——见 `renderer-map.md` §3。

## 护栏

- [MANDATORY] **热路径证据准入**：候选必须先证明在热路径。renderer 的热路径 = streaming 消息追加链路（每 token）、消息列表 render/patch、滚动跟随、Composer 输入。冷路径（设置、启动一次性逻辑、手动触发的命令）优化是负收益，不提。
- [MANDATORY] **先测量后优化**：本项目**无现成 benchmark**。可用测量手段：Playwright 连 dev app（`http://localhost:9222`）做 profile / 耗时打点、`console.time` 探针、测试断言渲染/重算次数（增量渲染参照 `src/__tests__/markdown-renderer-incremental.test.ts`；virtua 场景参照 `src/__tests__/effects/use-virtua-follow.test.ts` 与 `components/panel/message-stream/__tests__/MessageStream.wire.test.ts` 的 `_virtua-mock-helper.ts` 用法）。无测量手段的候选只列不改。
- [MANDATORY] **B 档候选不默认套用"行为不变"铁律**：显式列出行为差异，用户确认后才可应用。
- [MANDATORY] **覆盖率 gate**：renderer vitest coverage 阈值 lines 68 / stmts 66 / branches 56 / funcs 60（`packages/renderer/vitest.config.ts`）。纯删除类简化会拉低覆盖率——删除前评估是否跌破阈值，跌破则要么同步补测试要么放弃该候选。
- [MANDATORY] **dev 冒烟闸门**：凡动到模块加载期代码（import 结构、顶层副作用、CSS 变量引用），验证必须含 `node scripts/dev-smoke.mjs`——mock 轨 E2E 验证不了模块加载期副作用（[HISTORICAL] 2026-06-30 事故）。
- [OPTIONAL] 性能改动后测试通过只证明行为不变；收益陈述需 profile/打点证据，禁止"应该会更快"。
