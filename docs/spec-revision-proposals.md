# 移动壳 v2 spec 修订建议呈报清单（remote-use-mobile-v2 附录 A）

来源：remote-use-mobile-v2 设计包（v6）附录 A 汇总的 12 条 spec 修订建议。spec 现行契约存于
Open Design 目录（`spec.md` 19 节 + 38 条验收标准），不由本仓直接修改——本清单待用户确认后
逐条回写 Open Design 存档。每条给出：现行条款 → 建议修订 → 依据（设计文档节号，落地证据在
`packages/mobile-renderer/MIGRATION-RECONCILIATION.md` 与 docs/adr/decisions.md 对应 ADR）。

| # | 现行 spec 条款 | 建议修订 | 依据与落地形态 |
|---|---------------|---------|---------------|
| 1 | F16「表单/权限请求超时」 | →「请求失效（extension 域撤销通知 + plugin 域过期事件）」 | §6.4 / ADR-0176——extension 域无超时（runtime 既有裁决 + 超时默认原则禁墙钟），移动端消费 `extension:requestsInvalidated` 与 plugin 域既有过期事件；「请求已超时」通知仅在 plugin 域出现 |
| 2 | §16.9「自包含单文件 index.html」 | → 标注为 demo 预览专属约束，真实壳多文件产物 | §6.15——vite `base:'./'` 多文件标准形态，打包链路（E2E-REMOTE-02 mobile-dist extraResources）零变化；单文件形态不进真实壳 |
| 3 | §9.2 Connection 实体 `tokenCreatedAt` 字段；Session 实体 `turnStartedAt` | → `tokenCreatedAt` 字段删除（无 runtime 信号源，显示即造假）；`turnStartedAt` 不新增，回合计时为客户端派生 | §6.11 / §6.21——设置页连接信息客户端派生（主机 = location.host、网络 = Tailscale 网段判定、时长 = 本地记录）；计时 = 本回合 message_start 本地时刻，未订阅会话不显示计时 |
| 4 | §6.12 子代理详情「执行记录（步骤）」 | →「最近执行历史（会话消息派生）」；子代理状态显示按两态（running/idle）+ error 字段收窄 | §6.10 / §7.2——`session.getSubagentHistory` 最近消息派生（不新增 runtime steps 概念）；SubagentRecord 两态 + error? 是协议全集 |
| 5 | §17 草稿风险行「会话内持久化或返回二次确认」两个后续方向 | → 本设计均不采纳（返回丢弃保持 spec §7.3 字面），登记待后续产品裁决 | §6.23 / impl-plan 残留风险 4——聊天视图断连不卸载、草稿表覆盖切会话恢复；路由返回丢弃输入的范围保持 spec 字面，不扩大 |
| 6 | §4.1「进行中带待办计数」与 §1.2「只聚合当前活跃会话」内部矛盾 | → 收窄为：回合主体看当前活跃会话；「需要你处理」与底部导航计数聚合**全部会话**的可归属请求 + 无归属（进程级）请求全局呈现 | §6.18——权限请求归属为广播 payload 可选字段（`sessionId?`，additive 向后兼容）、缺失是一等分支；落地 = ActivityScreen 聚合 + BottomNav 计数同源 computed |
| 7 | F15.4「进入队列（queued）」措辞 | →「进入投递（活跃回合 steer 注入、持有窗口 queued）」；F6 保留状态机字面、补 steer 快速通过说明 | §6.22——队列条跟随 `session.delivery` 条目状态机（queued 可取消 / in-flight 不可取消 / failed 可重试），不预设「生成中 = 排队」；steer 注入使条目通常短现即隐 |
| 8 | §9.4 七类动作通知 | → 标注「壳层经 core 通知插入 API（六类 `appendSystemNotice`、会话重新打开走 `appendRespawnNotice`）插入会话分区、会话期间不消失、刷新/重开后不在历史中；文案为固定形态——允许/拒绝不带 scope、提交回答不带答案内容，插值仅子代理名」 | §6.20——内存态通知（重连保留、不入 pi 历史）；不新增 runtime 写入通道、不新造壳层插入路径；固定文案实证 = `packages/mobile-renderer/src/locales/zh-CN.ts` mobile.notices 六条 |
| 9 | F13「从失败步骤重新开始」 | →「重发最后一条用户消息（截断重发整轮）」 | §6.14——与实装 editAndResend 语义对齐（core 纯编排：truncateFrom → submitNewMessage，内部新 clientUuid）；失败条「重试」按钮独立入口，不依赖 hover |
| 10 | §7.2「路径只读展示」 | →「项目名 + 项目最近会话工作目录只读展示」 | §7.2 映射表——Project 实体无路径字段（`{id, name, lastUsedAt}`）；NewTaskSheet 项目 chip 的 cwd 派生自该项目最近会话的 SessionSummary.cwd |
| 11 | §9.3「非当前会话收到新消息置未读」 | →「该会话有**新投递或新终态**时置未读」 | §6.3——流式中间态与等待用户输入在客户端无信号源（session 级消息订阅定向，未订阅会话不可见）；触发 = `config.sessions` 广播 diff（lastActiveAt 推进 = 新投递、status 翻转 = 新终态），runtime 在 prompt 受理与回合终态两写点补发既有广播（不加新事件） |
| 12 | §11「单会话超过 200 条或 50 轮启用窗口化」 | →「按需加载语义：加载窗口化（游标扩窗）、渲染不虚拟化」 | §7.1——不引入桌面 virtua 虚拟化编排；已加载消息全量渲染、上界取舍显式声明（「加载更早」游标扩窗 + 前插保位；长会话滚动性能登记为独立优化项） |

## 回写流程

用户逐条确认（或逐条否决/修改）后，在 Open Design 目录对 `spec.md` 对应条款回写；本清单
不自动失效——全部条款回写完成后可归档。落地核对锚点：设计文档
`remote-use-mobile-v2.md`（§6 对应决策节）· `packages/mobile-renderer/MIGRATION-RECONCILIATION.md`
（老能力映射对账）· docs/adr/decisions.md ADR-0164 ~ ADR-0167。

## 回写记录（2026-10-27）

12 条已全部回写 Open Design 目录 `spec.md`（用户裁决：全部采纳）：

| # | 回写后的条款位置 | 说明 |
|---|----------------|------|
| 1 | F16「请求失效与撤销」 | 「超时」改为失效事件驱动：extension 域消费 `extension:requestsInvalidated`、plugin 域消费既有过期事件，「请求已超时」通知仅 plugin 域出现；§14 / §19 对应行同步收窄 |
| 2 | §16.9 + A28 | 自包含单文件 `index.html` 标注为 demo 预览专属约束，真实壳为 vite `base:'./'` 多文件产物 |
| 3 | §9.2（Session / Connection 实体 + 尾注） | `turnStartedAt`、`tokenCreatedAt` 字段删除，回合计时与连接信息为客户端派生 |
| 4 | §6.12 详情条 + §9.2 SubagentRun | 「执行记录（步骤）」改「最近执行历史（会话消息派生）」；协议收窄为 running / idle 两态 + error?，§14 对应行同步 |
| 5 | §17 草稿保留行 | 「会话内持久化 / 返回二次确认」两方向均不采纳，返回丢弃保持 §7.3 字面，持久化待后续产品裁决 |
| 6 | §1.2 + §4.1（同源：§4.3 底部导航、§7.4 需要你处理、§9.3 请求归属） | 矛盾收窄：回合主体看当前活跃会话，「需要你处理」与底部导航计数聚合全部会话的可归属请求 + 无归属（进程级）请求 |
| 7 | F15.4 + F6（同源：A38） | 「进入队列」改「进入投递」（steer 快速注入 / queued 时序窗口）；F6 补 `session.delivery` 状态机与「不预设生成中 = 排队」 |
| 8 | §9.4（表格文案 + 尾注；同源：F7、F8） | 标注壳层经 core 通知插入 API（六类 `appendSystemNotice` + `appendRespawnNotice`）；文案固定化，「已提交回答：X」→「已提交回答」、「已允许：scope」→「已允许本次权限请求」、「重试本轮…」→「已重发最后一条消息，重试本轮」，F7 / F8 同步 |
| 9 | F13 | 「从失败步骤重新开始」改「重发最后一条用户消息（截断重发整轮）」，对齐 editAndResend（truncateFrom → submitNewMessage、新 clientUuid）；重试为独立按钮入口 |
| 10 | §7.2 项目 chip | 「路径只读展示」改「项目名 + 该项目最近会话工作目录只读展示」（cwd 派生自 SessionSummary.cwd） |
| 11 | §9.3 未读行（同源：§19） | 「收到新消息置未读」改「有新投递或新终态时置未读」（`config.sessions` 广播 diff，runtime 两个写点补发既有广播） |
| 12 | §11（同源：§19） | 窗口化条款改按需加载语义：加载窗口化（游标扩窗 + 前插保位）、渲染不虚拟化，长会话滚动性能登记为独立优化项 |

全部条款已回写，清单可归档。联动修改（同一语义在 spec 内的重复表述处，共 9 处）：§14 两行（#1、#4）、§19 三行（#1、#11、#12）、A28（#2）、A38（#7）、F7 与 F8 通知文案（#8）。19 节结构与 38 条验收标准编号体系未变。
