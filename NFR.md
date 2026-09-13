# 非功能约束（NFR）

> 工程级不变式，分 7 维度。每条约束带「验证」字段（grep AC / 事故来源 / 规则编号），破坏即 bug。设计新功能时对照本文件评估副作用。

## 1. 安全

| 约束 | 要求 | 验证/来源 |
|------|------|----------|
| 路径白名单动态化 | 禁硬编码 `~/.xyz-agent`/`~/.pi`，所有路径从 `getConfigDir()`/`getPiAgentDir()` 推导 | pre-commit `check_path_whitelist.py`；CLAUDE.md 安全约束#2 |
| ENV 白名单 SSOT 单一性 | `ENV_WHITELIST_PREFIXES` 仅定义在 `shared/src/constants.ts`，main/runtime 只能 import | `check_env_whitelist_sync.py`；CLAUDE.md 安全约束#3 |
| 数据目录隔离 | `~/.xyz-agent/` 与 `~/.pi/agent/` 完全隔离，互不读写 | CLAUDE.md 安全约束#1；ADR-0009 |
| dev/prod 实例隔离 | `XYZ_AGENT_DATA_DIR` 唯一心智锚点，dev 自动 `~/.xyz-agent-dev/`，端口偏移 +100，零侵入 prod | `2026-06-07-instance-isolation/spec.md` |
| DOMPurify 必须保留 | 聊天 markdown 容器 `.msg__body` 经 v-html 渲染，须净化 | `docs/STANDARDS.md §7.2` |
| Plugin Worker Thread 隔离 | 每个插件独立 Worker，崩溃不影响主进程；sandbox 插件受 PermissionChecker 约束，trusted(built-in) 不受限 | `2026-05-27-clarify-plugin-phase1/spec.md` FR-3 |
| Tool Approval / Human Confirm | 危险操作三选一(Allow/Deny/Always)；UI 弹窗 60s 超时自动关闭，用户可取消 | context.md「Tool Approval」 |
| findFiles 范围限定 | 限定 `process.cwd()`，自动忽略 `.git`/`node_modules`，插件不能搜项目外 | `2026-05-29-plugin-remaining-phases` NFR §5 |
| 文件树/git 路径越界守门 | 所有接收 path 的文件树/git 操作入口必须调 `isUnderOrEqual(cwd, resolvedPath)`，越界抛 `FileError('out_of_cwd')`/`GitError('path_not_allowed')`；防 `../../etc/passwd` 穿越。词法判定不解析 symlink（接受理由：用户对 cwd 内容负责） | `runtime/services/file-service.ts` + `git-service.ts` getFileDiff；`[from: 2026-06-28-sidebar-project-file-tree §S-1/S-5]` |
| git 命令防注入 | git CLI 必须经 `IGitExecutor.exec(cwd, cmd, args[])` port，`execFileSync('git',[cmd,...args])` 数组形式，禁函数体直接 exec/execSync 字符串拼接 | `runtime/infra/git-executor.ts`；`[from: 2026-06-28-sidebar-project-file-tree §S-3]` |
| 文件预览禁 v-html | 渲染用户可控的文件内容/diff 禁 v-html，用 `{{ }}`/`<pre>` 文本插值；高亮复用 shiki 单例，禁引第二套高亮库 | `renderer/components/panel/DetailPane.vue` grep 无 v-html；`[from: 2026-06-28-sidebar-project-file-tree §S-4]` |
- **持久化文件路径动态推导（S-13）**：所有用户数据持久化文件路径必须从 `getConfigDir()` 动态推导，禁止硬编码 `~/.xyz-agent` 或 `~/.pi/agent` 字面量。实例隔离机制允许 `XYZ_AGENT_DATA_DIR` 改变数据目录，硬编码会导致白名单失效/数据写入错误位置。验证：`recent-workspaces-store.ts:38-39` `join(configDir, FILE_NAME)` + real NFR 测试 T1.10 验证 getConfigDir() 不含 pi 路径。`[from: 2026-07-03-recent-workspaces §nfr Issue#1 INV-5]`

## 2. 数据

- **Session 隔离（核心）**：所有 runtime→前端消息若涉及特定 session，payload 必带 `sessionId`；缺失则忽略（防广播到所有 panel）。三层机制：ChatStore `Map<sessionId>` 分区 → useChat 全局路由 → PaneSessionView 组件过滤。Runtime 侧 `server.ts sendError` 也必须带 sessionId。验证：CLAUDE.md 规则#7（「违反必出 bug」）
- **延迟写入**：pi 的 `_persist()` 在首个 assistant 消息前不写 session 文件；读取 `get_state` 返回的 sessionFile 路径时文件可能不存在，必须处理 not-exist（返回空树/空消息）。验证：CLAUDE.md 规则#6
- **.jsonl 持久化**：扁平结构，不按 cwd 子目录组织；entry 每行一个 JSON。验证：`docs/STANDARDS.md §4.2`
- **文件是 SoT，内存是缓存**：启动加载 → 写后刷新 → 防竞争（异步队列串行化）。验证：`docs/STANDARDS.md §5`
- **PluginStorage 原子写**：write-to-temp + rename；500ms debounce 批量写；每插件 10MB 上限，单 value 1MB。验证：plugin-phase1 spec FR-6
- **sessionData**：通过 Pi Bridge 走 `pi.appendEntry()` 持久化在 pi session JSONL，天生跟随 session 生灭（区别于独立 JSON 的 PluginStorage）
- **持久化文件损坏降级空数据（S-14）**：读取用户数据持久化文件遇 ENOENT 或非法 JSON 必须 try/catch 降级返回空数据（[]），不得抛异常导致启动失败。首启文件不存在是正常态；磁盘错误/外部篡改不应阻塞启动。验证：`recent-workspaces-store.ts:116-128` try { JSON.parse } catch { 返回 [] } + 单测 T1.5/T1.6。`[from: 2026-07-03-recent-workspaces §nfr Issue#1 INV-4]`
- **用户数据写入必须 atomicWrite（S-15）**：用户数据持久化写入必须用 `atomicWrite`（temp + rename），禁直接 writeFileSync 覆盖主文件。半写崩溃时 rename 原子性保证“要么旧要么新”，无损坏中间态。与 PluginStorage 原子写（本节 S-PluginStorage）同模式。验证：`recent-workspaces-store.ts:141` atomicWrite 调用 + real NFR 测试 T1.11 验证崩溃保护。`[from: 2026-07-03-recent-workspaces §nfr Issue#1 atomicWrite]`
- **启动时异步数据加载必须在消费之前（S-17）**：renderer 启动编排中异步数据加载（如 workspaceStore.load）必须在消费该数据的状态设置（如 presetCwd）之前 await 完成，禁止依赖数据已就绪的隐式假设。load 与 presetCwd 顺序倒置 → presetCwd 读到空数据 → 默认 cwd undefined → 首屏空 chip。验证：`useSidebar.ts:360-364` await load → presetCwd + 集成测试 T3.3。`[from: 2026-07-03-recent-workspaces §nfr Issue#4 INV-6]`

## 3. 性能

- **流式渲染轻量**：流式阶段用 `renderLightweight`（markdown-it 无 Shiki）；完整阶段用 `renderFull`。MergeBlock 折叠时不挂载 ThinkingBlock/ToolCallCard（v-if）。验证：`docs/STANDARDS.md §7.2.6`
- **重型组件懒加载**：Mermaid 仅在页面有 mermaid 块时加载；shiki 语言包按需
- **状态反映 <100ms**：streaming setInterval(1000) 仅在 streaming 状态存在，complete 后清除，同时最多 1 个 timer
- **findFiles**：fast-glob（Rust 实现），>10k 文件项目 <500ms，1000 条结果截断
- **Hook 执行**：串行，单 handler 5s 超时，典型 1-2 handler 增加 <100ms。验证：CLAUDE.md 规则#11

## 4. 并发

- **session 单写者**：SessionService 持有 sessions Map，组合 lifecycle/dispatcher/scanner 三子模块经 `ISessionServiceInternal` 接口访问 Facade（非半构造）
- **subagent 并发限制**：TaskNode 递归嵌套 `max_depth=20`；底层复用 pi SubAgent extension
- **Worker Thread 分组**：trusted 插件共享 1 Worker（默认 max 10 插件），untrusted 插件每独占一 Worker（崩溃隔离）
- **多插件并发写互不阻塞**：每 pluginId 独立锁 + ReadWriteLock
- **独立数据源并行用 `Promise.allSettled` 不用 `all`**（CLAUDE.md 前端编码规则#7）

## 5. 稳定性

- **runtime 崩溃恢复**：Worker crash → 5s 冷却 + 3 次重建上限防 crash loop；trusted Worker 自动重建重载，untrusted 等下次激活。Hook 调用 try-catch 包裹，异常/超时视为放行，消息流不中断。验证：CLAUDE.md 规则#11
- **WS 重连**：退避上限后报错，不自动重试到死循环；重连成功后对所有 `isGenerating=true` 的 session 调 `markSessionError('连接已重置')` 收尾（不续传中断的 streaming，pi 上下文已丢失）
- **错误不变量集中**：`chatStore.markSessionError(sid, err)` 单一入口重置 isGenerating + streamingMessage（防 UI 卡「思考中」）。验证：CLAUDE.md 规则#3
- **命令超时善后**：默认 30s，超时 reject + 删 pending Map + 迟到响应静默丢弃
- **文件操作超时**：FileService listDir/stat/readFile 共用 `READ_TIMEOUT_MS=10_000`（10s），超时抛 `FileError('timeout')`；withTimeout 用单 Promise 构造器 + 手动 settle 避免 unhandledRejection。验证：`runtime/services/file-service.ts`。`[from: 2026-06-28-sidebar-project-file-tree §K-2]`
- **展开请求幂等去重**：同 path expand 在途时不重发（inFlight Map），loaded 复用缓存。验证：`renderer/composables/features/useFileTree.ts`。`[from: 2026-06-28-sidebar-project-file-tree §AC-3.8]`
- **error 冒泡链不经吞错层（S-6）**：编排层（composable）消费 WS 源须直调 domain 方法（如 `composer.getFileCandidates`），**不经**会吞错的中间层（如 `useFileSearch.load` 在 :39-43 静默 catch 降级空数组）；file 跳转须直调 `fileApi.read` 校验，不经 `useDetailPane.openPreview` 吞错层（后者 try/catch 吞错设 status='error' 不抛）。吞错层阻断失败冒泡 → catch 永不触发 → 错误处理假性 PASS。验证：`packages/core/src/domain/new-task-search/search.ts` grep `ports.fileCandidates` 无 `useFileSearch.load`（原 renderer `useSearch.ts` 已删）；`packages/core/src/domain/new-task-search/search-jump.ts` grep `ports.fileRead` 无 `openPreview`。`[from: 2026-06-30-search-modal §nfr MR-4.5/MR-6.2]`
- **WS 源超时 race（S-7）**：UI 消费 WS pending 的查询须包 `Promise.race` 超时（搜索 10s 量级，对齐 runtime），防 WS 断连时 `ws-client.ts onclose` 不 reject in-flight pending（pending.ts 无 clear/flush）→ pending 永不 settle → allSettled 永不 resolve → UI 永久 loading 挂死。超时→reject→allSettled settle→降级空态+toast。验证：`packages/core/src/domain/new-task-search/search.ts` `withWsTimeout` + `WS_SOURCE_TIMEOUT_MS`（定义在 `types.ts`）。`[from: 2026-06-30-search-modal §nfr MR-17.1]`
- **查询乱序守卫 loadSeq（S-8）**：快速连续查询（用户快速输入）时，编排层（useSearch.query）须维护自增 loadSeq 序列号，await 后比对 `seq !== loadSeq` 丢弃旧响应，防旧响应晚到覆盖新结果（数据错乱）。验证：`packages/core/src/domain/new-task-search/search.ts` grep `loadSeq` + `seq !== loadSeq return []`。`[from: 2026-06-30-search-modal §nfr MR-4.1]`
- **thinkingLevelMap 按 key 判定可用档位（S-9）**：`resolveAvailableLevels(map)` 必须遍历 map 的 **key**（pi 档位名 off/minimal/low/medium/high/xhigh）判定——key 存在且 value≠null = 可用，value=null = 不可用。**禁止按 value 判定**（value 是 provider 实际值如 'max'/'xhigh'，不是 pi 档位名，value-based 会导致档位名错乱）。与 pi `getSupportedThinkingLevels`（models.ts:50）语义一致。验证：`thinking-levels.ts` grep `for (const key of Object.keys(map))`。`[from: 2026-07-02-thinking-level-and-model-select §nfr N2]`
- **useThinkingLevelSync watch 必须 immediate（S-10）**：Composer 挂载时 `currentThinkingLevelMap` 首次求值即触发 watch——landing 态 `localThinkingLevel` 初始 undefined，不 immediate 则 popover fallback 到 'max'（可能不在当前模型可用集）。验证：`useThinkingLevelSync.ts` grep `immediate: true`。`[from: 2026-07-02-thinking-level-and-model-select §nfr N3]`
- **思考等级 popover 只渲染可用档位（S-11）**：`availableOptions` computed 过滤 `THINKING_LEVELS` 只保留 `resolveAvailableLevels` 返回的档位，不可用档位不显示（非灰显——灰显会让用户误以为可点）。验证：`ThinkingLevelPopover.vue` grep `availableOptions` + `THINKING_LEVELS.filter`。`[from: 2026-07-02-thinking-level-and-model-select §nfr N4]`
- **前端发 thinkingLevelMap 映射后的 value 给 runtime，不直接发 key（S-12）**：展示是展示，传递 value 是 value——这是两回事。`ThinkingLevelPopover.onSelect` emit `resolveThinkingValue(opt.level, map)`（value，如 max 档发 xhigh），`sessionApi.setThinkingLevel(sid, value)`。**禁止直接发 key（如 max）给 pi**——pi 不认识 max（pi 枚举是 off/minimal/low/medium/high/xhigh），会 clamp 到其他档位。`resolveThinkingValue` 把 UI 档位 key 映射成 pi 认识的 value。前端枚举保留 max（spec 要求展示「最高」）。验证：`ThinkingLevelPopover.vue` grep `resolveThinkingValue`。`[from: 2026-07-02-thinking-level-and-model-select §nfr N1]`

## 6. 兼容性

- **向后兼容 env var**：`XYZ_AGENT_DATA_DIR` 未设时行为完全不变（prod 默认）；`XYZ_AGENT_PORT_OFFSET` 未设默认 0。验证：instance-isolation spec §5、§9
- **pi 版本**：使用上游 `badlogic/pi-mono`（npm 包 `@earendil-works/pi-coding-agent`，当前 `0.80.3`）。session tree / fork / clone 核心能力为 pi 原生，不依赖 fork 改动。历史：曾用 fork `xyz-pi` 透出 `leafId`，该字段前端从未消费，已切回上游
- **旧消息兼容**：不含 contentBlocks 的历史消息走 `groupByLegacyFields`，渲染不变
- **plugin manifest 向后兼容**：semver 兼容性检查（`engines.xyz-agent`），不兼容跳过扫描
- **shared 层禁 node 内置模块**：`packages/shared/src/` 是浏览器/runtime 共享层，禁 import `node:` 内置（node:path/fs/crypto），浏览器环境 vite externalize 成空代理访问即崩。验证：`grep -rn "from 'node:" packages/shared/src/` 返回空。事故来源：W1a 误迁 isUnderOrEqual 到 shared 导致 dev 崩溃（E2E mock 掩盖 8 Wave）。`[from: 2026-06-28-sidebar-project-file-tree §3.1]`（教训固化为 2026-06-30-e2e-retrospect）
- **跨 store 编排在 composable 层**：stores 间禁互相 import，跨 store 编排（如 fileTreeStore 监听 chatStore）在 composable 层 watch + 派发 store action。验证：`useFileTree.ts` setupInvalidation。`[from: 2026-06-28-sidebar-project-file-tree §K-9]`
- **外部输入双层守卫（S-16）**：外部输入参数（如 cwd）的空值/非法值守卫，service 层做主守卫 + store 层做防御性兒底。service 是业务入口主守卫拦截非法输入；store 是叶子层兒底防 service 守卫被绕过（未来新增调用点忘记守卫）时脏数据落盘。验证：`workspace-service.ts:22` `if (!cwd || cwd.trim()==='') return`（主）+ `recent-workspaces-store.ts:55` 同校验（兒底）+ 单测 T1.4/T2.x。`[from: 2026-07-03-recent-workspaces §nfr Issue#2 INV-1]`
- **cwd 失效降级 homedir + toast（S-18）**：create / restoreSession 收到可能已被删除的 cwd（worktree 清理/手动删目录）时，必须 existsSync 校验，失效则降级 homedir（与 restoreSession 对称），前端比对「请求 cwd」vs「reply session.cwd」不一致时 toast 通知用户「目录 X 已不存在，已切换到主目录」。禁用失效 cwd 继续 create（后续 fs 操作报错）。验证：`session-lifecycle.ts:43-49` create existsSync+homedir 降级 + `useNewTaskFlow.ts:159-163` 比对 toast + `session-service.test.ts` INV-7 fallback 测试 + `use-new-task-flow.test.ts` INV-7 toast 真实断言。`[from: 2026-07-03-recent-workspaces §nfr Issue#6 INV-7]`（2026-07-03 closeout 补全）

## 7. 可观测性

- **三级通知层级**：plugin `notify` → info/warning/error 三级；`plugin:notification` WS 事件广播到前端
- **Statusline 三区**：Input Toolbar（per-panel 输入框内）/ Session Strip（per-panel 输入框下）/ Global Statusbar（窗口底部全局）。数据来自 pi extension `setStatus()` + plugin `updateStatusBarItem()` 两通道
- **Hook 可审计**：`blocked` 和 `transformedContent` 变更在 session 历史可见
- **错误内联**：错误作为 assistant 消息插入聊天流，不用顶部 banner。验证：CLAUDE.md 规则#3
- **SystemNotification 过渡态**：v3 重构后聊天流内联系统通知暂未重新落地，错误/提示走 overlay/toast 层，待 v3 内容层深化时重新接入（见 context.md「SystemNotification」）
