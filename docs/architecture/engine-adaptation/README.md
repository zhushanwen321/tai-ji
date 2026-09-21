# 外部 coding-agent 引擎适配映射

本目录收录六个外部 coding-agent 对 taiji subagent 引擎协议 v1（`packages/subagent-engine-sdk/src/protocol/`）的 **type 级适配映射文档**。协议面权威 = SDK protocol 源码；协议设计决策 = [`../subagent-engine-protocolization.md`](../subagent-engine-protocolization.md)；本文档族回答「每个引擎的细分类型如何映射到协议靶面」。

## 文档索引

| 引擎 | 映射文档 | 证据基准 | 建议接入形态 |
|------|---------|---------|-------------|
| Claude Code | [claude-code-mapping.md](claude-code-mapping.md) | v2.1.88 npm 产物反解快照 | spawn `claude -p --input-format stream-json --output-format stream-json --verbose`（pi 式，双向 stdio 控制协议） |
| Codex | [codex-mapping.md](codex-mapping.md) | openai/codex@a305084（2026-08-24） | 常驻 `codex app-server --listen stdio://`（JSON-RPC）；exec `--json` 降级 |
| opencode | [opencode-mapping.md](opencode-mapping.md) | sst/opencode@70a2469（2026-09-21） | 常驻 `opencode serve` + `@opencode-ai/sdk`（HTTP + SSE） |
| Kimi Code | [kimi-code-mapping.md](kimi-code-mapping.md) | MoonshotAI/kimi-code@d3b27cc（2026-08-24） | 常驻 `kimi acp`（ACP JSON-RPC over stdio） |
| openclaw | [openclaw-mapping.md](openclaw-mapping.md) | openclaw/openclaw@7a8d307（2026-06-02，较旧） | 常驻 gateway（WebSocket RPC：sessions.send/steer/abort/subscribe） |
| hermes-agent | [hermes-mapping.md](hermes-mapping.md) | NousResearch/hermes-agent@fa3b06b（2026-06-01，较旧） | 常驻 `hermes acp`（ACP JSON-RPC over stdio） |

每份文档固定 9 节：接入形态 / run 参数映射 / 事件映射 / 内容块与 tool 调用 / usage / session 记录与 read 重建 / 反向通道 / 能力位 / gap 清单（源有靶无、靶有源无、语义错配三分类）。

## 六引擎能力位矩阵

值取自各映射文档 §8（含逐位 file:line 依据，此处只留结论）。

| 能力位 | claude-code | codex | opencode | kimi | openclaw | hermes |
|--------|------------|-------|----------|------|----------|--------|
| schemaEnforcement | native | native | emulated | emulated | unsupported | emulated |
| steer | native | native | emulated | unsupported（ACP 面） | emulated | emulated |
| conversation | cold | cold | native | cold | native | cold |
| personaInjection | file | prompt | file | file | file | prompt |
| eventGranularity | stream | stream | stream | stream | stream | stream |
| sandbox | none | native | emulated | none | none | emulated |
| sessionRead | full | full | full | full | full | full |
| resume | cold | native | native | cold | native | cold |
| interrupt | native | native | native | native | native | native |
| permissionMode | native | native | native | native | native | native |
| maxTurns | true | false | true* | false | false | true |

\* opencode maxTurns 机制存在但为 agent 级 steps；per-run 达成须适配器为每次 run 生成临时 agent 定义，有并发命名/清理成本，放弃则声明 false 宿主自管 limiter。

**六家全绿位**：eventGranularity=stream、sessionRead=full、interrupt=native、permissionMode=native——协议 9 事件可全部落位，read 重建与优雅取消是普遍能力。

**稀缺位**：steer 仅 claude-code / codex 为 native，其余为 emulated（排队/打断重发/文本命令）或 unsupported（kimi 的 node-sdk 有 `Session.steer` 但 ACP 方法集无对应）；schemaEnforcement native 仅 claude-code（`--json-schema`）与 codex（`output_schema_strict`）。

## ResumeAnchor.sessionRef 建议

开放载体按引擎构成（详见各文档 §6）：

| 引擎 | sessionRef 构成 | 数据目录隔离 |
|------|----------------|-------------|
| claude-code | `{sessionId}`（transcript 路径引擎自推导） | 环境变量重定向 `~/.claude` |
| codex | `{threadId, rolloutPath}` | `CODEX_HOME` |
| opencode | `{sessionId, directory}` | `XDG_DATA_HOME` |
| kimi | `{sessionId}` + 数据根 | `KIMI_CODE_HOME` |
| openclaw | `{sessionKey, sessionId}` 双带（路由键 ≠ uuidv7 id） | gateway 配置 |
| hermes | `{sessionId, hermesHome}`（SQLite 库非单文件） | `HERMES_HOME` |

## 横向事实

- **ACP 公共面**：kimi（`kimi acp`）、hermes（`hermes acp`）原生提供 ACP stdio server；openclaw 的 `openclaw acp` 是 gateway 的客户端桥。ACP 语义与协议 v1 同构度高，一个「ACP ↔ engine-protocol 转换层」可覆盖多引擎；但 kimi 实测 ACP 面存在 steer/maxTurns/schema/细分 usage 四项不可达，需扩展 acp-server 或直连引擎层。
- **拓扑两极**：全部六家均可用常驻服务形态承载（zcode 式）；仅 claude-code 推荐每任务 spawn（其常驻形态 daemon/mcp serve 均非会话服务）。
- **usage 字段方言**：各家 token 字段名与归并口径不同（如 codex cached/uncached、opencode reasoning 单列、hermes usage 在 turn 终态一次性给出需差分）；cacheWrite/cost 普遍缺 wire 槽。适配层需逐家按映射文档 §5 落。
- **快照漂移风险**：各文档头部标注证据基准 commit；openclaw/hermes 快照较旧（2026-06），按机制存在性采信，实施前须按当时实装版重验（纪律同 pi 语义断言，见 [pi-boundary-reliability.md](../pi-boundary-reliability.md)）。
