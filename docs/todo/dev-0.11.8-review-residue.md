# dev-0.11.8 合入点横切审查 minor 残余（feat-relay-extension-refactor 分支）

状态：未解决（2026-10-18 dev-merge 合入点横切审查登记；全部 minor/suggestion 级，不阻塞合并，终局 PR 期复核裁决补修或关闭）

## 背景

feat-relay-extension-refactor 分支（relay 通道重构：control 通道 / raw mirror / prompt 送达回执 / LocalEngineTransport + RuntimeEngineTransport）合入 dev-0.11.8 前，经 review-fix-loop 6 维横切审查（business-logic / arch-boundary / data-governance 恒派 + electron-build / monorepo-impact / extension-api 触发式——三触发条件均命中）。审查对象 = `git diff 98072ad9d...HEAD`（含 28+3 笔分支提交）。

审查运行记录：run `wf-1792319581470-ma8aec`（base `98072ad9d`）。轮次结论：

- round 1 = 6 must-fix + 16 suggestion（must-fix 6/6 + S-14 / S-16 修复并提交 `b2ac49ca3`）
- round 2 = 0 must-fix + 1 suggestion（修复并提交 `522bdb381`）
- round 3 = 0 must-fix + 1 suggestion（修复并提交 `c4c61d116`）
- round 4 = 0 must-fix（extension-api 复核全 ledger；其余维度 clean 未再派发）

终态 stuck：round-1 的 13 条 suggestion（S-1..S-13）未被派发（round-1 aggregator 决定「Suggestions are not dispatched to fixers in this round」），且 ledger 对账连续 3 轮未闭合（reviewer 逐条核实 not-fixed 但按不重报纪律未关闭条目）→ workflow 判 stuck。六维实质结论 = 全员 clean（0 must-fix，全部 must-fix 经 6 方独立读取 + 测试复跑核实 fixed）。按 dev-merge 分级「随分支带走」登记，与 `dev-0.11.7-review-residue.md` 同处置。

流程注记：workflow 的 suggestion-ledger 动态问题（未派发 suggestion 永挂 open、clean 轮也被残值门拦为 stuck）已在 `fix-review-fix-loop-suggestion-ledger` 分支处理（`dd2ac81b6` fix(workflow): track suggestion ledger in review-fix-loop），本登记不依赖该修复。

## 残余清单（round-1 未派发，round-3/4 复核仍成立）

| ID | 维度 | 位置 | 问题 | 修复方向 |
|----|------|------|------|---------|
| S-1 | extension-api | `goal/src/adapters/goal-control-adapter.ts` (:163-169)、`todo/src/model.ts` (:373-378)、`ask-user/src/types.ts` (:133-138)、`scheduler/src/tool.ts` (:191-201) | `details.summary` 单行契约被 4 处违反（自由文本可含 `\n`；reviewer 复现 goal `report_blocked` 多行 summary） | 截断前归一单行（复用 `plan/src/tool.ts` 的 `toSingleLine` 模式），补「输入含 `\n` → summary 不含」用例 |
| S-2 | extension-api | `todo/src/model.ts` (:429-435) | todo delete summary 未去重（同一动作两个计数：「Deleted 1 items (#1)」vs「Deleted #1, #1」） | 渲染前 `[...new Set(ids)]` |
| S-3 | extension-api | `goal/src/adapters/goal-control-adapter.ts` (:166-168)、`base-tool-enhance/src/render-result.ts` (:66-68) | UTF-16 `length`/`slice` 截断可劈开代理对，与 code-point-safe 的 todo/plan 不一致（仅外观风险） | 统一 code-point-safe 截断（与 S-1 共享 helper，可下沉 extension-protocol） |
| S-4 | extension-api | todo/rename-session/session-reader/scheduler/pending-notifications/smart-context 六包 `renderResult` 接线点（各 :125-317 之一） | 6 包新 `renderResult` 缺 `registerTool` 接线断言（C-ext-05 部分；8 个他包已有先例） | 每包补 `expect(typeof tool.renderResult).toBe('function')` + 折叠输出断言（约 3-6 行/包） |
| S-5 | data-governance | `runtime/src/infra/subagent-control/paths.ts` (:20-57)、`pid-file.ts` (:47-79)、`sweep.ts` (:39-113)、`docs/architecture/data-source-registry.md` §6 | run/ socket/pid 文件族未登记 data-source-registry §6（无即时数据丢失风险；登记纪律） | §6 补行（writer=owner runtime；reader/deleter=跨代启动 sweep；无锁死主自愈；JSON 字段域）或显式 scope-out 注记 |
| S-6 | data-governance | `runtime/src/services/zcode-provider-sync.ts` (:322-330)、`runtime/src/services/auth/provider-credential-resolver.ts` (:142-155) | 第二处未锚定 pi 凭据断言（oauth 自动刷新 / 非 api_key skip；MF-1-3 同族、凭据路径） | 锚 `auth-storage.js:207-220`；或声明 skip 为独立于 pi refresh 的 fail-closed 保守判定（R2 已部分落地 skip 侧声明） |
| S-7 | arch-boundary | `subagent-core/.../transport/control-client.ts` (:70)、`subagent-core/src/shared/global-slots.ts` | 模块级 `sharedClients` Map 违反进程单例 globalThis 槽纪律（C-state-20 族）；双包实例共存时每个 `(socket, root)` 两条连接（降级风险） | 加槽键改 `globalThis[Symbol.for(...)] ??= new Map()`（`spawned-children.ts` 先例——**必须保留 per-(socket, root) 复用键语义**），或文档化豁免 |
| S-8 | arch-boundary | `runtime/src/infra/subagent-control/mirror.ts` (:94, :217, :277) | `mirrorKey` 缺 channelId → record 生命周期绑定首个 channel，释放延后（seq 连续性防数据混串） | identity 纳入 channelId 并同步查询侧，或跨 channel 复用时显式重归属/降级 + warn |
| S-9 | business-logic | `runtime/src/infra/subagent-control/control-server.ts` (:378-388)、`sweep.ts` (:46) | 当前 socket 路径被 sweep 跳过 → 崩溃残片 + pid 复用 → `EADDRINUSE` 致命（relay 实现回归；基线 relay 有 `probeStaleSocket`，现只有 listen 前无探活） | listen 前探活当前路径：死文件 unlink；活文件 fail-fast 附恢复指引（**必须保留 pid 复用 fail-fast 语义**；现 sweep 测试只覆盖他 pid 残片） |
| S-10 | business-logic | `runtime/src/infra/subagent-control/frames.ts` (:76)、`subagent-core/.../control-client.ts` (:195-207)、`runtime/src/infra/subagent-control/channel-registry.ts` (:86) | `launch.recordId` 生产恒不写 → `findDescendantIds()` 死路径（D4 递归收割不可达；当前拓扑由 kill-on-disconnect 扇出兜住，非行为缺陷） | 从 `RemoteEngine.run`/`ctx.taskId` 接线写入 open 帧；或显式降级（删字段+递归分支，或注记「生产不可达，仅扇出」） |
| S-11 | electron-build | `packages/runtime/tsup.config.ts` (:36-42) | tsup noExternal 注释错误：subagent-core 以 src TS 内联（import 条件），dist 不是载体（产物证据：`index.cjs` 内 144 处 `subagent-core/src` 模块标记 vs 0 处 dist） | 改写注释（src 内经 import 条件内联；保留 noExternal 条目——打包 require 面无 node_modules），或显式钉 require 条件 |
| S-12 | electron-build | `.githooks/check_runtime_meta_url.py` (:25-60)、`scripts/validate-runtime-bundle.sh` (~:236)、`subagent-core/.../d8-compat.ts` (:117) | CJS 兼容守卫只扫 `packages/runtime/src`，而打包 workspace 面已扩（subagent-core 的 `import.meta.url` fallback 当前被 tree-shake，未来可达即静默破 CJS） | 扫描根扩到 noExternal workspace 包，或补产物级 `import_meta.url`/`globalThis.__dirname` 形态断言（allowlist plugin-host guard） |
| S-13 | electron-build (+arch-boundary) | `runtime/src/infra/subagent-control/sweep.ts` (:44, :132)、`docs/todo/subagent-control-delivery-residue.md` | 旧 relay 残片不在新 sweep 覆盖（`relay-*.sock` / `relay-children/*.pid`）——孤儿引擎失去 fallback，升级后残片长存 | sweep 增 relay 族（探活后 unlink）与 `relay-children/*.pid` 收割，或在 docs/todo 登记「旧 relay 不清理」决定 |

## 正式 deferred（known-remaining，不重报）

- **S-15**：`TAIJI_ENGINE_RAW_MIRROR` 字面量三处镜像无机器锁（`pi-subagent-cli/src/raw-mirror.ts:39` CLI const、`runtime/src/infra/subagent-control/engine-launch-env.ts:100/102` 注入键、`shared/src/spawn-env-contract.ts:46` deny 成员）。**理由**：单一源迁移被分层阻断（shared 是叶子包不得 import Node 侧 SDK，键无法下沉）。真正修法 = `.githooks/check_env_whitelist_sync.py` 新增 rule-3 断言（现提取器只认 `const X = '...'` 声明，需属性赋值提取 + 权威选择）= 独立加固改动、带自己的测试，不适合修复轮内编辑。**Follow-up**：在专门 hook 改动中扩 rule 3（或加聚焦机器锁）。单侧改名即静默实时流降级、无机器红。

## 已修复（终态存档）

- must-fix 6/6 + S-14（未用 devDependency 移除）+ S-16（changeset 补 relay 资产移除行）→ `b2ac49ca3`
- round-2 suggestion（`development-guide.md:1109` 状态栏文案）→ `522bdb381`
- round-3 suggestion（同处触发面文案校正）→ `c4c61d116`
- 复核证据：round-2 aggregator 汇总——6/6 must-fix 经 6 方独立读取 + 复跑（structured-output 202/202、transport-runtime 29/29、PS-81 probe 4/4、`pnpm run lint` exit 0、`check-pi-semantics` 79 条绿、`check-version-changes` declared）；round-4 extension-api 对 13 条残余逐条文件复核（仍成立）。
