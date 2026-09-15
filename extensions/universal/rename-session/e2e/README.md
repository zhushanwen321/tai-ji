# rename-session E2E 验收资产

E2E wave（P0 探针 + T1 harness + A1-A7 场景）的探针结论与运行指南。

- 测试模型固定 `xiaomi-token-plan-cn/mimo-v2.5-pro`（项目规范，禁 kimi）
- 本 E2E 定位为**本地人工触发的验收资产**（真实模型 API，不进常规 CI）
- 场景 runner：`node e2e/run-a1.mjs` ~ `node e2e/run-a7.mjs`（单场景独立可跑）、`node e2e/run-all.mjs`（顺序全跑 + 汇总 + exit code），harness 见 `e2e/harness.mjs`
- run-all 两种模式：默认全量 A1-A7（真实 pi + 真实模型，约 2-15 分钟，人工验收用）；`E2E_QUICK=1` 只跑 harness 断言工具单测（秒级，cw test gate 用——cw testRunner 硬编码 120s 命令超时，真实模型全量必超；E2E 场景正式验收证据 = RESULTS.md + 各场景跑记录）；vitest 入口等价物：`npx vitest run --config e2e/vitest.e2e.config.ts`（A1-A7 各一个 test；专用 e2e config 的 include 才含 scenarios.test.mjs，根 vitest.config.ts 白名单不含，不带 `--config` 直跑会 No test files found）

## P0 探针结论（2026-08-15 实测）

环境：macOS darwin24 arm64 / Node v24.11.1 / pi binary = repo `node_modules/.bin/pi`（symlink → `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`，devDependency 提供）。探针脚本为一次性产物（/tmp 已清理），下述命令样例即复现路径。

### 1. auth 迁移（GAP-1 硬前提）——可行，无降级需求

**结论**：`xiaomi-token-plan-cn` 是 **pi-ai 内置 provider**（`pi-ai/dist/providers/xiaomi-token-plan-cn.js`，`envApiKeyAuth(["XIAOMI_TOKEN_PLAN_CN_API_KEY"])`）。迁移只需把 `~/.pi/agent/auth.json`（含 `xiaomi-token-plan-cn` key）复制到 tmp 的 `PI_CODING_AGENT_DIR/auth.json`。实测：tmp 隔离环境起 pi 发真实 prompt，主模型与 rename LLM（同 provider）均真实调通，标题「基础算术计算」落库。

无需迁移 customProvider 定义（provider 是内置的，models-store.json 是 pi 自管的 catalog 缓存，会自建）。无 settings.json `packages` 时不触发 npm 安装。

**最小样例**：

```bash
TMP=$(mktemp -d /tmp/rename-e2e.XXXXXX)
mkdir -p $TMP/agent $TMP/sessions
cp ~/.pi/agent/auth.json $TMP/agent/auth.json          # 唯一必需的迁移物
printf '%s' '{"enabledModels":["xiaomi-token-plan-cn/mimo-v2.5-pro"],"retry":{"enabled":false}}' > $TMP/agent/settings.json
touch $TMP/agent/auto-rename-enabled                    # rename 开关 flag（live 覆盖源）
env PI_CODING_AGENT_DIR=$TMP/agent TAIJI_AGENT_DEBUG=1 PI_SKIP_VERSION_CHECK=1 \
  <repo>/node_modules/.bin/pi --mode rpc --session-dir $TMP/sessions \
  --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve \
  --extension <repo>/extensions/universal/rename-session
# stdin: {"id":"p-1","type":"prompt","message":"1+1等于几？只回答数字。"}
```

**降级路径（若 auth.json 不存在/key 在别处）**：环境变量注入 `XIAOMI_TOKEN_PLAN_CN_API_KEY`（pi-ai `env-api-keys.ts` 的 provider→env 映射，auth.json 优先、env 兜底）。

### 2. RPC 协议格式——实测确认，与 docs/rpc.md 一致

**结论**：stdin/stdout 严格 JSONL（LF 分隔）。命令带 `id` 可关联响应；事件流无 id。注意两点：

1. **Node `readline` 不合规**（会按 U+2028/U+2029 切行，JSON 字符串内合法）——必须手写 LF splitter（harness 已实现）。
2. **原始 RPC `turn_end` 事件不含 `turnIndex` 字段**（只有 `message` + `toolResults`）；extension 内部事件才有 turnIndex（session JSONL 日志 entry 的 `turnIndex=0` 可见）。断言 turnIndex 只能走 session JSONL 的 `rename-session:log` entry，不能走 stdout 事件。

**实测样例**：

```jsonl
→ {"id":"p-1","type":"prompt","message":"1+1等于几？只回答数字。"}
← {"id":"p-1","type":"response","command":"prompt","success":true}
← {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"2"}],"stopReason":"stop",...}}
← {"type":"turn_end","message":{...,"stopReason":"stop"},"toolResults":[]}
← {"type":"agent_settled"}
→ {"id":"gs-1","type":"get_state"}
← {"id":"gs-1","type":"response","command":"get_state","success":true,"data":{"sessionFile":"...","sessionId":"...","sessionName":"...","messageCount":3,...}}
→ {"id":"sn-1","type":"set_session_name","name":"probe-manual-name"}
← {"id":"sn-1","type":"response","command":"set_session_name","success":true}
```

时序要点：`response(prompt)` 在 prompt 被**接受**时即返回（异步）；round 完成以 `agent_settled` 为准；**rename 是 fire-and-forget，settled 后仍需等 session JSONL 的 rename 日志 entry**（`renamed to` / `rename LLM call failed` / `skip: ...`，extension-logger appendEntry 通道 customType `rename-session:log`，harness `waitForSessionLog` 轮询，上限 30s 超时 + 余量）。扩展日志不写 pi 进程 stderr（logger.warn 落 appendEntry + debug 文件日志）。

### 3. `--session` 续跑——可行（A4 阶段 2 前提）

**结论**：`pi --mode rpc --session <绝对路径>` 重启后 `get_state` 确认 `sessionFile` 与目标一致、`messageCount` 恢复、`sessionName` 保留。发第二条 prompt 正常完成，rename 正确跳过并留痕 `skip: count=2`（turnIndex 每进程重新从 0 计）。

**最小样例**：

```bash
F=<tmp>/sessions/2026-08-15T..._<uuid>.jsonl
env PI_CODING_AGENT_DIR=$TMP/agent TAIJI_AGENT_DEBUG=1 \
  <repo>/node_modules/.bin/pi --mode rpc --session-dir $TMP/sessions \
  --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve \
  --extension <repo>/extensions/universal/rename-session --session "$F"
# get_state → sessionFile===F；prompt 第二条 → turn_end(stop) → stderr: skip: count=2
```

**降级方案**（本次未触发）：同进程 `switch_session` RPC 命令加载 session 文件（docs/rpc.md 有此命令），但失去「重启进程」语义；A4 阶段 2 优先用 `--session`。

### 4. 坏 provider 配置——turn_end 携带 stopReason=error（A4 断言前提成立，无需降级）

**结论**：tmp `agentDir/models.json` 覆盖内置 provider 的 baseUrl 即可让请求失败：

```json
{ "providers": { "xiaomi-token-plan-cn": { "baseUrl": "http://127.0.0.1:1/v1" } } }
```

（settings.json 需 `retry.enabled=false`，否则 auto-retry 退避重试拉长 error 轮。）

实测 error 轮行为（对 A4 的断言面）：

- `message_end` 与 `turn_end` 的 `message.stopReason === "error"`，`message.errorMessage === "Connection error."`，`content: []`
- `agent_end` `willRetry:false` → `agent_settled` 照常发出（**settled 不代表成功**，断言必须看 stopReason）
- rename handler 走快速路径：session JSONL 日志 entry `[rename-session] t=... turnIndex=0 skip: stopReason=error`，无 LLM request 日志、无 session_info
- **pi 进程存活**，error 轮后 RPC 命令（get_state）正常响应

**降级方案**（本次未触发）：若 turn_end 不发，改用 `agent_end` 事件 + session JSONL error entry 行序替代；实测不需要。

### 5. stub socket（hang provider）——可行（A5 前提）

**结论**：node `net.createServer` accept 后不响应即可 hang 住 openai-completions 请求。三件套配置：

1. `agentDir/models.json` 新增独立 customProvider（不动主 provider）：

```json
{
  "providers": {
    "stub-hang": {
      "name": "Stub Hang Provider",
      "baseUrl": "http://127.0.0.1:<port>/v1",
      "api": "openai-completions",
      "apiKey": "stub-dummy",
      "models": [
        { "id": "hang-model", "name": "Hang Model", "reasoning": false, "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000, "maxTokens": 4096 }
      ]
    }
  }
}
```

2. `settings.json` 的 `enabledModels` 追加 `"stub-hang/hang-model"`
3. `agentDir/config/rename-session-ext-config.json` 写 `"model": {"type":"ref","ref":"stub-hang/hang-model"}`（标题模型指向 stub；主对话 `--model mimo-v2.5-pro` 不受影响）

实测（A5 全链路语义）：主 round 正常完成（`turn_end` stop + `agent_settled`）；rename LLM request 发出后 hang，**约 30s 超时**；失败日志 entry（appendEntry 通道）为：

```
message: [rename-session] rename LLM call failed
data:    { error: "unknown error" }   ← 结构化 data 字段，message 不含冒号拼接
```

**注意**：超时时 callLLM 内部（llm-shared call.ts 的 extractText）将空错误文本归一为 `unknown error`——extension 侧 `result.error ?? "unknown error"` 只兜 null/undefined，空串兜底发生在 llm-shared 层。A5 断言匹配 message **子串** `rename LLM call failed`（无冒号——error 在结构化 data，不拼接进 message），不要匹配具体超时文案。超时后 pi 进程存活、后续 RPC 正常、session JSONL 无自动 session_info（实测 0 条）。

## T1 harness 使用指南

`e2e/harness.mjs` 导出：

- **进程编排**：`spawnPi(opts)`（tmp 初始化 + auth 迁移 + 交错时间轴 + RPC client）、`startHangServer()`（A5 stub socket）、`runScenario(name, fn)`（场景 runner 通用执行器：单场景失败不阻断，四分类汇总）、`runStandalone(moduleUrl, run)`（独立执行入口判定 + exit code 映射，run-aN.mjs 尾部共用）
- **RPC client**（spawnPi 返回值的 `rpc`）：`request(cmd)`（id 关联）、`waitFor(type, opts)`、`waitForSessionLog(pattern, opts)`（轮询 session JSONL 的 rename-session:log entry，pattern 匹配 message）、`prompt(msg)`、`setSessionName(name)`、`getState()`
- **断言纯函数**（场景脚本与单测共用）：`sleep`（场景通用 sleep）/ `assert`（场景通用 assert，失败抛 assertion 分类 HarnessError）/ `rebuildPreview` / `parseLogMessages` / `lastSessionInfoEntry`（取最后一条 session_info entry，name SSOT）/ `parseJsonlEntries`（逐行 JSON.parse，坏行跳过）/ `extractRenameLogEntries` / `extractLastStopAssistant` / `firstAssistantStartT` / `lastStopAssistantEndT` / `countToolCalls` / `countLlmRequestLogs` / `countSessionInfoEntries` / `assertTitleGuards` / `assertLogTitleMatches`（断言 renamed to 日志标题与 session_info 落库一致）/ `classifyFailure`
- **共用常量/类**：`E2E_MODEL`（测试模型，值见开头）、`LLM_REQUEST_MARKER`（rename LLM request 日志行前缀）、`RENAME_LOG_CUSTOM_TYPE`（rename 日志 entry 的 customType）、`HarnessError`（携带失败分类的错误类，classifyFailure 归类依据）
- **清理**：handle 的 `kill()`（按 PID）与 `cleanup()`（kill + 删 tmp；`E2E_KEEP_TMP=1` 保留现场）

单测：`cd extensions/universal/rename-session && npx vitest run e2e/harness.test.mjs`（根 vitest.config.ts 的 include 白名单精确列 `e2e/harness.test.mjs`；scenarios.test.mjs 只在专用 e2e/vitest.e2e.config.ts 的 include 里）。

环境要求：`~/.pi/agent/auth.json` 存在且含 `xiaomi-token-plan-cn` key（缺失时改用 `XIAOMI_TOKEN_PLAN_CN_API_KEY` env，见探针 1）。

## 已知事实备忘（场景脚本断言时引用）

| 事实 | 出处 |
|---|---|
| session_info entry 位于 round 全部 entry 之后（佐证 rename 在 round 末触发） | 探针 1 实测行序 |
| 手动 set_session_name 追加第二条 session_info，**最后一条生效** | 探针 1 实测 |
| rename 结果日志 entry 三条：`renamed to "<title>"`（src/index.ts，`setSessionName` 之后打出）/ `rename LLM call failed`（src/llm.ts，`logger.warn(msg,{error})` 形态）/ `skip: <原因>`（no user prompt / title empty 在 llm.ts；name exists / count=N / stopReason=X 在 index.ts） | src/index.ts + src/llm.ts |
| handler 侧日志 message 带 `turnIndex=<n>`（含 `renamed to`），llm.ts 侧不带；日志通道 = appendEntry（session custom entry，customType `rename-session:log`），不写 stderr | src/index.ts vs src/llm.ts |
| `turnIndex` 每进程从 0 重新计（--session 续跑后第二轮日志仍 turnIndex=0） | 探针 3 实测 |
| error 轮：turn_end stopReason=error + errorMessage="Connection error."，pi 存活 | 探针 4 实测 |
| 超时轮：约 30s 后 `rename LLM call failed`（message 子串；error 详情在结构化 data 字段，空串归一发生在 llm-shared extractText 层） | 探针 5 实测 |
