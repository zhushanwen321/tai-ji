# ext-simplify-13 实施计划

基线: 08ce984d7 | 来源设计: docs/design/ext-simplify-13-base-tool-enhance-protocol.md (v2.3) | 日期: 2026-09-14

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|------------------|
| 背景/目标 | §1（1.1 系统背景 / 1.2 设计目标 G1-G4 表 + In/Out-of-scope） |
| 终态/机制 | §2（现状 F1-F4/根因）+ §3（3.1 终态 / 3.2 D1+D2 归一策略含子出口与 onLog / 3.3 D3-B 两层 API / 3.4 D3-M5 / 3.5 D4/D5 / 3.6 执行项总表 E1-E11） |
| 验收场景表 | §4（V1-V6） |
| 下一层拆分 | §5（5.1 迁移路径 M0-M5 / 5.2 单元清单 / 5.3 探针 P1-P3 / 5.4 协调与待验证 / 5.5 文件改动地图） |
| 待验证检查点 | §5.4 待验证①-④ + §5.3 探针（P1⛔M0 / P2⛔M3 / P3⛔M4） |

## 1 目标快照（逐字摘录）

> | G1 | 行为原语单一实现 | pid 判据/进程树 kill/tail/原子写/LRU/registry 解析防御在仓内各只有一份实现（extension-protocol），bte 与 runtime 改 import；任一侧修改语义，另一侧编译期即见 |
> | G2 | bt- 对账判据与 pending 差集规则同源 | bte `collectUnsettledTaskIds` 删除，对账消费 protocol 差集核心；对账与 goal 守卫对同一 session 文件得出一致的活跃集 |
> | G3 | isGui 模式分派单点 | 「isGuiCapable 外层判定不可省略（TUI 误调 marker 乱码）」这条约束被编码进 protocol helper 一次，todo/goal 消费方不再各自持守卫注释 |
> | G4 | 零用户可见回归 + bte 独立性保持 | **用户/LLM 可见行为与 registry.json 文件字节形态零变化**；内部 API 签名归一（tail 字段名/参数序、registry 读写薄壳）、日志通道经回调注入的适配、对账 emit 恒 no-op 死路径删除（D5）为**有意内部变化**（清单见 D2/D5）；bte 的 bash 后台/查询/kill 行为、pending optional peer 语义不变；纯 CLI 单独安装 bte（无 pending）仍功能完整 |

**Out-of-scope**：pending W4/registry 现算化/导出面收敛（12 号已实施，E6 仅委托）；goal theme 成员（03 号已实施）；bte 其余机制（poller/task-store/force-patterns/config）；relay 第 4 份 isPidAlive（移交 code-simplify）；移交 code-simplify 清单 5 条。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|----------------------|------|------|----------|
| u0 = M0 探针门 | P1 探针前置可行性证实：esbuild 对 workspace 包 exports 子路径解析（pi-file-lock/core 先例已在 runtime 双链路实证——设计已核实，本单元仅做 bte builtin staging 侧打样验证） | 无文件改动（探针性，允许临时脚本，收尾清理） | 无 | plain | bte 打包链（scripts/bundle-extensions.mjs）对 `@xyz-agent/extension-protocol/background-task` 子路径 import 解析成功的证据（临时探针 + grep 产物后删除）；失败 → 冻结流水线升级（D1 降级重审） |
| u1 = M1 protocol 落地（E1+E4+E7） | 三原语模块（background-task-process.ts ~90 行含 onFallback / background-task-registry-file.ts ~90 行含 onLog / output-tail.ts ~60 行 opts+onLog）+ background-task-entry.ts 子出口聚合 + pending-entries.ts 两层 API（常量/scan/diff/collect 组合）+ background-task.ts 补 BACKGROUND_TASK_ID_PREFIX + core/helpers.ts 增 setWidgetDual + index.ts 出口（pending-entries 进 index，三原语不进）+ package.json exports/publishConfig + tsup entry 三处同步 + README 首段与 description 更新 + 各新模块单测 | packages/extension-protocol/src/{background-task-process,background-task-registry-file,output-tail,background-task-entry,pending-entries}.ts、background-task.ts、core/helpers.ts、index.ts、../README.md、../package.json、../tsup.config.ts、相关 .test.ts（新增） | u0 | plain | ① protocol 包 test+typecheck 绿（新单测覆盖：4 原语 / corrupt 隔离 / 原子写 / trim / tail opts 签名 / pending-entries 两层语义含 register→unregister→register 边界 / setWidgetDual TUI 不产 marker 断言）；② grep：index.ts 无三原语 re-export；exports 含 "./background-task"；③ `node -e "import('@xyz-agent/extension-protocol/background-task')"` 或等价探针解析成功 |
| u2 = M2 bte 切换（E2+E5+E10+E11） | kill-tree.ts 整删（消费点 bash-kill-tool/spawn-background/pending-reconcile 改 import 子出口）；registry.ts 本地 guard/parse/atomicWrite/LRU 删改引（onLog 注入 logger 适配）；task-store evictTerminalOverflow 改 trim 纯函数；output-tail.ts 薄壳化（readTailSummary 保留，bash_output `output` 字段名经薄壳适配保持）；pending-reconcile 删 collectUnsettledTaskIds 改 collectActivePendingIds + 删 emit 路径（:135-144）与文件头 emit 句；tool-error-audit.ts:7 注释修正；E11 登记（base-tool-enhance.md :333 三处旧口径回写 + CLI 兜底边界登记） | extensions/universal/base-tool-enhance/src/{kill-tree.ts(删),bash-kill-tool.ts,spawn-background.ts,background/output-tail.ts,background/registry.ts,background/task-store.ts,background/pending-reconcile.ts,tool-error-audit.ts}、docs/design/base-tool-enhance.md、bte 相关测试 __tests__/{kill-tree,registry,task-store,pending-reconcile,maintenance-once,index}.test.ts | u1 | plain | ① bte 包 test 绿 + extensions:typecheck 全仓绿；② grep：src/ 无 kill-tree 本地实现（文件已删）、无 collectUnsettledTaskIds、pending-reconcile 无 `events.emit`；③ bash-output-tool 返回 JSON 的 output 字段名不变（测试断言）；④ base-tool-enhance.md :333 段无「内存 registry/changed/rebuild/尽力补 emit」旧口径残留 |
| u3 = M3 runtime 切换（E3） | reaper 删本地原语改 import 子出口（编排层保留）+ console 适配注入；registry-write writeTrimmedLocked 改 trim；output-tail 删实现（OUTPUT_TAIL_DEFAULT_MAX_BYTES 留调用方实参） | packages/runtime/src/services/session/background-task-reaper.ts、services/background-task/{registry-write,output-tail}.ts、runtime 相关测试 test/background-task-reaper{,-primitives}.test.ts、services/background-task/{output-tail,background-task-service}.test.ts | u1 | plain | ① runtime 包相关测试绿；② grep：两文件无本地 isPidAlive/killProcessTree/getProcessStartTimeSec/pidStartMatchesRegistered/readOutputTail 实现（import 代替）；③ `bash scripts/validate-runtime-bundle.sh` 绿（P1 runtime 侧证据） |
| u4 = M4 todo/goal 收敛（E8+E9） | todo makeRefreshDisplay 四分支 → setWidgetDual 两次调用 + 删守卫注释；goal UiPort 删 isGui/setGuiWidget、setWidget 签名改 dual（string 臂删除、theme 不动）、adapter delegate helper、updateWidget 三处 2×2 塌缩、session.ts:129 兼容；两包 UiPort fake 测试同步 | extensions/universal/todo/src/index.ts、extensions/universal/goal/src/{ports.ts,adapters/ports.ts,projection/widget.ts,session.ts}、todo/goal 的 UiPort 相关测试 | u1 | plain | ① 两包 test 绿 + extensions:typecheck 绿；② grep：todo/goal src 无 isGuiCapable 直接调用（helper 内化）、无 `setGuiWidget`；③ helpers.test 的 TUI 负面断言（P3 单测面）绿 |
| u5 = M5 pending 委托（E6） | pending state.ts 删私有 scanPendingEntries 改 import protocol 版；countActiveFromEntries 委托 scan+diff，filterActiveRegisters 收窄为 pending 特有过滤层；hasPendingId/isPendingActive 随私有 scan 删除自动消费 protocol 原语 | extensions/universal/pending-notifications/src/state.ts、state 相关测试 | u1（与 u2-u4 无文件交集） | plain | ① pending 包 test 绿（12 号 TC 矩阵不回归）；② grep：state.ts 无本地 `function scanPendingEntries`；③ extensions:typecheck 全仓绿 |

## 3 DAG 图

```mermaid
graph TD
    u0[u0: P1 探针门] --> u1[u1: protocol 落地]
    u1 --> u2[u2: bte 切换]
    u1 --> u3[u3: runtime 切换]
    u1 --> u4[u4: todo/goal 收敛]
    u1 --> u5[u5: pending 委托]
    u2 --> S3[阶段3]
    u3 --> S3
    u4 --> S3
    u5 --> S3
```

u2/u3/u4/u5 领地互斥可并行（并发 ≤5 内全派）；验收 V3（双端协作）需 u2+u3 齐。

## 4 测试与验收计划

**增量**：各单元按验收条款 ①；**全量（阶段 3 尾）**：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` + `pnpm --filter @xyz-agent/runtime test` + `bash scripts/validate-runtime-bundle.sh`。
**L0**：pre-commit 全套（C-proc-09 spawn-env / 引擎边界 / doc-symbol-drift 等）。

### 验收计划表

| # | 验收项（场景表行） | 方式(L0-L4) | 成本(1-10) | 收益(1-10) | 组 | 依赖 | 优化判定 |
|---|--------------------|-------------|------------|------------|----|------|----------|
| A1 | V2 bte 后台 bash 全流程（含 tail 50KB 口径 + kill 进程组消亡） | L4（pi CLI bash 驱动 + pgrep 断言） | 6 | 9 | 核心 | u2 | 驱动可脚本化（stdin JSONL + pgrep），agent 判定 |
| A2 | V1 M13 对账一致性（僵尸 register 收口 + JSONL entry 逐字段） | L4（pi CLI，双 extension 装载） | 7 | 9 | 核心 | A1（同环境链） | 可脚本化驱动；JSONL diff 断言机器可判 |
| A3 | V4 registry 字节同构 + 旧文件兼容 | L0/L3（文件 diff + 预置旧文件重跑 V3 流程） | 3 | 8 | 核心 | A1、A4 | 纯文件比对脚本化 |
| A4 | V3 runtime 双端协作（孤儿补杀 + corrupt 日志落盘两侧通道） | L4（pnpm dev 桌面端 + browser-automation） | 8 | 9 | 核心 | u2+u3 committed | 真机必需；corrupt 日志断言脚本化 |
| A5 | V5 widget 双模渲染含负面（TUI 无 marker 行 / 桌面组件 / headless） | L4（TUI pi CLI + 桌面 dev） | 7 | 7 | 非核心 | u4 | TUI 侧可脚本化（输出 grep 无 marker）；桌面并入 A4 环境 |
| A6 | V6 bte 独立安装负面（无 pending 全功能） | L4（pi CLI 单装 bte） | 4 | 7 | 非核心 | A1 | 与 A1 同脚本换装载参数合并跑 |

**提速结论**：可脚本化 4 项（A1/A2/A3/A6 的驱动与断言）；可合并 2 组（A2 并入 A1 会话链、A5 桌面侧并入 A4 环境）；L0 守卫 = pre-commit 全套 + validate-runtime-bundle。预计核心组 2 轮派发（A4 桌面一轮 + CLI 链一轮），非核心 1 轮。

## 5 合理偏差登记表

> 实施偏差全程记录于 §7 变更历史（u1 serializeRegistryFile 补导出 / write-fail warn 留锁壳层 / onFallback 稳定 step 标识符 / pgrep 诊断归一 / u2 契约常量走 index 出口教训（误从子出口取致 vite 下 undefined、LRU 失效 19 红——子出口仅聚合行为原语）/ kill-tree 消费点实为 5 处 / u3 编排层保留 + registry 原语体薄壳化 / 日志 event+detail 通道等价适配 / 批次 1-3 与微修复各条），不在此重复。

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|----------|
| u0 | committed（探针通过零文件落地） | 1 | esbuild bundle:true inline 解析 exports 子路径实证：staged bte 产物 :202 命中探针常量；三处临时改动完整还原，git status 干净 |
| u1 | committed | 1 | 30f21b95c；protocol 166/166（64 新用例）+ typecheck 绿 + dist 双探针（子出口 OK / index 零原语泄漏） |
| u2 | committed | 1 | 3e153e188；bte 233/233 + extensions typecheck/lint 绿 + doc-symbol-drift 0 |
| u3 | committed | 1+1 | 4f10c8b7d + ESM 修复 2da00e91f；runtime background-task 定向面 73/73（含间接消费面合计 130，口径=直接 4 文件 vs 直连+间连）+ validate-runtime-bundle exit 0（含 tsx 链）|
| u4 | committed | 1 | 795393b96；todo 137 + goal 402 全绿；isGuiCapable/setGuiWidget 零残留 |
| u5 | committed | 1 | 092916edc；pending 32/32（与基线同数零测试改动）+ 依赖边登记 |

## 7 残留风险与变更历史

- V1 的 JSONL 逐字段比对基线需在 u2 前采集（改动前跑一次留档，设计 §5.4③）——编排者在 u2 派发前执行。
- u0 探针若失败：冻结流水线，D1 降级重审（设计 P1 降级路径）。
- 版本 bump（extension-protocol patch）归 merge 阶段 changesets。
- 2026-09-14：计划创建（阶段 0 预检通过；审查证据 = .tmp/tech-design/ext-simplify-13-r3-review.md PASS 0 must-fix + 原始 review.md 5 MF 与 r2 复审 1 MF 均已修复闭环）。
- 2026-09-14（u3 blocker 发现与正解）：protocol 缺 "type": "module"——export * 聚合在 node tsx 源码链 CJS interop 下断 named exports（esbuild/tsup 链免疫，u0/u1 探针盲区）。u3 以 runtime 侧中介临时闭环 + 回派正解（protocol 补声明 + publishConfig 指针 .mjs→.js + 中介简化纯 named re-export，commit 2da00e91f）；三链验证 vitest 73/73 + validate-runtime-bundle exit 0 + esbuild/dist 探针全过。教训登记：子出口类改动验证面必须含 tsx 直跑链。
- u2 偏差要点：契约常量走 index 出口、原语走子出口（曾误从子出口取常量致 vite 下 undefined、LRU 失效 19 红——已修正并登记）；kill-tree 消费点实为 5 处（poller/process-exit-guard 为任务清单外编译必要联动）。
- 2026-09-14（阶段 3 聚合）：三分区审查（A=protocol+runtime / B=bte / C=todo+goal+pending）+ Gate A 全绿（extensions 三连 exit 0 / protocol 166 / runtime 全量 5940/5940 / bundle exit 0，落盘 .tmp/dev-flow/ext-simplify-13.gate-a.log）。reasonable 27 条（同构性/等价性/出口纪律全面确认）；unreasonable 5 条按领地分 3 批并行修——批次1 protocol 测试矩阵回port（A-U1 P2：Windows taskkill/pgrep 顺序/ps 错误注入/孙子组 kill 四段防护净损失 + B#2 同族）、批次2 bte（B#3 process-exit-guard 缩进 + B#1 E11 错误文案评估补做留痕）、批次3 pending（C#1 §5.4④ emit 措辞清扫 + C doc_errors 两处具象落点）；doc_errors 4 条主 agent 修——设计 V3 措辞（renamed→quarantined）、本表 u3 口径（本条）、C 两处随批次3。
- 2026-09-14（阶段 4 修复落地）：三批次已提交（c59e67d8f / e5f6c85b7 / de52cac0a）。E11 评估结论：cross-process hint 失真成立已修正（事实陈述 + 条件式 runtime 收殓 + CLI 可操作指引；pid-reuse/start-time 段无误导不改）；TEST-STRATEGY.md:303 承接方声明随批次1 回port 后恢复为真（孙子组 kill/Windows/顺序矩阵已由 protocol 侧承接）。定向复审：三批领地互斥、无交叉结论可共谋，合并单 reviewer 分三节独立审（对「按组并行收口」的合并偏离，理由=三批合计 diff 小且零交集，登记备查）。
- 2026-09-14（阶段 4 收敛）：定向复审三节结论——批次1 pass（mock 打点实缝验证，四段齐全强度≥基线，178/178）；批次2 pass（diff -w 零语义，hint 四句与收殓触发面实存吻合）；批次3 medium 1 条（index.ts:19 文件头漏扫）+ low/observation 各 1——微修复批次已落地并提交（32/233/178 绿，grep 零残留）。阶段 4 一轮修复 + 一轮定向复审 + 一轮微修收敛，0 未决 finding（epoch 范围观察已顺带强化）。转入阶段 5。
- 2026-09-14（阶段 5）：验收 V1-V6 结果——**V1 PASS**（孤儿+僵尸 register → 孤儿终态后 resume，对账按 running+pid 判死分支补写；JSONL entry data 逐字段 {id,reason:cancelled,status:cancelled}；pending_notifications list 该任务非 active；日志 reconciled:1。诚实注记：孤儿仍活时对账 D12 保守 skip 为设计内行为，生产前提由 runtime reaper 提供）；**V2 PASS**（task_id 即时返回；bash_output 返回含 output 字段=LLM 契约保持；tail 口径字节级精确 51252B/1719 行 truncated=true 残首丢弃；bash_kill 后 detached 组整组消亡）；**V3 PASS**（触发面 A：pi kill -9 即收殓 orphaned；触发面 B：整树 -9 后重启 startup full scan killed=1 stdout 实证；桌面两段式 kill → exited/reason=killed，D6-en 握手成功；corrupt 场景 quarantined 措辞双侧落盘取证——runtime stdout+日志文件行号、bte 侧经 pi CLI 探针同代码链）；**V4 PASS**（bte 写侧/runtime 写侧 registry 双文件字节形态同构：version=1/indent2/尾换行/共享字段序一致；protocol readRegistry 双读零 corrupt；legacy 最小格式兼容 + trim 可处理）；**V5 PASS（TUI 腿 BLOCKED 按设计预设降级）**（桌面组件渲染/goal 清除/TUI marker 负面 grep absent；TUI 完整链路因环境级 headless LLM 不通受阻，P3 helpers.test 单测负面断言兜底 + 桌面组补 GUI 正断言）；**V6 PASS**（纯 CLI 只装 bte 全流程可用，对账 no-op 不报错，D16 optional 保持）。清理由两组验收 agent 确认（进程 PID 级、临时目录、留证件迁移）。
- 覆盖矩阵备注：V5-TUI 的环境限制与降级已登记；V3-corrupt 的 bte 腿经 pi CLI 探针（桌面内 runtime watch 2s 确定性先行，无法让 bte 先读 corrupt 文件）——机制链同代码，偏差已披露。
- 2026-09-14（阶段 6 终态同步）：审查四条关系过（除下述 findings）。must-fix 1：ext-simplify-01 :202 对账说明未落地——已补（其附录 A 白名单表后追加 E10/D4 对账块：注释措辞已修正、customType 字符串承诺不变）；suggestion 3：本表头部版本指针 v2.2→v2.3 已更正、§5 空声明改为 §7 指针、base-tool-enhance.md :333 的 pending index 行号指针去行号化（「unregister 落盘形态」文字锚点，消再漂移面）；info 1（reaper.ts 历史出处标记口径）：**显式不补**——审查自评豁免类（前 epoch 历史出处表述，非现存口径），不构成错误，登记为已接受。修复后 13 流水线交付完成。
