# subagent-model-switch D3 验收缺陷登记（2026-10-06 首轮真机验收产出）

状态：未解决（D3 首轮验收 A1/A4/A6 节点产出；A2/A3 degraded 已含入口层降级说明；修复后须重验收覆盖）。

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

## 验收环境教训（非缺陷）

- 并行 inspect 共享单窗口 DOM：UI 输入通道全局唯一焦点，逐键注入与会话切换穿插交叉污染——多 agent 单窗口 UI 验收须预置时隙互斥协议；重验收轮按串行链编排（前一轮 A5 升级裁决已现场补课）。
- 凭据缺失变体结构性不可达：catalog 准入即凭据检查，§5.2 宿主预检分支无构造面（设计字面的构造前提不成立）；变体以同族校验型分型「目录无此模型」承接成立。
