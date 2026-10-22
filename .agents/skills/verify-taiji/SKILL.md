---
name: verify-taiji
description: "驱动真实 taiji dev 实例做功能验收：启动、体检（doctor）、CDP 驱动、能力原语（capabilities/）、scenario 剧本执行（summary.jsonl/verdict.json）、证据三件套、清理收尾的全流程。触发词：真机验收、UI 验收、验收 taiji、verify taiji、驱动 dev 实例、faux LLM 验收、mock-http 验收、能力原语、scenario runner、mock pi 置换。不用于写 e2e spec（那是 e2e/ 目录的机器资产）也不用于 VITE_MOCK 手工调试。"
---

# verify-taiji：taiji 真机验收技能

本文件写给冷启动的验收 agent：把真实 dev 实例拉起来，按用户路径驱动一个功能，抓证据，收尾不留进程。

**三层结构**（从下往上读）：

1. `SKILL.md`（本文件）= 环境侧总流程：Launch / Doctor / Drive / Evidence / Cleanup；
2. `capabilities/` = **能力原语层**：72 个原子能力（一个动作 + 断言 + 证据 + 证不了 + 坑），按域拆文件，索引见 [capabilities/README.md](capabilities/README.md)；
3. `scenarios/` = **验收剧本层**：能力组合成可执行剧本，由 `scripts/run.mjs` 跑出 `summary.jsonl` / `verdict.json` / `report.md`，可直接被 dev-flow D3 消费。

冷启动读序：本文件 §1-§6 → [capabilities/README.md](capabilities/README.md) → [capabilities/P0-P1-COVERAGE.md](capabilities/P0-P1-COVERAGE.md)（要验的功能在哪一行）→ 目标域的 `capabilities/<域>.md` → 目标 scenario。`features/` 保留人读的端到端故事（见 §8），漂移以 capability 为准。

## 0. 定位与边界

- 本技能是 AI agent 真机验收的**唯一入口**：后台启动、CDP 连接、faux LLM 装配、mock pi 置换、多验收窗编排、证据与清理的操作知识都收拢在此。AGENTS.md「前端调试」节只留指针。
- 与既有验证体系的边界（不许越界，防止变成第六套验证体系）：
  - `e2e/` 的 playwright spec 与 `docs/testing/e2e-map.json` 是机器资产（CI/开发期按改动范围触发）；本技能不写 spec、不进 CI、不登记 e2e-map。
  - `docs/testing/` 分域手册是 testid 清单与已知坑的权威源；feature 剧本引用它们，不复制清单。
- 驱动对话类功能（需要 LLM 回复）的通道三选一：**faux**（主会话默认，凭证无关零 token）→ **mock-http**（本地 OpenAI 兼容 mock server；孙进程即 subagent/workflow 执行层**只有这条零 token 通道**）→ **live**（真模型智能或真鉴权）。详见 [capabilities/README.md §3](capabilities/README.md)。faux 覆盖不到的进程级行为用 **mock pi 置换**（见 §1.3）。

## 1. Launch

cwd 一律 = worktree 根（下称 `<repo>`）。启动命令用 background 模式派发（长驻进程，同步启动会阻塞会话到超时）。

```bash
# 常规验收实例（数据目录 = ~/.taiji-dev/instances/<worktree>/）
TAIJI_DEV_BACKGROUND=1 node apps/electron/scripts/dev-instance.mjs

# 隔离数据目录的实例（与常驻实例数据互不污染；端口仍按 worktree 派生）
TAIJI_DEV_BACKGROUND=1 node apps/electron/scripts/dev-instance.mjs --data-dir ~/.taiji-dev/verify-<run-id>

# 需要干净环境（删实例目录后从模板重建；会连数据一起删，只对自建实例用）
node apps/electron/scripts/dev-instance.mjs --data-dir ~/.taiji-dev/verify-<run-id> --fresh
```

- `TAIJI_DEV_BACKGROUND=1` 必带：窗口 showInactive 不抢前台焦点。macOS 上 Electron 无法 headless，连接已有实例是避免抢焦点的唯一可靠方式；交互操作经 CDP 注入通常不激活窗口，新开实例必然抢焦点。
- **就绪判据（三条全过才算可用；进程活着 ≠ 就绪）**：
  1. `<dataDir>/runtime.port` 文件出现（runtime 已完成 spawn + 健康检查 + 写端口文件）；
  2. CDP `http://localhost:<cdpPort>/json/list` 出现页面，且页面 URL 属于本实例的 `http://localhost:<vitePort>/`（连错实例看旧代码是已知坑，必须核对 URL）；
  3. `<dataDir>/logs/runtime-*.log` 出现 `resolved N extensions from M sources` 且 N ≥ 8（扩展装载完成；端口在位但扩展没装载完时建 session 会缺命令/工具）。
- 端口、数据目录按 worktree 名 hash 派生，每次用 `node .agents/skills/verify-taiji/scripts/doctor.mjs <repo> [--data-dir <dir>]` 查实际值，不背数字。
- **同实例名同时只能有一个实例**（Vite strictPort：第二个实例静默失败加载旧代码）。多验收窗共用一个实例：主会话持有生命周期，各验收方只经 CDP 接入，不重启不杀；全部跑完由主会话按 PID 收尾。
- **端口被占但实例不属自己**（他人 dev 实例 / 打包版）：不要杀，用 `TAIJI_DEV_INSTANCE_NAME=<独立名>`（或 `--name`）给验收实例派生独立端口段，配合 `--data-dir` 指向自己的数据目录并行跑。
- `--data-dir` 值域限定在 `~/.taiji-dev/` 树内且不得指向保留目录（`~/.taiji-dev` 本体与 `instances/`），越界即响亮退出。
- 首启种子从只读模板 `~/.taiji-dev.template/` 白名单复制进实例目录（已存在的实例目录原样保留，不会覆盖预置内容）；模板本身调整后 `node apps/electron/scripts/dev-instance.mjs init-template --force` 重建，只读模板勿直改。
- 单实例锁按数据目录 userData 区分：不同数据目录的实例天然共存；同 worktree 撞端口是唯一互斥条件（见上条）。
- 打包版应用（磁盘 bundle 名 TaiJi.app）可能与 dev 实例同跑：裸跑占 3210 / CDP 9222 / Vite 1420 / runtime 3310。doctor 的 CDP URL 核对能区分实例，不要靠端口号猜。

### 1.1 faux LLM 装配（驱动对话 / 工具调用 / 提问表单，零 token）

faux = 真 Electron 进程树 + 真 pi 子进程 + 真 extension 装载 + 假 LLM 演员。每一轮回复由响应脚本 JSON 编排，注入链 = 数据目录预置 + 两个 env，零产品代码改动：

```bash
# 一步预置（settings.json / models.json / faux 扩展 / 引擎注册 / 响应脚本），并打印启动命令
node .agents/skills/verify-taiji/scripts/seed-faux.mjs <repo> ~/.taiji-dev/verify-faux-<run-id> [responses.json]

# 按打印出的命令启动；等价于「隔离实例 + 三个 env」：
TAIJI_DEV_BACKGROUND=1 \
TAIJI_FAUX_SCRIPT=~/.taiji-dev/verify-faux-<run-id>/agent/faux-responses.json \
TAIJI_EXTENSION_PATHS=<repo>/e2e/fixtures/faux-provider-ext \
node apps/electron/scripts/dev-instance.mjs --data-dir ~/.taiji-dev/verify-faux-<run-id>
```

响应脚本形态（FauxStep 数组，模型固定 `faux/faux-1`；每个 assistant 轮消费一个 step、逐次出队，脚本耗尽后无回复）：

```json
[
  { "thinking": "考虑中", "text": "第一轮文本回复", "stopReason": "stop" },
  { "toolCalls": [{ "name": "ask_user", "args": { "questions": [{ "header": "DB", "question": "选哪个数据库？", "options": [{ "label": "SQLite", "description": "零运维" }] }] } }], "stopReason": "toolUse" },
  { "text": "收到选择，继续执行", "stopReason": "stop" }
]
```

- 想拉长流式窗口观察中途态（呼吸环 / 停止按钮 / steer）：env 加 `TAIJI_FAUX_TPS=<每秒 token 数>`。
- 不设 `TAIJI_E2E`（那是 e2e fixture 的产物加载形态，dev 路径下设它会破坏 vite 加载）。副作用：workflow/subagent 的 pi 孙进程不加载 faux 扩展，faux 只覆盖主会话 agent 轮次——**孙进程域用下面的 mock-http 通道**（实测可达）。
- 常用工作目录选真实 git 仓库（如 `<repo>` 自身或 e2e/fixtures/sample-project），文件树 / git 角标才有内容。

### 1.1b mock-http LLM 装配（孙进程可达的零 token 通道）

faux 在 subagent / workflow 的**孙进程不可达**（孙进程 `--no-extensions` spawn，只说宿主的扩展白名单）。
第二条零 token 通道不走 extension：孙进程继承 `PI_CODING_AGENT_DIR`，读同一份 `<dataDir>/agent/models.json`，
因此只要里面有个 `openai-completions` 自定义 provider 且 `baseUrl` 指向本机 mock 服务即可。

```js
import { createInstance, resolveRepo } from '<skill>/scripts/lib/instance.mjs'

const instance = createInstance({
  repo: resolveRepo('/abs/path/to/worktree'),
  name: `verify-mock-${Date.now().toString(36)}`,
  llm: { responses: { 'mockllm/mock-1': [...], 'mockllm/mock-sub-a': [...] } },  // 与 faux 互斥
  background: true,
})
await instance.launch()
// instance.llm → { baseUrl, mainRef: 'mockllm/mock-1', subRef: 'mockllm/mock-sub-a', ... }
// instance.mockLlm.requests → 每次请求的 model / messages（「孙进程真的打到 mock」的铁证面）
await instance.dispose()   // 同时关 mock server + 删自建数据目录
```

- 剧本形态与 faux 完全同构（`fixtures/faux-responses/*.json` 可直接搬）；**model-keyed** 才能分主/成员演员。
- 磁盘落盘：`models.json`（provider `mockllm`）、`settings.json`（默认模型 + `enabledModels`）、
  `agent/subagents/config.json`（`engineDefaults.pi = mockllm/mock-sub-a`）；不写 faux 扩展。
- 剧本库与踩坑清单：[fixtures/mock-http/README.md](fixtures/mock-http/README.md)。
- 实测探针：`scripts/probes/mock-llm-grandchild.mjs`（subagent，`mock-grandchild-reachable`）/
  `scripts/probes/mock-llm-workflow.mjs`（workflow fan-out，`mock-workflow-reachable`）。

### 1.2 普通实例建 session 的凭证前提

常规实例（非 faux）的数据目录从 `~/.taiji-dev.template/` 种子而来，含 provider/secrets；若模板里没有可用 provider，建 session 后发消息会报模型不可用。验收对话类功能优先走 faux 装配。

### 1.3 mock pi 置换（替代通道）

适用：需要伪造 pi 进程级行为（进程崩溃、异常退出、非 LLM 的协议行为）而 faux 覆盖不到时。方法 = 文件级置换 runtime 解析到的 pi 可执行文件：

1. `mv node_modules/.bin/pi node_modules/.bin/pi.bak`（保留原 symlink）；
2. 放入自编 mock 可执行脚本（node shebang，stdin/stdout 按 pi RPC 协议应答）；
3. 新 session 起 pi 子进程时生效（runtime 缓存路径，旧 session 不受影响）。

窗口结束**必须恢复**，三项核对全部通过才算恢复完成：`mv` 回原 symlink；`node_modules/.bin/pi --version` 输出真实版本号；`ls -l` 形态核对（symlink 指向真实包）。恢复完成前禁起依赖真实 pi 的新场景。

## 2. Doctor

任何驱动前、以及驱动中出现异常时，先跑：

```bash
node .agents/skills/verify-taiji/scripts/doctor.mjs <repo> [--data-dir <dir>]
```

输出五项判定（全绿才驱动）：

| 项 | 判定 |
|----|------|
| 装配参数 | `--print` 可解析出 worktree / 数据目录 / Vite / CDP / runtime 端口段；pi stage 版本与声明一致（劈叉会 exit 1 并给恢复动作） |
| 端口归属 | Vite / CDP 端口无人占用（实例未起）或被本实例进程占用（附 PID 与命令行） |
| CDP 指向 | `/json/list` 页面 URL 属于本实例 Vite 端口——连错实例（旧 worktree / 打包版）在这里暴露 |
| runtime 健康 | `<dataDir>/runtime.port` + `runtime-token` 存在且端口可连 |
| 扩展装载 | runtime 日志末次 `resolved N extensions`，N ≥ 8 |

注意：doctor 底层跑 `dev-instance.mjs --print`，对不存在的实例目录会从模板创建目录（幂等副作用，可接受）。doctor 不杀任何进程；端口被占但 CDP 不是本实例时，按 PID + 命令行识别占用者，属于他人实例（含打包版）就换 worktree 或等待，禁止盲杀。

## 3. Drive

- 工具：browser-automation 技能（Playwright 优先，连 `http://localhost:<cdpPort>`）。前置：其 scripts 目录 `npm install` 过一次。
- 选择器纪律：`data-testid` 优先（全仓清单与分域手册在 `docs/testing/`：01 对话主链 / 02 侧栏与抽屉 / testids-canvas / testids-plan）；其次 ARIA role + name；最后受控文本锚点。禁坐标、禁 tab 序。
- 输入区是 contenteditable：用 `pressSequentially` 逐字输入（`fill` 不触发 slash 检测等 input 逻辑）。
- Popover / Modal 经 reka-ui portal 挂到 `<body>`：查询全局找，别限定在触发组件内。
- 等待纪律：等状态出现（`toBeVisible({timeout})` / 特定 testid 出现），禁固定 sleep。runtime 起动慢（pi 子进程 spawn）按 30s 量级给预算。
- 会话级状态在切换/创建 session 后要主动拉取才可靠（runtime 广播可能早于 renderer 订阅）——断言侧表现为：切 session 后多等一次主动刷新出的数据，不假设广播已到。

## 4. Evidence

证据目录：`~/.agents/skill-data/verify-taiji/<worktree>/<run-id>/<feature>/`（run-id 形如 `20261021-1530`；目录自建）。**证据绝不落在实例数据目录里**——清理会删掉它。

每个验收点抓三件套（三者互证，缺一不可）：

1. **动作 + 状态**：截图（含应用身份可见——窗口标题或页面内容可识别出是 taiji）+ 操作时刻的关键 DOM 断言输出（testid 命中的文本/属性，不是整页 dump）；
2. **副作用**：磁盘/进程侧证据——`ext-sessions/<sessionId>/` 树内容、runtime 日志 grep 行、git status（功能触达工作区时）、设置文件变更前后对照；
3. **可追溯**：一份 `report.md` 记录：驱动了哪个 feature 剧本的哪些 sub-feature、每步的期望 vs 实际、未覆盖项与原因（不可达的要写明前置缺失，禁止弱化剧本硬凑通过）。

证明标准：走真实用户路径（点击/输入），不经内部 setter 或测试专用端点；改了状态的场景要有第二视角复核（如 UI 显示已归档 + `archive-list-view` 里行存在 + 数据目录里会话树已移出活跃列表）。

## 5. Cleanup

收尾顺序（每步做完做下一步）：

1. 停实例：`kill <dev-instance PID>`（SIGTERM；装配器把信号转发给整个子进程组走优雅链：runtime stop → 销毁全部 pi → 应用退出）。PID = 启动时的 background 任务 PID；找不到时用 `ps aux | grep 'scripts/dev-instance.mjs'` 找，核对命令行里的 `--data-dir` 是自己的再杀。**禁止 `pkill electron` / `pkill vite` 类宽泛匹配。**
2. 验证端口释放：`lsof -ti :<vitePort> :<cdpPort>` 为空。不释放 = 子树有残留，按 PID 逐个定位处置。
3. mock pi 若置换过：按 §1.3 三核对恢复。
4. 一次性数据目录（`verify-*`）可删（`rm -rf ~/.taiji-dev/verify-<run-id>`）；`instances/<worktree>/` 常驻实例目录不删。
5. **证据幸存核对**：`ls ~/.agents/skill-data/verify-taiji/<worktree>/<run-id>/` 仍在且内容完整——清理吃掉证据 = 本次验收作废。

## 6. Helpers

四个脚本都零依赖（node 内置模块），从任意 cwd 调用，`<repo>` 传 worktree 根绝对路径：

```bash
# 体检：五项判定 + 实际端口/数据目录（--json 给机器可读输出）
node .agents/skills/verify-taiji/scripts/doctor.mjs <repo> [--data-dir <dir>] [--json]

# 预置 faux 数据目录并打印启动命令（responses.json 不传则写默认单轮演示脚本；--force 覆盖已存在的预置）
node .agents/skills/verify-taiji/scripts/seed-faux.mjs <repo> <dataDir> [responses.json] [--force]

# 能力原语单步 CLI（stateless / 单行 JSON / 可组合，供 codemode 编排）
node .agents/skills/verify-taiji/scripts/vp.mjs <capability> --data-dir <dir> [flags] [--json]

# scenario runner（组合原语 → summary.jsonl + verdict.json + report.md）
node .agents/skills/verify-taiji/scripts/run.mjs scenarios/<id>.mjs --artifacts-dir <dir> [--json]

# 探针：孙进程 LLM 可达性（faux 不可达 / mock-http 可达）
node .agents/skills/verify-taiji/scripts/probes/faux-grandchild.mjs [--repo <repo>]
node .agents/skills/verify-taiji/scripts/probes/mock-llm-grandchild.mjs [--repo <repo>]   # subagent 派发
node .agents/skills/verify-taiji/scripts/probes/mock-llm-workflow.mjs [--repo <repo>]    # workflow fan-out
```

## 7. 能力原语层与验收剧本

本技能分两层，**驱动任何功能前先读对应的 capability，再读 scenario**：

| 层 | 目录 | 用途 |
|----|------|------|
| **能力原语层** | [capabilities/](capabilities/README.md) | 72 个原子能力（入口 / 驱动 / 断言 / 证据 / 证不了 / 坑），覆盖 env / session / chat / model / subagent / workflow / interaction / settings / plugin / extension / render / workspace / evidence 十三域；其中 **20 个可用 `vp.mjs` 单步调用**，其余走 scenario 或手工驱动（差距表见 [README §4.2](capabilities/README.md)、限制见 [API-CONTRACT §7 L6](capabilities/API-CONTRACT.md)） |
| **验收剧本层** | `scenarios/*.mjs` → [capabilities/README.md §4.3](capabilities/README.md) | 能力组合 = 可执行剧本，产 `summary.jsonl` / `verdict.json` / `report.md`，可直接被 dev-flow D3 的 verify/inspect 节点消费 |

**覆盖对账** = [capabilities/P0-P1-COVERAGE.md](capabilities/P0-P1-COVERAGE.md)（P0 17 行 / P1 4 行逐行状态：`scenario` / `capability-only` / `reuse-e2e` / `unreachable`）。要回答「某功能能不能验、怎么验」，查这张表。

LLM 通道三选一（决定能否零 token）：**faux**（主会话默认）/ **mock-http**（孙进程即 subagent·workflow 执行层）/ **live**（真模型智能或真鉴权）。判定依据与装配要点见 [capabilities/README.md §3](capabilities/README.md)。

**被 dev-flow-wf D3 消费的节点契约**：dev-flow 引擎与剧本进程之间只有 script 路径一个通道（`node <script>` 直跑，无参数、无 per-node env），所以 workflow 内 verify 节点的 script = dev-flow D0 生成的 wrapper（spawnSync 本 runner + scenario 绝对路径 + `--artifacts-dir <节点 artifactsDir>`），不是剧本本体。本 runner 侧已满足的对齐契约：退出码 fail=1 / degraded=0（`--strict` 时 2）；`verdict.json` 与 `summary.jsonl` 镜像落 artifactsDir 根（引擎事实锚读此根）；`summary.jsonl` 每步一行。手工 / 主 agent 直跑仍用 §6 的 run.mjs 命令形态。T3 验收计划表对本技能的引用入口 = [capabilities/P0-P1-COVERAGE.md](capabilities/P0-P1-COVERAGE.md)（矩阵行四态即「验收项 ↔ 现成剧本」对账）。

## 8. 人工剧本（features/）

`features/` 保留用户视角的端到端故事（四段式：Sub-features / 用户入口 / 驱动剧本 / Gotchas），适合「要看某个界面怎么点」的场景；它是 capability 层的**人读摘要**，新增功能面以 capability 为准。当前五个 P0 剧本：

| 文件 | 功能 | 与 capability 的关系 |
|------|------|---------------------|
| [features/new-task.md](features/new-task.md) | 新建任务（Landing → 选目录 → 首发提交建 session） | `session.create` 的 UI 入口；参数面（`presetId`/`modelOverride`/`clientUuid` 等）见 [session.md](capabilities/session.md) |
| [features/session-management.md](features/session-management.md) | 多会话管理（列表 / 切换 / 归档 / 彻底删除 / 右键菜单） | **已知漂移**：会话行根是 `.session-item`（`session-detail-card` 是 hover 卡）；归档/彻底删除是两段确认，彻底删除在归档列表行 → 以 [session.md](capabilities/session.md) 为准 |
| [features/chat-stream.md](features/chat-stream.md) | 对话发送与流式渲染（thinking / 工具 / 文本 / 变更集 / 中断） | 细节与失败信号见 [chat.md](capabilities/chat.md) |
| [features/settings-provider.md](features/settings-provider.md) | 设置页 provider 管理 | 六面（provider / 系统提示词 / 预设 / MCP / 网络代理 / 主题）见 [settings.md](capabilities/settings.md) |
| [features/ask-user-form.md](features/ask-user-form.md) | 统一提问表单 FormOverlay（agent 向用户提问） | **已知漂移**：示例脚本第二题只给 1 个 option，schema 要求 `minItems: 2`；正确形态见 `fixtures/faux-responses/ask-user-two-questions.json` |

## 9. 维护

功能变化后剧本会漂移，维护分两轨：

- **随交付增量同步（dev-flow-wf D4 第 5 步承接）**：交付触达覆盖矩阵登记的功能行时，由 dev-flow-wf 收尾流程增量回写能力文档/场景剧本/矩阵行，并只重跑本次被修改过的剧本（未改的引用 D3 verdict 证据）。维护单元 = [capabilities/P0-P1-COVERAGE.md](capabilities/P0-P1-COVERAGE.md) 的矩阵行，不是 features/ 的人读摘要。
- **定期全量体检（人工触发）**：定期或大改动后用 `/maintain-verification-skill` 跑一轮（逐功能源码核对 + 实跑驱动 + 最多一个 PR 的修正）。该技能按「项目技能目录下 `verify-*` 前缀 + SKILL.md 含 Launch 与 Drive 驱动节」发现本技能；其 source wave / live pass 的「每个 feature」对应上述覆盖矩阵的矩阵行。
