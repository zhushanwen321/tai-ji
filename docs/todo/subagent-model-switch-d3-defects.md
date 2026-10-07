# subagent-model-switch D3 验收缺陷登记（2026-10-06 首轮真机验收产出）

状态：**全部完成（2026-10-07 收尾轮修复）**——缺陷一/二已修复（重验收轮覆盖）；缺陷三改判结案（判活链无需修复）；缺陷四已修（D5 F1-31，commit 729473960）；缺陷五/六已修（d4722ef38，manifest 派生视图补字段 + 转发面三源兜底）；缺陷七已修（9db5ccfc8，「记账已写」错误码分型落显示面）；顺带发现 1/3/9 已修或已固化，2 已收尾（0d36f0885，引用按 subagentId 裁决），4/5/6/7/8 已修（d4722ef38 / 48760fd27 / a9f07a942 / a9e83c742 / 465be54b9）。

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
- 根因链：effective 型回执只写 `displayState.effectiveModel` 不写 `overrideIntent`（`useSubagentModel.ts:193`）；badge 分支取 `overrideIntent ?? record.modelOverride`（`:103/:106`）；renderer `record.modelOverride` 刷新通道 = session.subagents 全量重推（`useMessageEffects.ts:205`），重推 = 派生缓存失效后增量重新拉取（`record-entry-appended` 主信号 + bg-notify 兜底触发，均经 `onRecordEntriesInvalidated`，轮边界发生——W18 起事件直写退役，登记时点（2026-10-07）误记 bg-notify 为唯一重推点）——轮内无重推 → 首次轮内热切的 badge 存在首个轮内空窗。
- 影响面：仅 badge 显示时延；标签本体、覆盖记账、切换语义均正确（A6br3 三源证据一致）。裁决方向：与 badge 数据流收敛方案合并评估——effective 型回执补写 overrideIntent，或 record.modelOverride 增量刷新通道。
- 已修（2026-10-07，D5 F1-31 裁决候选 A）：commit 729473960——effective 型回执同时写 `overrideIntent`（请求目标 ref；应答 wire 无意图字段，回执本身即该意图的受理凭证）；候选 B「runtime 切换后即时重推 records」为推送补偿、违反 ADR-0097，不采用。读取端生效值优先、意图承「用户覆盖中」标注（`useSubagentModel.ts` SubagentModelDisplayState 注释与 resolveSubagentModelDisplay 优先级链同步更新）；已记账型标签承接不变；useSubagentModel 单测 16 用例回归绿。

## 缺陷五：混合 run 聚合间歇性把 zcode 成员误归失败名单（2026-10-07 A7r2 实证）

- 现象：run-2 聚合应答把 zc1（zcode 成员）归入 failures 分型 `engine_state_readback_failed`，应属 not-applicable；间歇性（同场景 4/5 次正常）。
- 根因链：record 磁盘快照缺 `parentRunId` 字段 → 接线层抛无码 plain Error → 聚合对无码错误兜底分型 readback 失败，capability 预检未到达。与顺带发现 4 同族（快照派生视图失真家族）；GUI drawer 的 workflow 块未渲染同根（栈 `workflow-record-projection.ts:237`）。
- 已修（2026-10-07 收尾轮，commit d4722ef38）：① ManifestRecord 派生视图族补 `origin/parentRunId/stepIndex/modelOverride` 四字段（derived/terminal/adopted 三写面下行 + manifestToSubagent 读侧形状检查回读）；② `resolveMemberEnginePortForSwitch` 三源查找补 `findByIdManifestFallback`（zcode 成员无子 session 文件不在扫描集、settle 后出内存，bound 物化的 manifest 是其磁盘唯一载体）——三源全 miss 才进失败名单。回归锚 = record-store-round-manifest / model-switch-wiring 两测试文件的缺陷五用例。

## 缺陷六：聚合成员可见性时序 flake（2026-10-07 A7r2 实证，根因未定位）

- 现象：同 run 首次切换应答 members=[]（空）、重试非空——运行中成员存在静默漏切面（漏切成员只靠 run 级意图写入兜底，重派时记账仍到达，覆盖不丢）。
- 根因（收尾轮定位，与缺陷五同族）：zcode 成员 spawn 后的磁盘兜底载体 = bound 物化 manifest，派生视图缺 `parentRunId` → 按 `parentRunId` 过滤的 run 级成员查询（collectRecordsByParentRunId）必然漏掉；主 session 注册条目（entry 源）受 pi 落盘时序影响存在暗窗——窗口内四源全暗即 members=[]。重试可见 = 条目 flush 后 entry 源接管。
- 已修（commit d4722ef38）：manifest 派生视图携带 parentRunId + 每个意图写点（含 markModelOverride）同步刷新派生 manifest（水位写序构造性新鲜）——spawn 后任一时点至少一个磁盘载体对 run 级查询可见，暗窗结构性封住。

## 缺陷七：错误应答路径「用户覆盖中」badge 空窗（回读失败型，机制推断未实证，2026-10-07 登记待排期）

- 形态：缺陷四的修复（F1-31 候选 A，commit 729473960）只覆盖成功路径——effective 型回执写 overrideIntent 即时亮 badge；错误应答走 catch 分支不写显示态（设计明文），badge 依赖 record.modelOverride 载荷重推（轮边界发生），轮内不触发——与缺陷四同机制（推断，未单独实证）。
- 分型事实（实装处置表，`execution/service/model-switch.ts` catch 分支）：`engine_model_not_in_snapshot`（处置行 3）/ `engine_state_readback_failed`（处置行 7）= 写记账 + 错误应答——记账已写但轮内 badge 不亮，属空窗缺陷面；`engine_credential_missing`（§7.5 凭据行）= 不写 + 错误应答——badge 不亮是正确行为（切换整体未生效），不属缺陷。
- 修复前置 = 先定「哪些错误码代表记账已写（可亮 badge）vs 未写（不得亮）」的语义映射并落显示面：已写型错误应答补写显示态（overrideIntent 同款通道），或并入缺陷四裁决方向的 record.modelOverride 增量刷新通道一并评估。
- 已修（2026-10-07 收尾轮，commit 9db5ccfc8）：语义映射裁决 = 行 3/7 两码（`engine_model_not_in_snapshot` / `engine_state_readback_failed`）代表记账已写、`engine_credential_missing` 与全部校验型/通道型失败代表未写或未知。落地面 = shared 契约常量 `SUBAGENT_SET_MODEL_ACCOUNTED_ERROR_CODES`（显示面词表，机制权威注记指向 core 处置表）+ renderer catch 分支对 accounted 码写 overrideIntent（badge 与已记账型同通道亮灯，不等轮边界重推）；词表外错误码一律不写，行为与原形态一致。单测实证 = useSubagentModel 三用例（快照型亮灯 / 回读失败型亮灯 + credential_missing 不亮 / 无码不亮）——原「推断未实证」面随单测补全。

## 验收环境教训（非缺陷）

- 并行 inspect 共享单窗口 DOM：UI 输入通道全局唯一焦点，逐键注入与会话切换穿插交叉污染——多 agent 单窗口 UI 验收须预置时隙互斥协议；重验收轮按串行链编排（前一轮 A5 升级裁决已现场补课）。
- 凭据缺失变体结构性不可达：catalog 准入即凭据检查，§5.2 宿主预检分支无构造面（设计字面的构造前提不成立）；变体以同族校验型分型「目录无此模型」承接成立。

## 顺带发现（D3r3，非本设计范围，P2 已修/登记 2026-10-06）

1. **托盘已结束 tab 渲染崩（已修）**：`subagent-bucket.ts subagentDotClass` 对词表外/缺失 status 无检查，`SUBAGENT_DOT_RULES[undefined].find` 抛 TypeError → 已结束列表整列不渲染 + 全局错误 toast（证据 A4r3/r3-05、r3-08 截图 + renderer-error log 22:05-22:06）。修复 = 词表外/缺失兜底中性 accent 档 + 回归用例两枚。
2. **@新任务 directive record 缺 agent/slug 字段的展示与点击（已收尾，2026-10-07）**：directive 派发 record.json agent=None（sa-3dd4468b 实证）→ mention 候选行 "undefined · undefined"、空 slug 点击误入「新建」流。已修展示层（副行 direct 兜底 + 过滤缺省安全）；**空 slug 点击语义已收尾**（commit 0d36f0885，裁决 = 按 subagentId 引用——与发送链分流判据同键）：缺 slug record 的 mention chip 显示名回落 subagentId（与候选行同口径），「新任务」占位文案仅属新建项（subagentId 空串）。
3. **验收环境纪律（流程项已固化）**：runtime 修复 commit 晚于实例启动 = 修复未生效陷阱（tsx 非热载）——inspect 任务书开工自查项已入 D3r3-A4；后续验收 ENV 模板应含「实例启动时点 vs 修复 commit 时点」比对与强制重启条款。

## 顺带发现（D3r2-r4 补登记，非本设计范围）

4. **records .json 磁盘快照为陈旧派生视图（已修，2026-10-07）**：records/sa-*.json 快照 modelOverride=null / recentEffectiveModel=null / status=running(stale)，与 .events 的 override 帧及 runtime 内存派生视图不一致（A6br2 量化：第四轮完成后快照依旧 null/running）。**快照语义裁决 = 各意图写点的物化派生视图**（非创建时形态）：markModelOverride 写点同步刷新派生 manifest（事件帧先写、manifest 后写——水位构造性新鲜，commit d4722ef38）；读侧水位校验（mergeManifestRecords 对不上即跳过回落事件流重建）保持不变——权威面纪律不变：断言面锚 .events 帧 / journal / session 文件，快照 json 不作断言面。

5. **运行中实体在托盘子代理面板无行（已修，2026-10-07）**：A4r4 deviation「进行中 0 三次核验，同期 pi 进程活跃 + record-round-started 已发」。**产品语义裁决 = 运行中该有行**（托盘两桶结构 running/ended 本就如此设计，无「运行中无行」意图）。根因 = runtime 侧推送接收器丢报窗口：per-session 事件派生视图未建时 journal 报告被丢弃、依赖视图创建时的冷读收敛——而创建触发点全在轮边界，轮内实时事件全程到不了订阅方。修复 = applyJournalReport 视图未就绪时就地建视图后应用（attach 冷读已覆盖盘上事件、回放按 seq 水位构造性幂等，commit 48760fd27；回归锚 = session-records「派生视图未就绪时报告到达」用例）。

6. **zcode 引擎显式 personal provider 模型首派即败（已修，2026-10-07）**：app-server 侧报「Provider Registry 中不存在 Model」与引擎侧校验源不一致。根因（实机两文件对照核实）= 仅存在于 `~/.zcode/v2/provider_config.json` 的个人 provider（opencode-go-chat / new-provider-StepFun 两条，A7r2 失败模型 step-5-preview 即属后者）未物化进 v2 config 字典，launcher wrapper 只注入后者 → 注册表缺条目。修复 = wrapper 为带 apiKey+baseUrl 且 v2/real 均缺失的 rule 合成 cli-config 条目（形状照抄现网个人条目；contextWindow 来自 providerModelRules；禁用模型不进；无 baseUrl 的模板型 rule 不合成），引擎校验源经 `ZCODE_ENG_PROVIDER_CONFIG` 同锚（commit a9f07a942）。**遗留真机验证项**：合成条目的 `kind` 按 standard-personal 多数先例取 openai-compatible（provider_config.json 不携带协议形态）——错配时请求期协议错误可见，下次真机显式 personal 模型派发时顺带核验。

7. **composer 模型选择器同 short-id 歧义（已修，2026-10-07）**：同名 short-id 多候选时选择按裸 id 全局反查首中，可能落在错误 provider 的行。修复 = providerId 贯穿选择链（组级 providerId 随事件上行、高亮双匹配、触发器显示名复合串精确匹配；反查函数仅保留作无 providerId 自建分组的兜底，commit a9e83c742）。

8. **e2e global-setup 自动构建与真轨 pre-flight 检查的 dist 形态冲突（已修，2026-10-07）**：`e2e/fixtures/global-setup.ts` 自动构建恒注入 `VITE_MOCK=true`，真轨首跑撞 mock bundle 被 pre-flight 拒绝。修复 = 形态感知构建：REAL_TRACK_SPECS 抽共享模块（playwright project 匹配与 global-setup 同源），global-setup 按 argv 请求轨 + MOCK_BUNDLE_MARKER 探测当前形态，缺失或形态不符自动按正确形态重建并做构建后形态断言（commit 465be54b9；新 fixture 已登记 e2e-map E2E-REAL-01）。
9. **thinkinglevel-real spec reader 落后 ADR-0078 键名改名（已修，2026-10-07）**：registered 条目持久化键 b48d1a373 起 `journalPath→recordPath`，spec reader 仍读 journalPath → registered 恒 null → 三 TC 全挂（PLAYWRIGHT_DEBUG_KEEP_DATA 取证：条目在场、字段名不符）。修复 = reader/定位链/断言文案对齐 recordPath（2e2220113），重跑 3/3 绿。同族教训：持久化键改名未同步 e2e 资产、且该 spec 自改名后无人触发过（真轨按改动范围触发的盲区）。
