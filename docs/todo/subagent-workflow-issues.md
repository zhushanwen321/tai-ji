# subagent 体系剩余登记（导航页：剩余项索引 + 否定性结论 + D1 执行纲领）

> **本文件定位**（2026-10-11 重组）：subagent 体系（`packages/subagent-core` / `packages/subagent-engine-sdk` / `packages/pi-subagent-cli` / `packages/zcode-subagent-cli` / `extensions/universal/subagent-workflow` 及 runtime 派生视图消费链）剩余问题的**导航页**——真实剩余项已按「一文件一主题」拆为独立登记文件（见下索引）；本文件只保留两份不宜拆分的整体性资产：§7 否定性结论与 §2.0 D1 执行纲领（原样保留在文末）。
>
> 已修 / 已收 / 已裁决条目（原 §1 全部、§2.1–2.11、§3.1–3.3、§4、§5.1–5.4、§6、§8）已全部移出本文件，不保留正文——追溯 = 本文件的 git 历史（2026-09-29 三轮对抗式架构审查登记，修复批次集中于 2026-09-30 ~ 2026-10-02 的 fix(subagent) 系列 commit）。
>
> **§7 归宿待用户裁决（删除 or 折进 docs/adr/decisions.md）**。

## 剩余项索引

| 登记文件 | 主题 | 来源 |
|---|---|---|
| [subagent-core-d1-residual-edges.md](subagent-core-d1-residual-edges.md) | D1③ 拆边残余：2 条显式豁免反向值边 + 1 条转发路径残留（2026-10-11 源码核实） | §2.0 D1 / §2.3 |
| [subagent-d5-nested-dispatch-verification.md](subagent-d5-nested-dispatch-verification.md) | D5 真机嵌套验收（父→子→孙真实派发） | §2.0 D5 / §2.7 |
| [subagent-reload-replacement-window-recheck.md](subagent-reload-replacement-window-recheck.md) | reload // /new 替换窗真机复验 + supervisor 重启循环归因 | §6.1 |
| [zcode-provider-wiring-recheck.md](zcode-provider-wiring-recheck.md) | zcode Provider Registry / reasoningLevel 接线真机复验（随 a1a4 复跑） | §6.2 |

已关闭不再单独立项：§3.3 遗留③的文档治理终裁——session-reader 两份 2026-08-10 日期归档设计笔记（subagent-workflow-reading / cwd-popup-redesign）已删除（commit 4ffeef5fa，现行能力语义由包 README 与 `docs/workflow-record-formats.md` 承载），删除 vs 保留终裁落定，本项关闭。

---

## §7 否定性结论（2026-09-29 审查核实，后续勿重复怀疑）

1. **防御堆积假设在 notify/ui/lifecycle 三域证伪**：notify 七层防线各自覆盖不同丢失窗口，与设计三路径三桶一一对应；ui 三层错误围栏各承独立契约。
2. **reaper 与 pid-file 无误杀路径**：判据全是身份四元组（宿主死 + 引擎活 + cmdline + lstart 四道闸），无端口/时间窗启发式。
3. **run journal append 物理单写点成立**：全仓恰 1 处生产写点（terminal-actions.ts appendTransition），dispatchRunTrigger 唯一投递漏斗，无第六写点。
4. **reentry-guard check-set 竞态不成立**：acquire 同步无 await，原子性构造性保证。真实窗口是 guard 未进 domain-state 槽（reload 后新旧 guard 并存，窄窗口）。
5. **gui-mappers 现行输入域覆盖正确**（原见 §2.2，已移出，git 可追溯）。
6. **19 组包间同名文件 12 组是合法垫片/参数化收敛形态**，真差异双实现仅 best-effort / logger / data-dir / server 四组且均有文档登记。
7. **worktree reconcile 无误删路径**：判死清理有 mtime+宽限防 create 窗口误清；方向一要求双消失且查询失败保守跳过；歧义宁跳勿删。
8. **测试深路径 import 不是缺陷**（2026-09-29 用户裁决）：属 C-ext-27 已裁决设计——测试/bench/mocks 消费符号不塞 barrel，经 vitest alias + tsconfig paths 双轨解析；生产码深路径由该约束的 ESLint 门单独拦（见 C-ext-27 原文）。
9. **subagents 批量 tool 无文本生成**（2026-09-29 核实）：handler 只做 args 组装与按名解析内置模板，`@pi-meta` 与 `workerData.scriptPath` 注入安全锚均有效；「模板由 tasks[] 生成」的旧表述与实现不符，更正记录见 git 历史 §2.10。

---

## §2.0 终态演进方向与阶段计划（2026-09-30 用户裁决：全部按长期合理架构 / 终态演进）

> 注（2026-10-11）：本节为当时执行纲领的**原样保留**；表中 D1 行的「进行中」与「③ 终局编排搬迁」表述已滞后——D1 现状以 [subagent-core-d1-residual-edges.md](subagent-core-d1-residual-edges.md) 的 2026-10-11 核实结论为准（原拆边计划已由逐符号处置替代完成，现存残余见该文件）。

**本节是原 §2 的执行纲领**——七条方向的裁决结果与阶段划分在此一次写死，各条不再单独留待决项。

| # | 议题 | 终态方向（已裁决） | 阶段 |
|---|---|---|---|
| D1 | §2.3 双向依赖终态形态 | **整体拆边**：终局编排（terminal-actions 一族）归 orchestration；execution 只暴露端口（persistence / engine / ui / worktree），反向边收窄为「execution → orchestration 端口接口」 | ✅① 盘清并分类（见下「D1 拆边分类」）；② 逐类收窄，每类一个 commit（进行中：Class A 词汇下沉已落、Class B 已收尾、Class C 已落 script-lint / model-catalog / scanRunEvents〔第 3 步〕/ member-reuse-pool〔第 4 步〕/ settle 单点下沉 + 启动收编上移〔第 5 步〕，生产代码反向值边清零）；③ 终局编排搬迁 |

**D1 拆边分类（2026-09-30 实测：execution→orchestration 共 40 文件 / 值导入 48 条 / 类型导入 31 条，其中测试文件占大半）**

生产代码反向边只有 12 个文件，按终态归四类：

| 类 | 内容 | 终态动作 |
|---|---|---|
| **A 可消除（词汇下沉）** | `ALL_RUN_OUTCOMES` / `RunOutcome` / `RunErrorCode` / `RUN_EVENTS_SUFFIX`（run-events；原 `RUN_EVENT_JOURNAL_SUFFIX` 已随 D1 record 单源改名）被 `persistence/manifest-store`、`state-marker`、`run-state-evidence`、`pi-host-run-store`、`session-file-gc` 消费；`SLUG_MAX_LENGTH`（orchestration/models/types）被 `workflow-dispatch`、`subagent-actions-core` 消费 | 下沉到 `shared/`（最低层，两侧都可 import）→ 直接消掉 7 条反向边，零语义变更 |
| **B 需搬迁（journal 原语归持久化层）** | `createRunEventJournal` / `foldRunEventFrames` / `scanRunEvents` / `runSettledOutcomeToDoneReason`（run-events + terminal-actions）被 `persistence/run-state-evidence`、`service/workflow-dispatch` 消费 | ✅ 词表先下沉（B1，commit 233c358e3：`RUN_EVENT_TYPES`/`RunEventType` 入 shared——值不能反向依赖编排层，事件载荷接口留原位作类型导入）；✅ journal 落盘实现（行校验 + `createRunEventJournal` + 解析原语）迁 `execution/persistence/run-event-journal.ts`（B2，commit 054535760），orchestration 反向 import 它；✅ `run-state-evidence` 改指持久化模块。✅ `run-state-evidence` 终态判据改为直接读 run-settled 帧（不再经 fold——不变量「terminal ⟺ 有该帧」由转移表保证，持久化层不再引入状态机语义）；✅ `runSettledOutcomeToDoneReason` 纯映射下沉 shared（配 shared 侧 `RunDoneReason` 镜像）。✅ **收尾**：`scanRunEvents` 随 journal 目录解析集群（`setRunEventJournalDirForTest` / `resolveRunEventJournal` / `runEventJournalPathOf` / `runEventJournalDirOf` + no-op 测试防线）一并迁 `execution/persistence/run-event-journal.ts`（Class C 第 3 步，本 commit）——`terminal-actions` 反向 import 并保留同名 `re-export`（含测试注入范围，全仓既有导入侧零改动），`service/workflow-dispatch` 改直连持久化层（本条反向值边消除） |
| **C 编排逻辑上移**（✅ 第一步：`script-lint.ts` 整体下沉 `shared/script-lint.ts`，commit d77288d86；✅ 第二步：`model-catalog.ts` 整体下沉 `shared/model-catalog.ts`，commit b6dbae7cd——两步各消掉 `assembly/agent-registry` 与 `service/workflow-dispatch` 的反向边；✅ 第三步：`terminal-actions.scanRunEvents` 连 journal 目录解析集群一起迁持久化层，见 Class B 行；✅ **第四步：`member-reuse-pool` 整体下沉 `execution/service/member-reuse-pool.ts`**——依赖范围核查 = 可下沉（值依赖只有 `core/logger` 叶子，类型依赖只有 run-events 的 `WorkflowRunEvent`〔事件载荷接口按 B1 先例留原位作类型导入〕，本体是 record 流 fold + runId 分区内存表，零编排状态机语义）；`orchestration/member-reuse-pool.ts` 过渡期保留同名 re-export 使编排侧消费方〔terminal-actions / worker-message-pump / 测试〕零改动（收尾已删该 façade——三消费点改直连新址、C-ext-28 scope 同步），`service/workflow-dispatch` 改直连新址。**剩余**（本步后实测 execution → orchestration 值边 4 条：3 条生产 + 1 条 `registry-reconcile` 内联测试文件）：`run-registry.adoptInterruptedRun`、`terminal-actions.settleWorkflowRecord`（两个消费点）——均属「终局编排/收编逻辑归属」需随编排搬迁） | `settleWorkflowRecord`（terminal-actions）被 `service/record-lifecycle`、`run-orchestration` 消费；`adoptInterruptedRun`（run-registry）被 `assembly/startup-sweep`；`lintAgentMeta`（script-lint）被 `assembly/agent-registry`；member-reuse-pool 三符号被 `service/workflow-dispatch`（池本体已迁 `execution/service/`） | 归 orchestration（或经端口调用）——这是「终局编排归 orchestration」的主体工作量 |
| **D 测试范围** | 24 个 `__tests__` 文件的导入 | 测试可继续直连（检查只约束生产代码）；若要全清，随各类搬迁顺带改路径 |
| D2 | §2.4 re-export 过渡 | **收掉**：`execution/domain/` 成为领域类型的唯一权威路径，`assembly/types.ts` 不再 re-export | ✅① 全仓 import 改路径（71 文件 / 80 条语句 + barrel + 无扩展名与 inline `type` 修饰两形态）；✅② 删 re-export 块；✅③ 新增 `scripts/check-domain-type-path.mjs`（领域名清单动态读自 domain 两模块；assembly 禁 re-export、消费方禁绕道）+ 4 例 fixture 单测 + E2E-PIPE-09 + ci.yml 与 pre-commit 双接线 |
| D3 | §2.5 `interface/` 职责归位 | **排期拆开**：按 command / format / gui / tool / tui 五类归位（独立设计，不并入 §2 其它项） | ① 先出「文件 → 类别」映射与目标目录结构设计（设计文档随五批全落删除，git 可追溯）；② 分五批搬迁，每批保持行为等价。✅ **批 1 `format/` 已落**（commit 9c16cf630）：`format.ts` / `id-preview.ts` / `display-state.ts` → `src/interface/format/`，测试 `__tests__/display-state.test.ts` 随迁 `format/__tests__/`；实测引用范围 16 文件 / 19 处全改（批外 14 + 批内 2），barrel / `vi.mock` / e2e-map 均 0 处；纯路径替换，零逻辑 / 导出 / 渲染变更。✅ **批 2 `tui/` 已落**（commit 9f2a2d4a7）：`tui-kit` / `list-shared` / `list-component` / `list-view` → `src/interface/tui/`，`views/` 三文件 + 其测试 → `src/interface/tui/views/`；实测引用范围 12 文件 / 24 处全改（批外 7 + 随迁 1 + 批内 4），barrel / `vi.mock` / e2e-map 均 0 处；10 处注释路径串同步。✅ **批 3 `gui/` 已落**（commit e495c9e98）：`gui-mappers.ts` / `bg-notify-render.ts` / `subagent-actions.ts` → `src/interface/gui/`（批内无测试随迁）；实测引用范围 11 文件 / 14 处全改（批外 10 + 批内 1），barrel 1 条（`src/index.ts:50`）与 `vi.mock` 4 处（均指向 `bg-notify-render.ts`）同步，e2e-map 0 处；另改 2 处自述头行与 1 处测试源码文本读取路径（`bg-notify-render.test.ts` 的 `CONSUMER_SOURCE`——该路径型依赖未列入文档 §3 批 3 清单）；纯路径替换，零逻辑 / 导出 / 渲染 / 注册顺序变更。✅ **批 4 `command/` 已落**（commit a792458f9）：`command-actions` / `commands` / `subagents` + 其测试 → `src/interface/command/`；e2e-map E2E-RESUME-01 的 asset ref 与 run 串同批修正。✅ **批 5 `tool/` 已落**（commit b8398bb74）：9 生产文件 + 8 测试/fixture → `src/interface/tool/`，实测引用范围 36 文件（含设计期清单外的 e2e-map 第 7 处 `tool-workflow-resume.test.ts`、mock 工厂内动态 import 与两处 `__dirname` 爬升级数 +1）；三条反向边（gui→tool / tool→tui / tui→tool）按设计保留。**提交技法（实测）**：D3 搬迁用 `git commit -- <仅新路径>` 会被 `oe-assert` 把 rename 当全新文件而判 11 个单实现接口新增 → 先对 `git diff --cached --name-only` 做期望清单断言，通过后**不带 pathspec** 提交 |
| D4 | §2.7 身份三字段上协议 | **补齐**：`slug` / `startedAt` / 精确 `mode` 挂 `RunContextParams`（additive，形态 = 单个 `identity` 信封——平铺 `slug` 会撞 wire 双写禁令），引擎写入子 env，壳读者由回落改直读；同批更新 C-proc-23 词表锁 | ✅① SDK 协议加字段（commit ee4ed417c）；✅② 引擎写回（协议 ctx → RunContext → SpawnRunParams → 子 env，含 3 例信封单测）；✅③ 宿主填充（`identityEnvelopeOf` 单点 + 三处 run 组装点接线 + 3 例单测）；✅④⑤ 壳直读（env 值已到位，回落分支保留给未发信封的引擎/独立运行）+ 词表锁通过 + 引擎义务与机制文档同批更新 |
| D5 | §2.7 真机嵌套验收 | **跑**：父→子→孙真实派发，核对 `/subagents` 树、`subagent-identity` 条目与 core 三读者 | ① 确认本机可用模型与 CLI 形态；② 空载串行跑；③ 结果登记（含失败形态）——已独立登记：[subagent-d5-nested-dispatch-verification.md](subagent-d5-nested-dispatch-verification.md) |
| D6 | §2.2 状态机词汇演进 | (a) ✅ **v1 兼容层退役已落**（批次 commit d79ace765 / 13d929bc3）：`RunExecutionSnapshot`（原 RunState 执行快照）已无 status 字段、`WorkflowRun` 聚合不承载生命周期状态；终局判定唯一源 = 进程内终局记录注册表（`isRunSettled` / `settledRecordOf`），展示派生视图 = `runSummary` 三态（settled→done > meta.interruptedAt→interrupted > running）；`RunStatus` 两态类型全仓 src 零残留，原四包消费方（core / 壳 / 两引擎 / runtime）逐一核实清零，runtime 最后一处历史快照行读侧随 ADR-0102 删除； (b) ✅ **内活性状态收敛到唯一读口已落**（commit 9e2603443）：terminal-actions 活体缓存升级为 `RunEventFoldCheckpoint` 检查点（state 半边 + seq 水位；写入 journal 记录后按 append 返回事件的 seq 精确推进水位；terminal 即删 + `setRunEventJournalDirForTest` 清空联动保持），新增共享读口 `foldRunEventsToLifecycleState`（水位单调防御——磁盘旧快照不回退内存权威态），`adoptInterruptedRun` 收编 fold 经它与 dispatch 链共享同一份全量重放（单次收编 2 次全量 fold → 1 次）；失效面结论 = 单写者纪律下缓存条目存活期间无重读窗口，队列外读点的交错窗由水位单调防御封住；保留全量重放：`resume-run` 资格 fold（严格读侧与宽容 scan 缓存不同源、低频一次性冷路径）、`projectRunRegistryState`（无生产调用方且签名收 journal 实例无法定缓存目录域）、壳 `foldRecordStreamToRun`（record 流另一介质、session_start 冷启动一次性）；(c) **core 保留领域词表**（协议侧线格式与领域词表分离，边界映射） | (a) ✅ 已落（无需退役顺序设计——消费方盘清后逐面直接切换）；(b) ✅ 已落（增量等价对拍 + 失效三联动单测 `run-fold-cache.test.ts` 7 例；subagent-core 全量 3648 用例绿）；(c) 已定（边界映射保持现状） |
| D7 | 并发 worktree 协作 | **拆到不同 worktree**（消除互卷与等绿灯窗口的时间损失） | ① 由用户/另一会话在新 worktree 起工作线（本会话 workspace 不可自迁移）；② 本会话在新 worktree 未就绪前，按路径提交 + 冲突风险最小的项优先。**工作方式裁决，无代码载体（2026-10-01 关闭登记）**——执行主体是用户侧的 worktree 工作流编排（worktree-manipulate / dev-merge 已具备所需能力），不存在待实现项 |

**执行顺序（按「冲突风险最小 × 终态收益」排）**：D4 → D6(c 已定) → D2 → D1 → D3 → D6(a)(b) → D5（D5 需模型额度窗口；D7 依赖会话级迁移）。

**报告纪律（本轮起）**：中途不再就任何议题提问；只在收尾汇总一轮（报结果 + 真正的新发现），决策项一次列全、不逐条抛。
