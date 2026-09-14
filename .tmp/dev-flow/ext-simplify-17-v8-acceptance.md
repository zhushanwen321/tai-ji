# ext-simplify-17 V8 真机验收报告（rename-session 迁移 298f05901）

- **验收对象**：commit `298f05901`（THINKING_LEVELS/normalizeModelSelector/joinTextBlocks/isRecord 四副本删除改 import llm-shared/ext-guards + truncateCodePoints 三点合并）
- **验收环境**：pi CLI 真机（AGENTS.md 本地实测规范，`-ne` 必带），模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`，日期 2026-09-14
- **判定**：**两项 PASS**（thinking level 传递 / 模型恢复路径），附 1 条非阻塞观察（thinking on 时标题空，产品固有行为，非迁移回归，证据见 §4）

## 1 结论速览

| # | 验收项 | 判定 | 核心真机证据 |
|---|--------|------|--------------|
| 1 | thinking level 传递（llm-shared isThinkingLevel 七值白名单，不降级不误拒） | **PASS** | thinkingLevel=high：rename LLM 调用 `usage.reasoning=65`（off 对照 `=0`）；thinkingLevel=xhigh：`usage.reasoning=70`（词表未拒）；两场景均无 `model not available` / `rename LLM call failed` 日志 |
| 2 | 模型恢复路径（normalizeModelSelector 迁移点） | **PASS** | 配置 `model.ref="xiaomi-token-plan-cn/mimo-v2.5"`（区别于主对话模型 mimo-v2.5-pro）：日志 `rename with model xiaomi-token-plan-cn/mimo-v2.5` + usage 落账 `model=xiaomi-token-plan-cn/mimo-v2.5` + 标题落库 `session_info.name="二分查找算法解释"`，无回退空 ref 的 `model not available, skipping` |

## 2 场景与证据

三个场景共用：主对话模型 `mimo-v2.5-pro`，mode `first-stop`（首个成功 round 末触发 rename），prompt「用一句话解释什么是二分查找。」。证据通道 = session JSONL 的 custom entry：`rename-session:log`（debug 日志，需 `XYZ_AGENT_DEBUG=1`）+ `rename-session`（usage 落账）+ `session_info`（name SSOT）。

### 场景 B：模型恢复路径（normalizeModelSelector）

config：
```json
{ "enabled": true, "model": { "type": "ref", "ref": "xiaomi-token-plan-cn/mimo-v2.5" },
  "mode": "first-stop", "maxTitleLength": 50, "thinkingLevel": "off" }
```

证据（session JSONL 日志时序）：
```
t=12:34:02.474Z LLM request messages: [{"role":"user","text":"用一句话解释什么是二分查找。"},...]
t=12:34:03.232Z rename with model xiaomi-token-plan-cn/mimo-v2.5
t=12:34:03.233Z turnIndex=0 renamed to "二分查找算法解释"
```
- usage 落账 entry：`model=xiaomi-token-plan-cn/mimo-v2.5 usage={"input":280,"output":6,"cacheRead":192,...,"reasoning":0,...}`
- `session_info.name = "二分查找算法解释"`（与 `renamed to` 日志一致）

判定链：配置文件 unknown JSON → llm-shared `normalizeModelSelector`（迁移点）恢复 `{type:"ref", ref:"mimo-v2.5"}` → `resolveModel` 独立选模成功 → **rename 用的模型 ≠ 主对话模型**，证明走的是配置 ref 而非空 ref fallback；全程无 `model not available, skipping`。5/5 检查全过。

### 场景 A：thinking level 传递（high）

config：`model.ref=""`（空 ref 跟随主模型）、`thinkingLevel: "high"`。

```
t=12:34:11.731Z LLM request messages: [...]
t=12:34:14.222Z rename with model xiaomi-token-plan-cn/mimo-v2.5-pro
t=12:34:14.223Z skip: title empty
```
- usage 落账：`usage={"input":284,"output":64,"reasoning":65,...}` —— **reasoning 65 tokens，thinking 真实生效**（同一任务 off 对照 reasoning=0、output=6）
- 传递链验证：config thinkingLevel="high" → llm-shared `isThinkingLevel` 白名单通过 → `callRenameLLM` `reasoning: "high"` 透传 → `callLLM`（`off` 才不传，其余直传）→ pi-ai `clampThinkingLevel`（mimo reasoning:true，"high" 在 supported levels，原样透传）→ openai-completions deepseek format 请求体 `thinking:{type:"enabled"}` + `reasoning_effort:"high"` → 响应 reasoning tokens 回包
- 无 `model not available` / `rename LLM call failed`（无降级/失败日志）

### 场景 C：xhigh 不误拒（词表七值）

config：`model.ref=""`、`thinkingLevel: "xhigh"`。

- usage 落账：`usage={"input":296,"output":64,"reasoning":70,...}` —— **词表未拒 xhigh**：若 `isThinkingLevel` 误拒，normalize 会回退默认 `"off"` → `callLLM` 不传 reasoning → deepseek format `thinking:{type:"disabled"}` → reasoning=0。实测 reasoning=70，排除误拒
- 3/3 检查全过

## 3 命令序列（可复现）

验收脚本：`.tmp/dev-flow/v8-run.mjs`（自包含，三场景顺序执行，mkdtemp 临时目录自建自删，证据落 `.tmp/dev-flow/v8-evidence.json`）。

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/dev-0.9.21
node .tmp/dev-flow/v8-run.mjs          # exit 0 = 全 PASS
```

脚本内部等效的手工命令（每场景一条，config 按上表）：

```bash
TMP=$(mktemp -d /tmp/v8-manual.XXXXXX)
mkdir -p "$TMP/agent/config" "$TMP/sessions"
cp ~/.pi/agent/auth.json "$TMP/agent/"
printf '%s' '{"enabledModels":["xiaomi-token-plan-cn/mimo-v2.5-pro"],"retry":{"enabled":false}}' > "$TMP/agent/settings.json"
touch "$TMP/agent/auto-rename-enabled"
printf '%s' '{"enabled":true,"model":{"type":"ref","ref":"xiaomi-token-plan-cn/mimo-v2.5"},"mode":"first-stop","maxTitleLength":50,"thinkingLevel":"off"}' > "$TMP/agent/config/rename-session-ext-config.json"

PI_CODING_AGENT_DIR="$TMP/agent" XYZ_AGENT_DEBUG=1 PI_SKIP_VERSION_CHECK=1 \
  node node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  -ne --mode rpc --session-dir "$TMP/sessions" \
  --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve \
  --extension /Users/zhushanwen/Code/xyz-agent-workspace/dev-0.9.21/extensions/universal/rename-session <<'EOF'
{"id":"req-1","type":"prompt","message":"用一句话解释什么是二分查找。"}
EOF
# 证据：读 $TMP/sessions/<sid>.jsonl 的 custom entry（rename-session:log / rename-session / session_info）

rm -rf "$TMP"
```

要点：`-ne` 禁 settings 清单 extension discovery（防 npm 版双载，显式 `--extension` 仍生效）；`PI_CODING_AGENT_DIR` 隔离配置/auth/log 目录不污染 `~/.pi/agent/`。

## 4 非阻塞观察：thinking on 时标题空（产品固有，非迁移回归）

现象：场景 A/C（high/xhigh）rename LLM 调用 ok，但 `skip: title empty`——64 maxTokens 输出预算被 reasoning 全部占满（output=64，reasoning=65/70），无标题文本可清洗。

归因（三段证据）：
1. **与迁移无关**：`git show 298f05901^` 与 `298f05901` 的 llm.ts 中 `maxTokens: 64`（line 312→299）与 `reasoning: config.thinkingLevel` 透传（line 316→303）逐字一致，迁移 commit 未触碰。thinking on + 64 token 在迁移前必然同样 title empty。
2. **pi-ai 语义**：openai-completions 的 thinking budget 上限字段（`thinking_token_budget`）仅对配置了 `thinkingTokenBudgetField` 的 provider 生效；mimo（deepseek format）无此配置 → reasoning 与 answer 共享 max_tokens（pi-ai 源码注释原话「Reasoning and the answer share max_tokens here」）。
3. **xhigh 的 clamp 属 pi-ai 层**：mimo 无 thinkingLevelMap → `getSupportedThinkingLevels` 不含 xhigh/max → `clampThinkingLevel("xhigh")→"high"`。这是 pi-ai provider 层语义（对全部调用方一致），不是 llm-shared 词表拒绝——词表层面 xhigh 正常通过（reasoning=70 证明透传成功）。

处置建议（不在本次验收范围执行）：若希望 thinking on 时标题可落库，需产品层决策（如 thinkingLevel 非 off 时提高 maxTokens，或 thinking 预算字段协商）——登记为产品行为特征，待 rename-session 后续迭代裁决。

## 5 环境与清理

- 临时目录：三场景 mkdtemp（`/tmp/v8-*`）已全部自删（脚本 cleanup，复核 `ls /tmp/v8-*` 无匹配）
- 仓库代码：零改动。`git status` 仅余 ` M .tmp/dev-flow/ext-simplify-17-shared-extraction.impl-plan.md`——该文件是本次会话之前已存在的认知外改动（.tmp gitignore 前已被跟踪），按规则未触碰、未提交、未还原
- 本报告与 `v8-run.mjs`/`v8-evidence.json` 均在 `.tmp/`（gitignore），不入库

## 6 决策清单（全托管模式）

1. **验收环境选 pi CLI 真机**（非 xyz-agent 桌面）——按任务与 AGENTS.md 规范，`-ne` + `PI_CODING_AGENT_DIR` 隔离。
2. **场景补齐第三个（C: xhigh）**——任务标注「若可构造则对比 xhigh 也接受」，构造成本低（同脚本改 config）且直接覆盖「词表不误拒」断言，故执行。
3. **thinking 生效判据选 usage.reasoning tokens**——请求体无法从外部观测（不抓包不改码），usage 落账 entry 里的 reasoning 计数是唯一无侵入端到端硬证据，off 场景（B）作对照（reasoning=0）。
4. **模型恢复验证用「rename 模型 ≠ 主对话模型」**——两者相同则无法区分「配置 ref 恢复」与「空 ref fallback」，选 provider 下第二模型 `mimo-v2.5`。
5. **场景 A 的「标题落库」检查判 fail 但整体项判 PASS**——传递链的验收断言（reasoning>0 + 无降级日志 + 调用成功）全过；标题空归因为产品固有的 64-token 预算竞争（§4 三段证据），不构成迁移回归，不擅自改产品代码（任务边界）。
