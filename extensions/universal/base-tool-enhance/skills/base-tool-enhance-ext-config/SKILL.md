---
name: base-tool-enhance-ext-config
description: "使用或排查 @zhushanwen/pi-base-tool-enhance 的 bash 后台/白名单配置时加载。说明配置文件路径与热重载生效时机、5 键 schema（forceBackgroundPatterns / disableBuiltinForcePatterns / foregroundTimeoutSeconds / backgroundTimeoutSeconds / maxConcurrentBackground）与默认值、force-background 白名单命中语义（测试命令自动转后台、忽略显式 timeout、返回 task_id）、用户正则自动命令位置锚定约定（无需自带 ^）。触发词：bash background、后台任务配置、force-background 白名单、测试命令自动后台、dev server 自动后台、backgroundTimeoutSeconds、foregroundTimeoutSeconds、maxConcurrentBackground、base-tool-enhance-ext-config。"
---

# base-tool-enhance 配置指南

> @zhushanwen/pi-base-tool-enhance：bash 工具增强扩展（前台委托 pi 官方工厂 + 增量 background 模式 + force-background 白名单）。本指南讲清配置位置、字段语义、白名单命中行为与用户正则锚定约定。

**生效时机（与 subagent-workflow 不同）**：配置在**每次 bash 工具调用时读时加载**（mtime+size 缓存刷新）——改完配置文件保存后，下一次 bash 调用即生效，**无需重启、无需新建 session**。用户问「改了没生效」时先核对文件路径与 JSON 合法性，不要怀疑 session。

## 配置文件在哪（三环境）

路径固定为 `<agentDir>/config/base-tool-enhance-ext-config.json`（pi 核心 `getAgentDir()` 派生）：

| 环境 | 路径 |
|------|------|
| 独立 pi CLI | `~/.pi/agent/config/base-tool-enhance-ext-config.json` |
| taiji dev | `~/.taiji-dev/agent/config/base-tool-enhance-ext-config.json` |
| taiji prod | `~/.taiji/agent/config/base-tool-enhance-ext-config.json` |

**动态推导（推荐）**：agentDir 由 pi 核心 `getAgentDir()` 决定（读 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）；taiji 通过 `TAIJI_AGENT_DATA_DIR` 隔离数据目录。排查时先查这两个 env 组合出实际路径，不要假设单一环境——写错环境的配置文件改了也不生效。

文件不存在 / JSON 解析失败 → 全默认值继续工作（工具不报错，warn 落扩展日志）。单键类型错/非法值 → **仅该键**回退默认 + warn，不整体拒载；未知键忽略（前向兼容）。

## 字段表（5 键）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `forceBackgroundPatterns` | string[] | `[]` | 用户正则（源字符串），追加到内置两组白名单之后。单条非字符串或非法正则 → 仅丢弃该条 + warn，其余保留 |
| `disableBuiltinForcePatterns` | boolean | `false` | `true` = 关闭内置 force-test / force-longrun 两组，只用用户正则 |
| `foregroundTimeoutSeconds` | number \| null | `null` | `null` = 不注入（pi 原生不限时）；正数 = 前台命令未填 timeout 时注入的默认秒数。非正数/非有限数 → 回退 null + warn；超 int32 毫秒上限自动 clamp |
| `backgroundTimeoutSeconds` | number \| null | `null` | 同上，后台任务未填 timeout 时的默认秒数 |
| `maxConcurrentBackground` | number | `8` | 后台任务并发上限，正整数（小数取 floor） |

示例（最小可用——只关内置白名单 + 给用户正则 + 后台默认超时）：

```json
{
  "disableBuiltinForcePatterns": false,
  "forceBackgroundPatterns": ["pnpm\\s+typecheck", "make\\s+-j\\d+"],
  "foregroundTimeoutSeconds": null,
  "backgroundTimeoutSeconds": 600,
  "maxConcurrentBackground": 8
}
```

## force-background 白名单命中语义

命令命中白名单（内置两组或用户正则任一）时，即使未要求（甚至显式 `background: false`）也**强制转后台**：

1. **返回形态变化**：bash 返回 `task_id` + pid + 输出文件路径（不再等命令跑完直接回输出）——用 `bash_output {task_id}` 轮询进度，`bash_kill {task_id}` 终止。result 文案会注明 `Forced to background: command matched force-background whitelist ...`（内置条目报组名+标签，用户正则报字面量前 40 字符）。
2. **显式 timeout 被忽略**：白名单命中时 LLM 显式 timeout 不生效（防止「跑测试带 timeout」的老习惯精确触发挂死问题），后台 timeout 取 `backgroundTimeoutSeconds` 配置默认，未配置 = 不限。
3. **内置两组**：force-test（`npm test` / `pnpm run test:*` / `npx vitest` / `pytest` / `go test` / `cargo test` / `mvn test` 等测试套件命令）+ force-longrun（`npm run dev` / `npx vite` / `npx next dev` / `tsc --watch` / `nodemon` / `tail -f` / `ngrok` 等无自然退出点的长驻命令）。完整清单以扩展源码 `force-patterns.ts` 为准。

**timeout 优先级（非白名单路径）**：LLM 显式值 > 配置默认 > 不限。前台与后台分别取 `foregroundTimeoutSeconds` / `backgroundTimeoutSeconds`。

**subagent 降级（D14）**：subagent 进程内白名单与 `background` 参数同时失效（全量降级，保持内置同步语义），只有主 agent 进程受配置影响。

## 用户正则锚定约定（重要）

用户正则**自动加命令位置锚定前缀**（`CMD_ANCHOR`：行首，或 `;` / `&&` / `||` / `|` / 换行之后的命令起始位，后随可选空白）——与内置条目统一匹配语义：

- **无需也不应自带 `^`**：写 `pnpm\s+typecheck` 即可。自带 `^` 反而收窄匹配（`^` 只钉死整条命令第一段，`cmd1 && pnpm typecheck` 中的第二段就匹配不到了）。
- **不做裸子串匹配（防误伤）**：参数文本里的命令词不会命中——`git commit -m "fix: npm test"` 不触发后台（unified-hooks 时代的 `\s` 前缀会误伤，本包已收紧为命令位置锚定）。
- **wrapper 局限（漏报方向）**：`sudo npm test` / `timeout 300 npm test` / `xargs npm test` 这类 wrapper 形态不命中（wrapper 名占命令位置）。漏报无害——force 命中本就是非破坏性的，模型可显式传 `background: true` 兜底。

## 常见排查

| 症状 | 原因与处置 |
|------|------|
| 测试命令没自动转后台 | ① 内置被 `disableBuiltinForcePatterns:true` 关了；② wrapper 形态不命中（见锚定约定）；③ 在 subagent 进程内（D14 降级）——换显式 `background: true` |
| 用户正则不生效 | 检查是否带了 `^`（收窄匹配）；非法正则被静默丢弃（warn 在扩展日志）；确认写对了环境的配置文件路径 |
| 后台任务报 limit reached | 并发达到 `maxConcurrentBackground` 上限——错误文案含最老任务 task_id，用 `bash_kill` 释放或调大配置 |
| 命令总被转后台但不想要 | 该命令命中了白名单——`disableBuiltinForcePatterns:true` 关内置组，或缩小用户正则 |
| 配置键改了无效 | 单键非法被回退默认（warn 在扩展日志）；确认 JSON 值类型正确（如 timeout 键是数字或 null，不是字符串） |
