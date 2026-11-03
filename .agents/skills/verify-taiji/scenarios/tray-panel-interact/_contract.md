# D3 L4 inspect 任务书公共契约（各任务书引用，不再重复）

- 角色：验收检查执行者。可运行只读命令、可操作 taiji dev 实例（启动 / 连 CDP / 驱动 / 读状态 / 杀自建实例）、读文件；**禁止修改任何仓库代码、禁止 git 写操作**。禁止向用户提问（无交互位；无法自决的按职责内默认处置并记录 deviations）。
- 真机驱动唯一入口 = verify-taiji 技能（`<repo>/.agents/skills/verify-taiji/SKILL.md`，worktree 内经 symlink 共享）。冷启动读序：SKILL.md §1-§6 → capabilities/README.md → capabilities/P0-P1-COVERAGE.md → 目标域 capability（subagent.md / workflow.md / interaction.md / render.md / evidence.md）→ 按需 scenario。禁裸驱动 Electron、禁自建第二套验收流程。
- LLM 通道 = mock-http（孙进程即 subagent/workflow 执行层唯一零 token 通道）：经 SKILL.md §1.1b 的 `createInstance` 装配（model-keyed 响应脚本，主会话与孙进程分演员）；不设真凭据、不打真模型。
- 实例隔离（并行验收硬约束）：本节点实例名固定 `verify-tray-<节点id>`、数据目录 `~/.taiji-dev/verify-tray-<节点id>`（独立名派生独立端口段）；不与任何其他实例 / 常驻 dev 实例共用端口与数据目录；启动前跑 `doctor.mjs` 五项全绿才驱动；CDP `/json/list` 页面 URL 必须核对属于本实例 Vite 端口（连错实例看旧代码是已知坑）。
- 证据三件套（verify-taiji §4）：每个验收点抓 ① 动作+状态（截图含应用身份可见 + testid 命中的文本/属性断言输出，非整页 dump）② 副作用（磁盘/进程侧证据：ext-sessions 树、runtime 日志 grep 行、设置文件前后对照）③ report.md（驱动了哪些步骤、每步期望 vs 实际、未覆盖项与原因——不可达的写前置缺失，禁弱化剧本硬凑通过）。证据落 `~/.agents/skill-data/verify-taiji/<worktree>/<run-id>/<feature>/`，**同时**把 verdict.json 与关键证据副本放进本节点 artifactsDir（引擎事实锚读 artifactsDir 根；清理实例不删证据）。
- 汇总核对纪律：deps 指向节点的 `summary.jsonl`（`<artifactsDir>/summary.jsonl`）以汇总为准，仅异常步骤读全文日志。
- 失败处置：先读 `<repo>/docs/TROUBLESHOOTING.md` 匹配已知症状，归因（spec-bug / product-bug / environment）再定 verdict；禁不归因重试、禁放宽断言；失败现场先保全（runtime/pi 日志、mock 请求记录 try/finally 抢救到 artifactsDir）再谈重试；同因连败两轮 = 系统性问题，停止重试上报。
- 收尾（verify-taiji §5）：kill 自建实例 PID（SIGTERM，按启动记录/PID 核对，禁 `pkill electron`/`pkill vite` 宽泛匹配）→ `lsof` 验证端口释放 → 一次性数据目录（verify-tray-*）可删 → 证据幸存核对（`ls` 证据目录仍在且完整）。
- 过程记录义务：临时待办 / 需裁决事项 / 复盘观察随时 append 到 `<name>.runlog/<节点id>.md`（一行一条 `[HH:MM] 类型: 一句话事实`）。
- **返回契约（固定，禁写 status 字段）**：最终结构化返回 = `{verdict: "pass"|"fail"|"degraded", test_evidence, deviations: [], blockers: []}`；同时把同 JSON 落盘 `<artifactsDir>/verdict.json`（文件内 verdict 与结构化返回一致——引擎以此文件为 done 事实锚，缺失/不一致按失败处理）。degraded 仅限 environment 类不可归因于产品的问题，须在 blockers 记录。
