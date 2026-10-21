# 能力原语层（capabilities）· 索引与使用契约

本目录是 `verify-taiji` 的**能力原语层**：把「驱动 taiji 的一个原子动作 + 它的断言 + 它的证据」写成可组合、可机器读的契约。上层 `scenarios/` 组合原语成验收剧本，`scripts/run.mjs` 执行并产结构化产物。

## 0. 三层结构与冷启动顺序

```
SKILL.md                 环境侧总流程（Launch / Doctor / Drive / Evidence / Cleanup）
  └─ capabilities/       原子能力（本目录）：一个动作一条契约
       └─ scenarios/     能力组合 = 一条验收剧本（dev-flow L3 verify 节点）
            └─ scripts/run.mjs   执行 + summary.jsonl / verdict.json / report.md
```

冷启动读序（新 agent 第一次进本技能）：

1. `SKILL.md` §1-§6（起实例 / 体检 / 驱动纪律 / 证据 / 清理）——**必读，不跳**
2. `capabilities/API-CONTRACT.md`——接口与红线（§5 红线是硬性约束）
3. `capabilities/P0-P1-COVERAGE.md`——要验的功能面在哪一行、当前是什么状态
4. 目标功能的 capability 文件（`capabilities/<域>.md`）——入口 / 驱动 / 断言 / 坑
5. 目标 scenario（`scenarios/*.mjs`）——组合好的可执行剧本

## 1. 文档清单

| 文件 | 域 | capability id |
|------|-----|---------------|
| [API-CONTRACT.md](API-CONTRACT.md) | 接口契约（冻结）+ capability id 全量清单 | — |
| [P0-P1-COVERAGE.md](P0-P1-COVERAGE.md) | P0/P1 覆盖矩阵（功能面 × 状态） | — |
| [env.md](env.md) | 实例与环境 | `env.launch` `env.doctor` `env.ready` `env.cleanup` `env.isolation` |
| [session.md](session.md) | 会话生命周期 | `session.create` `list` `switch` `history` `delete` `archive` `restore` `isolation` `persistence` |
| [chat.md](chat.md) | 对话主链 | `chat.send` `stream` `wait` `abort` `steer` `revoke` `reload-equiv` |
| [model.md](model.md) | 模型与思考档位 | `model.list` `switch` `thinking` `subagent-switch` |
| [subagent.md](subagent.md) | 子代理派发 | `subagent.dispatch` `list` `stream` `cancel` `model` |
| [workflow.md](workflow.md) | 工作流派发与可视化 | `workflow.dispatch` `runs` `overlay` `abort` `reconnect` |
| [interaction.md](interaction.md) | agent↔用户闭环 | `interaction.askuser` `permission` `plan-review` `canvas` |
| [settings.md](settings.md) | 设置页 | `settings.provider` `system-prompt` `preset` `mcp` `network-proxy` `theme` |
| [plugin.md](plugin.md) | 插件系统 | `plugin.list` `toggle` `statusbar` `mountpoints` |
| [extension.md](extension.md) | 扩展装载框架 | `extension.load` |
| [render.md](render.md) | 渲染面 | `render.markdown` `shiki` `html-preview` `changeset` `image` |
| [workspace.md](workspace.md) | 外设面（文件树/抽屉/搜索/终端/导入） | `workspace.filetree` `drawer` `search` `terminal` `import` |
| [evidence.md](evidence.md) | 取证原语 | `evidence.tree` `logs` `grep` `screenshot` |

## 2. 通道三角（每个断言必须标通道）

| 通道 | 手段 | 能证明 | 证不了 |
|------|------|--------|--------|
| **A** | UI（CDP / Playwright，`testid=` 优先） | 用户可见终态、渲染契约、交互闭环 | 内部数据正确性、协议字段、时序 |
| **B** | runtime 协议（WS RPC + broadcast） | 事实源真值、`live ≡ reload`、字段漂移、per-session 隔离 | 渲染效果 |
| **C** | 进程 · 磁盘（`ext-sessions/` 树、`logs/`、`git status`、`lsof`） | 副作用落地、pi 进程行为、扩展装载 | 用户可见性 |

**纪律**：一条断言只走一个通道 = `weak-anchor`，必须在 capability 文件里显式标注；scenario 至少跨两条通道。

## 3. LLM 通道三选一（决定哪些功能可零 token 验）

| 通道 | 装配 | 主会话 | 孙进程（subagent / workflow 成员） | 何时用 |
|------|------|--------|-----------------------------------|--------|
| **faux** | `seed-faux.mjs` + `TAIJI_FAUX_SCRIPT` + `TAIJI_EXTENSION_PATHS` | ✅ | ❌ **实测不可达**（`--no-extensions` + 白名单不含 faux provider；`TAIJI_E2E=1` 门 dev 不设） | 主会话对话类场景的默认通道（零 token、可编排 thinking/toolCalls） |
| **mock-http** | `createInstance({ llm })` → `lib/mock-llm.mjs`（本地 OpenAI 兼容 mock server）+ 自动写 `<dataDir>/agent/models.json` 自定义 provider | ✅ | ✅ **可零 token 验**（孙进程读同一个 `PI_CODING_AGENT_DIR`） | subagent / workflow 执行层；provider / 模型切换类场景 |
| **live** | 真实 provider 凭证 | ✅ | ✅ | 只有「真实模型智能 / 真实鉴权 / 真实计费」才能证明的场景；**不进 CI、不进 PR 门禁** |

依据：faux 不可达的实测证据 = `env.md` 的 Gotchas + `scripts/probes/faux-grandchild.mjs`；mock-http 通道先例 = 仓库 `scripts/verify-provider-live-sync.mjs`（本地 mock server + models.json，零外网）。

**mock-http 通道用法（实测已打通孙进程）**：`createInstance({ llm: { responses } })` → `lib/mock-llm.mjs` 起 HTTP 服务并写好
`models.json` / `settings.json` / `subagents/config.json`；`instance.mockLlm.requests` 记录每次请求的 `model`（判「孙进程是否真的
打到 mock」的铁证）。实测探针：`scripts/probes/mock-llm-grandchild.mjs`（`mock-grandchild-reachable`）与
`scripts/probes/mock-llm-workflow.mjs`（`mock-workflow-reachable`，两成员 outcome=done）。
剧本库与踩坑清单：[fixtures/mock-http/README.md](../fixtures/mock-http/README.md)。

## 4. 三种使用形态

### 4.1 单独验某个功能（人工/agent 驱动）

读目标 capability 文件 → 按「驱动」段执行精确命令（CDP 或 `vp.mjs`）→ 按「证据」段抓三件套 → 写进 `~/.agents/skill-data/verify-taiji/<worktree>/<runId>/<feature>/report.md`。

### 4.2 单步原语调用（脚本 / codemode 组合）

```bash
node .agents/skills/verify-taiji/scripts/vp.mjs model.switch \
  --data-dir ~/.taiji-dev/verify-<runId> --sid <sid> --provider faux --model-id faux-1-reasoning --json
# → {"ok":true,"capability":"model.switch","observations":{...},"evidence":{...},"elapsedMs":420}
# 失败 → exit 1 + {"ok":false,"capability":"...","reason":"...","hint":"...","evidence":{...}}
```

stateless、单步、机读，适合 codemode 里 `Promise.allSettled` 并行编排或条件分支。

### 4.3 组合成验收剧本（dev-flow 对接）

```bash
node .agents/skills/verify-taiji/scripts/run.mjs scenarios/p0-session-chat.mjs \
  --artifacts-dir ~/.agents/skill-data/verify-taiji/<worktree>/<runId> --json
```

产出（字段名冻结，dev-flow 直接消费）：

| 产物 | 消费者 | 说明 |
|------|--------|------|
| `summary.jsonl` | dev-flow D3 inspect 节点 | 每步一行 `{step, command, exitCode, stats, channel, at}`（**六键恒在**）；**核对以汇总为准，只对异常步骤读全文日志** |
| `assertions.jsonl` | 人工 / 审查 | 每条断言的 `channel / expected / actual / ok` |
| `report.md` | 人工 | 期望 vs 实际 + 未覆盖项 + 坑 |
| `verdict.json` | dev-flow D3 事实锚 | `{verdict, test_evidence, deviations, blockers, notProvable}`；`verdict ∈ pass\|fail\|degraded`；**禁写 `status` 字段**；`test_evidence` 是引擎 `validateInspectResult` 的 string 必填项，runner 已自动生成（证据指针摘要） |
| `*.png` / 附件 | 审查 | 截图与 DOM/日志/目录树附件 |

**产物落位**：完整细节在 `<artifactsDir>/<runId>/<scenarioId>/`；同时把
`verdict.json` / `summary.jsonl` / `report.md` / `assertions.jsonl` **镜像到 `artifactsDir` 根**，
因为引擎的 `inspectVerdictAnchorOk` 读的是 `<artifactsDir>/verdict.json`。
`<artifactsDir>/latest-run.json` 记录最近一次 run 的定位信息。

退出码：`pass=0` / `degraded=0`（`--strict` 时 2）/ `fail=1`。

## 5. 与 dev-flow-wf 的接线

| dev-flow 环节 | 接法 |
|---------------|------|
| T3 impl-plan「验收计划表」 | L3 行 → `scenarios/xxx.mjs`（**D0 前必须已实跑 exit 0**，见 `flow/compile.md` 剧本实装硬门槛）；L4 判断行 → promptFile 指向 `capabilities/*.md` 作为执行依据 |
| D3 verify 节点 | **必须经包装壳**（引擎 `spawn(解释器,[script])` 零参数，直接写 scenario 会 exit 0 假绿）：`script` = `<repo>/.agents/skills/verify-taiji/scripts/verify-run.sh`，参数经 env：`TAIJI_VERIFY_SCENARIO` / `TAIJI_VERIFY_ARTIFACTS` / `TAIJI_VERIFY_NAME`。详见 [API-CONTRACT.md §8](API-CONTRACT.md) |
| D3 inspect 节点 | 只读 `<artifactsDir>/summary.jsonl` + `verdict.json`（根镜像）；`verdict` 语义固定 `pass/fail/degraded`，`test_evidence` 已由 runner 填好 |
| D3 熔断/并行 | `meta.parallelGroup`（同组互斥）+ `meta.estimateSec`（预算）+ **独立实例名 + 独立 runId**。⚠️ 并行有两条已实测的坑：① 同秒同 runId 会共享 dataDir（一绿一红）；② 仓内 staged 扩展目录会被 `bundle-extensions.mjs` 抢占写（串行必绿、并行常见 EEXIST）。**并行节点必须串行错开启动**（详见 [API-CONTRACT.md §7 L4/L5](API-CONTRACT.md)） |
| D4 分流 | 一次性 → 留 skill-data；可复用且**能降为 L1/L2 零 token 机器轨** → 迁 `e2e/` 并登记 `docs/testing/e2e-map.json`；**本技能的 scenario 本身永不进 CI**（它跑真 dev 实例） |

## 6. 边界（防变成第六套验证体系）

- **不写 e2e spec**，不登记 `docs/testing/e2e-map.json`（机器资产归 `e2e/`）
- **不进 CI / PR / merge 门禁**（真 dev 实例 + 长耗时）
- **不复刻 `docs/testing/` 的 testid 清单**——引用路径与段落，清单漂移由那侧承担
- **不 import `@playwright/test` fixture**（`_electron.launch` 会抢焦点 + 走 mock 构建；本技能只复用其**知识**与 faux 扩展文件）
- **lib 不实现产品语义**：不做模型解析、不做 session 归属判定，一律走 UI/协议既有契约

## 7. 维护

| 场景 | 动作 |
|------|------|
| UI 改版 / testid 改名 | 按 `/maintain-verification-skill` 跑一轮：逐功能源码核对 + 实跑驱动 + 修正 |
| 新增功能面 | 先写 capability（按 §4 骨架）→ 再写 scenario → 更新 `P0-P1-COVERAGE.md` 状态 |
| 发现剧本跑不通 | **原样报失败 + 写进该 capability 的 Gotchas**；禁止弱化断言凑绿 |
| 新增 capability id | 先改 `API-CONTRACT.md` §6，再写文档 |
| 验收中发现新坑 | 当场回写该 capability 的 Gotchas（map 保持可信的唯一方式） |
