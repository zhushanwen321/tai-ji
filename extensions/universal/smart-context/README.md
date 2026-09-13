# @zhushanwen/pi-smart-context

智能上下文压缩 pi extension：把 compact 时机交给 agent 自决，压缩生成用双模式接管（same-model KV 缓存命中 / cross-model 廉价模型），3 档阈值提醒不强制。

## 功能

- **`compact_context` 工具**：agent 在「任务阶段性完成 && 压缩不影响后续 && 上下文超阈值」三条件同时满足时自决调用；带最低档阈值保护
- **双模式生成接管**（`session_before_compact`，覆盖工具 / `/compact` / 内建 auto 三条路径）：
  - same-model：完整原始上下文 + 会话原 system prompt + tools + 末尾追加压缩指令——前缀缓存全命中，成本≈增量指令+输出，且模型看全量上下文（质量上限最高）
  - cross-model：调用 pi 原生 `compact()` 仅换模型与凭证——split-turn / fileOps / previousSummary 原生组装
- **3 档阈值提醒**（默认 200K/400K/600K）：`agent_settled` 越档检查，每档一次、多档合并、压缩后重置，followUp 投递；措辞是数据投递不是指令
- **排除模型**（精准 `provider/modelId` 匹配）：工具拒绝 + 不提醒 + 回落 pi 原生生成；切换跨界时注入一条可用性通知，downshift（切小窗模型将触线）时建议先压缩
- **健壮性**：摘要收缩校验、max-tokens 截断 fail-closed、接管失败 3 次熔断、transcript 回查指针、压缩后最近文件内容重注入（≤5 文件/50K）、多轮压缩降智提示
- **subagent 进程**自动静默（`PI_SUBAGENT_ROOT_SESSION_ID` 标记）

## 行为门控

| 状态 | 工具 execute | 阈值提醒 | 压缩生成接管 |
|---|---|---|---|
| enabled，模型未排除 | 放行（低于最低档阈值时拒绝并返回用量建议） | 生效 | 生效（按双模式判定） |
| enabled，模型命中排除列表 | 拒绝（返回原因） | 跳过 | 跳过（回落 pi 原生生成） |
| enabled=false | 拒绝（"可在设置页开启"） | 跳过 | 跳过（回落 pi 原生） |
| compactModel 未配置/无效 | 放行（same-model 不依赖该配置） | 生效 | same-model 生效；cross-model 回退当前模型，压缩不失败 |
| 模型切换跨界（model_select） | 常驻不变 | 注入一条可用性变化通知（仅跨界时） | 按新模型即时重判 |

行为正确性由 execute / handler 现场校验兜底，每次事件回调重新读配置（热加载，改完下一 turn 生效，无需重启）。

> 设计层 why 与业界调研记录见原设计文档（已随 2026-09 docs 清理退役，git 历史可查 `docs/extensions/smart-context/design.md`）。

## 配置

`<agentDir>/config/smart-context-ext-config.json`（读时热加载）。schema 与示例见 `skills/smart-context-ext-config/SKILL.md`。xyz-agent 桌面端在设置页（系统 → 智能上下文压缩）可视化配置。
