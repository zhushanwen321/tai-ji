# faux 响应剧本库（索引）

本目录是 `verify-taiji` 的 faux 响应脚本库（`FauxStep[]` 或 model-keyed 对象），
**纯数据、零代码**。形态与注入链的事实源：

- 演员/队列语义：`packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts`
  （`loadScript` 两种形态、`toAssistantMessage` 字段、`TAIJI_FAUX_TPS` 限速）
- 预置与启动：`scripts/seed-faux.mjs`
  （会把传入的 responses.json 解析后写到 `<dataDir>/agent/faux-responses.json`，
  再以 `TAIJI_FAUX_SCRIPT` 指过去）

## 用法

```bash
# 1) 预置数据目录（第二步参数 = 本目录下的剧本；省略则写默认单轮演示脚本）
node .agents/skills/verify-taiji/scripts/seed-faux.mjs <repo> ~/.taiji-dev/verify-faux-<run-id> \
  .agents/skills/verify-taiji/fixtures/faux-responses/tool-bash.json

# 2) 按打印出的命令启动（等价于下面三行 env + dev-instance）
TAIJI_DEV_BACKGROUND=1 \
TAIJI_FAUX_SCRIPT=~/.taiji-dev/verify-faux-<run-id>/agent/faux-responses.json \
TAIJI_EXTENSION_PATHS=<repo>/e2e/fixtures/faux-provider-ext \
node apps/electron/scripts/dev-instance.mjs --data-dir ~/.taiji-dev/verify-faux-<run-id>
```

> 每个 assistant 轮消费**一个 step**（逐次出队）；脚本耗尽后再发消息会命中
> pi-ai 的 "No more faux responses queued" 错误——这是预期，不是 bug。
>
> **同 session 单队列**：队列是 per-pi-进程的（每个 session 各自 spawn pi，各自从文件头加载）。
> 模板默认开 auto-rename（`<dataDir>/agent/auto-rename-enabled`）会经 `llm-shared` 消耗
> 一个 step；`scripts/seed-faux.mjs` 的 faux 装配会删这个标志，手工装配时记得自己删。

## 剧本索引

| 文件 | 验什么 | 形态 | 需要额外 env / 前置 | 已知限制 |
|------|--------|------|---------------------|----------|
| `plain-text.json` | 最小可用：单轮文本落屏 + 历史回读 | 数组 1 步 | — | 无 |
| `thinking-stream.json` | thinking 块与 text 块分离 + 流式中途态 | 数组 1 步 | `TAIJI_FAUX_TPS=8`（可选，拉长流式窗口） | 限速只影响切块节奏，不影响内容 |
| `tool-bash.json` | 工具调用 → 结果回灌 → 收尾文本 | 数组 2 步 | cwd 需可执行 `echo` | 只验轻量命令 |
| `tool-edit.json` | write + edit → 变更集卡（A 态） | 数组 2 步 | cwd 必须是 **git 仓库**；会写 `.faux-changeset.txt` | 仅未跟踪文件（A）；`partially-reviewed`/`resolved` 无 UI 锚点 |
| `ask-user-two-questions.json` | 统一表单：两题 tab / 选项 / 提交后继续 | 数组 2 步 | — | 每题 options 必须 ≥2（schema `minItems:2`）；不改 footer 文案 |
| `permission-tool.json` | 权限审批浮层（strict/approve 模式） | 数组 2 步 | **必须先切非 yolo 模式**：`<dataDir>/agent/config/permission-ext-config.json` 写 `{"mode":"strict",...}`，或会话里发 `/permission strict` | 只验 `strict` 确定性分支；`auto` 的 AI classifier 未验 |
| `subagent-dispatch.json` | 子代理派发（model-keyed 双演员） | **对象**（`faux/faux-1` + `faux/faux-1-b`） | 无（faux 通道**跑不通**，见下节） | 孙进程 faux 不可达 → 子代理模型无法解析。**同一剧本结构可用 mock-http 通道跑**（faux 通道不可达；mock 版见 `fixtures/mock-http/subagent-dispatch-mock.json`） |
| `workflow-fanout.json` | workflow 派发 + 两路 fan-out（model-keyed 三演员） | **对象**（`faux/faux-1` + `-b` + `-c`） | 需要真实 workflow 脚本绝对路径替换 `name`；faux 通道**跑不通** | 同孙进程 faux 不可达 + 脚本路径必须先存在。**同一剧本结构可用 mock-http 通道跑**（faux 通道不可达；mock 版见 `fixtures/mock-http/workflow-fanout-mock.json`，脚本用 `fixtures/workflows/fanout-canary.workflow.js`） |
| `markdown-kitchen-sink.json` | 表格 / ts 代码块 / 行内+块级 KaTeX / 相对图片 / html-preview / 链接 | 数组 2 步 | cwd 可写（会写 `.faux-pic.svg` / `.faux-artifact.html`） | shiki 只支持 12 种白名单语言；html-preview 用相对路径（基准 = session cwd） |
| `canvas-enter.json` | 画布：`tool_search` 激活 deferred 工具 → `canvas_enter` → 自动开画布 | 数组 3 步 | 必须在 **taiji GUI 宿主**（裸 pi CLI 会返回「非 taiji 宿主」错误） | deferred 激活链**未实测**（见下节）；`tool_search` 的 query 命中率依赖 BM25 |
| `split-multi.json` | 多轮出队（3 轮各消费一步） | 数组 3 步 | — | 第 4 轮会命中队列耗尽错误（预期） |

## 跑不通 / 有风险的剧本（先说清楚）

### 1. `subagent-dispatch.json` / `workflow-fanout.json` — 孙进程 faux 不可达（**结构性问题**）

- 事实链：
  1. 主 pi 的扩展装载走 `--no-extensions + --extension <列表>`（`packages/pi-rpc/src/spawn-args.ts`）；
     faux provider 能工作，是因为 `TAIJI_EXTENSION_PATHS` 走进了 resolver 的 `user` 源。
  2. subagent / workflow 的**孙进程**由 `packages/pi-subagent-cli/src/spawn-args.ts` 启动，
     同样带 `--no-extensions`，且 `--extension` 白名单被收窄为
     **仅 `structured-output`**（`extensions/universal/subagent-workflow/src/host/pi-host.ts`
     的 `GRANDCHILD_EXTENSION_PKG_SEGMENTS`）。
  3. 唯一例外是 e2e harness：`resolveE2eFauxExtensionPath()` 要求 `TAIJI_E2E=1`
     （e2e fixture 独有）且 `<agentDir>/extensions/faux-llm-ext.ts` 在盘，才把它追加进
     孙进程白名单；dev 装配不设该 env。
  4. 结论：孙进程没有 faux provider 注册，`faux/faux-1-b` 等模型无法解析 → 派发即失败。
- 实测证据（见 `capabilities/env.md`）：孙进程 stderr tee
  `<dataDir>/logs/pi-task-stderr-<pid>.log` 出现 `Error: Model "faux/faux-1-c" not found`，
  subagent record `stopReason: failed / error: pi child exited with code 1`；
  探针 = `scripts/probes/faux-grandchild.mjs`。
- 因此这两个剧本**保留为形态参考**（model-keyed 的写法、参数形状），
  **不作为 faux 通道的可执行验收资产**。
  **但有第二条通道**：mock-http（本机 mock OpenAI provider，零 token / 零外网 / 零 extension）
  已实测打通孙进程 —— 同一份 step 数据结构直接喂 `createInstance({ llm: { responses } })` 即可跑，
  mock 版剧本在 `fixtures/mock-http/`（`subagent-dispatch-mock.json` / `workflow-fanout-mock.json`），
  自检剧本 `fixtures/workflows/fanout-canary.workflow.js`。真机验证子代理/工作流的执行层
  请用 **`requires: mock-http | live`**（见 `capabilities/env.md` Gotchas）。

### 2. `canvas-enter.json` — deferred 激活链未实测

- canvas 六工具是 `exposure:"deferred"`（`extensions/taiji/canvas/src/index.ts` 文件头），
  扩展自己注入的 `<available_tools>` 段要求「先 `tool_search` 再调用」。
- 剧本按此写了两步，但**未实测**「未激活直接调用」时 pi 的确切错误形态；
  也不能保证 `tool_search` 的 BM25 query 一定命中六个工具（当前 query 取工具名/描述词）。
- 若 `canvas_enter` 未被激活，预期失败信号 = 工具调用错误（不是画布不出现）；
  排障看 `session.getCommands` 无关、应看 pi jsonl 的 toolResult 文本。

### 3. `permission-tool.json` — 依赖模式切换，默认什么都不弹

- `@zhushanwen/pi-permission` 的默认模式是 `yolo`（`extensions/universal/permission/src/types.ts`
  的 `DEFAULT_CONFIG`）→ 不弹审批。
- 必须先把 `<dataDir>/agent/config/permission-ext-config.json` 写成 `strict`（推荐，确定性），
  或在会话里发 `/permission strict`（需要该命令已注册，即扩展装载成功）。
- `companion-select-option-*` 的 testid 值含空格与括号（选项字符串原文），选择器要加引号。

### 4. `markdown-kitchen-sink.json` — 相对图片依赖 SVG 被 local-file 放行

- 剧本写的是 `.faux-pic.svg`（相对 session cwd），图片 `src` 会被重写成 `local-file:///…`。
  若 `local-file` 白名单不放行该路径，图会破（`naturalWidth=0`）——断言时要读
  `{src, naturalWidth, complete}`，不能只看 `<img>` 存在。
- 会在 cwd 留下 `.faux-pic.svg` / `.faux-artifact.html` 两个文件，验收后自行清理。

## 维护

- **JSON 里不能写注释**（`JSON.parse` 会拒）；所有说明都写在本文件。
- 新增剧本时：同批更新上表 + 「跑不通」节（如果踩到结构性限制）。
- `_note` 键只用于 model-keyed 剧本的头部提示；`loadScript` 只按模型 ref 取队列，
  未知键被忽略，不会影响出队。**不要**在数组形态里加 `_note`（会被当成一个 step）。
- 剧本里的工具名/参数必须对得上真实 pi 工具 schema（`bash` / `edit` / `write` / `read` /
  `ask_user` / `plan` / `canvas_*` / `subagent_start` / `workflow_run`），
  出处见各 capability 文档的「驱动」段。
