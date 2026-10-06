# subagent-model-switch D3 验收缺陷登记（2026-10-06 首轮真机验收产出）

状态：缺陷一/二已修复（重验收轮覆盖）；缺陷三改判结案（判活链无需修复）；缺陷四/五/六未解决（待裁决立案）；顺带发现 1/3 已修或已固化，2 部分修（空 slug 点击语义待产品裁决）、4/5/6/7 待裁决。

## 缺陷一：chat 域模型切换入口点击不可达（U1 入口层，验收节点 A6 实证）

- 现象：`subagent-model-trigger` 点击三次均不弹出模型 popover，chat 域成员的 UI 切换路径整体不可用。
- 根因：`SubagentTab.vue:78-93` 的 ModelSelectPopover `#trigger` 具名 slot 传裸 `Button`，未包 `PopoverTrigger as-child`（`ModelSelectPopover.vue:16-29` 无 slot 包裹逻辑）；`SubagentTab.model-label.test.ts:71-72` mock 掉 ModelSelectPopover 组件，点击行为零覆盖（三视角缺一不可红线的「使用者黑盒」缺席实例）。
- 修复方向：trigger slot 内容包 `PopoverTrigger as-child`（WorkflowTab.vue 同款检查）；补一条真实渲染点击用例（不 mock ModelSelectPopover）。

## 缺陷二：网关会话归属判定在多会话共享 cwd 时误路由（U6 适配器，验收节点 A4 实证）

- 现象：`SubagentModelSwitchGateway.resolveSessionMeta` 的 record 分支按 `getSubagentRecordsDir(agentDir, s.cwd)` 共享目录存在性判定归属，同 cwd 多会话全部命中 `sessions.find` 第一个（scanSessions mtime 序）——请求被路由到非归属会话的 pi 进程，宿主 `getRecordForAction` 归属校验拒绝。并行多会话场景必现；单会话正常使用不可现。
- 修复方向（A4 建议）：record 分支改按 record 事件帧 rootSessionId（或会话 id 精确匹配）判定归属，目录存在性只作快速过滤不作归属裁决。

## 缺陷三：chat 域执行中热切降级记账型（已改判结案，2026-10-06 专项调查）

- 初判（A1 自报）：宿主镜像判活与 chat 每轮新进程形态不匹配，执行中切换全部降级记账型。
- **改判（专项调查，置信度 high）**：「镜像缺注册」不成立——chat 域 runChatRoundViaEngine 恒构造 resume.recordId（chat-rounds.ts:467-497），childSpawned 反向帧键 = record.id（server.ts:275-279），桥接进 core 镜像（engine-client.ts:83-94），chat/workflow 都注册、轮内镜像项存在（spawn-runner.ts:500-508 agent_settled 才回收）。A1 两次 captured NOT_ACTIVE 均落轮间（记账型合法）；两次轮内尝试死于网关共享 cwd 误路由 + 信封失配（缺陷二同源，已修），从未到达判活门。同 build 同日反证：A4 变体2 轮内命中引擎错误码、重试已生效型；A5 子场景② chat 轮内热切回执生效值。
- 结论：判活链无需修复；A1 归因错误的根源 = 验收时序未锚定轮内 + 当时的网关缺陷。重验收轮 A1 须以轮内探针锚定切换时点（单轮长任务 + 发切换前探针 record running + session 尾条非收尾；探针证轮内而仍 recorded 才记缺陷）。

## 缺陷四：轮内首次热切后「用户覆盖中」badge 轮内空窗（时延自愈型，2026-10-07 A6br3 实证）

- 现象：轮内热切后主标签即时更新且值始终正确，但「用户覆盖中」badge 缺席约 4 分钟（切 1 00:09:12 → 轮 1 idle 后 00:13:17 在场），轮终自愈非恒缺；切 2/3 badge 即时在场（切 1 的覆盖已随轮 2 round-started bg-notify 预先入 store）。
- 根因链：effective 型回执只写 `displayState.effectiveModel` 不写 `overrideIntent`（`useSubagentModel.ts:193`）；badge 分支取 `overrideIntent ?? record.modelOverride`（`:103/:106`）；renderer `record.modelOverride` 刷新通道 = session.subagents 全量重推（`useMessageEffects.ts:205`），重推点 = bg-notify（`event-interpreter.ts:772`）——轮内无重推 → 首次轮内热切的 badge 存在首个轮内空窗。
- 影响面：仅 badge 显示时延；标签本体、覆盖记账、切换语义均正确（A6br3 三源证据一致）。裁决方向：与 badge 数据流收敛方案合并评估——effective 型回执补写 overrideIntent，或 record.modelOverride 增量刷新通道。

## 缺陷五：混合 run 聚合间歇性把 zcode 成员误归失败名单（2026-10-07 A7r2 实证）

- 现象：run-2 聚合应答把 zc1（zcode 成员）归入 failures 分型 `engine_state_readback_failed`，应属 not-applicable；间歇性（同场景 4/5 次正常）。
- 根因链：record 磁盘快照缺 `parentRunId` 字段 → 接线层抛无码 plain Error → 聚合对无码错误兜底分型 readback 失败，capability 预检未到达。与顺带发现 4 同族（快照投影失真家族）；GUI drawer 的 workflow 块未渲染同根（栈 `workflow-record-projection.ts:237`）。
- 裁决方向：record 快照投影补 parentRunId（或聚合对 engine 路由成员先走 capability 预检再判引擎错误），与顺带发现 4 合并立案。

## 缺陷六：聚合成员可见性时序 flake（2026-10-07 A7r2 实证，根因未定位）

- 现象：同 run 首次切换应答 members=[]（空）、重试非空——运行中成员存在静默漏切面（漏切成员只靠 run 级意图写入兜底，重派时记账仍到达，覆盖不丢）。
- 裁决方向：查聚合 members 收集的时序源（活进程窗与可见窗错开的具体环节），确定「可见性」契约后收敛。

## 验收环境教训（非缺陷）

- 并行 inspect 共享单窗口 DOM：UI 输入通道全局唯一焦点，逐键注入与会话切换穿插交叉污染——多 agent 单窗口 UI 验收须预置时隙互斥协议；重验收轮按串行链编排（前一轮 A5 升级裁决已现场补课）。
- 凭据缺失变体结构性不可达：catalog 准入即凭据检查，§5.2 宿主预检分支无构造面（设计字面的构造前提不成立）；变体以同族校验型分型「目录无此模型」承接成立。

## 顺带发现（D3r3，非本设计范围，P2 已修/登记 2026-10-06）

1. **托盘已结束 tab 渲染崩（已修）**：`subagent-bucket.ts subagentDotClass` 对词表外/缺失 status 无守卫，`SUBAGENT_DOT_RULES[undefined].find` 抛 TypeError → 已结束列表整列不渲染 + 全局错误 toast（证据 A4r3/r3-05、r3-08 截图 + renderer-error log 22:05-22:06）。修复 = 词表外/缺失兜底中性 accent 档 + 回归用例两枚。
2. **@新任务 directive record 缺 agent/slug 字段的展示与点击（部分修）**：directive 派发 record.json agent=None（sa-3dd4468b 实证）→ mention 候选行 "undefined · undefined"、空 slug 点击误入「新建」流。已修展示层（副行 direct 兜底 + 过滤缺省安全）；**空 slug 点击语义未修**（insertSubagentChip 消费契约需产品裁决：按 subagentId 引用还是视为新建）——登记待裁决，验收路径以 WS 直发替代（A4r3 已证可行）。
3. **验收环境纪律（流程项已固化）**：runtime 修复 commit 晚于实例启动 = 修复未生效陷阱（tsx 非热载）——inspect 任务书开工自查项已入 D3r3-A4；后续验收 ENV 模板应含「实例启动时点 vs 修复 commit 时点」比对与强制重启条款。

## 顺带发现（D3r2-r4 补登记，非本设计范围）

4. **records .json 磁盘快照为陈旧投影（立案待裁决）**：records/sa-*.json 快照 modelOverride=null / recentEffectiveModel=null / status=running(stale)，与 .events 的 override 帧及 runtime 内存投影不一致（A6br2 量化：第四轮完成后快照依旧 null/running）。UI 标签数据源为 runtime 派生不受影响；影响面 = 任何以磁盘快照为断言面的文件级检查。裁决方向：确认快照语义（创建时形态 or 应同步投影）——若属投影写回缺口，归 record-store 快照写面（ADR-0078 管辖）；断言纪律 = 权威面锚 .events 帧 / journal / session 文件，快照 json 不作断言面。
5. **运行中实体在托盘子代理面板无行**（A4r4 deviation：进行中 0 三次核验，同期 pi 进程活跃 + record-round-started 已发）——运行中实体的 drawer 入口经对话流 subagent block 可达、托盘不可达；是否立案 = 托盘产品语义裁决（运行中该不该有行），非缺陷定性。
6. **zcode 引擎显式 personal provider 模型首派即败**（A7r2）：app-server 侧报「Provider Registry 中不存在 Model」与引擎侧校验源不一致；引擎缺省模型可跑，切换记账仍正确到达。裁决方向：统一两侧模型解析源。
7. **composer 模型选择器同 short-id 歧义**（A7r2 辅助观察）：同名 short-id 多候选时选择指向不明确；fixture 以显式钉模型规避，非阻塞。
8. **e2e global-setup 自动构建与真轨守卫的 dist 形态冲突（2026-10-07 A13 首跑实证）**：`e2e/fixtures/global-setup.ts:45` 自动构建注入 `VITE_MOCK=true`（服务 mock 轨），而 electron-real 的 launch-real 守卫拒绝含 mock fixture 标记的 renderer bundle 并要求「VITE_E2E=true 且不传 VITE_MOCK」——两轨共享同一 dist 路径、自动构建形态只会满足 mock 轨；worktree 首次跑真轨（dist 缺失触发自动构建）必踩。本轮回避 = 手工 `VITE_E2E=true pnpm run build:e2e` 重建后重跑。裁决方向：按轨分 dist 或按 project 感知构建形态。
9. **thinkinglevel-real spec reader 落后 ADR-0078 键名改名（已修，2026-10-07）**：registered 条目持久化键 b48d1a373 起 `journalPath→recordPath`，spec reader 仍读 journalPath → registered 恒 null → 三 TC 全挂（PLAYWRIGHT_DEBUG_KEEP_DATA 取证：条目在场、字段名不符）。修复 = reader/定位链/断言文案对齐 recordPath（2e2220113），重跑 3/3 绿。同族教训：持久化键改名未同步 e2e 资产、且该 spec 自改名后无人触发过（真轨按改动范围触发的盲区）。
