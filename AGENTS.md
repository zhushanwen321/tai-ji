# xyz-agent AGENTS.md

Electron + Vue 3 + Node.js Runtime 的 AI Agent 桌面工作台。架构分层：

- **Electron 主进程** (`apps/electron/main/`)：窗口管理、runtime 子进程生命周期、快捷键
- **Preload** (`apps/electron/preload/`)：安全桥接，暴露 `electronAPI`
- **渲染进程** (`packages/renderer/src/`)：Vue 3 + TS + Pinia + Tailwind v3 + xyz-ui（太极纯灰设计系统）
- **Runtime** (`packages/runtime/src/`)：Node.js WebSocket 服务（transport/services/infra 三层），子进程 RPC 与 pi 通信
- **共享类型** (`packages/shared/src/`)

## 文档索引

| 主题 | 文档 |
|------|------|
| **功能与用例分级（P0-P3 SSOT）** | [docs/feature-priorities.md](docs/feature-priorities.md)——tech-design 风险打分锚定源 / 测试回归排序依据 / dev-flow 收尾同步登记目标；功能挂掉后果变化须同 commit 更新 |
| **架构约束登记表（SSOT）** | [docs/constraints.json](docs/constraints.json)（机器权威）· [docs/constraints.md](docs/constraints.md)（生成式人读视图）——全部架构级约束的 id/scope/权威源/执行方式登记处；新增约束先登记再写代码，改 json 后跑 `node scripts/render-constraints.mjs` 重新生成 md；CR 动态加载：`node scripts/select-constraints.mjs --base main` |
| 完整编码规范 / UI 设计演变 / 术语表 | [docs/standards.md](docs/standards.md) · [design-evolution.md](docs/design-evolution.md) · [architecture/context.md](docs/architecture/context.md) |
| 设计系统（tokens / 原语层 / v6 SSOT / 视觉规格） | [docs/page-design/](docs/page-design/)（design-tokens.md · design-system.md · v6-master-spec.md · v6-spec-*.html；能力设计 spec 在 `archive/v3/`。禁止创建 `demos/`、`impeccable/` 目录） |
| 窗口顶部 traffic light 布局数值 SSOT | [traffic-light-layout.md](docs/page-design/traffic-light-layout.md)（v3 刻意调整形态，不遵循 v6 demo） |
| Renderer 终态包拓扑（现行 SSOT）/ 七层目标概念与 v6 重构（历史） | [architecture/renderer-rebuild-architecture.md](docs/architecture/renderer-rebuild-architecture.md)（现行 SSOT：§3 包拓扑 / §4 core 分层）· 历史：[renderer-target-architecture.md](docs/architecture/renderer-target-architecture.md)（七层目标概念，已 supersede）· [v6-architecture-refactor.md](docs/architecture/v6-architecture-refactor.md)（已 supersede） |
| pi 边界可靠性（语义吸收层四支柱） | [docs/design/pi-boundary-reliability.md](docs/design/pi-boundary-reliability.md)（能力注册表 / 生效回执 / 确认式送达 / 漂移守卫；决策记录 [ADR-0064](docs/adr/0064-pi-semantic-absorption-layer.md)，约束登记 C-pi-12 / C-pi-13 / C-ext-19 / C-proc-08） |
| 功能开发地图（启动新 Phase 前更新） | [docs/feature-map/](docs/feature-map/)（最新 2026-08-28.md） |
| 测试策略 SSOT | [TEST-STRATEGY.md](TEST-STRATEGY.md) + [docs/testing/](docs/testing/)（00 总览入口；testid 清单/调用链/已知坑） |
| Release Notes 写作规范 | 全局规范 SSOT `~/.agents/guide/release-notes.md`（三节结构 / 30 字模糊化 / 双语强制；merge 阶段 5 撰写 notes 前必读）+ 项目特化 [docs/release-notes.md](docs/release-notes.md)（展示位 / release.sh 草稿行为） |
| 问题排查（日志/诊断/常见问题/历史排查规则） | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Pi Extension 开发 | [docs/extensions/development-guide.md](docs/extensions/development-guide.md)（指南）· [extension-conventions.md](docs/extensions/extension-conventions.md)（强约束）· [logging-conventions.md](docs/extensions/logging-conventions.md)（日志现行 SSOT）· [glossary.md](docs/extensions/glossary.md) · [local-dev-guide.md](docs/extensions/local-dev-guide.md) |
| Subagent 体系架构（包拓扑 / 协议面 / 机制落点） | [docs/extensions/subagents/architecture.md](docs/extensions/subagents/architecture.md)（现状 SSOT 导航页：5 类包拓扑 · engine-protocol v1 · 关键机制落点表 · 主题文档指针） |
| 待执行架构任务 | [docs/todo/remote-use-merge-architecture.md](docs/todo/remote-use-merge-architecture.md)（合并 remote-use 后删除） |

**外部依赖 pi**：[badlogic/pi-mono](https://github.com/badlogic/pi-mono) 上游（npm `@earendil-works/pi-coding-agent@0.84.4`，曾用 fork xyz-pi 已切回）。**[MANDATORY] 不修改 pi 源码、不提 PR、不 fork**——pi 没有的能力由 xyz-agent 自实现。**pi 语义断言的权威源 = node_modules 实装版**（断言前 `npm ls @earendil-works/pi-coding-agent` 核对版本，以 dist 编译 JS 为准）；clone `~/Code/git-fork/pi-mono-workspace/main/packages/`（coding-agent/src 核心逻辑、ai/src/providers provider 层）仅作可读 TS 参照，引用前须核对 clone 版本与实装一致（clone 领先/落后实装均属常态——曾因按 0.80.3 clone 断言 0.84.1 行为连产 4 条漂移 bug，审计 C #6）。不靠网络搜索。pi 版本 bump 受 C-proc-08 版本门禁机器拦截（`node scripts/check-pi-semantics.mjs`：四包版本一致 + verifiedWith 比对 + 探针族重验；升级 PR 必查 pi-ai exports 的 `./compat` 与 changelog ModelManager 迁移——登记细节以 constraints.json 为准）。构建期派生锚点（build.yml env / prepare 脚本默认值 / 快照 / extensions peerDeps / KNOWN_PI_API_TYPES / pi-tui）由 `node scripts/check-pi-sync.mjs` 守卫跟随（约束登记 C-build-07，pre-commit 按路径触发 + CI invariants）——升级 pi 后必须执行 `pnpm gen:builtin-providers` 重生成快照并随升级 PR 提交，锚点漏同步会被守卫拦截。

**Pi Extension 源码（本项目维护）**：`extensions/` 下 21 个 `@zhushanwen/pi-*` 包，按职责分两组（约定见 [extension-conventions.md](docs/extensions/extension-conventions.md)「目录分组」）+ `extensions/shared/` 共享库（llm-shared / extension-logger / file-lock / ext-guards），统一在本仓开发发布（旧仓 xyz-pi-extensions-workspace 已废弃，以本仓为准）。分组（package.json `xyz-agent.role` 字段必须与所在分组一致，`scripts/check-extension-dependencies.mjs` 校验）：

- **`extensions/taiji/`**（role=taiji，xyz-agent 集成包——契约两端在 xyz-agent 体系内，离开 xyz-agent 无功能，必在 mandatory 清单）：agent-ext / msg-id-mapper / plugin-bridge（Plugin system bridge——register plugin tools into pi and relay events/intercepts via select marker channel） / system-prompt / system-prompt-trace（builtin feature-tier，xyz:system-prompt 留痕）
- **`extensions/universal/`**（role=universal，独立通用包——功能自足，独立 pi 用户可单独安装）：ask-user / base-tool-enhance（同名 override 内置 bash 工具：前台委托 pi 官方工厂保持等价 + 增量 background 后台模式 + 工具报错审计，承接已废弃 unified-hooks 的能力；设计见 [docs/design/base-tool-enhance.md](docs/design/base-tool-enhance.md)） / cache-probe（前缀指纹采集 + analyze.py 归因） / cw-tool / goal / pending-notifications / permission / plan / rename-session / scheduler / session-manager（agent-managed session：6 个 session 管理工具经 select+SESSION_MANAGER_MARKER 通道对接 xyz-agent runtime 的 SessionManagerHandler；嵌套 {action,params} 契约 SSOT 在 @xyz-agent/extension-protocol） / session-reader / smart-context（agent 自决上下文压缩：compact_context 工具 + 双模式摘要接管 + 分档提醒） / structured-output / subagent-workflow / todo

新增/删包时更新此列举与所在分组。校验：`pnpm extensions:typecheck` / `extensions:lint` / `extensions:test`。

- **[MANDATORY] extension 改动优先在本地 pi CLI 实测**（不是 xyz-agent 桌面）：`pi --mode rpc --session-dir <dir> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <path>` + stdin JSONL 发 prompt；`XYZ_AGENT_DEBUG=1` 看 `~/.pi/agent/logs/` 扩展日志。xyz-agent 的 builtin 打包/数据隔离/runtime 中转层会掩盖版本差异
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

`pnpm dev` 走 `apps/electron/scripts/dev-instance.mjs` 装配器（C-dev-01）：按 worktree 名 hash 稳定派生端口（Vite/CDP/runtime 段）+ 数据目录 `~/.xyz-agent-dev/instances/<worktree>/`（首启从只读模板 `~/.xyz-agent-dev.template/` 复制，默认模型预置 mimo-v2.5-pro），多 worktree 并行 dev 互不干扰。**AI agent 真机验收必须 `XYZ_DEV_BACKGROUND=1 pnpm dev`**（showInactive 不抢前台焦点，遵循 browser-automation skill 对策 2）；连接前 `node apps/electron/scripts/dev-instance.mjs --print` 查本实例 CDP 端口，browser-automation 连 `http://localhost:<cdp-port>`（截图/DOM/执行 JS）。验收要干净环境时加 `--fresh`。

- 实例排查：单实例锁按数据目录 userData 区分（多实例天然共存）；连错实例看旧代码——先确认 `list-pages` URL 是本实例的 `localhost:<vite-port>`；模板调整后 `node apps/electron/scripts/dev-instance.mjs init-template --force` 重建（只读模板勿直改）
- 打包版太极.app 可能同跑（占 3210）；裸跑（不经装配器）时 dev CDP 9222 / Vite 1420 / runtime 3310
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
8. **per-session 状态隔离范式 [ADR-0049]**：持有 per-session 状态的 composable 必须用 `useSessionScopedState` 工厂（Map 分区范式），禁止实例级状态 / watch(sessionId) 手动清空。**WS handler 必须用 `updateFor(capturedSid)` 不用 `update`**（结构性消除切 session 竞态）；cleanup 由 `useSidebar.deleteSession` 统一编排。新增/修改 composable 时 reviewer 按 [ADR-0049 Checklist](docs/adr/0049-session-isolation-map-partition.md#code-review-checklist范式守护替代-eslint-规则) 逐条确认
9. **对话流状态必须实时可见 + 重开 session 仍可见 [HISTORICAL]**：实时链路（message.* 广播 + core `effects/registry.ts`）与持久化链路（entry → 同一 `applyEntry` reducer，不丢弃任何 pi entry 类型 / 文件路径 JSONL filter 不只留 message）两条通路必须同时实现——bash/user/custom/compaction 全类型 live entry 化（2026-08 conversation-turn-attribution）后两通路共用同一 reducer，「live ≡ reload」构造性成立，等价性测试（`apply-entry-equivalence`）守卫。命令副作用归 `message-dispatcher.ts` 编排，不散落 event-adapter。检测：操作后关闭重开 session，对话流应一致

**workspace / git**：

10. **Worktree 创建必须走 `git-cwt`**（自动 pnpm install + Electron dist 缓存 symlink）；Vite `strictPort: true`，1420 被占则静默失败加载旧代码——`lsof -i :1420 -P` 确认端口归属
11. **Bare repo 模式**：`origin` = 本地 `.bare`，GitHub remote 叫 `github`（push 用 `git push github HEAD:fix-xxx`）；workspace root 不是 git repo，`gh` 命令带 `--repo zhushanwen321/xyz-agent`；merge 脚本无 main worktree 时用 `git --git-dir` 指向 `.bare`，版本 bump push 用 `HEAD:refs/heads/main`

**架构机制**：

12. **Electron 打包约束（事故最高发）**：① runtime 源码禁止 `import.meta.url` / `globalThis.__dirname`（CJS bundle 下失效），路径用 `typeof __dirname !== 'undefined' ? __dirname : undefined`；② 新增 runtime 依赖必须同步加 `tsup.config.ts` 的 `noExternal`；③ 打包子系统改动逐个 commit 逐个验证。细节核对见 `pr-cr-fix/agents/review-electron-build.md`；验证三阶段（preflight → build → postbuild）+ validate-runtime-bundle 由脚本自动化
13. **目录规范**：禁止 `demos/` / `impeccable/` 目录；禁止外部绝对路径 symlink（pre-commit 检查）；`.xyz-harness/` 必须提交不可删除（决策追溯）；`DESIGN.md` 保留作历史参考（已 DEPRECATED by ADR-0019）
14. **项目 skill 必须自包含 [HISTORICAL]**：`.agents/skills/` 引用的脚本复制到 skill 目录内随 git 跟踪（`merge/scripts/` 已自包含），禁止依赖 `~/.agents/skills/` 全局脚本或 symlink
15. **排查规则（untracked 展开 `-uall` / 禁止写死绝对路径用 `getDataDir()` 等动态推导 / 跨层机制穷尽 pi extension 层）**：详见 [docs/troubleshooting.md](docs/troubleshooting.md) 的「历史排查规则」

**Plugin / Builtin extensions**：

16. **Plugin System**：PluginService 是唯一适配层（WS → server.ts → PluginService）；trusted 插件跑 Worker Thread、sandbox 跑独立 fork 子进程；hook 按 priority 串行（单 handler 5s 超时放行）；sessionData 写入 debounce 缓存 + shutdown flushAll；WS 命名 Client→Server 点号（`plugin.xxx`）/ Server→Client 冒号 camelCase（`plugin:statusBarUpdate`）
17. **Builtin pi-extensions 打包内置（现行）**： `@zhushanwen/pi-*` 包 esbuild bundle 后 staged 到 `apps/electron/resources/extensions/` 随应用打包（不走 npm 安装；数量以 `packages/shared/src/mandatory-extensions.json` SSOT 为准，不在此写死）。清单 SSOT = `packages/shared/src/mandatory-extensions.json`（infrastructure 组不可禁、feature 组可禁、都不可卸，组内包数以该 JSON 为准；守卫抛 `builtin_cannot_*`）。[HISTORICAL] 演化：builtin 依赖 → 推荐安装 → mandatory npm → 打包内置（2026-08-12）；「删除打包所需依赖致产物缺失」教训始终适用（pi binary、builtin 扩展包如 `@zhushanwen/pi-system-prompt` 同理）
18. **子进程 env 出站契约（C-proc-09）**：进程创建点的子 env 必须经 `buildOutboundChildEnv` 构建（deny 清单剥 `XYZ_AGENT_PACKAGED` / `XYZ_RUNTIME_TOKEN`），与 `ENV_WHITELIST_PREFIXES` 入站准入正交——入站管准入、出站管外泄；守卫 `.githooks/check_spawn_env_boundary.py`，设计依据 [docs/design/env-propagation-boundary.md](docs/design/env-propagation-boundary.md)
19. **超时默认原则（任务级默认无超时，量级按对象粒度校准）**：subagent turn / workflow `agent()` / 引擎 run 等**任务执行正常路径禁止自带墙钟超时**——用户显式指定（`timeoutMs` / `budgetTimeMs` / watchdog env）才生效，调用方未传就是不限时。必须设防挂死兜底时，量级必须按**被保护对象的粒度**校准：任务级（subagent / workflow run）= 小时级或「无进展检测」（idle / ping，ADR-0047：静默 ≠ 卡死，活跃产出不得判死）；控制面单请求（RPC 帧 / 探针 / 握手）= 秒级；禁止跨粒级挪用（单 turn 分钟级预算 ≠ 整任务总预算）。回收层（dispose / kill / 上界 / idle timer 四族）防挂死兜底允许默认有界（opt-out）——权威裁决见 [subagent-core-unbounded-wait-audit.md](docs/design/subagent-core-unbounded-wait-audit.md)「正常路径逐点根修 + 回收层统一有界兜底」。[HISTORICAL] 反例：zcode appserver `turnTimeoutMs` 固定 300s 墙钟（`ZCODE_APPSERVER_TURN_DEFAULT_TIMEOUT_MS`，2026-09 实测 21% 任务误杀——343s/541s 正常完成的任务被 300s 判死，死后 app-server 继续烧 token；且流式 delta 不刷新计时）。
20. **pnpm store 布局双向翻转（沙箱 HOME × pnpm store）**：zsw 引擎 worker 等沙箱执行体覆写 HOME，其 pre-commit 内 verify-*.sh 自含 `pnpm install` 会把沙箱侧 store 写进 `node_modules/.modules.yaml` 的 storeDir；本地（正常 HOME）后续 install 判布局过期 → `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 硬崩（pre-commit 随机红，`CI=true` 治标会复发）。护栏 `.githooks/check_pnpm_store_layout.sh`（pre-commit 第 0 段 + validate-runtime-bundle Gate 0）翻转即红并给 [FIX]；恢复：`CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install`（约 6-7s）。根因/排障见 [docs/troubleshooting.md](docs/troubleshooting.md)；引擎侧修复落地后护栏应恒绿，红 = HOME 覆盖回退的验收信号
21. **看门狗/滚动重启默认不武装（Gate W 数据门，C-proc-19）**：`XYZ_RUNTIME_WATCHDOG_ARMED` 缺失时 runtime watchdog 纯观测（采样进环，无 relief / 无滚动重启 / 无通知）——armed 动作必须显式 env 开启，且武装前置 = V6 soak 水位数据 + 评估器 watermark-daily 趋势复审通过（阈值校准 + 重启循环风险排除），禁未经数据复审先武装（兜底先行掩盖问题）；滚动重启走专用退出码 86 + supervisor 零退避零计数，推迟上限 30min（`XYZ_ROLLING_RESTART_DEFER_LIMIT_MS`）。设计依据 [docs/design/crash-forensics-and-watchdog.md](docs/design/crash-forensics-and-watchdog.md) §3.2 方案 B / D5

## 测试

**先读 [TEST-STRATEGY.md](TEST-STRATEGY.md)（分层/mock/回归基线 SSOT）+ [docs/testing/](docs/testing/) 对应功能文档**，复用已有 testid/调用链/踩坑经验。红线：vitest（禁 `node:test` / `tsx --test`，配置在子包 vitest.config.ts，从子包目录运行）；timer 测试用 fake timers；派编码 subagent 时 task 写明测试框架。**三视角缺一不可 [HISTORICAL]**（构建者白盒 + 使用者黑盒 + 观察者形态；每条用例至少一个用户可见 DOM 断言；spec 结构条目 = 渲染断言清单）——细则见 TEST-STRATEGY.md §3。

**用例级耗时报告**：vitest 包的 config 统一配 `reporters: ["default", "junit"]` + `outputFile: { junit: "./test-results/vitest-junit.xml" }`（`test-results/` 已 gitignore），每次 run 自动落盘用例级耗时，慢用例排查用 grep/sort，勿临时加 reporter flag：`grep -o '<testcase classname="[^"]*" name="[^"]*" time="[0-9.]*"' test-results/vitest-junit.xml | sed -E 's/.*classname="([^"]*)" name="([^"]*)" time="([0-9.]+)".*/\3s \1 > \2/' | sort -rn | head -15`。已有自定义 reporters 的包（如 runtime 的 cw-acceptance-markers-reporter）**追加** `junit` 项而非覆盖；v4 json reporter 的文件级 `duration` 恒 null（用例级有值），程序化消费用 junit `time` 属性。示范实现：`packages/subagent-core/vitest.config.ts`；新建 vitest 包默认带上，存量包改动其测试时顺手补。

**测试禁止触碰真实数据目录 [HISTORICAL]**（2026-09-02 会话丢失事故：测试在 env 带 `XYZ_AGENT_DATA_DIR=~/.xyz-agent` 时运行，`rmSync(getSessionsDir())` 删光全部活跃会话，三个 pi 进程追加写入 ENOENT 崩溃——appendFileSync flags `'a'` 本可自建文件，ENOENT 根因是父目录被 recursive 删除）。双层防线已固化在 runtime vitest：① `test/global-setup.ts` 对「注入的 `XYZ_AGENT_DATA_DIR` 指向真实 `~/.xyz-agent`」fail-fast 拒跑；② `test/fs-guard.ts`（setupFiles 切面）拦截全部破坏性 fs 操作（写/删/移动），**白名单 = `os.tmpdir()` + `$XYZ_AGENT_DATA_DIR`（≠ 真实目录）+ `~/.xyz-agent-dev`（homedir 动态推导），其余目录一律抛错**。约束：新测试的写删目标必须 `mkdtempSync(join(tmpdir(), ...))` 自建自删，禁止删除 `getSessionsDir()` 等共享推导路径；禁止绕过 guard（restore 原始 fs / 子进程删真实目录）；renderer/core 等其他包新增或改造 vitest 配置时必须挂同款 setupFiles。

## 前端编码规范

权威标准：`~/Code/xyz-ui/CONVENTIONS.md`。核心：

1. 禁止原生 HTML 表单元素（用 xyz-ui 组件）；禁止 Emoji（inline `<svg>` / @lucide/vue）
2. 样式三层：tokens（`style.css` 只放 CSS 变量 + reset）/ Tailwind 工具类（组件样式统一在此）/ `<style scoped>` 仅 escape hatch（伪元素、后代选择器、Transition 类）。禁止 `@apply`
3. `<template>` ≤ 400 行，`<script setup>` ≤ 300 行；禁止 `any`（断言须有运行时 guard，extensions/ 由 taste/no-unsafe-cast 强制）
4. `v-model`（禁 `:value` + `@input`）；独立数据源用 `Promise.allSettled`
5. 禁止硬编码颜色 / 魔数间距（用 CSS 变量与标准 Tailwind scale）
6. border-radius 遵循 v3 tokens（`--radius-sm:3px` 默认 / `--radius:8px` / `--radius-lg:12px`，ADR-0019）
7. **窗口顶部 traffic light 布局**：v3 刻意调整形态（非 v6 demo），全部数值（AppShell p-1 / pt-11 / {x:8,y:8} / h-[22px] 共线等）见 [traffic-light-layout.md](docs/page-design/traffic-light-layout.md)——改窗口顶部 UI 前必读
8. **reka ScrollAreaViewport 默认 `overflow-x: hidden` [HISTORICAL]**：横向滚动需给 `ScrollArea` 传 `horizontal` prop（`!overflow-x-auto` 覆盖内联；`:deep()` 会破坏 reka Root 渲染顺序）

自动化检查：taste-lint（no-native-html / no-emoji / prefer-v-model 等，`pnpm run lint` + pre-commit）· vue_rules_checker.py（行数/选择器/Tab/原生元素，pre-commit）。

**Lint / Hooks 原则 [MANDATORY]**：按全局 AGENTS.md「Pre-commit Hook 问题处理」执行——检出问题全部正面修复（含存量、含 warning），禁 `--no-verify` / `SKIP_*`（仅限线上热修复并说明）；规则误报修正规则本体并加 `[HISTORICAL]` 注释，禁 `eslint-disable-next-line` 静默。

**完成即提交 [MANDATORY]**：按全局「提交策略 → 完成即提交」；「检查未过」不构成不提交理由（先修复）。

## Git 规范

分支 `feat:`/`fix:`/`refactor:`/`chore:` 前缀；commit 英文 conventional 风格；粒度见全局提交策略（优先本次会话改动，文件级）。

## pi 资源放置

agent.md / workflow.js 归位：与 extension 强相关（tools 受限某 extension / 离开该 extension 不可用）→ `extensions/<group>/<pkg>/agents|workflows/` + package.json `pi.agents`/`pi.workflows`；项目自用 → `.agents/agents|workflows/`；跨项目通用 → `~/.agents/`。发现机制：resource-discovery 扫 7 源同名 last-writer-wins（project-agents 最高）；extension 内置 agent 须装到 npm 扫描目录才被发现（dev-link 不发现 agent）；skill 走 `pi.skills` 独立通路（first-writer-wins）。SSOT：`extensions/universal/subagent-workflow/src/shared/resource-discovery.ts`。

## 架构约定

- 视图切换状态驱动（settingsStore.currentView），不用 vue-router；Mock 用 `VITE_MOCK=true` 在 ws-client 层拦截
- 共享类型经 `packages/shared/` workspace 共享；Runtime 通信走 WebSocket（ws-client.ts + event-bus.ts）；Electron IPC 经 preload 暴露 `electronAPI`
- **Runtime broadcast 时序竞争 [HISTORICAL]**：session 激活/创建流程内部发出的 session 级 broadcast 早于 renderer 订阅 → 消息丢失。renderer 切换/创建 session 后需立即消费的 session 级状态必须主动拉取（`session.getCommands` RPC），不可依赖 broadcast
- **数据目录隔离**：`~/.xyz-agent/` 与 `~/.pi/agent/` 完全隔离；路径白名单禁止硬编码，从 `getConfigDir()` / `getPiAgentDir()` 动态推导（pre-commit 检查）
- **ENV_WHITELIST_PREFIXES SSOT**：只许定义在 `packages/shared/src/constants.ts`，main/runtime 只 import（pre-commit 检查）
- **Runtime/pi 日志必须落盘 + 轮转**（`<getDataDir>/logs/`，date + size 双策略，dev debug / prod info）；pi stdout tee 到 `pi-<date>-<sessionId>.jsonl`（pi 卡死时唯一证据）；新增日志库必须加 tsup `noExternal`
- **设计文档同步纪律 [HISTORICAL]**（C-proc-10 + dev-flow post-delivery）：修复 impl-plan/设计文档登记过的残留风险时，同 commit 回写登记与变更历史（登记即债务修复即清账）；符号删除/改名/常量改函数须同批清扫 docs 与测试注释中的悬空引用，`node scripts/check-doc-symbol-drift.mjs` 必须跑过（pre-commit 按 docs/design/ 或映射源码路径触发）。起因 2026-08-31：流水线后修复 UPDATE_DIR 烤死 bug 只改代码未回写文档，对抗审查抓出 9 条漂移
- **包管理器纪律 [HISTORICAL]**：pnpm workspace 单一管理器，`pnpm-lock.yaml` 唯一权威，通用纪律按全局 lock 规则。npm 例外（不要"统一"）：外部消费者安装指引 / `npm publish` / runtime 安装用户 extension / 规则正文描述被禁命令 / `npx`。标准：执行者是本项目开发者/CI/AI → pnpm；外部消费者/终端用户 → npm
- **zcode 引擎单一 app-server 形态（2026-09 用户拍板）**：zcode 引擎现役实装在 **`packages/zcode-subagent-cli`**（引擎协议化 W5/W11 后自主包，core 壳侧零内建 zcode），**只走 app-server RPC，不走 CLI spawn**（`zcode --json --prompt` 单轮链与 probe 冒烟/protocol-drift 降级已删除——协议漂移直接报错）；**共享宿主 HOME**（spawn env 不覆写 HOME——db/plugins/MCP 继承宿主 HOME；无 HOME 池/锁/pidfile）；**会话库隔离（2026-09-09）**：spawn env 覆写 `ZCODE_SESSION_DB_PATH`（并清空别名键 `ZCODE_SESSION_DB`），会话落独立库 `<engineDataDir>/engines/zcode/session-db/db.sqlite`（路径单一来源 `zcodeSessionDbPath()`，不进 ZCode GUI 侧边栏，不落 `engines/zcode/shared/` 池目录），与 GUI 引擎库分离——GUI 侧边栏零污染；handle.dbPath 为隔离库绝对路径，两条读取链（`session-view-service` ①级 + `EnginePort.read`）按 `zcodeDbPathAllowlist(dataDir)` 白名单集合成员判定放行（集合第二项 = 宿主库路径，仅存量 record 兼容锚点）；**凭据经 fs 拦截 launcher 注入**（`appserver-launcher.ts` 落盘 wrapper 进程，patch fs 把 CLI 对 `~/.zcode/cli/config.json` 的读取重定向为「真实文件 + v2 provider 注入」内存合并，同 id 时 v2 整条优先——v2 是权威凭据源；漂移面 = zcode 升级若改变配置读取路径/方式，失败信号 missing baseURL / Model config is missing 明确报错）。poolKey 恒 `'shared'`（journal 落 `engines/zcode/shared/`）。约束登记 C-ext-20；设计修订见 `docs/design/zcode-engine-appserver-resident.md` 头部与 `docs/design/zcode-session-db-isolation.md`

## 发布与 CI 验证 [HISTORICAL]

两条独立管线：Electron 打包（`v*` tag → release.yml → `verify-ci-release.sh` 验证）与 npm 发布（`npm-*` tag → release-npm.yml）。npm 两条机制：main 稳定发布（人工定 type + `check-version-changes.sh` + `apply-version.sh`，merge skill 阶段 4N 封装，**禁止本地 `changeset publish`**，曾因 registry 最终一致性 E403）与 dev-npm 预发布（changeset pre，`scripts/npm-prerelease.sh`）。补强（npm-publish-surface-guard D2，C-proc-11）：npm 发布实为三条路径（正式 `release-npm.yml` / dev 线推 `dev-npm-*` 分支触发 `release-npm-dev.yml` / 本地 `npm-prerelease.sh`），publish 前均挂 `scripts/check-publish-surface.mjs` 硬拦截（幽灵 files 条目 / 产物目录反向覆盖 / 自包含探针）——「push tag 后验证 CI」流程中守卫红灯是合法失败形态。

- changeset 准则（PR 阶段）：type 是初判最终人工定；body 认真写（进 CHANGELOG）；dep 传播不在 PR 声明（merge 时自动闭包）
- **[MANDATORY] push tag 后必须验证 CI 产物**：push 发布 tag 后禁直接宣布完成，轮询 CI 验证产物直到脚本 exit 0（预发布 `prerelease-test.sh` 内置 / 正式 `bash scripts/verify-ci-release.sh v<version>`）。exit 非 0 修到 0，禁说「应该没问题」
- **[MANDATORY] Release Notes 中英双语 + 写作规范**：`<!-- LANG:en -->` 在前 `<!-- LANG:zh -->` 在后，标记独占一行，无标记旧 release 向后兼容；写作规范 SSOT 在全局指引 `~/.agents/guide/release-notes.md`（三节结构 / 每条 30 字以内面向用户模糊化 / 工程细节不进 note），项目特化补充见 [docs/release-notes.md](docs/release-notes.md)，撰写前必读

## 跳过检查

cw testRunner 的 monorepo 坑已修复（wave design 填 `plan.testCwd: "<子包目录>"`，gate 数字与本地一致）[HISTORICAL]。默认禁止跳过检查；`SKIP_*` 变量（SKIP_ALL_CHECKS / SKIP_FRONTEND_LINT / SKIP_EXTENSION_LINT / SKIP_CODE_RULES_CHECK / SKIP_ENV_WHITELIST_CHECK / SKIP_PATH_WHITELIST_CHECK / SKIP_DIRECTORY_RULES_CHECK / SKIP_TOOL_SCHEMA_CHECK / SKIP_CSP_COMPAT_CHECK）仅限线上热修复且须 commit message 说明原因。CSP 能力一致性检查（`check_csp_compatibility.py`）[HISTORICAL]：2026-08 v0.9.3+ CSP `script-src 'self'` 拦截 shiki Oniguruma WASM 致全部 markdown 渲染静默降级纯文本，源码级 eval/WebAssembly 用法与 CSP 指令不一致即拦截；产物级防线在 `postbuild-validate.sh`。
