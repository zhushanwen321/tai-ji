# docs/todo 可直接开工清单（just-do-it）

状态：执行中（2026-10-23 自 docs/todo/ 45 份登记文档整理归并；修复方向均已明确，按批次派发实施）

本清单承载「修复方向明确、无需设计裁决」的待办。每条含来源、位置、修复内容、验收标准。条目完成后在行首标记 `[x]` 并附 commit；全部完成后本文件转收尾记录，随下次 docs/todo 清理处置。

执行纪律：

- 涉及写测试的任务：vitest（禁 `node:test`），从子包目录运行；新测试的写删目标必须 `mkdtempSync` 自建自删
- 改完跑受影响包的增量测试 + typecheck；不跑全仓扫描
- 行号以当前 HEAD 为准，登记行号漂移时按符号名定位
- 修复中发现登记与现状不符（已修/已不存在），不改代码，在汇报中说明并标记条目关闭

## 批次 1（已完成：T1=69c0b0818 T2=33bf7a018 T3=f18fe0a6a T4=9365b6f77 T5=0c81f904c）

### T1 CI 与钩子配置批

- [x] **条目 1（dmg-r3-3）** mobile-renderer typecheck 补 CI：`.github/workflows/ci.yml` typecheck job 增补 mobile-renderer typecheck step（本地 quality-gates 已覆盖，CI 对齐）。来源 dev-0.11.10-review-residue。
- [x] **条目 2（N-4-typegate）** core 包类型门禁：`.github/workflows/ci.yml` typecheck job 增补 `TypeCheck - core` step（`pnpm --filter @taiji/core run typecheck`）；`.githooks/install-hooks.sh` FRONTEND_FILES 正则扩含 `packages/core`。来源 dev-0.11.6-review-residue。验收：注入类型错的用例不再静默通过（可本地模拟验证正则匹配）。
- [x] **条目 3（check-prompt-outposts）** 修复 `scripts/__tests__/check-prompt-outposts.test.mjs` 中 4 条红测试：fixture 改为直接 import `.githooks/check_prompt_outposts.py` 的 `OUTPOST_CALLSITES` 常量生成注入内容（消除指纹漂移，长期方案）；测试文件读 Python 常量可用正则提取。修完把该测试加进 `.github/workflows/ci.yml`「Test - scripts guards」步骤固定文件清单。来源 check-prompt-outposts-test-drift。验收：该测试文件全绿，CI 清单含此文件。补充：实测真实根因是检查脚本 10-04 加的 staged 交集使 fixture 树必然空扫描（顺带使 CI 全量扫描步静默恒绿），已随 69c0b0818 一并修复（--root/--all 跳过 staged 交集 + CI 步改 --all）。

### T2 canvas 批

- [x] **条目 4（零发现轮停摆）** reviewer 零发现轮永不推进轮次：`ReviewReport` 聚合补「本轮 run 已完成写回」的事实字段（如 `lastRunRound`，随 review-append 事件落盘，保持直写与重放等价；禁止占位假条目——会污染 entries 全部消费方），`roundHasReport` 据此对零发现轮成立，恢复轮次推进与 max-rounds 终态判定。位置：`extensions/taiji/canvas/src/review.ts`（:81、:220-223）、`packages/runtime/src/services/canvas/canvas-review-actions.ts`（:24-26、:53、:65-69）、`packages/extension-protocol/src/extensions/canvas/state.ts:157`。补测试：reviewer 零发现（空 entries / 全 dropped）后再发起应推进轮次；达 maxRounds 触发 max-rounds 终态。来源 canvas-review-round-zero-finding-stall。
- [x] **条目 5（基线债登记）** `docs/architecture/runtime-layering.md` §3 ④ 基线债清单按既有批次格式补 canvas-service.ts 条目：fs 使用点（events.jsonl appendFileSync / canvas.json writeFileSync 与 atomicWrite / exports writeFileSync / 启动扫描 readdirSync / 目录 mkdirSync）+ 同族形态（对齐 gen-stats-store 存储落盘族）+ 收编路线（随 ports 收编统一迁移）。位置参照 `packages/runtime/src/services/canvas/canvas-service.ts:25-26`。来源 canvas-service-fs-baseline-debt-registration。验收：登记格式与清单内既有条目一致。

### T3 subagent-workflow 扩展批

- [x] **条目 6（cancel 回执缺失）** subagent streaming 态 cancel 成功路径不写结果文件，runtime 消费侧报 handler_error（5 轮确定性复现）。修复（方案 A，从源头修复）：`extensions/universal/subagent-workflow/src/interface/command/subagents.ts` 的 rpcCancel 成功路径（`service.cancel(recordId)` 返回 true 时）补写 `{scope:"ok"}` 结果文件，写法对齐同文件 rpcMessage 的成功回执先例。不改 runtime 消费侧判定（`packages/runtime/src/services/session/session-records.ts` 的「文件不存在判回执缺失」语义保持）。补单测锁定成功路径写回执。来源 subagent-cancel-receipt-race。
- [x] **条目 7（保留键误判嵌套 required）** `missingRequiredKeysOf` 提取缺失键时未过滤 `instancePath`，嵌套 required 同名键被误报进「保留键通道被占用」解释文案。修复：仅收集 `instancePath === ""` 的顶层缺失键，嵌套缺失归普通缺参原样透出。位置：`extensions/universal/subagent-workflow/src/interface/tool/tool-workflow.ts`（missingRequiredKeysOf :599、reservedKeyChannelError :574）。补用例：嵌套 required 缺失不触发保留键解释。来源 workflow-reserved-key-channel-nested-required。

### T4 zcode-subagent-cli 批

- [x] **条目 8（ADR-0143 表述）** `docs/adr/decisions.md:770` 括号内「oauth 同时存在时 identity 不参与凭据查找」与代码条件不一致（代码：`authSource === 'manual' || !oauthBacked` 时 identity 仍参与 manual 查找）。改写为「仅 `auth-source==='oauth'` 时 identity 不参与查找；`manual` 形态即使 oauth token 同时存在仍按 manual 判定」，与代码逐字对齐。来源 dev-0.11.7-review-residue。
- [x] **条目 9（N-1 回退调用点锚）** `packages/zcode-subagent-cli/src/appserver-launcher-patches.ts:193-196` 回退调用点锚取全文件首个匹配、无 count 检查，同名函数双调用点时静默假 armed。修复：与定义锚同口径统计 `callAnchor` 出现次数，>1 放弃本锚；补「两处同款调用点 → not armed」变体用例。来源同上。
- [x] **条目 10（N-2 陈旧行号）** `docs/architecture/data-source-registry.md:170` 重写副本行 5 处陈旧行号（deriveZcodeEngineModels、removeStaleCopyOrOutcome、wrapper merge catch、piSyncedProviderConfigPath、defaultZcodeProviderSyncPaths）替换为符号名（消除行号漂移）。来源同上。
- [x] **条目 11（N-3 无锁 RMW）** `appserver-launcher-patches.ts:301→:398-406` 快照读与写回之间 GUI 权威写入可能被陈旧值覆盖。加固修复：写回前重读，两键（identity/auth-source）当前值与快照不同则放弃本次写入（compare-and-skip）；`docs/adr/decisions.md:770` 并发边界补一句「矫正可能因陈旧快照放弃写入，恢复 = 重新登录/配置」。来源同上。
- [x] **条目 12（DG-R2-01 多 plan api-key）** `appserver-launcher-patches.ts:340-348` 多 plan api-key 时 derivedIdentity 取首个永不自愈。修复：优先用 `project-key-location:v1:[...]` 键内嵌 identity 作确定性信号；多候选时不猜测，保留既有 stored identity 并 log 歧义；补双 account fixture。来源同上。
- [x] **条目 13（DG-R2-02 原型链键）** `appserver-launcher.ts:208-218`（seen）与 `:117-119,142,166`（injectable）普通对象字典丢弃 `__proto__`/`toString` 类 provider id。修复：改 `Object.create(null)` 或 `Set`，`realProviders` 查找用 own-property 检查；merge 对账矩阵补 `__proto__`/`toString` 用例。来源同上。
- [x] **条目 14（DG-R2-03 补用例）** `appserver-launcher.test.ts` 补最高风险分支用例：oauth 在场 + 登录写入 identity + 无 api-key 时不得改写（`!oauthBacked` 条件检查拦截改写）。fixture：`oauth:bigmodel:access_token` + identity `uid-login` + 无 `account:uid-login:api-key` → 断言无写入且 identity 保留。来源同上。
- [x] **条目 15（S-20 文档表述）** `docs/extensions/subagents/engine-development-guide.md:53` 修「与 modelCatalog 行同款三态登记体例」互斥表述与「非非空字符串」笔误。来源同上。

### T5 ui 包批

- [x] **条目 16（S-3 v-memo deps）** `packages/ui/src/features/chat/composables/use-turn-trace.ts` 组块 v-memo deps 缺 `header.failedCount` 与成员内容指纹：deps 追加 `unit.header.failedCount`（`Turn.vue:192`「组块七项」注释同步改）；补成员内容指纹 dep（如 `unit.members.map((m)=>m.block.ref).join('|')`）；补回归测试（takeover + 未变化成员复用同一对象引用时失败 chip 不滞旧）。来源 dev-0.11.6-review-residue。
- [x] **条目 17（N-3 测试顺序脆弱）** `packages/ui/src/rendering-protocol/primitives/container-registry.ts` 模块级 Map 无 reset，`--sequence.shuffle` 6 跑 5 红。修复：加 `resetPrimitiveContainers()`（测试专用），`__tests__/PrimitiveRouter.test.ts` beforeEach 调用（或把「barrel 未加载」两用例拆独立文件，二选一，优先 reset 方案）。验收：`--sequence.shuffle` 跑绿。来源同上。
- [x] **条目 18（mobile 死 keyframes）** `packages/mobile-renderer` 的 tailwind.config 删除 wiggle / pulse-strong / ask-user-slide-up 三组零消费 keyframes（删前 grep 全仓确认零引用）。来源 mobile-token-mirror-divergence（登记的动画清理小项）。

## 批次 2

### T6 renderer 会话状态批

- [ ] **条目 19（S-4 数据编排门控）** `packages/renderer/src/composables/panel/useSubagentDrawerTabs.ts`：`enteredFrom === null` 时 activate/close 跳过停流与加载编排（隐性分叉）。修复：数据编排改挂 `activeTab` 变化（或解除 enteredFrom 门控），保证语义不依赖入口来源。来源 dev-0.11.4-review-residue。
- [ ] **条目 20（S-5 空串分区）** 同文件 activate/close 入口补 `if (!focusedSid.value) return`，杜绝 `''` 键退化分区。来源同上。
- [ ] **条目 21（N-1 清除分区键不一致）** `clearSubagentSelection` 清 current 分区而其余读写以 focusedSid 为键。修复：加可选 sid 参数走 `updateFor(sid)`（或注释声明前提，优先前者）。位置：`useSubagentDrawerTabs.ts` + `packages/core/src/domain/drawer/selection/subagent.ts`。来源同上。
- [ ] **条目 22（S-9 对拍单测）** `packages/shared/src/subagent.ts:756` 注释声称与 subagent-core 本地类型副本「逐字段等值」但未给副本路径。修复：注释补副本路径；补双侧字面量对拍单测（shared 与副本字段级比对）。来源同上。

### T7 renderer 设置与归档批

- [ ] **条目 23（dmg-r3-2 无调用方导出链）** `packages/renderer/src/composables/features/sidebar/useSidebarSessionActions.ts`：`onDeleteSession` 全仓零调用点，其唯一依赖 `options.deleteSession` 为它而设。删除 `onDeleteSession`（:107 定义 / :307 导出），`deleteSession` 依赖降级可选或移除（:43/:66）；核对两个测试文件的间接引用并同步更新。来源 dev-0.11.10-review-residue。
- [ ] **条目 24（dmg-r3-4 in-flight 收编）** `packages/renderer/src/composables/features/sidebar/useArchiveView.ts` 的 `refreshArchives` 手写 in-flight 去重违反 C-data-18（`createInflightDedup` 收编禁令）且无豁免登记。收编进单点；先核对 trailing 补充拉取语义是否为该工具已覆盖形态，不覆盖则补工具能力（不留双轨、不登记豁免）。来源同上。
- [ ] **条目 25（SG-8 reconcile 入口）** `packages/core/src/domain/settings/use-provider-edit.ts` + `provider-edit-form.ts`：form module 新增 `reconcile(fresh)` 公共入口（统一分流 id 变化 / 同 id 刷新），补幂等 store watch 与「仅 prop 变化」契约测试；完成后删除 `providerRef` watcher 的同 id 早退分支（JSDoc 契约随之更新）。来源 dev-0.11.7-provider-reveal-review-residue。

### T8 归档链批

- [ ] **条目 26（零消息 session 归档）** 归档前主文件不存在时报错。修复（按登记倾向）：主文件不存在 → 直接成功返回（空归档语义，幂等），簿记 name 回退 sessionId；报错文案通道删除。先读 `archive-service.ts` 归档入口现状再改。来源 archive-edge-inputs-failfast。
- [ ] **条目 27（符号链接 cwd 归档）** 归档单元目录按 cwd 编码、symlink cwd 与 pi 落盘路径编码不一致导致报错。修复：归档入口对 cwd 做 `realpathSync` 归一（与 pi 落盘同编码）；核对恢复路径（`sessionOriginalPath` 按簿记 cwd 推导）两侧一致性。来源同上。
- [ ] **条目 28（GUI 归档收尾 watch）** GUI 侧栏归档路径不收尾 completion-watch，父 agent watch 挂起至 runtime 重启。修复：`SessionDeathDisposition` 增 `'archive'` 值（`session-lifecycle.ts`，现为 `'delete' | 'suppress'`），归档 teardown 改发 `'archive'`；组合根（`packages/runtime/src/index.ts`）对该值统一 `speakSessionDeath(sid, 'exit')`，GUI 与 agent 工具两入口同判。位置：`session-lifecycle.ts`、`packages/runtime/src/index.ts`、`packages/runtime/src/transport/session-manager-handler.ts`（handleArchive，JSDoc 登记的缺口）、`session-message-handler.ts`（handleSessionArchive）、`archive-service.ts`（teardownForArchive → fireSuppressDisposition）。补测试：GUI 归档路径触发 disposition 收尾。来源 archive-watch-settlement-gap。

### T9 runtime 同步链批

- [ ] **条目 29（S-8 镜像触发位置）** `packages/runtime/src/transport/oauth-message-handler.ts:51-62`（provider-message-handler.ts 同形态）：镜像触发在 logout `try` 内 `ok:true` 之后，同步 throw 会走 catch 回第二份 `ok:false`。修复：镜像触发挪出 try（或 try 外独立 try-catch），失败不吞掉主结果、单独上报。来源 dev-0.11.7-review-residue。
- [ ] **条目 30（S-9 迁移后镜像）** `packages/runtime/src/services/startup-background-init.ts:285-310`：legacy provider migration 完成后无镜像触发。修复：补 `zcodeProviderMirrorSync` 依赖并在迁移完成后触发镜像同步。来源同上。
- [ ] **条目 31（S-13 sync wiring）** `packages/runtime/src/services/zcode-provider-sync-wiring.ts:82-86`：`defaultZcodeProviderSyncPaths()` 挪进 `try` 内；`:136-145` drain 补单轮 catch（单 listener 失败不中断其余 drain）。来源同上。
- [ ] **条目 32（S-7 注释补缺）** 三处注释补齐：`packages/subagent-core` 的 `registry.ts:88` 快照余项注释补 `modelTranslation`；`port.ts:236-244` translateModelRef 注释补 manifest/remote 形态；`services/ports/provider-credential-resolver.ts:54-57` resolver port 注释补 sync 消费方。来源同上。
- [ ] **条目 33（S-21 注释补缺）** `packages/runtime/src/transport/settings-message-handler.ts:61-67` 注释补 `refreshProviderCatalogs` 与凭据域触发点。来源同上。
- [ ] **条目 34（S-1 判据统一）** account 家族清单判据跨包漂移：`runtime/services/zcode-provider-sync.ts` 与 `zcode-subagent-cli/src/preparer.ts`（readAccountFamilyRules / pushAccountFamilyRuleModels）去重粒度与空 builtinModelIds 回落语义相反。统一为：模型级去重 +「数组在位即用（含空），缺键才回落 personal」，任一侧注释登记对齐点。来源 dev-0.11.4-review-residue。
- [ ] **条目 35（S-6 凭据断言锚定）** `packages/runtime/src/services/zcode-provider-sync.ts:322-330` 与 `runtime/src/services/auth/provider-credential-resolver.ts:142-155` 第二处 pi 凭据断言未锚定。修复：锚 `auth-storage.js:207-220`（pi 实装版本），或注释声明 skip 为独立 fail-closed 判定。来源 dev-0.11.8-review-residue。

### T10 extensions summary 契约批

- [ ] **条目 36（S-1 单行契约）** `details.summary` 单行契约被 4 处违反：`extensions/universal/goal/src/adapters/goal-control-adapter.ts:163-169`、`todo/src/model.ts:373-378`、`ask-user/src/types.ts:133-138`、`scheduler/src/tool.ts:191-201`。修复：截断前归一单行（复用 `plan/src/tool.ts` 的 toSingleLine 模式，各包本地实现或提共享 helper），补用例。来源 dev-0.11.8-review-residue。
- [ ] **条目 37（S-2 列表去重）** `todo/src/model.ts:429-435` delete summary 未去重，渲染前 `[...new Set(ids)]`。来源同上。
- [ ] **条目 38（S-3 代理对安全截断）** `goal-control-adapter.ts:166-168` 与 `base-tool-enhance/src/render-result.ts:66-68` UTF-16 截断可劈开代理对。统一 code-point-safe 截断（与条目 36 共享 helper）。来源同上。

## 批次 3

### T11 runtime index 与 subagent-control 批

- [ ] **条目 39（S-12 字面量手抄）** `packages/runtime/src/index.ts:1205-1209` 与 `:1492-1496` 三依赖字面量手抄两份。抽模块级常量单点定义，工厂头注「单处组装」改写为事实。来源 dev-0.11.7-review-residue。
- [ ] **条目 40（DC-8 降级推送）** runtime `markDegraded()` 只改态不发布，drawer 已打开且无 chunk 时用户看不到降级提示。修复：markDegraded 时发布 `session.subagentStreamDegraded {sessionId, recordId}` 广播，renderer 经 event-bus 应用到同一 per-(virtualId, recordId) 位（`useSubagentTabData` 摄入）。位置：runtime infra/subagent-control + renderer useSubagentTabData。补单测。来源 subagent-control-delivery-residue。
- [x] **条目 41（DC-12 双 spawn）** 共享 control 客户端按 `(socketPath, rootSessionId)` 复用导致非缺省引擎首轮 probe→run 双 spawn + 3s close grace。修复（选项 a，数据正确性优先）：把权威 rootSessionId 注入 probe/read/setModel 调用（消除键不一致）；位置 `packages/subagent-core/src/.../transport/control-client.ts`。来源同上。
- [x] **条目 42（hasPendingFrames 无调用方导出）** `runtime/src/infra/subagent-control/outbound-queue.ts` 的 `hasPendingFrames` 无调用方（删前 grep 全仓确认零引用），删除。来源同上（D5 卫生项）。
- [ ] **条目 43（tmp 残片扫描）** `runtime/src/infra/subagent-control/pid-file.ts` 的 `.pid.tmp-*` 残片不在 sweep 扫描范围（只扫 `*.pid`）。sweep 扫描模式扩为含 `.pid.tmp-*`。位置：`sweep.ts:39-113`。来源同上。

### T12 subagent-control infra 批

- [ ] **条目 44（S-9 listen 探活）** `runtime/src/infra/subagent-control/control-server.ts:378-388` + `sweep.ts:46`：当前 socket 路径被 sweep 跳过 → 崩溃残片 + pid 复用 → `EADDRINUSE` 致命。修复：listen 前对当前路径探活（尝试连接，通则报致命冲突，不通则清理后 bind），必须保留 pid 复用 fail-fast 语义。补用例。来源 dev-0.11.8-review-residue。
- [x] **条目 45（S-10 recordId 接线）** `frames.ts:76` 的 `launch.recordId` 生产恒不写 → `findDescendantIds()` 死路径。修复：从 `RemoteEngine.run` / `ctx.taskId` 接线写入 recordId（位置 `packages/subagent-core/src/.../transport/control-client.ts:195-207`、`runtime/src/infra/subagent-control/channel-registry.ts:86`）。若接线成本过高，改为显式降级（删字段 + 递归分支并更新登记），不留死路径。来源同上。
- [ ] **条目 46（S-5 registry 登记）** `docs/architecture/data-source-registry.md` §6 补 subagent-control run/socket/pid 文件族登记行（位置 `runtime/src/infra/subagent-control/paths.ts:20-57`、`pid-file.ts:47-79`、`sweep.ts:39-113`）。来源同上。
- [ ] **条目 47（S-11 tsup 注释）** `packages/runtime/tsup.config.ts:36-42` noExternal 注释错误，按事实改写。来源同上。
- [ ] **条目 48（S-12 CJS 检查扫描根）** `.githooks/check_runtime_meta_url.py:25-60` 与 `scripts/validate-runtime-bundle.sh:236` 附近：CJS 兼容检查只扫 `packages/runtime/src`。扫描根扩到 tsup noExternal 所列 workspace 包（或补产物级断言，优先扩扫描根）。来源同上。
- [ ] **条目 49（S-13 relay 残片收割）** `runtime/src/infra/subagent-control/sweep.ts:44,132`：旧 relay 残片不在新 sweep 覆盖。sweep 增 relay 族与 `relay-children/*.pid` 收割。来源同上。

### T13 subagent-core 批

- [ ] **条目 50（S-6 trim 入库）** `packages/subagent-core/src/execution/engine/engine-manifest.ts:253-257`：trim 只用于校验，`out[k] = val` 原始值入库带空白永不匹配。修复：入库也用 trim 后的值。来源 dev-0.11.7-review-residue。
- [ ] **条目 51（S-15 null 判定）** `packages/subagent-core/src/execution/engine/client/remote-engine.ts:273、:291`：`modelTranslation === undefined` 未含 null；`as Record<string, string>` 断言。改为 undefined/null 双判定 + 运行时类型检查替代 as 断言。来源同上。
- [ ] **条目 52（S-2 modelSource 三层判定）** `packages/subagent-core/src/execution/service/run-orchestration.ts` pi 分支 + `workflow-dispatch.ts` 同构点：`modelSource` 判定改三层 `opts.model ? "explicit" : (agentConfig?.model ? "frontmatter" : "default")`。来源 dev-0.11.4-review-residue。
- [ ] **条目 53（S-3 restamp 翻译）** `workflow-dispatch.ts` consultOverrideAtTaskSpec 非 pi 分支：模型覆盖路径直写 record.model（pi 词汇 ref）。restamp 前经 `engine.translateModelRef?.(overrideRef) ?? overrideRef`（幂等）。来源同上。
- [ ] **条目 54（dmg-r3-1 注释改写）** `packages/subagent-core/src/execution/persistence/record-store-rounds.ts`（:204/:221/:257/:329）正文注释仍把已退场的 `.state` 收条描述为现行写点。四处按现行事实改写（终态由事件承载、磁盘写入点 = 事件追加 + binding/manifest writeSync）。来源 dev-0.11.10-review-residue。
- [ ] **条目 55（d1 残余 3 转发路径）** `packages/subagent-core/src/shared/entry-guards.ts:15` 改直连 `shared/run-vocabulary.ts`（现经 `orchestration/models/types.ts` re-export）。来源 subagent-core-d1-residual-edges。

### T14 杂项收尾批

- [ ] **条目 56（S-4 接线断言）** todo / rename-session / session-reader / scheduler / pending-notifications / smart-context 六包 `renderResult` 接线点补 `expect(typeof tool.renderResult).toBe('function')` + 折叠输出断言（约 3-6 行/包）。来源 dev-0.11.8-review-residue。
- [x] **条目 57（F S-7 槽键）** `packages/subagent-core/src/.../transport/control-client.ts:70` 模块级 `sharedClients` Map 违反 globalThis 槽纪律（`shared/global-slots.ts`）。修复：加槽键（经 global-slots 注册），保留 per-(socket, root) 复用键语义。来源同上。
- [x] **条目 58（F S-8 mirrorKey）** `runtime/src/infra/subagent-control/mirror.ts:94,217,277`：`mirrorKey` 缺 channelId。修复：identity 纳入 channelId 并同步查询侧；不做降级（数据正确性优先）。来源同上。
- [ ] **条目 59（viz fit 竞态）** `packages/renderer/src/components/panel/workflow-viz/dag/WorkflowVizDag.vue`：fit 前确认容器尺寸就绪（ResizeObserver 首回调或 rAF 双帧后执行 fit）。来源 workflow-viz-dag-minor-residuals。
- [ ] **条目 60（viz callId 空态）** `workflow-viz/overlay/WorkflowVizOverlayHost.vue`：callId 未命中时回退 `calls?.[0]` 改显式空态（no-op），不静默换目标。来源同上。
- [ ] **条目 61（S-6 realpath 复核）** `apps/electron/main/utils/local-file-prefixes.ts`（isPathUnderSessionTmp）：`.tmp/` 准入只做词法 resolve。session-tmp 分支加 `realpathSync` 复核（性能敏感则复核结果缓存）。来源 dev-0.11.4-review-residue。
- [ ] **条目 62（S-7 成立性复核）** 同文件 cwd=`/` 空串候选问题：先复核问题成立性（R1 报告行号已漂移），成立则切片为空/根时跳过该候选（fail-closed），不成立则条目关闭并说明。来源同上。
- [ ] **条目 63（S-11 注释清理）** 4 处注释按现行事实改写：`packages/core/src/transport/api/domains/file.ts:18` + `packages/runtime/src/services/file-service.ts:92`（showIgnored 已退役）、`TurnSummary.test.ts:166`、`fork-entry-behavior.test.ts`。来源同上。
- [ ] **条目 64（scanDegradedFlag 退役）** `packages/runtime/src/infra/pi/session-file-utils.ts`：`scanDegradedFlag`（定义 :1134-1139，置位 :1251-1252/:1262-1264）零消费方。摘除旗标本体与置位/复位逻辑（`scanPiSessionsFromDisk` 降级判定改写，确认无其它依赖该旗标的分支），相关测试同步更新。来源 scan-degraded-flag-retirement。验收：全仓 grep `scanDegradedFlag` 零命中，runtime 包测试绿。

## 不派发项（注记）

- dev-0.11.4 S-12（几何变更在 e2e-visual 像素基线范围内）：CI 的 PR 期 L1 固定环节自动跑，红则按基线重录流程处置，无需现在动作。
- dev-0.11.7 S-18（engine-remote-membership-face.md 陈旧表述）：该文档随本次整理删除，表述随之消解。
- dev-0.11.7 deferred S-10 / S-16、dev-0.11.8 deferred S-15：正式 deferred 登记，见 need-design.md 低优先债节。

## 验证活动（需真机窗口，本轮不派发）

以下为登记在案的验证活动，不属代码改动，待安排真机窗口后另行执行：

- e2e 盲等清理：仓根 e2e/*.spec.ts 11 处固定时长盲等改条件等待（受「改哪条 spec 就在真实环境验证哪条」约束）——见 e2e-spec-blind-wait-cleanup.md
- zcode Provider Registry / reasoningLevel 接线真机复验——见 zcode-provider-wiring-recheck.md
- D5 父→子→孙嵌套真实派发验收（需真实模型额度）——见 subagent-d5-nested-dispatch-verification.md
- reload / /new 替换窗真机复验 + supervisor 重启循环归因——见 subagent-reload-replacement-window-recheck.md
- 终端多实例真机探针 P5 / R7 / T10 走查——见 terminal-multi-instance.md
- SG-7 GroupCard `overflow: clip` 其余 7 个设置页间距圆角复核——见 dev-0.11.7-provider-reveal-review-residue.md
- subagent-control 真机/混合版本验收窗口（S1/S3/S4/S6/S8/S10/S13/S15 + A11 混合矩阵 + A6 Windows）——见 subagent-control-delivery-residue.md
