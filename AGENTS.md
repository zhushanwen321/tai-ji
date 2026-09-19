# taiji AGENTS.md

Electron + Vue 3 + Node.js Runtime 的 AI Agent 桌面工作台。架构分层：

- **Electron 主进程** (`apps/electron/main/`)：窗口管理、runtime 子进程生命周期、快捷键
- **Preload** (`apps/electron/preload/`)：安全桥接，暴露 `electronAPI`
- **渲染进程** (`packages/renderer/src/`)：Vue 3 + TS + Pinia + Tailwind v3 + @taiji/ui（太极纯灰设计系统）
- **Runtime** (`packages/runtime/src/`)：Node.js WebSocket 服务（transport/services/infra 三层），子进程 RPC 与 pi 通信
- **共享类型** (`packages/shared/src/`)

## 文档索引

**重要文档资产（2026-09-13 收口）**：根目录只留 `AGENTS.md` + 2 个 README；一级资产全大写命名收在 `docs/` 下。下表前 8 行是资产登记（读取阶段 + 更新触发）——closeout 文档同步纪律见 dev-flow `flow/acceptance.md` 收尾节；本表即资产清单 SSOT。

| 文档 | 主题 | 谁在什么阶段读 | 什么触发时同 commit 更新 |
|------|------|---------------|------------------------|
| [docs/PRODUCT.md](docs/PRODUCT.md) | 产品愿景/用户画像 | tech-design 设计期（产品边界核对） | 产品定位/用户画像/核心场景变化 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构总览 | tech-design reviewer（项目约定提取） | 进程拓扑/分层/数据流/核心约束变化 |
| [docs/CONTEXT.md](docs/CONTEXT.md) | 领域术语表 | tech-design / design-code-sync（术语对齐） | 新术语/语义漂移/词条消亡 |
| [docs/DESIGN.md](docs/DESIGN.md) | 视觉设计权威 | impeccable / AI 视觉上下文；改 UI 前必读 | 视觉范式/token 结构/窗口布局变化 |
| [docs/STANDARDS.md](docs/STANDARDS.md) | 编码规范 | dev-flow 编码期 + CR | 编码规范变化 |
| [docs/TEST-STRATEGY.md](docs/TEST-STRATEGY.md) | 测试策略 | dev-flow 验收计划 + 写测试前 | 回归基线/测试分层/已知坑变化 |
| [docs/FEATURE-PRIORITIES.md](docs/FEATURE-PRIORITIES.md) | 功能分级 P0-P3 | tech-design 风险打分 + dev-flow 收尾 | 功能增删/挂掉后果变化 [MANDATORY] |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 问题排查 | 排障时 | 新排障规则/日志路径/常见问题 |

### 主题索引

| 主题 | 文档 |
|------|------|
| **功能与用例分级（P0-P3 SSOT）** | [docs/FEATURE-PRIORITIES.md](docs/FEATURE-PRIORITIES.md)——tech-design 风险打分锚定源 / 测试回归排序依据 / dev-flow 收尾同步登记目标；功能挂掉后果变化须同 commit 更新 |
| **架构约束登记表（SSOT）** | [docs/constraints.json](docs/constraints.json)（唯一登记处，机器权威，本身即人读）——全部架构级约束的 id/scope/权威源/执行方式登记处；新增约束先登记再写代码，改 json 后跑 `node scripts/validate-constraints.mjs` 结构校验；CR 动态加载：`node scripts/select-constraints.mjs --base main` |
| UI 设计演变史 / 视觉能力 spec | [docs/design-evolution.md](docs/design-evolution.md)（Warm&Soft → v3 → v6 → 太极纯灰）· [docs/architecture/v3-specs/](docs/architecture/v3-specs/)（v6 无对应物的能力设计 SSOT）· [docs/architecture/pi-launch-presets.md](docs/architecture/pi-launch-presets.md) |
| Renderer 终态包拓扑（现行 SSOT） | [architecture/renderer-package-topology.md](docs/architecture/renderer-package-topology.md)（现行 SSOT：§1 包拓扑 / §2 core 分层；原 renderer-rebuild-architecture.md 已改名，历史文档 renderer-target-architecture / v6-architecture-refactor 已删除，git 可追溯） |
| pi 边界可靠性（语义吸收层四支柱） | [docs/architecture/pi-boundary-reliability.md](docs/architecture/pi-boundary-reliability.md)（能力注册表 / 生效回执 / 确认式送达 / 漂移守卫；决策记录 [ADR-0064](docs/adr/decisions.md)，约束登记 C-pi-12 / C-pi-13 / C-ext-19 / C-proc-08） |
| session 导入源（多 coding-agent → pi session 统一转换） | [docs/architecture/session-import-sources.md](docs/architecture/session-import-sources.md)（SessionImportSource SPI 契约 / 新增导入源步骤清单 / 不变量全集 / zcode 源格式速查）——扩展新 coding-agent 导入前必读 |
| 功能开发地图（启动新 Phase 前更新） | [docs/architecture/feature-map.md](docs/architecture/feature-map.md)（滚动快照，只留最新一份；原 docs/feature-map/ 已并入 architecture，2026-09-13） |
| 测试细则 | [docs/testing/](docs/testing/)（00 总览入口；testid 清单/调用链/已知坑）；渲染采样管道资产 [docs/testing/render-sampling.md](docs/testing/render-sampling.md) + `scripts/render-sampling/`（真机采样前必读，复用管道禁现场重写） |
| Release Notes 写作规范 | 全局规范 SSOT `~/.agents/guide/release-notes.md`（三节结构 / 30 字模糊化 / 双语强制；merge 阶段 5 撰写 notes 前必读）+ 项目特化 [docs/release-notes.md](docs/release-notes.md)（展示位 / release.sh 草稿行为） |
| Pi Extension 开发 | [docs/extensions/development-guide.md](docs/extensions/development-guide.md)（指南）· [extension-conventions.md](docs/extensions/extension-conventions.md)（强约束）· [logging-conventions.md](docs/extensions/logging-conventions.md)（日志现行 SSOT）· [glossary.md](docs/extensions/glossary.md) · [local-dev-guide.md](docs/extensions/local-dev-guide.md) |
| Subagent 体系架构（包拓扑 / 协议面 / 机制落点） | [docs/extensions/subagents/architecture.md](docs/extensions/subagents/architecture.md)（现状 SSOT 导航页：5 类包拓扑 · engine-protocol v1 · 关键机制落点表 · 主题文档指针） |
| Subagent 引擎开发指南（引擎作者契约面 + 评估 checklist） | [docs/extensions/subagents/engine-development-guide.md](docs/extensions/subagents/engine-development-guide.md)（对接/改造引擎的义务清单：协议方法语义 · capabilities 声明契约 · 错误码登记 · 生命周期/接管点 · env/数据目录 · 可靠性模式库；tech-design 评估期 + dev-flow 实施期 + CR 读；**更新触发**：engine-protocol 版本 / capability 枚举 / 错误码词表 / 生命周期语义 / SessionView 契约任一变更须同 commit 更新——2026-09-18 填充并经三份对抗式审查修复） |
| 待执行架构任务 | [docs/design/tdflow-two-phase-workflow.md](docs/design/tdflow-two-phase-workflow.md)（tdflow 两阶段工作流设想：tech-design × dev-flow 参数化编排；plan 包存废随其落地时另行裁决——goal 桥修复已独立实施，不受本项影响） |

**外部依赖 pi**：[badlogic/pi-mono](https://github.com/badlogic/pi-mono) 上游（npm `@earendil-works/pi-coding-agent@0.84.4`，曾用 fork taiji-pi 已切回）。**[MANDATORY] 不修改 pi 源码、不提 PR、不 fork**——pi 没有的能力由 taiji 自实现。**pi 语义断言的权威源 = node_modules 实装版**（断言前 `npm ls @earendil-works/pi-coding-agent` 核对版本，以 dist 编译 JS 为准）；clone 本机 `<pi-mono-clone>/main/packages/`（coding-agent/src 核心逻辑、ai/src/providers provider 层）仅作可读 TS 参照，引用前须核对 clone 版本与实装一致（clone 领先/落后实装均属常态——曾因按 0.80.3 clone 断言 0.84.1 行为连产 4 条漂移 bug，审计 C #6）。不靠网络搜索。pi 版本 bump 受 C-proc-08 版本门禁机器拦截（`node scripts/check-pi-semantics.mjs`：四包版本一致 + verifiedWith 比对 + 探针族重验；升级 PR 必查 pi-ai exports 的 `./compat` 与 changelog ModelManager 迁移——登记细节以 constraints.json 为准）。构建期派生锚点（build.yml env / prepare 脚本默认值 / 快照 / extensions peerDeps / KNOWN_PI_API_TYPES / pi-tui）由 `node scripts/check-pi-sync.mjs` 守卫跟随（约束登记 C-build-07，pre-commit 按路径触发 + CI invariants）——升级 pi 后必须执行 `pnpm gen:builtin-providers` 重生成快照并随升级 PR 提交，锚点漏同步会被守卫拦截。

**Pi Extension 源码（本项目维护）**：`extensions/` 下 21 个 `@zhushanwen/pi-*` 包，按职责分两组（约定见 [extension-conventions.md](docs/extensions/extension-conventions.md)「目录分组」）+ `extensions/shared/` 共享库（llm-shared / extension-logger / file-lock / ext-guards），统一在本仓开发发布（旧仓 taiji-pi-extensions-workspace 已废弃，以本仓为准）。分组（package.json `taiji.role` 字段必须与所在分组一致，`scripts/check-extension-dependencies.mjs` 校验）：

- **`extensions/taiji/`**（role=taiji，taiji 集成包——契约两端在 taiji 体系内，离开 taiji 无功能，必在 mandatory 清单）：agent-ext / msg-id-mapper / plugin-bridge（Plugin system bridge——register plugin tools into pi and relay events/intercepts via select marker channel） / system-prompt / system-prompt-trace（builtin feature-tier，taiji:system-prompt 留痕）
- **`extensions/universal/`**（role=universal，独立通用包——功能自足，独立 pi 用户可单独安装）：ask-user / base-tool-enhance（同名 override 内置 bash 工具：前台委托 pi 官方工厂保持等价 + 增量 background 后台模式 + 工具报错审计，承接已废弃 unified-hooks 的能力；设计决策沉淀在包内源码注释与 README，原设计文档见 git 历史） / cache-probe（前缀指纹采集 + analyze.py 归因） / cw-tool / goal / pending-notifications / permission / plan / rename-session / scheduler / session-manager（agent-managed session：6 个 session 管理工具经 select+SESSION_MANAGER_MARKER 通道对接 taiji runtime 的 SessionManagerHandler；嵌套 {action,params} 契约 SSOT 在 @zhushanwen/extension-protocol） / session-reader / smart-context（agent 自决上下文压缩：compact_context 工具 + 双模式摘要接管 + 分档提醒） / structured-output / subagent-workflow / todo

新增/删包时更新此列举与所在分组。校验：`pnpm extensions:typecheck` / `extensions:lint` / `extensions:test`。

- **[MANDATORY] extension 改动优先在本地 pi CLI 实测**（不是 taiji 桌面）：`pi -ne --mode rpc --session-dir <dir> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <绝对路径>` + stdin JSONL 发 prompt；`TAIJI_AGENT_DEBUG=1` 看 `~/.pi/agent/logs/` 扩展日志。taiji 的 builtin 打包/数据隔离/runtime 中转层会掩盖版本差异。**`-ne` 必带 [HISTORICAL]**（2026-09-13 实测事故：settings 清单 `npm:` 版与 `--extension` 本地版同进程双载——jiti 模块独立但 `Symbol.for` 单例槽跨实例共享，版本错配交叉读写炸 `Cannot read properties of undefined (reading 'set')`，且报错路径指向 npm 版误导排查方向；`-ne` 跳过 settings 清单 + 绝对路径避免 cwd 依赖）
- **structured-output 方案 A [HISTORICAL]**：workflow 模式 `PI_WORKFLOW_SCHEMA` 注入的权威 schema 是唯一校验权威，LLM 自报 schema 不参与校验（曾因校验自报 schema 致修复静默丢失）。终态补强（structured-output-redesign D1/D3/D4）：workflow 模式已重设计为单参数合成工具——parameters 即权威 schema（根级 `additionalProperties:false` 结构性拒绝 schema 字段，模型结构上不可自报）+ 同签名 3 次闸门硬终止
- 本地开发调试（live edit ↔ npm 版切换）：`.agents/skills/dev-link/`
- **Review 工作流**：`pr-cr-fix` skill 是 PR 完整生命周期入口（开 PR → 8 维 review → 修 must-fix → pre-merge → push；review agent 内化在 `pr-cr-fix/agents/`，不全局暴露）

## 常用命令

```bash
pnpm run dev          # 开发模式 (Electron + Vite HMR)
pnpm run build        # 生产构建 (electron-builder)
pnpm run lint         # ESLint 检查
pnpm install          # workspace 单步安装（根 + packages/* + apps/*，ELECTRON_SKIP_BINARY_DOWNLOAD=1）
pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test   # extensions/ 三连
bash scripts/validate-runtime-bundle.sh    # runtime bundle 深度验证
```

## 前端调试（Playwright 连 dev app）

`pnpm dev` 走 `apps/electron/scripts/dev-instance.mjs` 装配器（C-dev-01）：按 worktree 名 hash 稳定派生端口（Vite/CDP/runtime 段）与**数据目录 `~/.taiji-dev/instances/<worktree>/`**——`main.ts` dev 分支受控采信该实例目录（外部 `TAIJI_AGENT_DATA_DIR` 仅当解析后位于 `~/.taiji-dev` 树内才采信，其余钉死回 `~/.taiji-dev`，防泄漏语义保留），多 worktree 并行 dev 数据自动隔离、单实例锁互不互踢；解析纯函数 = `apps/electron/main/utils/dev-data-dir.ts`（行为矩阵测试 `main/test/dev-data-dir.test.ts`）。首启配置种子（provider/secrets 等）由装配器从只读模板 `~/.taiji-dev.template/` 按 `TEMPLATE_TOP_FILES/DIRS` 白名单复制进实例目录（`--seed-from` 生成模板）。**AI agent 真机验收必须 `TAIJI_DEV_BACKGROUND=1 pnpm dev`**（showInactive 不抢前台焦点，遵循 browser-automation skill 对策 2）；连接前 `node apps/electron/scripts/dev-instance.mjs --print` 查本实例 CDP 端口，browser-automation 连 `http://localhost:<cdp-port>`（截图/DOM/执行 JS）。验收要干净环境时加 `--fresh`；需要额外独立数据目录（并行验收 / mock 实例 / 实验）时加 `--data-dir ~/.taiji-dev/<suffix>`（值域校验收敛在树内、拒保留目录，禁改 main.ts 实验通道）。

- 实例排查：单实例锁按数据目录 userData 区分（多实例天然共存）；连错实例看旧代码——先确认 `list-pages` URL 是本实例的 `localhost:<vite-port>`；模板调整后 `node apps/electron/scripts/dev-instance.mjs init-template --force` 重建（只读模板勿直改）
- 打包版应用（磁盘 bundle 名 `TaiJi.app`，Finder 显示「太极」）可能同跑（占 3210）；裸跑（不经装配器）时 dev CDP 9222 / Vite 1420 / runtime 3310
- runtime 改动不热重载（tsx 非 watch）：改 runtime 源码必须重启 `pnpm dev`；renderer 走 vite HMR
- **staged 引擎副本 dev 恒重建 [F7]**：dev 的 subagent 引擎加载 gitignored 产物 `apps/electron/resources/engines/<id>/index.js`（非源码——extensions 走源码但引擎没有 dev/build 分流）；`pnpm dev` 启动链已前置 `bundle-extensions.mjs`（<1s）重建，改 subagent CLI 源码后重启 dev 即生效。曾因 staged 滞后致 GUI 真机跑旧引擎代码（Gate B 发现 F7）。绕过 dev 链直接起 Electron 时须手动 `node scripts/bundle-extensions.mjs`

## 关键规则（违反必出 bug）

**runtime ↔ 前端编码核心**：

1. **emit 只传单个 payload 对象**：`emit('event', { arg1, arg2 })`，禁止多参数
2. **Event bus listener 防重复注册**：组件可能多实例（split mode），listener 用模块级 refCount 保护
3. **错误必须重置 isGenerating + streamingMessage**：错误作为 assistant 消息插入聊天流，不用顶部 banner
4. **外部系统对接先验证再编码**：对接 pi RPC 等先写独立验证脚本确认字段格式，用完归档移除
5. **pi 适配层不信任外部格式**：EventAdapter / session-pool 是 pi 协议唯一适配点；`sendCommand` 必须检查 `success`
6. **pi session 文件延迟写入**：首条 assistant 消息前文件可能不存在，读取代码必须处理；**[HISTORICAL] 禁止任何代码在 pi 首次 flush 前创建/触碰 session 文件**（EEXIST → session 永久卡死；活跃 session 靠 `SessionScanner.listAll()` 合并内存 Map 显示）
7. **Session 隔离：所有 runtime → 前端消息必须带 `sessionId`**，缺失的消息应被前端忽略（三层：ChatStore Map 分区 / useChat 路由 / PaneSessionView 过滤；`sendError` 必须传 sessionId）
8. **per-session 状态隔离范式 [ADR-0049]**：持有 per-session 状态的 composable 必须用 `useSessionScopedState` 工厂（Map 分区范式），禁止实例级状态 / watch(sessionId) 手动清空。**WS handler 必须用 `updateFor(capturedSid)` 不用 `update`**（结构性消除切 session 竞态）；cleanup 由 `useSidebar.deleteSession` 统一编排。新增/修改 composable 时 reviewer 按 [ADR-0049](docs/adr/decisions.md)（per-session Map 分区范式条目）逐条确认
9. **对话流状态必须实时可见 + 重开 session 仍可见 [HISTORICAL]**：实时链路（message.* 广播 + core `effects/registry.ts`）与持久化链路（entry → 同一 `applyEntry` reducer，不丢弃任何 pi entry 类型 / 文件路径 JSONL filter 不只留 message）两条通路必须同时实现——bash/user/custom/compaction 全类型 live entry 化（2026-08 conversation-turn-attribution）后两通路共用同一 reducer，「live ≡ reload」构造性成立，等价性测试（`apply-entry-equivalence`）守卫。命令副作用归 `message-dispatcher.ts` 编排，不散落 event-adapter。检测：操作后关闭重开 session，对话流应一致

**workspace / git**：

10. **Worktree 创建必须走 `git-cwt`**（自动 pnpm install + Electron dist 缓存 symlink）；Vite `strictPort: true`，1420 被占则静默失败加载旧代码——`lsof -i :1420 -P` 确认端口归属
11. **Bare repo 模式**：`origin` = 本地 `.bare`，GitHub remote 叫 `github`（push 用 `git push github HEAD:fix-xxx`）；workspace root 不是 git repo，`gh` 命令带 `--repo zhushanwen321/tai-ji`；merge 脚本无 main worktree 时用 `git --git-dir` 指向 `.bare`，版本 bump push 用 `HEAD:refs/heads/main`

**架构机制**：

12. **Electron 打包约束（事故最高发）**：① runtime 源码禁止 `import.meta.url` / `globalThis.__dirname`（CJS bundle 下失效），路径用 `typeof __dirname !== 'undefined' ? __dirname : undefined`；② 新增 runtime 依赖必须同步加 `tsup.config.ts` 的 `noExternal`；③ 打包子系统改动逐个 commit 逐个验证。细节核对见 `pr-cr-fix/agents/review-electron-build.md`；验证三阶段（preflight → build → postbuild）+ validate-runtime-bundle 由脚本自动化
13. **目录规范**：禁止 `demos/` / `impeccable/` 目录；禁止外部绝对路径 symlink（pre-commit 检查）；`.taiji-harness/` 是本地决策/工作流档案，**不入库**（2026-09-13 裁决：gitignore，决策追溯靠 commit message 与 docs）；视觉设计权威 = `docs/DESIGN.md`（Warm&Soft 旧根 DESIGN.md 已删除，git 可追溯）
14. **项目 skill 必须自包含 [HISTORICAL]**：`.agents/skills/` 引用的脚本复制到 skill 目录内随 git 跟踪（`merge/scripts/` 已自包含），禁止依赖 `~/.agents/skills/` 全局脚本或 symlink
15. **排查规则（untracked 展开 `-uall` / 禁止写死绝对路径用 `getDataDir()` 等动态推导 / 跨层机制穷尽 pi extension 层）**：详见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) 的「历史排查规则」

**Plugin / Builtin extensions**：

16. **Plugin System**：PluginService 是唯一适配层（WS → server.ts → PluginService）；trusted 插件跑 Worker Thread、sandbox 跑独立 fork 子进程；hook 按 priority 串行（单 handler 5s 超时放行）；sessionData 写入 debounce 缓存 + shutdown flushAll；WS 命名 Client→Server 点号（`plugin.xxx`）/ Server→Client 冒号 camelCase（`plugin:statusBarUpdate`）
17. **Builtin pi-extensions 打包内置（现行）**： `@zhushanwen/pi-*` 包 esbuild bundle 后 staged 到 `apps/electron/resources/extensions/` 随应用打包（不走 npm 安装；数量以 `packages/shared/src/mandatory-extensions.json` SSOT 为准，不在此写死）。清单 SSOT = `packages/shared/src/mandatory-extensions.json`（infrastructure 组不可禁、feature 组可禁、都不可卸，组内包数以该 JSON 为准；守卫抛 `builtin_cannot_*`）。[HISTORICAL] 演化：builtin 依赖 → 推荐安装 → mandatory npm → 打包内置（2026-08-12）；「删除打包所需依赖致产物缺失」教训始终适用（pi binary、builtin 扩展包如 `@zhushanwen/pi-system-prompt` 同理）
18. **子进程 env 出站契约（C-proc-09）**：进程创建点的子 env 必须经 `buildOutboundChildEnv` 构建（deny 清单剥 `TAIJI_AGENT_PACKAGED` / `TAIJI_RUNTIME_TOKEN`），与 `ENV_WHITELIST_PREFIXES` 入站准入正交——入站管准入、出站管外泄；守卫 `.githooks/check_spawn_env_boundary.py`，设计依据 [docs/architecture/env-propagation-boundary.md](docs/architecture/env-propagation-boundary.md)
19. **超时默认原则（任务级默认无超时，量级按对象粒度校准）**：subagent turn / workflow `agent()` / 引擎 run 等**任务执行正常路径禁止自带墙钟超时**——用户显式指定（`timeoutMs` / `budgetTimeMs` / watchdog env）才生效，调用方未传就是不限时。必须设防挂死兜底时，量级必须按**被保护对象的粒度**校准：任务级（subagent / workflow run）= 小时级或「无进展检测」（idle / ping，ADR-0047：静默 ≠ 卡死，活跃产出不得判死）；控制面单请求（RPC 帧 / 探针 / 握手）= 秒级；禁止跨粒级挪用（单 turn 分钟级预算 ≠ 整任务总预算）。回收层（dispose / kill / 上界 / idle timer 四族）防挂死兜底允许默认有界（opt-out）——权威裁决见 [crash-forensics-and-watchdog.md 附录 E](docs/architecture/crash-forensics-and-watchdog.md)「正常路径逐点根修 + 回收层统一有界兜底」。[HISTORICAL] 反例：zcode appserver `turnTimeoutMs` 固定 300s 墙钟（2026-09 实测 21% 任务误杀——343s/541s 正常完成的任务被 300s 判死，死后 app-server 继续烧 token；且流式 delta 不刷新计时）。
20. **pnpm store 布局双向翻转（沙箱 HOME × pnpm store）**：zsw 引擎 worker 等沙箱执行体覆写 HOME，其 pre-commit 内 verify-*.sh 自含 `pnpm install` 会把沙箱侧 store 写进 `node_modules/.modules.yaml` 的 storeDir；本地（正常 HOME）后续 install 判布局过期 → `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 硬崩（pre-commit 随机红，`CI=true` 治标会复发）。护栏 `.githooks/check_pnpm_store_layout.sh`（pre-commit 第 0 段 + validate-runtime-bundle Gate 0）翻转即红并给 [FIX]；恢复：`CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install`（约 6-7s）。根因/排障见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)；引擎侧修复落地后护栏应恒绿，红 = HOME 覆盖回退的验收信号
21. **看门狗/滚动重启默认不武装（Gate W 数据门，C-proc-19）**：`TAIJI_RUNTIME_WATCHDOG_ARMED` 缺失时 runtime watchdog 纯观测（采样进环，无 relief / 无滚动重启 / 无通知）——armed 动作必须显式 env 开启，且武装前置 = V6 soak 水位数据 + 评估器 watermark-daily 趋势复审通过（阈值校准 + 重启循环风险排除），禁未经数据复审先武装（兜底先行掩盖问题）；滚动重启走专用退出码 86 + supervisor 零退避零计数，推迟上限 30min（`TAIJI_ROLLING_RESTART_DEFER_LIMIT_MS`）。设计依据 [docs/architecture/crash-forensics-and-watchdog.md](docs/architecture/crash-forensics-and-watchdog.md) §3.2 方案 B / D5
22. **本机目录/绝对路径不入项目 + 不留历史痕迹（2026-09-15 用户裁决）**：本项目按整体重写定位维护，文档只保留当前现状。① 仓库内容（文档/代码/配置/注释）禁止出现本机绝对路径（`/Users/<user>/...`）与 workspace 专属目录名提法——引用 workspace 位置用占位形态（`<workspace>/<worktree>/`）或运行时动态推导（`os.homedir()` / `getDataDir()` / `getPiAgentDir()`，见既有路径白名单检查）；② 历史档案不回填不新建：版本沿革/迁移史/改名说明/演化叙述不进活性文档，已清理的历史档案族（`docs/todo/`、`docs/adr/` 旧编号文件、`**/CHANGELOG.md`、`.orchestration/`、`packages/*/probe/`、`.cw-specs/`、cw 验收脚本、一次性迁移工具）的现行承载 = [docs/adr/decisions.md](docs/adr/decisions.md)（ADR 现行决策收敛）与各活性文档；③ 登记例外（对齐磁盘事实的功能性提法可保留）：`.gitignore` 对真实目录名的忽略条目、守卫/检测脚本的功能性检查串、测试 fixture 的采集时点数据、merge/dev-merge 等 skill 操作真实 workspace 所必需的路径（优先动态推导，写死形态须注释说明）

## 测试

**先读 [docs/TEST-STRATEGY.md](docs/TEST-STRATEGY.md)（分层/mock/回归基线 SSOT）+ [docs/testing/](docs/testing/) 对应功能文档**，复用已有 testid/调用链/踩坑经验。红线：vitest（禁 `node:test` / `tsx --test`，配置在子包 vitest.config.ts，从子包目录运行）；timer 测试用 fake timers；派编码 subagent 时 task 写明测试框架。**三视角缺一不可 [HISTORICAL]**（构建者白盒 + 使用者黑盒 + 观察者形态；每条用例至少一个用户可见 DOM 断言；spec 结构条目 = 渲染断言清单）——细则见 docs/TEST-STRATEGY.md §3。

**e2e 执行准则（SSOT）**：e2e / 真实进程 / 真实 LLM 用例（runtime equivalence real-pi 池、`TAIJI_PI_LIVE` 真机、playwright real 轨等）只在**开发阶段按改动面**执行——改了哪个域跑对应子集，清单由 tech-design 设计文档的「e2e 影响面评估」圈定、dev-flow 验收计划表承接，且必须空载串行跑（跨包/跨套件并发会饱和 CPU，真实 LLM 轮次延迟会越过事件预算——2026-09-15 send-queue-e2e 120s 超时事故）。**禁止全量扫跑；PR / merge / CI 门禁一律不跑真实 LLM e2e**（`TAIJI_SKIP_REAL_PI=1` 跑 unit 轨，CI 与本地同口径；mock 轨零 token 用例除外——L1 CI 固定环节：e2e-visual 像素轨 + e2e-behavior P0 smoke 轨，2026-09-15 行为轨接线）。e2e 失败先读 junit failure 详情归因（`waitForEvent` 的 seen types 区分「LLM 在推进但慢」与「真死锁」），禁止不归因直接重试、禁止放宽断言或膨胀预算换绿灯。**长期方向：e2e 逐步单测化**——能以 mock / fixture 重放等价覆盖的 e2e 项随改动沉淀为单测，merge 门禁的回归防线由单测承担。**每条 e2e 资产必居三态之一**（R1 毕业进 CI / R2 按改动面触发且触发条件必填 / R3 归档进 docs/testing/），禁止第四态「既不跑也不归档」——三态定义、行为轨 spec 逐条归宿标注与新资产流转规则见 [TEST-STRATEGY.md「e2e 资产归宿纪律」](docs/TEST-STRATEGY.md)。**按改动面圈定跑哪些 e2e 的机器对账入口 = `node scripts/select-affected-e2e.mjs --base <ref>`**（登记 SSOT = [docs/testing/e2e-map.json](docs/testing/e2e-map.json)；`--check` 防漏登记门禁，结构校验 `node scripts/validate-e2e-map.mjs`）。

**用例级耗时报告**：vitest 包的 config 统一配 `reporters: ["default", "junit"]` + `outputFile: { junit: "./test-results/vitest-junit.xml" }`（`test-results/` 已 gitignore），每次 run 自动落盘用例级耗时，慢用例排查用 grep/sort，勿临时加 reporter flag：`grep -o '<testcase classname="[^"]*" name="[^"]*" time="[0-9.]*"' test-results/vitest-junit.xml | sed -E 's/.*classname="([^"]*)" name="([^"]*)" time="([0-9.]+)".*/\3s \1 > \2/' | sort -rn | head -15`。已有自定义 reporters 的包（如 runtime 的 cw-acceptance-markers-reporter）**追加** `junit` 项而非覆盖；v4 json reporter 的文件级 `duration` 恒 null（用例级有值），程序化消费用 junit `time` 属性。示范实现：`packages/subagent-core/vitest.config.ts`；新建 vitest 包默认带上，存量包改动其测试时顺手补。

**测试禁止触碰真实数据目录 [HISTORICAL]**（2026-09-02 会话丢失事故：测试在 env 带 `TAIJI_AGENT_DATA_DIR=~/.taiji` 时运行，`rmSync(getSessionsDir())` 删光全部活跃会话，三个 pi 进程追加写入 ENOENT 崩溃——appendFileSync flags `'a'` 本可自建文件，ENOENT 根因是父目录被 recursive 删除；2026-09-16 同族事故：从非包 cwd 误跑 workspace 全仓 vitest 绕过包级防线删光 prod 数据目录）。双层防线（① global-setup 将 `TAIJI_AGENT_DATA_DIR` 钉死 tmp + 对「注入真实 `~/.taiji` / 非白名单目录」的注入值**自动脱钩**（2026-09-17 前为 fail-fast 拒跑；脱钩=删 env 后落 tmp，安全等价且免去 `env -u` 摩擦，判定与 `isInjectedEnvAllowed` 共用）；② fs-guard（setupFiles 切面）拦截全部破坏性 fs 操作（写/删/移动），**白名单 = `os.tmpdir()` + `$TAIJI_AGENT_DATA_DIR`（≠ 真实目录）+ `~/.taiji-dev`（homedir 动态推导），其余目录一律抛错**）经 `test-guard/factory.ts` 的 `taijiTestConfig` 工厂统一注入**全仓所有 vitest 配置**（用户 setupFiles/globalSetup 追加保留；含根级兜底 config——从仓库根 cwd 跑 vitest 防线同样生效），漏挂由 `scripts/check-vitest-guard.mjs` 机器守卫拦截（pre-commit + CI invariants）。约束：新测试的写删目标必须 `mkdtempSync(join(tmpdir(), ...))` 自建自删，禁止删除 `getSessionsDir()` 等共享推导路径；禁止绕过 guard（restore 原始 fs / 子进程删真实目录）；**禁止从包目录外触发 vitest 扫描式跑测——根目录是唯一合法全仓入口（防线齐备）**。

## 前端编码规范

权威标准：外部 UI 规范项目的 `CONVENTIONS.md`（编码规范权威源，本机独立前端项目根，路径不入库——它是外部规范源，不是本仓组件依赖）。核心：

1. 禁止原生 HTML 表单元素（用 @taiji/ui 组件）；禁止 Emoji（inline `<svg>` / @lucide/vue）
2. 样式三层：tokens（`style.css` 只放 CSS 变量 + reset）/ Tailwind 工具类（组件样式统一在此）/ `<style scoped>` 仅 escape hatch（伪元素、后代选择器、Transition 类）。禁止 `@apply`
3. `<template>` ≤ 400 行，`<script setup>` ≤ 300 行；禁止 `any`（断言须有运行时 guard，extensions/ 由 taste/no-unsafe-cast 强制）
4. `v-model`（禁 `:value` + `@input`）；独立数据源用 `Promise.allSettled`
5. 禁止硬编码颜色 / 魔数间距（用 CSS 变量与标准 Tailwind scale）
6. border-radius 遵循 v3 tokens（`--radius-sm:3px` 默认 / `--radius:8px` / `--radius-lg:12px`，ADR-0019）
7. **窗口顶部 traffic light 布局**：v3 刻意调整形态（非 v6 demo），全部数值（AppShell p-1 / pt-11 / {x:8,y:8} / h-[22px] 共线等）见 [DESIGN.md §11](docs/DESIGN.md)——改窗口顶部 UI 前必读
8. **reka ScrollAreaViewport 默认 `overflow-x: hidden` [HISTORICAL]**：横向滚动需给 `ScrollArea` 传 `horizontal` prop（`!overflow-x-auto` 覆盖内联；`:deep()` 会破坏 reka Root 渲染顺序）

自动化检查：taste-lint（no-native-html / no-emoji / prefer-v-model 等，`pnpm run lint` + pre-commit）· vue_rules_checker.py（行数/选择器/Tab/原生元素，pre-commit）。

**Lint / Hooks 原则 [MANDATORY]**：按全局 AGENTS.md「Pre-commit Hook 问题处理」执行——检出问题全部正面修复（含存量、含 warning），禁 `--no-verify` / `SKIP_*`（仅限线上热修复并说明）；规则误报修正规则本体并加 `[HISTORICAL]` 注释，禁 `eslint-disable-next-line` 静默。

**完成即提交 [MANDATORY]**：按全局「提交策略 → 完成即提交」；「检查未过」不构成不提交理由（先修复）。

## Git 规范

分支 `feat:`/`fix:`/`refactor:`/`chore:` 前缀；commit 英文 conventional 风格；粒度见全局提交策略（优先本次会话改动，文件级）。

## pi 资源放置

agent.md / workflow.js 归位：与 extension 强相关（tools 受限某 extension / 离开该 extension 不可用）→ `extensions/<group>/<pkg>/agents|workflows/` + package.json `pi.agents`/`pi.workflows`；项目自用 → `.agents/agents|workflows/`；跨项目通用 → `~/.agents/`。发现机制：resource-discovery 扫 7 源同名 last-writer-wins（project-agents 最高）；extension 内置 agent 须装到 npm 扫描目录才被发现（dev-link 不发现 agent）；skill 走 `pi.skills` 独立通路（first-writer-wins）。SSOT：`packages/subagent-core/src/shared/resource-discovery.ts`。

## 架构约定

- 视图切换状态驱动（settingsStore.currentView），不用 vue-router；Mock 用 `VITE_MOCK=true` 在 ws-client 层拦截
- **markdown 渲染管线安全模型 = 分通道净化**（`markdown-sanitize.ts`，renderMarkdown 唯一出口）：markdown-it `html:true`；可信段（shiki/KaTeX/md-* 契约：fence/math/code_inline/filepath）以 per-call nonce 哨兵在 sanitize 前摘出、净化后单遍回填，不参与白名单过滤；用户 HTML 走 DOMPurify 两级白名单（GitHub 面对齐，class/style/data-* 构造性全剥——无样式伪造与交互借用通道）；相对资源的两条通道：img src 在净化 hook 按 `resourceBaseDir` 重写为 local-file URL（经 MarkdownEnv 透传，对话流 = session cwd、drawer = 文件所在目录）；相对链接 href 保持原样输出，点击时由 MarkdownRenderer ④路按 `props.resourceBaseDir ?? deps.sessionCwdOf()` resolve（drawer 走 props 通道不经 MarkdownEnv）；CSP 由此降级为纵深第二层。禁止绕过 renderMarkdown 直调 md.render、禁止向用户白名单放宽 class/style/data-*
- 共享类型经 `packages/shared/` workspace 共享；Runtime 通信走 WebSocket（ws-client.ts + event-bus.ts）；Electron IPC 经 preload 暴露 `electronAPI`
- **Runtime broadcast 时序竞争 [HISTORICAL]**：session 激活/创建流程内部发出的 session 级 broadcast 早于 renderer 订阅 → 消息丢失。renderer 切换/创建 session 后需立即消费的 session 级状态必须主动拉取（`session.getCommands` RPC），不可依赖 broadcast
- **数据目录隔离**：`~/.taiji/` 与 `~/.pi/agent/` 完全隔离；路径白名单禁止硬编码，从 `getConfigDir()` / `getPiAgentDir()` 动态推导（pre-commit 检查）
- **ENV_WHITELIST_PREFIXES SSOT**：只许定义在 `packages/shared/src/constants.ts`，main/runtime 只 import（pre-commit 检查）
- **Runtime/pi 日志必须落盘 + 轮转**（`<getDataDir>/logs/`，date + size 双策略，dev debug / prod info）；pi stdout tee 到 `pi-<date>-<sessionId>.jsonl`（pi 卡死时唯一证据）；新增日志库必须加 tsup `noExternal`
- **设计文档同步纪律 [HISTORICAL]**（C-proc-10 + dev-flow post-delivery）：修复 impl-plan/设计文档登记过的残留风险时，同 commit 回写登记与变更历史（登记即债务修复即清账）；符号删除/改名/常量改函数须同批清扫 docs 与测试注释中的悬空引用，`node scripts/check-doc-symbol-drift.mjs` 必须跑过（pre-commit 按 docs/architecture/ 或映射源码路径触发）。起因 2026-08-31：流水线后修复 UPDATE_DIR 烤死 bug 只改代码未回写文档，对抗审查抓出 9 条漂移
- **包管理器纪律 [HISTORICAL]**：pnpm workspace 单一管理器，`pnpm-lock.yaml` 唯一权威，通用纪律按全局 lock 规则。npm 例外（不要"统一"）：外部消费者安装指引 / `npm publish` / runtime 安装用户 extension / 规则正文描述被禁命令 / `npx`。标准：执行者是本项目开发者/CI/AI → pnpm；外部消费者/终端用户 → npm
- **zcode 引擎单一 app-server 形态（2026-09 用户拍板）**：zcode 引擎现役实装在 **`packages/zcode-subagent-cli`**（引擎协议化 W5/W11 后自主包，core 壳侧零内建 zcode），**只走 app-server RPC，不走 CLI spawn**（`zcode --json --prompt` 单轮链与 probe 冒烟/protocol-drift 降级已删除——协议漂移直接报错）；**共享宿主 HOME**（spawn env 不覆写 HOME——db/plugins/MCP 继承宿主 HOME；无 HOME 池/锁/pidfile）；**会话库隔离（2026-09-09）**：spawn env 覆写 `ZCODE_SESSION_DB_PATH`（并清空别名键 `ZCODE_SESSION_DB`），会话落独立库 `<engineDataDir>/engines/zcode/session-db/db.sqlite`（路径单一来源 `zcodeSessionDbPath()`，不进 ZCode GUI 侧边栏，不落 `engines/zcode/shared/` 池目录），与 GUI 引擎库分离——GUI 侧边栏零污染；handle.dbPath 为隔离库绝对路径，两条读取链（`session-view-service` ①级 + `EnginePort.read`）按 `zcodeDbPathAllowlist(dataDir)` 白名单集合成员判定放行（集合第二项 = 宿主库路径，仅存量 record 兼容锚点）；**凭据经 fs 拦截 launcher 注入**（`appserver-launcher.ts` 落盘 wrapper 进程，patch fs 把 CLI 对 `~/.zcode/cli/config.json` 的读取重定向为「真实文件 + v2 provider 注入」内存合并，同 id 时 v2 整条优先——v2 是权威凭据源；漂移面 = zcode 升级若改变配置读取路径/方式，失败信号 missing baseURL / Model config is missing 明确报错）。[池抽象降级 2026-09-13] poolKey 协议面整体退役（RunContext/run.params.ctx/host/poolResolved 通道/EngineHandleData.poolKey 已删；PI_POOL_KEY/ZCODE_SHARED_POOL_KEY 常量删除）——journal 固定落 `engines/zcode/shared/`（SDK `SHARED_POOL_KEY` 承载，磁盘布局字节不变）；持久化 record.engineHandle.poolKey 字段保留（值恒 'shared'，读侧守卫要求非空）。约束登记 C-ext-20；设计修订见 `docs/architecture/zcode-engine-appserver-resident.md` 头部与 `docs/architecture/zcode-session-db-isolation.md`

## 发布与 CI 验证 [HISTORICAL]

两条独立管线：Electron 打包（`v*` tag → release.yml → `verify-ci-release.sh` 验证）与 npm 发布（`npm-*` tag → release-npm.yml）。npm 两条机制：main 稳定发布（人工定 type + `check-version-changes.sh` + `apply-version.sh`，merge skill 阶段 4N 封装，**禁止本地 `changeset publish`**，曾因 registry 最终一致性 E403）与 dev-npm 预发布（changeset pre，`scripts/npm-prerelease.sh`）。补强（npm-publish-surface-guard D2，C-proc-11）：npm 发布实为三条路径（正式 `release-npm.yml` / dev 线推 `dev-npm-*` 分支触发 `release-npm-dev.yml` / 本地 `npm-prerelease.sh`），publish 前均挂 `scripts/check-publish-surface.mjs` 硬拦截（幽灵 files 条目 / 产物目录反向覆盖 / 自包含探针）——「push tag 后验证 CI」流程中守卫红灯是合法失败形态。

- changeset 准则（PR 阶段）：type 是初判最终人工定；body 认真写（进 CHANGELOG）；dep 传播不在 PR 声明（merge 时自动闭包）
- **[MANDATORY] push tag 后必须验证 CI 产物**：push 发布 tag 后禁直接宣布完成，轮询 CI 验证产物直到脚本 exit 0（预发布 `prerelease-test.sh` 内置 / 正式 `bash scripts/verify-ci-release.sh v<version>`）。exit 非 0 修到 0，禁说「应该没问题」
- **[MANDATORY] Release Notes 中英双语 + 写作规范**：`<!-- LANG:en -->` 在前 `<!-- LANG:zh -->` 在后，标记独占一行，无标记旧 release 向后兼容；写作规范 SSOT 在全局指引 `~/.agents/guide/release-notes.md`（三节结构 / 每条 30 字以内面向用户模糊化 / 工程细节不进 note），项目特化补充见 [docs/release-notes.md](docs/release-notes.md)，撰写前必读

## 跳过检查

cw testRunner 的 monorepo 坑已修复（wave design 填 `plan.testCwd: "<子包目录>"`，gate 数字与本地一致）[HISTORICAL]。默认禁止跳过检查；下表 `SKIP_*` 变量（pre-commit 全部逃生口，SSOT = `.githooks/install-hooks.sh` 生成的钩子本体）仅限线上热修复且须 commit message 说明原因。多数新守卫不设独立开关（R1 后惯例，仅 `SKIP_ALL_CHECKS` 总闸兜底）。

| 变量 | 跳过对象 |
|------|---------|
| `SKIP_ALL_CHECKS` | 总闸：pre-commit 全部检查 |
| `SKIP_FRONTEND_LINT` | 前端 ESLint（renderer staged .vue/.ts） |
| `SKIP_TYPE_CHECK` | 前端 vue-tsc 类型检查（全量 + 测试 tsconfig） |
| `SKIP_EXTENSION_LINT` | extensions ESLint/tsc/manifest/结构一致性/files 白名单四段（2b-2e 共用） |
| `SKIP_CODE_RULES_CHECK` | vue_rules_checker 代码规范 + vitest 防线挂载守卫（共用） |
| `SKIP_SIDECAR_SESSION_CHECK` | Sidecar session 隔离检查 |
| `SKIP_CSS_TOKENS_CHECK` | CSS tokens 检查（style.css 组件级样式禁令） |
| `SKIP_CSS_TOKEN_SSOT_CHECK` | CSS token SSOT 一致性（DESIGN.md 投影 ↔ style.css） |
| `SKIP_RENDERER_DEPS_CHECK` | Renderer 依赖完整性（import vs package.json） |
| `SKIP_ENV_WHITELIST_CHECK` | ENV_WHITELIST_PREFIXES SSOT 单一性检查 |
| `SKIP_TOOL_SCHEMA_CHECK` | Pi extension tool schema 顶层 Object 合规检查 |
| `SKIP_PATH_WHITELIST_CHECK` | 路径白名单动态化检查 |
| `SKIP_WS_SEND_CHECK` | ws-client send 直调检查 |
| `SKIP_NO_SERVICE_CYCLE_CHECK` | runtime services 循环依赖检查 |
| `SKIP_CSP_COMPAT_CHECK` | CSP 能力一致性检查 |
| `SKIP_RUNTIME_BUNDLE_CHECK` | Runtime Bundle 验证（runtime 源码变更时） |
| `SKIP_BOUNDARY_CHECK` | AC7 extension-host 边界检查（core 源码变更时） |
| `SKIP_PREFLIGHT_CHECK` | 打包配置预检查（electron-builder.yml / tsup.config.ts 变更时） |
| `SKIP_DIRECTORY_RULES_CHECK` | 目录规范检查（禁 demos/impeccable + 外部 symlink） |
| `SKIP_I18N_CJK_CHECK` | i18n CJK 残留检测（.vue 模板硬编码中文） |
| `SKIP_I18N_LOCALE_SYNC_CHECK` | i18n locale 双侧 key 对齐检查 |

CSP 能力一致性检查（`check_csp_compatibility.py`）[HISTORICAL]：2026-08 v0.9.3+ CSP `script-src 'self'` 拦截 shiki Oniguruma WASM 致全部 markdown 渲染静默降级纯文本，源码级 eval/WebAssembly 用法与 CSP 指令不一致即拦截；产物级防线在 `postbuild-validate.sh`。
