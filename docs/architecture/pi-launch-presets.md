# Pi 启动参数预设 - 设计文档

## 0. 概览

**目标**：在 xyz-agent 中支持 Pi 启动参数预设，允许用户为不同场景（全工具、Orchestrator、只读 Review 等）配置不同的工具集和扩展集。

**核心价值**：
- 用户可在 Landing 页快速选择「我要用什么模式启动」
- Session 创建后锁定模式，防止意外切换
- 预设可自定义，支持黑白名单精细控制

**Demo 预览**：
- Settings 页面 Demo（`demo-settings-pi-presets.html`，已删除）— 预设编辑、工具/Extension 黑白名单配置
- Landing 页面 Demo（`demo-landing-preset-chip.html`，已删除）— 预设选择 Chip、Session 锁定状态

> **[MANDATORY] 实现前必读**：本设计的所有 pi CLI 参数映射基于源码核实（见 [附录 A](#附录-api-cli-参数事实核实)）。pi 的工具白名单 `--tools` 是**替换语义**，extension 注入 `--extension` 是**追加语义**，两者不能复用同一套映射逻辑。pi **无原生 extension 黑名单**，denylist 必须由调用方（runtime）先枚举全部已启用 extension 再排除后，作为 allowlist 注入。

---

## 1. 数据模型

### 1.1 核心概念

**预设模式（PiLaunchPreset）**：一组 pi 启动参数的命名集合，用户可创建、编辑、删除。

**内置预设**：系统提供 3 个不可删除的预设，覆盖常见场景。
**自定义预设**：用户创建，可任意编辑。

### 1.2 TypeScript 类型定义

```typescript
// packages/shared/src/pi-preset.ts

/** 工具模式：决定如何处理工具列表 */
export type ToolMode = 'all' | 'allowlist' | 'denylist' | 'none'

/**
 * Extension 模式：决定如何处理 extension 列表。
 *
 * 注意：pi 无原生 extension 黑名单。denylist 由 runtime 先列出全部已启用 extension，
 * 排除用户指定的 deniedExtensions 后，作为 allowlist 注入（见 §2.4 实现细节）。
 *
 * builtin infrastructure 级扩展在任何 extensionMode 下都注入；feature 级 builtin
 * 与用户扩展同受 preset 筛选，见 §2.3。
 */
export type ExtensionMode = 'all' | 'allowlist' | 'denylist' | 'none'

/** 内置工具列表（pi 硬编码 7 个，见附录 A.1） */
export const BUILTIN_TOOLS = ['read', 'write', 'bash', 'edit', 'grep', 'find', 'ls'] as const

// [历史] 设计期的 BUILTIN_EXTENSION_FILES 常量（3 个文件型 xyz-*.js）已随 builtin→npm
// 迁移（2026-08）删除。现行 builtin 扩展 = @zhushanwen/pi-* npm 包，清单 SSOT =
// packages/shared/src/mandatory-extensions.json（tier: infrastructure / feature 两级），
// 打包经 scripts/bundle-extensions.mjs staging 到 apps/electron/resources/extensions/。
// infrastructure 级（pi-system-prompt / pi-msg-id-mapper / pi-agent-ext 等）不受
// extensionMode 影响；feature 级（pi-goal / pi-todo 等）与用户扩展同受筛选——见 §2.3。

/** Pi 启动参数预设 */
export interface PiLaunchPreset {
  /** 预设唯一 ID（内置用 'builtin:xxx'，自定义用 UUID） */
  id: string
  /** 预设名称（显示用） */
  name: string
  /** 预设描述 */
  description?: string
  /** 是否内置（不可删除/重命名） */
  builtin: boolean
  /** 排序权重（越小越靠前） */
  order: number

  // ── 工具配置 ──
  /** 工具模式 */
  toolMode: ToolMode
  /** allowlist 模式下允许的工具名列表 */
  allowedTools?: string[]
  /** denylist 模式下禁用的工具名列表 */
  deniedTools?: string[]

  // ── Extension 配置 ──
  /** Extension 模式 */
  extensionMode: ExtensionMode
  /** allowlist 模式下允许的 extension 名列表 */
  allowedExtensions?: string[]
  /** denylist 模式下禁用的 extension 名列表 */
  deniedExtensions?: string[]

  // ── 模型配置（可选覆盖） ──
  /**
   * 覆盖默认模型（如 'anthropic/claude-sonnet-4'）。不设则用全局默认。
   *
   * 优先级规则见 §5.2：Landing Model Chip > preset.modelOverride > 全局默认。
   */
  modelOverride?: string
  /**
   * 覆盖思考级别。合法值：'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'。
   * 注意：pi CLI 参数名是 --thinking（不是 --thinking-level），见附录 A.4。
   *
   * 优先级规则见 §5.2：Landing Thinking Chip > preset.thinkingLevel > 全局默认。
   */
  thinkingLevel?: ThinkingLevel

  // ── 其他配置 ──
  /** 禁用所有 skill（映射 --no-skills） */
  noSkills?: boolean
  /** 禁用 context files（AGENTS.md/CLAUDE.md，映射 --no-context-files） */
  noContextFiles?: boolean
}

/** 内置预设 ID 常量 */
export const BUILTIN_PRESET_IDS = {
  FULL: 'builtin:full',                // 全工具模式
  ORCHESTRATOR: 'builtin:orchestrator', // orchestrator 模式
  READONLY: 'builtin:readonly',         // 只读模式
} as const

/** 默认内置预设列表 */
export const DEFAULT_PRESETS: PiLaunchPreset[] = [
  {
    id: BUILTIN_PRESET_IDS.FULL,
    name: '全工具模式',
    description: '所有工具和扩展可用，适合大部分任务',
    builtin: true,
    order: 0,
    toolMode: 'all',
    extensionMode: 'all',
  },
  {
    id: BUILTIN_PRESET_IDS.ORCHESTRATOR,
    name: 'Orchestrator',
    description: '主 Agent 只做协调，实际执行由 SubAgent 完成',
    builtin: true,
    order: 1,
    toolMode: 'denylist',
    deniedTools: ['read', 'write', 'bash', 'edit'],
    extensionMode: 'all',
  },
  {
    id: BUILTIN_PRESET_IDS.READONLY,
    name: '只读模式',
    description: '只能查看代码，适合 Code Review',
    builtin: true,
    order: 2,
    toolMode: 'allowlist',
    allowedTools: ['read', 'grep', 'find', 'ls'],
    extensionMode: 'all',
  },
]
```

### 1.3 Session 绑定

```typescript
// 扩展 packages/shared/src/session.ts 的 SessionSummary
export interface SessionSummary {
  // ... 现有字段 ...

  /**
   * session 创建时锁定的预设 ID。
   *
   * 持久化在独立 sidecar `<sessionFile>.preset.json`（不是 .meta.json——.meta.json 是
   * session 终态 sidecar，session 结束时才写）。见 §4.1 持久化机制。
   *
   * session 活跃期间（未结束时）此值通过 session-scoped runtime 内存态保存，
   * 在 create() 成功后立即写 preset sidecar，保证 app 崩溃重启不丢失绑定关系。
   *
   * restoreSession 时从此 sidecar 读取（找不到则按 'builtin:full' 兜底），
   * 用此 preset 重新构建 pi args（包括重新 spawn pi 时应用相同工具/扩展配置）。
   */
  launchPresetId?: string
}
```

### 1.4 存储位置

**用户预设配置**：`~/.xyz-agent/pi-presets.json`
- 存储用户自定义预设 + 内置预设的用户覆盖（如改 description）+ 默认预设 ID
- 位置由 `getDataDir()` 推导（dev=`~/.xyz-agent-dev/`，prod=`~/.xyz-agent/`），禁止硬编码路径（架构约定 #2）
- 数据模型：
  ```typescript
  interface PiPresetsFile {
    /** 用户自定义预设 + 内置预设的用户编辑副本（builtin 字段仍 true） */
    presets: PiLaunchPreset[]
    /** 用户设置的「设为默认」preset id，全局生效。见 §5.3 default preset 作用域 */
    defaultPresetId?: string
    /** schema 版本，便于未来迁移 */
    version: 1
  }
  ```

**Session 绑定**：`<sessionFile>.preset.json`（独立 sidecar，与 `.meta.json` 并列）
- 内容：`{ presetId: string, version: 1 }`
- 生命周期与 sessionFile 绑定，删除 session 时一并清理（见 §4.4）

---

## 2. 与现有 Runtime 机制的集成

> 这是本设计的关键章节。设计必须回答「preset 字段如何与现有 `getExtensionPaths` / `getSkillPaths` / `getReplaceSystemPrompt` 共存」，否则会在 session-lifecycle.ts 三处（create / restoreSession / forkSession）与现有注入逻辑冲突。

### 2.1 现有注入机制（核实结果）

`session-lifecycle.ts` 的 create() / restoreSession() / forkSession() 三处**统一**调用以下三个 service 方法构建 RpcClientOptions：

| 现有字段 | 来源 | 用途 |
|---|---|---|
| `extensionPaths` | `svc.getExtensionPaths(cwd)` → `ExtensionService.getExtensionPaths` | 收集 builtin npm 扩展（mandatory-extensions.json SSOT）+ 用户启用的 extension（全部走 `--extension` 显式注入）|
| `skillPaths` | `svc.getSkillPaths(cwd)` → 读 `discovery.json` | 用户启用的 skill 目录 |
| `systemPrompt` | `svc.getReplaceSystemPrompt()` → 读 `system-prompt.json` | 替换 pi 核心系统提示词 |

rpc-client.ts:128 当前**硬编码** `--no-extensions --approve`，所有 extension 一律通过 `--extension` 显式注入（不依赖 pi 自动发现）。

### 2.2 覆盖 vs 叠加规则

| preset 字段 | 与现有机制的关系 | 规则 |
|---|---|---|
| `toolMode` / `allowedTools` / `deniedTools` | **新增维度**（现有完全没有） | 直接映射到 `--tools` / `--exclude-tools`，叠加在现有 args 上 |
| `extensionMode` + allowed/denied | **叠加**到现有 `getExtensionPaths` 结果 | 见 §2.4，过滤 `ExtensionService.scanExtensions()` 返回的可筛选 extension；infrastructure 级 builtin 不受影响 |
| `noSkills` | **叠加**到现有 `getSkillPaths` | noSkills=true 时清空 skillPaths，并在 args 追加 `--no-skills` |
| `noContextFiles` | **新增维度** | 直接映射到 `--no-context-files`，不影响其他 |
| `modelOverride` | 见 §5.2 优先级规则 | Landing Chip 覆盖 > preset > 全局默认 |
| `thinkingLevel` | 见 §5.2 优先级规则 | Landing Chip 覆盖 > preset > 全局默认 |

### 2.3 BUILTIN EXTENSION 强制注入（infrastructure 级不可 exclude）

> **[产品决策，已确认；机制已随 builtin→npm 迁移演进（2026-08）]** 设计期为「3 个 builtin 文件型 extension（`xyz-agent-extension.js` / `xyz-system-prompt-extension.js` / `xyz-client-msg-id-mapper.js`）永远注入，不受任何 `extensionMode` 影响」。现行形态：builtin 扩展 = `@zhushanwen/pi-*` npm 包（清单 SSOT = `packages/shared/src/mandatory-extensions.json`，tier 两级），「永远注入」语义收窄到 **infrastructure 级**——feature 级 builtin 与用户扩展同受 preset 筛选与禁用。

**现行理由（按原文件型三件套的继承者）**：
- `@zhushanwen/pi-system-prompt`（infrastructure）实现「系统提示词追加注入 + 全局 AGENTS.md 注入」，屏蔽它整个系统提示词机制失效
- `@zhushanwen/pi-agent-ext`（infrastructure）提供 session 树导航与 `/__xyz_reload__` 内部命令
- `@zhushanwen/pi-msg-id-mapper`（infrastructure）处理 msg id 映射，屏蔽会导致前端消息路由错乱

**现行实现**（设计期的 `getBuiltinExtensionPaths()` + 手工前置注入链路已删，builtin 与用户扩展统一走同一发现/过滤管线）：

```typescript
// preset-service.resolveExtensionPaths（现行，packages/runtime/src/services/preset-service.ts）
const { discovered, disabledSet } = await this.extensionService.getDiscoveredAndDisabled(cwd)
const resolved = resolveExtensions(discovered, disabledSet)   // tier 推导：mandatory SSOT 命中 → infrastructure/feature
const deduped = dedupeLoadedExtensions(resolved)              // P7 同名去重
const afterPreset = applyPresetMode(deduped, mode, allowed, denied)
// extension-filter.applyPresetMode：presetOverridable = !(mandatory && infrastructure)
//   —— infrastructure 级任何模式下都存活（none 模式也保留）；feature 级 / 用户扩展按 mode 筛选
return afterPreset.filter(r => r.loadable).map(r => r.path)
```

打包内置：builtin 包由 `scripts/bundle-extensions.mjs`（esbuild）staging 到 `apps/electron/resources/extensions/@zhushanwen/<pkg>/` 随应用分发，不走用户 npm 安装。

### 2.4 Extension 黑白名单的真实实现

> **[修正]** pi 无原生 extension 黑名单。原设计文档的「denylist → `--no-extensions --extension <allowed-paths>`」描述错误——`--no-extensions --extension X` 的实际效果是**白名单**（只加载 X），不是黑名单。

**所有模式统一走「runtime 端过滤 + 白名单注入」**：

| extensionMode | runtime 行为 | 最终 pi args |
|---|---|---|
| `all` | 加载所有 enabled 的可筛选 extension | `--no-extensions --extension <infra-builtin...> --extension <all-others...>` |
| `allowlist` | 只加载 allowedExtensions 命中的 | `--no-extensions --extension <infra-builtin...> --extension <allowed...>` |
| `denylist` | 加载除 deniedExtensions 之外的所有 enabled | `--no-extensions --extension <infra-builtin...> --extension <non-denied...>` |
| `none` | 不加载任何可筛选 extension | `--no-extensions --extension <infra-builtin...>` |

`--no-extensions` 一直传（与现有 rpc-client.ts:128 硬编码一致），所有 extension 走 `--extension` 显式注入。

### 2.5 工具黑白名单的映射（替换 vs 叠加）

> **[修正]** pi 的 `--tools` 是**替换语义**（只启用列出的工具），`--extension` 是**追加语义**。两者不能复用同一套映射逻辑。

| toolMode | runtime 行为 | pi args |
|---|---|---|
| `all` | 不传工具相关 flag，用 pi 默认（4 个：read/bash/edit/write） | （无） |
| `allowlist` | 只启用 allowedTools 列出的 | `--tools <allowedTools>` |
| `denylist` | 启用默认 4 个再排除 deniedTools | `--exclude-tools <deniedTools>` |
| `none` | 禁用所有工具 | `--no-tools` |

**注意 `all` 模式不传 `--tools`**——因为 pi 默认就启用 read/bash/edit/write（不是全部 7 个）。若要启用 grep/find/ls，必须用 allowlist 显式列出。

### 2.6 与现有 systemPrompt 的关系

现有 `getReplaceSystemPrompt()` 读 `~/.xyz-agent/system-prompt.json`，提供「替换 pi 核心系统提示词」功能。

**preset 不引入新 systemPrompt 字段**（避免与现有机制冲突）。preset 仅控制是否禁用 context files：

| preset.noContextFiles | systemPrompt 来源 | pi args |
|---|---|---|
| `false` / 未设 | 现有 `getReplaceSystemPrompt()` | `--system-prompt <value>` |
| `true` | 现有 `getReplaceSystemPrompt()` | `--system-prompt <value> --no-context-files` |

`--no-context-files` 禁用 AGENTS.md / CLAUDE.md 自动发现（不影响显式 `--system-prompt`）。

---

## 3. Settings 页面设计

### 3.1 位置

Settings → 新增 Tab「Pi 参数」（或在「系统」Tab 下新增 Section）

### 3.2 布局

```
┌─────────────────────────────────────────────────────────────┐
│  Pi 启动参数预设                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ [全工具模式]  [Orchestrator]  [只读模式]  [+ 新建]    │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ 预设名称: [全工具模式        ]                         │ │
│  │ 描述:     [所有工具可用，适合大部分任务]               │ │
│  │                                                       │ │
│  │ 工具模式: ○ 全部工具  ○ 白名单  ○ 黑名单  ○ 无工具   │ │
│  │                                                       │ │
│  │ 黑名单工具:                                           │ │
│  │ ┌─────────────────────────────────────────────────┐   │ │
│  │ │ ✓ read    ✓ bash    ✓ edit    ✓ write          │   │ │
│  │ │ ☐ grep    ☐ find    ☐ ls                       │   │ │
│  │ └─────────────────────────────────────────────────┘   │ │
│  │                                                       │ │
│  │ 模型覆盖: [使用全局默认 ▾]                            │ │
│  │ 思考等级: [使用全局默认 ▾]                            │ │
│  │                                                       │ │
│  │ 高级选项:                                             │ │
│  │ ☐ 禁用所有扩展                                        │ │
│  │ ☐ 禁用所有 Skill                                      │ │
│  │ ☐ 禁用 Context Files（AGENTS.md/CLAUDE.md）          │ │
│  │                                                       │ │
│  │ ⓘ 3 个内置扩展（系统提示词等）始终加载，不可禁用      │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  [删除预设]                              [保存更改]         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**新增提示行**（图中最后一行 ⓘ）：明确告知用户「3 个内置扩展始终加载，不可禁用」，避免用户设置 extensionMode=none 后误以为所有扩展都禁用了。

### 3.3 工具和 Extension 的数据来源

**内置工具列表**（pi 硬编码 7 个）：
```typescript
const BUILTIN_TOOLS = ['read', 'write', 'bash', 'edit', 'grep', 'find', 'ls'] as const
```

**默认启用 vs 默认禁用**（来自 pi 源码 sdk.ts:244）：
- 默认启用 4 个：`read` / `bash` / `edit` / `write`
- 默认禁用 3 个：`grep` / `find` / `ls`（只读工具，需显式 `--tools` 启用）

Settings UI 在工具 Checkbox 列表旁标注默认状态（"默认启用"/"默认禁用"），帮助用户理解 `all` 模式的实际效果。

**Extension 列表**（动态发现）：
- `ExtensionService.scanExtensions()` 返回所有可用 extension（**含** builtin npm 扩展，layer=builtin——feature 级 builtin 与用户扩展同样出现在列表，infrastructure 级不可禁用，见 §2.3）
- 每条展示 `name + description + 是否已启用`
- 用户勾选/取消勾选控制 allowlist/denylist 成员

**Extension 提供的工具**（数据缺口，见 §6.2）：
- 当前 `ExtensionInfo.tools` 字段在 runtime 扫描时**未填充**（注释说"可选：runtime 扫描到时填"，实际未实现）
- MVP 阶段：Settings UI 只展示 extension 维度的勾选，不展开 extension 内的工具
- 后续阶段：runtime 扫描时解析 extension 注册的 tool，填充 `ExtensionInfo.tools`，UI 可分组展示「该 extension 提供的工具」

### 3.4 内置预设的可编辑边界

> 内置预设「不可删除但可自定义」需要明确边界，否则用户把「全工具模式」改成只剩 read，预设名字与内容语义冲突。

| 字段 | 内置预设可改 | 自定义预设可改 |
|---|---|---|
| `name` | ❌ 不可改（避免语义错位） | ✅ |
| `description` | ✅ 可改（仅显示文案） | ✅ |
| `toolMode` / `allowedTools` / `deniedTools` | ✅ 可改（如把「全工具」改成 `denylist`） | ✅ |
| `extensionMode` 等其他配置 | ✅ 可改 | ✅ |
| `id` / `builtin` / `order` | ❌ 不可改 | ❌ |

**「恢复默认」按钮**：内置预设编辑页提供「恢复默认」按钮，一键还原为 `DEFAULT_PRESETS` 中的初始值。自定义预设无此按钮。

---

## 4. 持久化与 Session 锁定

> **[修正]** 原设计说「launchPresetId 写入 `.meta.json` sidecar」——错误。`.meta.json` 是 session **终态 sidecar**（session 结束时才写，仅 4 字段：type/outcome/reason/timestamp），session 活跃期间不存在此文件。

### 4.1 持久化机制：独立 preset sidecar

**新增文件**：`<sessionFile>.preset.json`，与 `.meta.json` 并列。

**写入时机**：session-lifecycle.ts `create()` 成功 spawn pi 后立即写（不等 session 结束）。

```typescript
// packages/runtime/src/services/session/session-file-utils.ts 新增
/**
 * 写 preset sidecar。session 创建后立即调用（在 launchPresetId 确定之后）。
 * session 结束、删除时此文件与 .meta.json 一起清理。
 *
 * 注意：pi 延迟写入窗口下 sessionFile 可能不存在（首条 assistant 前），但 preset
 * sidecar 写的是 `<sessionFile>.preset.json`（与 sessionFile 同目录），写它不触碰
 * sessionFile 本身，不与 pi 的 _persist 冲突（规则 #6）。
 */
export function persistPresetBinding(sessionFilePath: string, presetId: string): void {
  if (!sessionFilePath) return  // 活跃 session 未落盘时 no-op，由 restoreSession 时补写
  atomicWrite(sessionFilePath + '.preset.json', JSON.stringify({ presetId, version: 1 }), ...)
}
```

**读取时机**：
- `restoreSession()` 启动时读此 sidecar，确定用哪个 preset 重新构建 args
- `SessionScanner.scannedToSummary` 扫描时一并读取，填入 `SessionSummary.launchPresetId`

### 4.2 session 活跃期间 launchPresetId 的持有

session 活跃期间，`IManagedSessionView` 内存态持有 `launchPresetId`：
- `create(presetId)` 时传入并写入 `IManagedSessionView`
- `toSummary()` 时一并输出到 `SessionSummary`
- app 崩溃重启后，活跃 session 变 dead/idle，从 sidecar 重建

### 4.3 Session 锁定逻辑

```
新建 Session → 选择 preset → 写入 .preset.json sidecar → 锁定
                                  ↓
恢复 Session → 读 sidecar → 用锁定 preset 重建 args → 只读显示（前端 Chip 不可改）
```

**「锁定」的两层含义**（实现复杂度差一个数量级，必须明确）：

1. **Runtime 层锁定**（必做）：restoreSession 时强制使用 sidecar 记录的 preset 重新构建 args（重新 spawn pi 时应用相同的工具/扩展配置）。即使全局默认 preset 改了，恢复历史 session 仍用创建时的 preset。
2. **前端 UI 锁定**（必做）：已创建 session 的 PresetSelectChip 显示锁图标，不展开 Popover，tooltip 显示「此 Session 使用 {预设名} 模式创建，不可更改」。

**forkSession 的特殊处理**（见 §4.5）。

### 4.4 删除 session 时的清理

`session-lifecycle.delete()` 当前已清理 `.meta.json`（session-lifecycle.ts:180/189）。新增：同时清理 `.preset.json`。

```typescript
// session-lifecycle.ts:180 附近
try { unlinkSync(session.sessionFilePath + '.meta.json') } catch { void 0 }
try { unlinkSync(session.sessionFilePath + '.preset.json') } catch { void 0 } // 新增
```

### 4.5 forkSession 的 preset 继承语义

> **[新增]** forkSession（session-lifecycle.ts:283）当前也走 `getExtensionPaths` / `getSkillPaths`。preset 机制必须定义 fork 行为。

**决策：fork 出的新 session 继承源 session 的 preset，不可重选。**

理由：
- fork 语义是「从某 entry 分叉继续」，新 session 与源 session 的运行环境（工具/扩展）应一致
- 如果 fork 允许重选 preset，用户可能在「只读 fork」里执行 write 操作，与 fork 点的上下文冲突

**实现**：

```typescript
// session-lifecycle.ts forkSession
async forkSession(srcSessionId, fromPiEntryId, includeFrom, label): Promise<SessionSummary> {
  // ... 现有逻辑 ...

  // 读取源 session 的 preset（从 sidecar 或内存态）
  const sourcePresetId = await this.readPresetBinding(source.filePath) ?? 'builtin:full'
  const preset = this.presetService.getPreset(sourcePresetId)

  // 用源 preset 构建 args（覆盖默认 getExtensionPaths）
  const extPaths = await this.presetService.resolveExtensionPaths(sessionCwd, preset)
  const client = await this.pm.createSession(forkedId, sessionCwd, {
    skillPaths: this.presetService.resolveSkillPaths(sessionCwd, preset),
    extensionPaths: extPaths,
    systemPrompt: this.svc.getReplaceSystemPrompt(),
    tools: this.presetService.resolveToolArgs(preset),       // 新增
    excludeTools: this.presetService.resolveExcludeToolArgs(preset), // 新增
    noTools: preset.toolMode === 'none',                     // 新增
    noExtensions: false, // extension 全走 --extension 注入，不依赖此 flag
    noSkills: preset.noSkills ?? false,                      // 新增
    noContextFiles: preset.noContextFiles ?? false,          // 新增
    model: preset.modelOverride,                             // 新增（Landing 未传时）
    thinkingLevel: preset.thinkingLevel,                     // 新增（Landing 未传时）
  })

  // 写入新 session 的 preset sidecar（继承源 preset）
  persistPresetBinding(forkedFilePath, sourcePresetId)

  // ... 现有 switchSession 逻辑 ...
}
```

---

## 5. 交互与 UI 规则

### 5.1 Landing 页设计

**位置**：Landing 页 Composer 下方，与 Model/Thinking Level Chip 并列

**布局**：

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  输入消息...                                         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  [📁 ~/Code/xyz-agent]  [⚡ Claude 4]  [🧠 High]  [🔧 全工具模式 ▾]  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 选择启动预设:                                        │   │
│  │                                                       │   │
│  │  ● 全工具模式                                        │   │
│  │    所有工具可用，适合大部分任务                       │   │
│  │                                                       │   │
│  │  ○ Orchestrator                                      │   │
│  │    主 Agent 只做协调，SubAgent 执行                   │   │
│  │                                                       │   │
│  │  ○ 只读模式                                          │   │
│  │    只能查看代码，适合 Review                          │   │
│  │                                                       │   │
│  │  ────────────────────────────────────────────────    │   │
│  │  ✓ 设为默认                                          │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**交互细节**：
1. **Chip 显示**：当前选中预设的名称 + 图标
2. **点击展开**：Popover 显示所有预设列表
3. **选择预设**：点击 Radio 选中，显示预设描述
4. **设为默认**：Checkbox 勾选后写入 `pi-presets.json` 的 `defaultPresetId`
5. **提交后**：Session 创建时传入 `launchPresetId`，Chip 变为只读显示

### 5.2 Landing Chip 与 preset override 的优先级

> **[新增]** Landing 已有 Model chip / Thinking Level chip，preset 也有 modelOverride / thinkingLevel 字段，必须定义冲突时的优先级。

**优先级规则（高 → 低）**：

1. **Landing Model/Thinking Chip**（用户当前选择，最高优先级）
2. **preset.modelOverride / preset.thinkingLevel**（预设配置）
3. **全局默认**（settingsStore.defaultModel）

**实现**：
- 用户在 Landing 选 Model chip 时，该选择覆盖 preset 的 modelOverride
- 用户没选 Model chip（使用全局默认）时，preset 的 modelOverride 生效
- preset.modelOverride 未设时，用全局默认

**UI 提示**：当 preset 有 modelOverride 但被 Landing Chip 覆盖时，Model chip 旁可显示小图标提示「预设指定了 {modelOverride}，当前选择覆盖之」。MVP 可不实现此提示。

### 5.3 default preset 作用域

> **[新增]** 「设为默认」的 default 是 global 还是 per-cwd？

**决策：global（全局生效）**

理由：
- per-cwd 增加复杂度（要在 `pi-presets.json` 维护 cwd → presetId 映射，cwd 变化时 fallback）
- 大多数用户的实际需求是「我主要做 orchestrator 协调工作」这种全局偏好
- per-cwd 可作为 Phase 2 增强（如果用户反馈需要）

**存储**：`pi-presets.json` 的 `defaultPresetId` 字段，全局唯一。

### 5.4 已创建 Session 的 Chip 只读态

- **已创建的 Session**：Chip 显示创建时的预设名称，带 🔒 图标
- **Tooltip**：「此 Session 使用 {预设名} 模式创建，不可更改」
- **点击**：只读，不展开 Popover
- **历史 session 兼容**：无 `.preset.json` sidecar 的历史 session（设计上线前创建的），按 `builtin:full` 兜底，Chip 显示「全工具模式 🔒」但 tooltip 加注「（历史 session，未记录预设）」

---

## 6. 实现细节缺口

### 6.1 ExtensionInfo.tools 字段填充方案

> **[已知缺口]** 当前 `ExtensionInfo.tools` 字段未填充。MVP 不依赖此字段。

**当前现状**：
- `shared/src/extension.ts:34-36` 定义了 `tools?: string[]`
- `ExtensionService.scanExtensions()` 扫描时**没有**解析 extension 注册的 tool，字段始终 undefined

**MVP 阶段**：
- Settings UI 只展示 extension 维度勾选，不展开 extension 内工具
- preset 的 allowedExtensions / deniedExtensions 用 extension.name 匹配，不深入到工具粒度

**Phase 2 填充方案**（不在 MVP 范围）：
- runtime 扫描时 require/parse extension 文件，提取 tool 注册信息
- 或约定 extension 在 package.json 声明 `pi.tools: ["tool1", "tool2"]`
- 填充后 Settings UI 可分组展示

### 6.2 测试矩阵

> 原设计测试清单只列了「参数透传」，缺少关键 case。

**Runtime 测试**（vitest）：

| 测试 case | 验证点 |
|---|---|
| preset.toolMode=all | args 不含 `--tools` / `--exclude-tools` / `--no-tools` |
| preset.toolMode=allowlist | args 含 `--tools read,grep,find,ls`（替换语义） |
| preset.toolMode=denylist | args 含 `--exclude-tools read,write`（叠加在默认之上） |
| preset.toolMode=none | args 含 `--no-tools` |
| preset.extensionMode=all | args 含所有 enabled 用户 extension 的 `--extension` |
| preset.extensionMode=allowlist | args 只含 allowedExtensions 的 `--extension` |
| preset.extensionMode=denylist | args 含除 deniedExtensions 之外所有 enabled 的 `--extension` |
| preset.extensionMode=none | args 只含 infrastructure 级 builtin 的 `--extension`（**可筛选 extension 全部排除**） |
| **infrastructure builtin 永远注入** | extensionMode=none 时 args 仍含 infrastructure 级 builtin path |
| preset.noSkills=true | args 含 `--no-skills`，skillPaths 为空 |
| preset.noContextFiles=true | args 含 `--no-context-files` |
| create() 写 preset sidecar | create 成功后 `<sessionFile>.preset.json` 存在 |
| restoreSession 读 preset sidecar | 恢复时用 sidecar 的 preset 重建 args |
| forkSession 继承源 preset | fork 出的新 session preset sidecar = 源 session 的 |
| delete 清理 preset sidecar | delete 后 `<sessionFile>.preset.json` 不存在 |
| 历史session 兼容 | 无 sidecar 时按 `builtin:full` 兜底 |

**Renderer 测试**（vitest + @vue/test-utils）：

| 测试 case | 验证点 |
|---|---|
| PresetSelectChip 默认显示 default preset | Chip 显示 defaultPresetId 对应名称 |
| Popover 列出所有 preset | 内置 3 + 自定义 N |
| 已创建 session Chip 只读 | find chip 不展开 Popover，显示 🔒 |
| Landing Model Chip 覆盖 preset.modelOverride | 提交时 model = Landing 选择 |
| preset.modelOverride 覆盖全局默认 | 未选 Landing Chip 时 model = preset.modelOverride |

---

## 7. 数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                         用户操作流程                                 │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  Landing 页      │
                    │  选择 preset     │  ← defaultPresetId 预选
                    │  (+Model/Think)  │  ← Chip 优先级见 §5.2
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  Composer 提交   │
                    │  (带 presetId +  │
                    │   Model/Think)  │
                    └────────┬────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Runtime 层                                  │
├─────────────────────────────────────────────────────────────────────┤
│  session.create(presetId, modelOverride?, thinkingOverride?)        │
│       │                                                             │
│       ├─► PresetService.resolve(preset, cwd)                        │
│       │   ├─ toolMode → --tools / --exclude-tools / --no-tools      │
│       │   ├─ extensionMode → runtime 过滤用户 extension             │
│       │   │   + builtin extension 永远注入（§2.3）                   │
│       │   ├─ noSkills → 清空 skillPaths + --no-skills               │
│       │   ├─ noContextFiles → --no-context-files                    │
│       │   └─ modelOverride/thinkingLevel（受 Landing Chip 覆盖）     │
│       │                                                             │
│       └─► RpcClient.start()                                         │
│           └─ spawn(pi, ['--mode', 'rpc', '--no-extensions',         │
│                        '--approve', ...presetArgs])                 │
│       │                                                             │
│       ├─► persistPresetBinding(sessionFile, presetId)               │
│       │   写 <sessionFile>.preset.json sidecar                       │
│       │                                                             │
│       └─► IManagedSessionView.launchPresetId = presetId              │
└─────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  Session 创建    │
                    │  (锁定 preset)   │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  restoreSession │
                    │  读 .preset.json│
                    │  用锁定 preset  │
                    │  重建 args      │
                    └─────────────────┘
```

---

## 8. API 设计

### 8.1 Runtime API

```typescript
// packages/runtime/src/services/preset-service.ts（新增）

export class PresetService {
  /**
   * 加载所有预设：内置默认 + 用户自定义（用户对内置的编辑覆盖合并）
   */
  getAllPresets(): Promise<PiLaunchPreset[]>

  /**
   * 获取单个预设。找不到时返回 undefined（builtin:full 不会找不到）
   */
  getPreset(presetId: string): Promise<PiLaunchPreset | undefined>

  /**
   * 保存预设（新增或更新）。内置预设仅可改允许的字段（见 §3.4）
   */
  savePreset(preset: PiLaunchPreset): Promise<void>

  /**
   * 删除预设。内置预设抛错
   */
  deletePreset(presetId: string): Promise<void>

  /**
   * 获取默认预设 ID（pi-presets.json 的 defaultPresetId，缺省 'builtin:full'）
   */
  getDefaultPresetId(): Promise<string>

  /**
   * 设为默认
   */
  setDefaultPresetId(presetId: string): Promise<void>

  /**
   * 核心：根据 preset + cwd 解析为 RpcClientOptions 的扩展字段
   * 返回值会被 session-lifecycle 用于覆盖现有 getExtensionPaths/getSkillPaths 结果
   */
  resolve(preset: PiLaunchPreset, cwd: string): Promise<PresetResolution>
}

interface PresetResolution {
  /** 替换 getExtensionPaths 的结果 */
  extensionPaths: string[]
  /** 替换 getSkillPaths 的结果（noSkills=true 时为空数组） */
  skillPaths: string[]
  /** 工具相关 args，传给 RpcClientOptions */
  toolArgs: { tools?: string[]; excludeTools?: string[]; noTools?: boolean }
  /** 其他 args */
  flags: { noSkills: boolean; noContextFiles: boolean }
  /** model/thinking（受 Landing Chip 覆盖） */
  modelOverride?: string
  thinkingLevel?: string
}
```

```typescript
// packages/runtime/src/infra/pi/rpc-client.ts 扩展 RpcClientOptions

export interface RpcClientOptions {
  // ... 现有字段 ...
  /** 工具白名单（替换语义，--tools） */
  tools?: string[]
  /** 工具黑名单（叠加在默认之上，--exclude-tools） */
  excludeTools?: string[]
  /** 禁用所有工具（--no-tools） */
  noTools?: boolean
  /** 禁用所有 skill（--no-skills），同时清空 skillPaths */
  noSkills?: boolean
  /** 禁用 context files（--no-context-files） */
  noContextFiles?: boolean
  /** 覆盖思考级别（--thinking，合法值见附录 A.4） */
  thinkingLevel?: string
}
```

```typescript
// session-lifecycle.ts 三处（create / restoreSession / forkSession）改造

async create(
  cwd?: string,
  label?: string,
  options?: {
    hidden?: boolean
    presetId?: string                  // 新增
    modelOverride?: string             // 新增（Landing Model Chip 覆盖）
    thinkingOverride?: string          // 新增（Landing Thinking Chip 覆盖）
  },
): Promise<SessionSummary>
```

### 8.2 前端 API

```typescript
// packages/renderer/src/composables/usePiPresets.ts

export function usePiPresets() {
  /** 当前选中的预设 ID（仅 Landing 态有效，已创建 session 读 session.launchPresetId） */
  const selectedPresetId: Ref<string>

  /** 所有可用预设 */
  const presets: ComputedRef<PiLaunchPreset[]>

  /** 当前 Session 是否锁定（不可更改预设） */
  const isLocked: ComputedRef<boolean>

  /** 选择预设（新建 Session 时） */
  function selectPreset(id: string): void

  /** 获取默认预设 ID */
  function getDefaultPresetId(): Promise<string>

  /** 设为默认 */
  function setDefault(id: string): Promise<void>
}
```

---

## 9. 文件清单

| 文件路径 | 说明 | 阶段 |
|---------|------|------|
| `packages/shared/src/pi-preset.ts` | 数据类型定义 + DEFAULT_PRESETS | Phase 1 |
| `packages/shared/src/session.ts` | 扩展 SessionSummary.launchPresetId | Phase 1 |
| `packages/runtime/src/services/preset-service.ts` | 预设存储 + resolve 服务（**新增**） | Phase 1 |
| `packages/runtime/src/services/extension-service.ts` | 提取 `getBuiltinExtensionPaths()` 公开方法 | Phase 1 |
| `packages/runtime/src/services/session/session-lifecycle.ts` | 三处 create/restore/fork 改造 | Phase 1 |
| `packages/runtime/src/services/session/session-file-utils.ts` | 新增 `persistPresetBinding` / `readPresetBinding` | Phase 1 |
| `packages/runtime/src/services/session/session-scanner.ts` | scannedToSummary 读取 preset sidecar | Phase 1 |
| `packages/runtime/src/infra/pi/rpc-client.ts` | RpcClientOptions 扩展 + args 构建 | Phase 1 |
| `packages/renderer/src/stores/preset.ts` | 前端预设状态管理（**新增**） | Phase 1 |
| `packages/renderer/src/composables/usePiPresets.ts` | 预设选择 composable（**新增**） | Phase 1 |
| `packages/renderer/src/components/PresetSelectChip.vue` | Landing 页 Chip 组件（**新增**） | Phase 1 |
| `packages/renderer/src/pages/settings/PiPresetsPage.vue` | Settings 页面（**新增**） | Phase 1 |
| `~/.xyz-agent/pi-presets.json` | 用户预设存储文件（getDataDir 推导） | 运行时生成 |

---

## 10. 实现 Checklist

### Phase 1（MVP）
- [ ] `shared`: 添加 `PiLaunchPreset` 类型 + `DEFAULT_PRESETS`
- [ ] `shared`: 扩展 `SessionSummary` 添加 `launchPresetId`
- [ ] `runtime`: 实现 `PresetService`（读写 `pi-presets.json`，merge builtin + user）
- [ ] `runtime`: `ExtensionService` 提取 `getBuiltinExtensionPaths()` 公开方法
- [ ] `runtime`: 实现 `PresetService.resolve()`（§8.1）
- [ ] `runtime`: `session-file-utils` 新增 `persistPresetBinding` / `readPresetBinding`
- [ ] `runtime`: `session-scanner.scannedToSummary` 读取 preset sidecar
- [ ] `runtime`: 修改 `RpcClientOptions` 支持 tools/extensions/noSkills/noContextFiles/thinkingLevel
- [ ] `runtime`: 修改 `RpcClient.start()` 构建 CLI 参数（注意 --thinking 不是 --thinking-level）
- [ ] `runtime`: 修改 `session-lifecycle.create()` 接收 presetId + modelOverride + thinkingOverride
- [ ] `runtime`: 修改 `session-lifecycle.restoreSession()` 读 sidecar 重建 args
- [ ] `runtime`: 修改 `session-lifecycle.forkSession()` 继承源 preset
- [ ] `runtime`: 修改 `session-lifecycle.delete()` 清理 `.preset.json`
- [ ] `renderer`: 实现 `usePiPresets` composable + `stores/preset.ts`
- [ ] `renderer`: 实现 `PresetSelectChip.vue` 组件（含只读锁定态）
- [ ] `renderer`: 实现 Settings 预设编辑页面（含 builtin 提示行）
- [ ] 测试: Runtime 测试矩阵（§6.2，必含 builtin 永远注入 case）
- [ ] 测试: Renderer 测试矩阵（§6.2）
- [ ] 测试: 历史 session 兼容（无 sidecar 时 builtin:full 兜底）

### Phase 2（增强）
- [ ] `ExtensionInfo.tools` 字段填充（runtime 扫描时解析 extension tool 注册）
- [ ] Settings UI 展示 extension 内工具分组
- [ ] 预设导入/导出（JSON 格式）
- [ ] 预设使用统计（哪个预设最常用）
- [ ] 快速切换预设的键盘快捷键
- [ ] per-cwd default preset（按工作区设不同默认）
- [ ] 预设模板市场（社区分享）

---

## 附录 A: pi CLI 参数事实核实

> 本附录固化 2026-07-26 对 pi-mono 源码的核实结果，作为本设计的参数映射依据。源码位置：`~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/`。

### A.1 工具控制参数

| Flag | 语义 | 证据 |
|---|---|---|
| `--tools` / `-t <names>` | **白名单（替换语义）**：逗号分隔工具名 allowlist，只启用列出的 | args.ts:120-124, 257-258；sdk.ts:245-250 |
| `--exclude-tools` / `-xt <names>` | **黑名单（叠加语义）**：在启用集合之上排除列出的 | args.ts:125-129, 259-260 |
| `--no-tools` / `-nt` | 禁用所有工具（built-in + extension + custom） | args.ts:116-117, 255；main.ts:435-436 |
| `--no-builtin-tools` / `-nbt` | 只禁用 built-in 默认工具，保留 extension/custom 工具 | args.ts:118-119, 256；main.ts:437-438 |

**内置工具（共 7 个）**：`core/tools/index.ts:83-84`
```ts
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
```

**默认启用 vs 默认禁用**：`core/sdk.ts:244`
- 默认启用 4 个：`read`, `bash`, `edit`, `write`
- 默认禁用 3 个：`grep`, `find`, `ls`（off by default，args.ts:386-388 帮助文本明确标注）

**替换 vs 叠加语义的关键代码**（`core/sdk.ts:245-250`）：
```ts
const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
const initialActiveToolNames = (
  options.tools ? [...options.tools] : options.noTools ? [] : defaultActiveToolNames
).filter(name => !excludedToolNameSet?.has(name));
```

### A.2 Extension 控制参数

| Flag | 语义 | 证据 |
|---|---|---|
| `--extension` / `-e <path>` | **追加**一个 extension 文件/目录路径（可多次） | args.ts:149-151, 262 |
| `--no-extensions` / `-ne` | 禁用 extension 自动发现（`-e` 显式指定的仍加载） | args.ts:152-153, 263 |

**关键事实：`--no-extensions --extension X` 是白名单，不是黑名单。**

证据 `core/resource-loader.ts:403-405`（reload 主路径）：
```ts
const extensionPaths = this.noExtensions
  ? cliEnabledExtensions                                    // 只用 CLI 显式指定的
  : this.mergePaths(cliEnabledExtensions, enabledExtensions); // 否则 CLI + 发现的合并
```

**pi 无原生 extension 黑名单机制**。要实现 denylist 语义，调用方必须自行先列出全部 extension 再排除，作为 allowlist 注入。

### A.3 Extension 发现路径

`core/extensions/loader.ts:651-698` 的 `discoverAndLoadExtensions`：

1. **项目本地**：`cwd/.pi/extensions/`（**不带 agent/ 段**）
2. **全局用户**：`~/.pi/agent/extensions/`（agent/ 段只在此处）
3. **显式配置路径**：configuredPaths 参数

`--extension` 路径**追加**到默认发现列表（不替换）：
- `main.ts:660-668` 将 --extension 路径作为 `additionalExtensionPaths` 传入
- `resource-loader.ts:404-405` 在 noExtensions=false 时 mergePaths 合并两者

### A.4 其他相关参数

| 设计字段 | pi CLI 参数 | 合法值 | 证据 |
|---|---|---|---|
| modelOverride | `--model <pattern>` | provider/modelId 形式 | args.ts:89-90, 239 |
| thinkingLevel | `--thinking <level>` **（不是 --thinking-level）** | off, minimal, low, medium, high, xhigh | args.ts:130-139, 261, 57 |
| noSkills | `--no-skills` / `-ns` | flag | args.ts:163-164, 265 |
| noContextFiles | `--no-context-files` / `-nc` | flag（禁用 AGENTS.md/CLAUDE.md 发现） | args.ts:169-170, 270 |
| systemPrompt | `--system-prompt <text>` | text | args.ts:93-97, 241-242 |

其他可选 flag：`--no-prompt-templates` / `-np`、`--no-themes`、`--provider`、`--api-key`、`--skill <path>`。

### A.5 RPC 模式（`--mode rpc`）下的参数生效

**所有 CLI 参数在 RPC 模式下都生效，无 flag 被专门忽略。**

证据链：
1. RPC 模式判定（main.ts:101-102）：`if (parsed.mode === "rpc") return "rpc"`
2. RPC 与 interactive/print 模式**共用** `createAgentSessionRuntime` 构造路径（main.ts:712-734）
3. 在该闭包内，`resourceLoaderOptions` 包含 noExtensions/noSkills/noContextFiles 等（main.ts:659-672），`buildSessionOptions` 处理 --model/--thinking/--tools 等（main.ts:352-448），无差别应用
4. main.ts:806-808 最终把构造好的 runtime 交给 runRpcMode

**RPC 模式的额外能力**（与 CLI flag 无关）：rpc-mode.ts 暴露运行时命令如 `set_model`、`set_thinking_level`、`cycle_model` 等，可在会话中动态修改。这些是 CLI flag 之上的另一层，不替代也不屏蔽启动 flag。
