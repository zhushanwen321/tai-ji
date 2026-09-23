---
name: smart-context-ext-config
description: "配置 @zhushanwen/pi-smart-context（智能上下文压缩：agent 自决 compact_context 工具 + 双模式摘要生成 + 3 档阈值提醒）时加载。含配置文件路径、schema、默认值、双模式说明、排障。触发词：smart-context 配置、压缩配置、compact 配置、上下文压缩、压缩模型、提醒阈值、排除模型。"
---

# smart-context 配置指南

## 功能概览

- `compact_context` 工具：agent 在「任务阶段性完成 && 压缩不影响后续 && 上下文超阈值」时自决调用
- 双模式摘要生成：压缩模型 = 当前模型 → same-model 模式（KV 缓存命中，成本最低质量最高）；不同 → cross-model 模式（廉价模型 + 最小输入）
- 3 档阈值提醒：越过档位时 agent 收到一次性提示（自行判断，不强制）。投递为静默注入——只进下一轮 LLM 上下文，不触发新 turn、不进对话流；同一档位不会重复提醒（已提醒档位随 session 持久化，reload / 重启后不丢）
- 排除模型：命中列表的会话模型整体关闭本功能（回落 pi 原生压缩）
- pi 内建自动压缩的触发线保留为最后防线，其压缩执行也走本扩展逻辑

## 配置文件

路径：`<agentDir>/config/smart-context-ext-config.json`（`<agentDir>` = `getAgentDir()`，默认 `~/.pi/agent`，taiji 环境 `~/.taiji/agent`；`PI_CODING_AGENT_DIR` 可覆盖）。

### Schema

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `compactModel` | `{type:"ref", ref:string}` | `{type:"ref", ref:""}` | 压缩模型（完整 `provider/modelId`）。`ref` 为空 = 跟随当前会话模型（same-model 模式）；等于当前模型同样进 same-model 模式 |
| `reminderThresholds` | `number[]` | `[400000, 500000, 600000]` | 3 档提醒阈值（token 绝对数，升序） |
| `excludedModels` | `string[]` | `[]` | 排除模型列表，完整 `provider/modelId` 精准等值匹配（如 `"deepseek/deepseek-chat"`），不做前缀匹配 |

### 配置示例

```json
{
  "enabled": true,
  "compactModel": { "type": "ref", "ref": "xiaomi-token-plan-cn/mimo-v2.5" },
  "reminderThresholds": [400000, 500000, 600000],
  "excludedModels": ["deepseek/deepseek-chat"]
}
```

## 生效时机

配置为读时热加载（mtime 检测）：修改保存后**下一次事件（压缩/提醒/工具调用）即生效**，无需重启会话。

## 模式选择建议

- 当前模型缓存便宜（如 DeepSeek）→ 加入 `excludedModels`，压缩反而更贵
- 当前模型缓存贵 + 有廉价可用模型 → `compactModel` 配廉价模型（cross-model）
- 想要最高摘要质量 + 最低成本 → `compactModel` 留空或配成当前模型（same-model，KV 缓存命中）

## 排障

- 压缩回退当前模型：`compactModel.ref` 指向的模型不可用（无凭证/已删）——换可用模型或留空
- 工具调用被拒「已禁用」/「已排除」：检查 `enabled` 与 `excludedModels`
- 提醒未出现：`getContextUsage().tokens` 在压缩后首个响应前为 null，属正常（下轮恢复）
- 连续接管失败 3 次后不再接管：本会话熔断保护，查看 `TAIJI_AGENT_DEBUG=1` 日志定位失败原因
- 调试：`TAIJI_AGENT_DEBUG=1` 后看 `[smart-context]` 前缀日志（`~/.pi/agent/logs/`）
