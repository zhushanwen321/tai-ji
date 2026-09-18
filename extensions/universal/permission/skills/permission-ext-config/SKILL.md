---
name: permission-ext-config
description: "配置 @zhushanwen/pi-permission（四档权限模式 + AI 风险分类）时加载。含配置文件路径、PermissionConfig/ClassifierConfig schema、权限模式、classifier model、默认值、示例、userRules、enabled 反直觉行为、热重载。触发词：配置权限、permission 配置、权限模式、classifier model、permission.json、permission 配置文件、auto/approve/strict/yolo 模式、热重载、enabled。"
---

# permission 配置指南

> @zhushanwen/pi-permission：四档权限模式（yolo/auto/approve/strict）+ 三层管道（AST 分析 + 规则匹配 + AI 风险分类）。

## ⚠ 先看：`enabled` 字段的反直觉行为

**`enabled: false` 不是「锁定/安全模式」，而是「扩展完全不介入」= 全部放行（等同 yolo，仅保留配置文件）。**

想提高安全性，改 `mode`（`auto`/`approve`/`strict`），**不要**把 `enabled` 设 false。把 `enabled` 设 false 是最危险的误配置——用户以为关掉了扩展等于安全锁死，实际等于完全无防护。（源码：`pipeline.ts`「config.enabled=false 等同 yolo」）

## 配置文件位置

`<agentDir>/config/permission-ext-config.json`

- `<agentDir>` = pi agent 目录（`PI_CODING_AGENT_DIR` 覆盖，默认 `~/.pi/agent`；taiji 隔离环境为 `~/.taiji/agent`）
- 走 llm-shared 泛型 config（config/ 子目录 + getAgentDir 派生 + mtime+size 缓存 + 原子写）
- 文件缺失/坏 JSON 返回默认值，不抛错；首次加载自动创建默认配置文件
- [HISTORICAL] 旧路径 `<agentDir>/permission-config.json`（agentDir 根）：**session_start hook 运行时迁移**到新路径（幂等，过渡性，Added in v1.0.0, remove after v2.0.0）

## 热重载：改文件即生效

配置走 **mtime+size 读时刷新（pull-based）**：每次权限检查（每个 tool_call）都 stat 文件，变了就读新配置，**无需重启 session**。

- 在编辑器改 JSON 保存 → 下一次工具调用立即按新配置拦截
- `/permission` 命令执行时也会读最新
- 不要担心性能：文件没变时只做一次 `statSync`（metadata 读，不读文件内容），开销可忽略

> 这是 llm-shared config 框架统一提供的热重载能力。早期版本曾用闭包缓存架空了它（同一 session 改文件不生效），已修复——现在每次 tool_call 直接读最新。

## Schema

```ts
interface PermissionConfig {
  mode: "yolo" | "auto" | "approve" | "strict";  // 权限模式，默认 "yolo"
  enabled: boolean;                                 // 扩展总开关（false=全部放行，见上方警告），默认 true
  classifier: ClassifierConfig;                     // AI 分类器配置（仅 auto 模式生效，见下）
  userRules: Rule[];                                // 用户自定义规则
}

interface ClassifierConfig {
  enabled: boolean;           // AI 层开关，默认 true；false 时 auto 模式跳过 AI 直接人工审批
  model: string;              // 'auto' 或 'provider/model-id'，默认 "auto"
  timeout: number;            // 超时秒，默认 90
  autoApproveLowRisk: boolean;   // 低风险自动放行，默认 true
  autoDenyHighRisk: boolean;     // 高风险转人工审批，默认 true
  thinkingLevel: ModelThinkingLevel;  // thinking 级别，默认 "off"（直接透传，llm-shared 映射为不传）；"minimal"~"max" 透传
}
```

### 权限模式

| 模式 | 行为 | classifier 是否介入 |
|---|---|---|
| yolo | 完全无防护，全部放行 | 否 |
| auto | 安全命令规则直通 + 非安全过 AI 审查 | **是（仅此模式）** |
| approve | 规则直通安全 + 非安全直接人工审批（无 AI） | 否 |
| strict | 全部审批 | 否 |

> `classifier.*` 配置**仅在 `mode: "auto"` 下生效**。在 approve/strict/yolo 模式下调 classifier 字段（timeout/model 等）无任何效果。

### classifier.model（只接受 string）

- `"auto"`（默认）→ permission 本地取 `ctx.modelRegistry.getAvailable()` 首个（不经过 llm-shared 的非精确 selector）
- `"provider/model-id"`（如 `"zhipu/glm-4-flash"`）→ 精确匹配（llm-shared `ModelSelector` 仅支持 ref）
- 传对象形式会被 console.warn 忽略，回落 auto

### auto 模式的风险判定（autoApproveLowRisk / autoDenyHighRisk）

AI classifier 输出 `outcome`（allow/deny/ask）+ `risk_level`（low/medium/high），**outcome 直接生效**：allow 自动放行、deny 直接拒绝、ask 转人工。两个开关只拨动两条边界 override：

| AI 输出 | override 条件 | 实际动作 |
|---|---|---|
| allow + low | `autoApproveLowRisk=false` | 改 **ask**（转人工）；默认 true 时自动放行 |
| allow + high | `autoDenyHighRisk=true` | 改 **deny**（不问人，直接拒绝）；false 时自动放行 |
| allow + medium | — | **自动放行**（不经人工，不受这两个开关影响） |
| deny / ask（任意风险） | — | 原样生效（deny 拒绝；ask 转人工） |

> 也就是说：medium + allow 会自动放行；只有 low+allow 与 high+allow 这两个边界会被开关改写。想让 medium 也转人工做不到（AI 说 allow 就放行），只能换 `approve` 模式去掉 AI 层。

## 默认值

```json
{
  "mode": "yolo",
  "enabled": true,
  "classifier": {
    "enabled": true,
    "model": "auto",
    "timeout": 90,
    "autoApproveLowRisk": true,
    "autoDenyHighRisk": true,
    "thinkingLevel": "off"
  },
  "userRules": []
}
```

> ⚠ 默认 `mode: "yolo"` = 安装后默认**无任何防护**。生产/敏感环境务必改为 `auto` 或 `strict`。

## 验证配置已生效

改完配置文件后，用 `/permission` 命令确认：

- `/permission` — 显示当前模式 + 可用模式
- `/permission status` — 显示详细配置（mode/classifier/userRules 全貌）
- `/permission <mode>` — 切换模式（yolo/auto/approve/strict）

`/permission status` 的输出应与你改后的 JSON 一致；不一致说明文件没保存成功或 JSON 语法错误（此时会回落默认值并 console.warn）。

## 配置示例

auto 模式 + 指定 classifier 用 glm-4-flash + 自定义危险规则：
```json
{
  "mode": "auto",
  "enabled": true,
  "classifier": {
    "enabled": true,
    "model": "zhipu/glm-4-flash",
    "timeout": 60
  },
  "userRules": [
    {
      "tool": "bash",
      "pattern": "rm -rf *",
      "action": "deny",
      "source": "user",
      "description": "禁止递归删除当前目录"
    }
  ]
}
```

## userRules 字段

每条规则：`{ id?, tool, pattern, action, source, description? }`
- tool：工具名（`*` 匹配全部，`bash` 精确）
- pattern：bash 工具对命令行匹配；非 bash 工具对文件路径匹配（path 缺省时对工具名）（wildcard）
- action：`allow` | `deny` | `ask`
- source：`user`（用户规则；内置规则 builtin-safe/builtin-danger 在代码里不进配置）
- id 省略时自动分配 `user-<n>`

## classifier LLM 调用

- 走 llm-shared callLLM（凭证 getApiKeyAndHeaders，含 OAuth/env/auth.json 三源合并）
- model 不可用 / 调用失败 / 超时 → fail-closed 降级为 `ask`（转人工审批）
- classifier 的 stopReason=error/aborted 同样降级 ask
