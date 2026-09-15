# Flow 3 · 主 Agent 编排多子 Agent（护城河）

**类型**: L3 Flow（时序 + L4 联动矩阵）· 产品差异化主路径
**关联**: ADR-0020、flow-2-code-review/spec.md（单 agent 主路径，本 flow 是其并行编排升级）、panel/spec.md（Process Panel v1 已删，子 agent 编排走 Side Drawer）
**配套 HTML**: `draft-cases.html`（编排屏幕样例）
**依据**: 多 agent 并行编排是产品护城河——单 agent 对话（Flow 2）谁都能做，并行调度 + 进度聚合 + steer 是壁垒。

## 目标

用户下达一个较大的编码任务，主 Agent 将其拆解为多个可并行子任务，派发给多个子 Agent 并行执行，实时聚合进度，按需 steer/中断，最终汇总合并结果。这是 Flow 2（单 agent 串行）的并行编排升级版。

## 与 Flow 2 的差异（核心）

| 维度 | Flow 2 单 agent | Flow 3 多 agent 编排 |
|---|---|---|
| 执行 | 串行，一条消息流 | 并行，主 + N 子 agent |
| 进度 | 单进度（tool call 序列） | 多进度聚合（progress-zone 升级） |
| 控制 | 中断整个 agent | steer/中断单个子 agent |
| 结果 | 单变更集 | 多子结果 → 主合并 → 变更集 |
| 呈现 | 消息流 | 消息流 + Side Drawer（SubAgent Detail） |

## 屏幕序列

### S1 · 任务拆解 + 派发
- 用户下达大任务（如"重构 auth 模块，拆 OAuth/Session/Token"）
- 主 agent 思考拆解，产出**派发计划**（派几个子 agent、各管什么、依赖关系）
- 消息流出现 subagent 块（design-system 卡片）：列出 N 个子 agent 的分工
- 用户可确认 / 调整派发计划后再执行（用户控制，Nielsen #3）

### S2 · 并行执行 + 进度聚合
- N 个子 agent 并行启动
- **progress-zone 升级**：从单 session 进度 → 多进度聚合（每子 agent 一条进度 + 整体进度）
- 各子 agent 的 tool call / thinking 流式回传到各自的 SubAgent Detail（Side Drawer 内，默认收起）
- 主 agent 消息流保持安静（只显编排态：派发/完成/失败事件）

### S3 · 子 agent 完成 / 失败（实时回传）
- 单个子 agent 完成 → 进度条变 success，结果摘要回传到主消息流
- 单个失败 → 进度条变 danger，错误回传，主 agent 决定重试 / 跳过 / 求助
- 不阻塞其它子 agent（并行独立性）

### S4 · 查看 SubAgent Detail（Side Drawer）
- 用户点某子 agent 进度条 / subagent 块 → Side Drawer 展开，切到该子 agent 的 Detail
- Detail 内：该子 agent 的完整消息流（thinking / tool call / 文本 / 子变更集）
- 可在 Drawer 内审查该子 agent 的 diff（复用 Flow 2 的 Diff 审查抽屉）

### S5 · steer / 中断单个子 agent
- 用户可对某个运行中的子 agent 下达 steer（调整方向）或中断
- steer 经 composer 的 steer 态（依赖 composer-states）下发，只影响该子 agent
- 中断 = 该子 agent 标 stopped，已完成的部分保留

### S6 · 汇总合并
- 全部子 agent 完成 → 主 agent 汇总各子结果
- 合并冲突时主 agent 协调解决（或求助用户）
- 产出统一变更集 → 进 Flow 2 的 Diff 审查流程（S4-S5）

## 子 Agent 状态机

```
dispatched → running → done
                ↓         ↓
            stopped    superseded（主 agent 又派了替代）
                ↓
            failed / timeout
```

- **dispatched**: 已派发，未启动
- **running**: 执行中（progress-zone 实时进度）
- **done**: 完成，结果已回传
- **stopped**: 用户中断（保留已完成部分）
- **failed**: 执行出错（错误回传，可重试）
- **timeout**: 超时（默认阈值，可配）
- **superseded**: 主 agent 用新子 agent 替代（旧结果归档）

## L4 联动矩阵（主 ↔ 子 agent 数据流 + 控制流）

| 主 agent 动作 | 子 agent 反应 | UI 呈现位 |
|---|---|---|
| 派发计划确认 | N 个 dispatched | 主消息流 subagent 块 + progress-zone |
| —（并行） | running，流式回传 | progress-zone 进度条 + Side Drawer（收起） |
| 收到子 done | 摘要入主消息流 | 主消息流 + progress-zone success |
| 收到子 failed | 决定重试/跳过/求助 | progress-zone danger + 主消息流错误 |
| 合并冲突 | 协调或求助 | 主消息流 conflict 块 |
| 用户 steer 子 | 只影响该子 | composer steer 态 + 该子 Drawer |
| 用户中断子 | 该子 stopped | progress-zone stopped |
| 全部 done | 汇总 → 变更集 | 主消息流变更集卡（Flow 2 衔接） |

## 边缘状态

| 场景 | 处理 |
|------|------|
| 子 agent 之间有依赖 | 派发计划标注依赖图，前置未完成则后续 waiting |
| 子 agent 改同一文件 | 合并阶段冲突，主 agent 协调或求助（S6） |
| 子 agent 超时 | 标 timeout，可手动续跑或放弃 |
| 子 agent 失败重试 | 新子 agent 标 running，旧的 superseded 归档 |
| 用户中途加新子任务 | 主 agent 评估后追加派发（不影响已运行的） |
| 全部失败 | 主 agent 汇总错误报告，求助用户 |
| 子 agent 数量 >8 | progress-zone 折叠显示（"另有 N 个"），详情进 Drawer |

## 对现有 demo 的增量

- **progress-zone 多进度聚合**：升级 panel/companion-zones 的 progress-zone（单 → 多）
- **SubAgent Detail**：panel/detail-pane 的 Side Drawer 形态（子 agent 专属）
- **subagent 块**：panel/message-types 已有该块类型，本 flow 定义其编排语义
- **steer 态**：依赖 panel/composer-states 的 steer 形态

## 约束（不可违背）

- **不出现 Process Panel**（v1 已删）——子 agent 编排全部走 Side Drawer + progress-zone，不另起独立 Panel
- **主消息流不被子 agent 噪音淹没**——子 agent 的细粒度 thinking/tool call 只进 Drawer，主消息流只显编排事件
- **用户控制**（Nielsen #3）——派发计划可确认、单个子 agent 可 steer/中断，不是黑盒
- **依赖 panel 4 叶深化**：composer-states（steer）/ companion-zones（progress 升级）/ detail-pane（SubAgent Detail）/ message-types（subagent 块）—— 本 flow 基于其当前 draft 设计，panel 定稿后需复核联动点

## 遗留

- 派发计划的可视化形态（列表 / 依赖图）待定——初版列表，复杂依赖再考虑图。
- 子 agent 超时默认阈值（建议 5 分钟，可配）待定。
- 合并冲突的主 agent 自动协调策略边界（哪些可自动、哪些必须求助）待定。
- 多子 agent 并发的资源限制（同时跑几个）待定——建议上限 5，超过排队。
