# dev-0.11.7 合入点横切审查 minor 残余（fix-zcode-engine-provider 分支）

状态：未解决（2026-10-17 dev-merge 合入点横切审查登记；全部 minor/suggestion 级，不阻塞合并，终局 PR 期复核裁决补修或关闭）

## 背景

fix-zcode-engine-provider 分支（ADR-0142 引擎模型翻译面 / ADR-0143 standalone 账号元数据 / zcode provider 镜像 write-through）合入 dev-0.11.7 前，经 review-fix-loop 4 维横切审查（business-logic / arch-boundary / data-governance / monorepo-impact）。两轮审查结论：**round 1 = 6 must-fix + 21 suggestion 全修**（commit `b6f76adb9`）；**round 2 = 四维一致 0 must-fix**（R1 六条 must-fix 全部经读文件+复跑核实 fixed，真机 ZCode 3.15.3 bundle 三锚复验通过）。以下 minor 残余按 dev-merge 分级「随分支带走」登记。

审查运行记录：review-fix-loop run `wf-1792240458014-x8mqzy`（base `f8b5e3955`；round 2 aggregate 阶段 agent 挂死致 run abort，round 2 四份 reviewer 报告已完整落盘并人工收割，结论 0 must-fix）。

## 残余清单（round 2 新增）

| ID | 位置 | 问题 | 修复方向 |
|----|------|------|---------|
| ADR-0143 表述 | `docs/adr/decisions.md:770` | 括号内「oauth 同时存在时 identity 不参与凭据查找，不在此列」与代码条件不一致：`appserver-launcher-patches.ts:366-367` 的孤儿判定是 `(authSource === 'manual' \|\| !oauthBacked)`——auth-source=manual 且 oauth token 同时存在时 identity 仍参与 manual 查找并被矫正。按 ADR 字面理解会误以为代码过度矫正 | 改写为「仅 `auth-source==='oauth'` 时 identity 不参与查找；`manual` 形态即使 oauth token 同时存在仍按 manual 判定」，与代码逐字对齐 |
| N-1 | `packages/zcode-subagent-cli/src/appserver-launcher-patches.ts:193-196` | 定义锚修好唯一性校验，但**回退调用点锚**仍取全文件首个 `create:r(()=>fnName(`，无 count 检查。未来版本若出现同名函数的同款调用，补丁会注入无关调用并置 `standaloneApplied=true`——真实协议路径仍 host 模式而门报 armed（MF-1-5 同类「静默假 armed」残余面；当前 3.15.3 无现值故障） | 与定义锚同口径统计 `callAnchor` 出现次数，>1 即放弃本锚；或要求调用点与导出映射邻域；补「两处同款调用点 → not armed」变体用例 |
| N-2 | `docs/architecture/data-source-registry.md:170` | 本轮重写的副本行仍有陈旧行号：`deriveZcodeEngineModels` 标 :1011（实际 :853）、「rules 为空删副本」标 :855（实际 `removeStaleCopyOrOutcome` :691）、wrapper merge catch 标 :241/:247（实际 :245-246/:252）、`piSyncedProviderConfigPath` 标 :265（实际 :266）、`defaultZcodeProviderSyncPaths` 标 :41（实际 :35） | 易漂行号替换为符号名，或按当前 HEAD 统一校正一次 |
| N-3 | `packages/zcode-subagent-cli/src/appserver-launcher-patches.ts:301`（读快照）→ `:398-406`（写回）；`docs/adr/decisions.md:770` | MF-1-1 把写面从「仅补缺键」扩为「改写既有键」，但仍是无锁 RMW：GUI 在快照读取与写回之间完成权威写入时，矫正可能用陈旧值覆盖新值；且回退后值有凭据支撑、下次 spawn 不再矫正（不自愈）。窗口毫秒级、后果通常可用（manual key 在） | 最小：ADR 并发边界补一句「identity/auth-source 可能被陈旧快照矫正覆盖，恢复 = 重新登录/配置或删除该键」；加固：写回前重读，两键当前值与快照不同则放弃本次写入（compare-and-skip） |
| DG-R2-01 | `packages/zcode-subagent-cli/src/appserver-launcher-patches.ts:340-348` | 同 provider 存在多个 plan api-key（旧+新 account / 轮换残留）时 `derivedIdentity` 取 `Object.keys` 首个 → 永久指向陈旧 account 且 `hasPlanApiKey` 为真永不自愈；旧 key 被撤销时 401 / 条目移除后 `entitled:false` | 优先用 `project-key-location:v1:[...]` 键内嵌 identity 作确定性信号；多候选时保留既有 stored identity 并 log 歧义（不猜测）；补双 account fixture |
| DG-R2-02 | `packages/zcode-subagent-cli/src/appserver-launcher.ts:208-218`（`mergeProviderConfig` seen）、`:117-119,142,166`（`injectedConfigText` injectable） | wrapper 侧字典是普通对象，`__proto__`/`toString` 等 provider id 被丢弃，而 TS preparer 用 `Set` 保留（S-17 已让 runtime 有意产出此类 id）→ 两端 lockstep 分歧：引擎视图丢 provider 而 order 仍列出 | `seen`/`injectable` 改 `Object.create(null)` 或 `Set`，`realProviders` 查找用 own-property 检查；merge 对账矩阵补 `__proto__`/`toString` 用例 |
| DG-R2-03 | `packages/zcode-subagent-cli/src/__tests__/appserver-launcher.test.ts`（元数据矫正用例族） | 缺最高风险分支用例：oauth 在场 + 登录写入 identity 且**无** api-key 时不得改写（`!oauthBacked` 守卫）。未来若翻转条件当前套件仍绿 | 补 fixture：`oauth:bigmodel:access_token` + identity `uid-login` + 无 `account:uid-login:api-key` → 断言无写入且 identity 保留 |

## 上轮（round 1）复核仍 open 的 suggestion

| ID | 位置 | 问题 |
|----|------|------|
| S-6 | `packages/subagent-core/src/execution/engine/engine-manifest.ts:253-257` | trim 只用于校验，`out[k] = val` 原始键/值入库，带空白键永不匹配 |
| S-7 | `registry.ts:88` / `port.ts:236-244` / `services/ports/provider-credential-resolver.ts:54-57` | 快照余项注释缺 `modelTranslation`；translateModelRef 注释未提 manifest/remote 形态；resolver port 注释未加 sync 消费方 |
| S-8 | `packages/runtime/src/transport/oauth-message-handler.ts:51-62`、`provider-message-handler.ts` 同形态 | 镜像触发仍在 logout `try` 内（`ok:true` 之后），同步 throw 会走 catch 回第二份 `ok:false` |
| S-9 | `packages/runtime/src/services/startup-background-init.ts:285-310` | legacy provider migration 完成后无镜像触发（无 `zcodeProviderMirrorSync` dep），首轮迁移后副本陈旧至下次 mutation/重启 |
| S-12 | `packages/runtime/src/index.ts:1205-1209` 与 `:1492-1496` | 三依赖字面量手抄两份，工厂头注「单处组装」与事实不一致 |
| S-13 | `packages/runtime/src/services/zcode-provider-sync-wiring.ts:82-86`、`:136-145` | `defaultZcodeProviderSyncPaths()` 在 `try` 之外；`drain` 无单轮 catch / pending 重排 |
| S-14 | `provider-message-handler.ts`（7 触发点）+ `oauth-message-handler.ts`（2 触发点） | 领域失效判定仍在 transport 层，无结构收口/枚举守卫 |
| S-15 | `packages/subagent-core/src/execution/engine/client/remote-engine.ts:273`、`:291` | `modelTranslation === undefined` 未含 null；`as Record<string, string>` 断言 |
| S-18 | `docs/todo/engine-remote-membership-face.md:30,34` | 陈旧表述：`account:zai-individual-coding-plan/...` 与「剩余前置 = credentials.json standalone 设置键」 |
| S-20 | `docs/extensions/subagents/engine-development-guide.md:53` | 「与 modelCatalog 行同款三态登记体例」互斥表述 +「非非空字符串」笔误 |
| S-21 | `packages/runtime/src/transport/settings-message-handler.ts:61-67` | 注释未含 `refreshProviderCatalogs` 与凭据域触发面 |

## 正式 deferred（known-remaining，不重报）

- S-10：`zcode-provider-sync.ts` warn sink 未收敛到统一日志通道。
- S-16：翻译通道键集三处手写；runtime 测试按源码树相对路径读 zcode 包 `package.json`（MF-1-4 已补 impl↔declared 双向锁步，紧急度降低、成本未变）。

## 已修复（终态存档）

- Round 1 must-fix 6/6 + suggestion 21 条中 14 条修复并提交：`b6f76adb9`（6 must-fix + 21 suggestion 批次）。
- Round 1 之前的 gates 修复：`b070a6965`（圈复杂度 16→7）、`ffae1777e`（runtime 覆盖补齐）。
- Round 2 复跑证据：三包 `tsc --noEmit` 全绿；runtime 7877 / subagent-core 3809 / zcode-subagent-cli 323 测试全绿；真机 ZCode 3.15.3 bundle 三锚命中且补丁产物 `new Function` 自检通过；真实 credentials.json 副本执行 no-op（字节不变）。

## 流程注记

round 2 aggregate agent 启动后 42 分钟零 session 输出（引擎侧挂死，非 429——round 2 四维 reviewer 全部正常完成）。按 ADR-0122 无墙钟兜底语义不等待自愈，人工 abort 并收割已落盘的 4 份报告定论。后续同类挂死处置同此：agent-settled 已达 phase 边界且报告完整时可人工判定，不重跑。
