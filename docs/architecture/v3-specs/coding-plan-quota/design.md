# Coding Plan 额度查询 — 设计文档

> 本文档为「调研 + 设计」阶段产物，不含实现代码。HTML demo 见同目录 `draft.html`。

## 0. 背景与目标

用户希望：
1. 在 **Provider 设置**中，新增「Coding Plan 额度查询」配置。内置 5 个 provider 预设（智谱 / Kimi / 小米 MiMo / MiniMax / opencode.go），理论上配 API key 或浏览器 cookie 即可查询额度。
2. 在**对话工作区 composer 上方上下文区域**，hover 时展示对应 provider 的额度使用情况（已用/剩余/重置时间/多窗口）。

### 核心发现：可直接复用 statusline 的成熟共享包

调研发现，`xyz-pi-extensions-workspace/main` 下的 statusline 已经把这块做透了，并且**封装成独立 npm 包**：`@zhushanwen/pi-quota-providers`（`shared/quota-providers/src/`）。

5 个 token-plan provider 全部实现完整（endpoint、认证、字段解析、归一化、缓存、错误兜底均已写好）：

| fetcher id | label | 认证方式 | 支持窗口 |
|---|---|---|---|
| `zhipu` | zhipu-coding-plan | Authorization token（无 Bearer） | 5h（wk/mh 显示 ∞） |
| `opencode-go` | opencode-go | Cookie | 5h / wk / mh |
| `kimi-coding` | kimi-coding-plan | Bearer API key | 5h / wk（mh 显示 ∞） |
| `minimax` | minimax-token-plan | Bearer API key | 5h / wk（mh 显示 ∞） |
| `mimo` | mimo-token-plan | Cookie | month only（5h/wk 显示 ∞） |

**归一化输出**统一为 `NormalizedQuotaRow`：

```ts
interface QuotaWindow {
  pct: number | null      // 已用百分比 0-100；null = 无限/未订阅（渲染 ∞）
  resetSec: number | null // 剩余秒数；null = 无重置信息（渲染 --）
}
type QuotaWins = [QuotaWindow, QuotaWindow, QuotaWindow]  // [5h, week, month]
interface NormalizedQuotaRow {
  label: string
  wins: QuotaWins
}
```

xyz-agent 作为 Electron 桌面应用，**直接以 npm 依赖形式引入该包即可**，无需重写任何 provider 实现。

---

## 1. 调研要点

### 1.1 statusline 的实现（参考源）

| 文件 | 用途 |
|---|---|
| `shared/quota-providers/src/providers/{zhipu,kimi,minimax,mimo,opencode-go}.ts` | 5 个 provider 的 fetch + normalize 实现 |
| `shared/quota-providers/src/registry.ts` | 合并声明式配置 + 内置 fetcher，按 mtime 缓存重载 |
| `shared/quota-providers/src/cache.ts` | TTL 缓存（2min）+ Promise.allSettled 并发拉取 + 原子磁盘写入 |
| `shared/quota-providers/src/config.ts` | `providers.json` 加载器（声明 token-plans / search-tools 列表） |
| `shared/quota-providers/src/secrets.ts` | `${ENV_VAR}` 占位符解析 |
| `shared/quota-providers/src/paths.ts` | 路径基于 `getAgentDir()`（pi 用 `~/.pi/agent/`）派生 |

**关键设计点**：
- `Promise.allSettled` 模式：单 provider 失败不影响其他；失败保留旧缓存值不覆盖为 null
- 凭证缺失直接 `return null`，不发请求
- 所有 fetch 包 `AbortSignal.timeout(5000)`（opencode-go 8000ms）
- 归一化统一为「已用百分比」+「剩余秒」（minimax 原始给的是剩余，normalize 反转为已用；mimo 给的是 0~1 小数，normalize ×100）

### 1.2 xyz-agent 当前 Provider 模型

| 项 | 当前状态 | 与本需求关系 |
|---|---|---|
| `ProviderInfo` 类型 | id/name/api/baseUrl/apiKeySet(boolean)/headers/authHeader/status/models[]/enabled | **无 quota 相关字段**；apiKeySet 是布尔态，明文 key 仅 runtime 侧持有 |
| 内置 provider 预设 | **无**。只有 2 个 API 类型常量（anthropic-messages / openai-completions） | 需新增「内置预设表」 |
| `ProviderInfo` 内置/自定义区分字段 | **无**。所有 provider 平等存储 | 若要区分「内置预设」与「用户自定义」，需加 `source: 'builtin' \| 'custom'` |
| 当前模型在 composer 上的展示 | `ModelSelectPopover.vue` trigger 已显示当前 model 名（不显示 provider 名），click 弹切换列表 | 已有 click 行为，需在外层包 HoverCard 加 hover 浮层 |
| 上下文区域 chip 模式 | 分散在 `composer-box` 内：Fork chip / meta-row slot / ContextChipsBar / 工具条（Capacity / Model / Thinking / Send） | hover 浮层挂在工具条最自然 |
| 现有 hover 范例 | `ContextCapacityPopover.vue`（HoverCard + 进度条分档配色 + 2×2 stats grid） | **直接复用视觉模式**，配色/字号/布局/动画完全对齐 |
| 设计 tokens | 暗色冷蓝优先（`--bg #1a1b1f` / `--accent #4f8ef7`），浮层用 `--bg-elevated #313239 + --border-strong + --shadow-2` | demo 严格按 tokens |

### 1.3 数据流缺口（关键障碍）

当前 `ProviderInfo` / `ModelInfo` / WS protocol **均无额度字段**。`context.update` 只推 token 用量（inputTokens/contextLimit/usagePercent），不推 provider 配额。

若要让 composer hover 浮层显示额度，需要打通三层数据通路：
1. **runtime 层**：引入 quota provider 共享包，周期性拉取并缓存额度
2. **协议层**：定义额度查询 RPC（前端主动拉）+ 可选广播事件（额度刷新通知）
3. **前端层**：store 持有额度状态，composer hover 浮层订阅

---

## 2. 设计方案

### 2.1 方案对比

> 用户已确认：**做成 plugin 包**（方案 D）。下表方案 A/B/C 保留作为对比和短期 fallback 参考。

#### 方案 D：Plugin 包（**长期方案，推荐，用户已选**）

**思路**：把额度查询封装成独立的 xyz-agent plugin（如 `@xyz-agent/quota-provider`），挂到现有 Plugin System 上。plugin 内部依赖 `@zhushanwen/pi-quota-providers` 共享包做实际查询，对外暴露 quota 数据查询能力。

| 维度 | 评价 |
|---|---|
| 架构正确性 | ✅ 最佳。额度查询是「可插拔能力」而非「核心能力」——某个 provider 的 endpoint 变了、加新 provider、甚至整个额度查询功能下线，都不应该影响 runtime 核心逻辑。plugin 化让能力边界清晰 |
| 隔离性 | ✅ Worker Thread 隔离。某个 provider 查询崩溃（如 SSR HTML 解析异常）不会影响其他 provider 或 runtime 主进程。现状 `Promise.allSettled` 只是「不 reject」，崩溃（throw）仍会冒泡 |
| 可扩展性 | ✅ 第三方可开发新 provider plugin（如私有部署的 coding-plan），无需改 xyz-agent 主仓库。符合「plugin 是唯一适配层」的架构约束 #11 |
| 独立升级 | ✅ plugin 版本独立，provider endpoint 变化发新 plugin 版本即可，不需 xyz-agent 发版 |
| 复用度 | 内部仍依赖 `@zhushanwen/pi-quota-providers` 共享包做实际查询，5 个 provider 实现零成本复用 |
| 工程量 | ⚠️ 较大。需扩展 plugin 协议（当前只支持 hook + tool，不支持「周期性后台任务」+「主动事件推送」），是本方案的主要工作量 |
| 推荐安装 | 可加入 Settings → Extensions 的推荐列表（参考 §11 builtin pi-extensions 机制），用户一键安装 |

**长期性**：架构正确归位（额度查询作为可插拔能力），未来扩展（第三方 provider、不同刷新策略、多账号）不需要改 runtime 核心。三个月后回来看这段代码不会想骂人。

**需要的 plugin 协议扩展**（当前 Plugin System 不支持的部分）：
1. **后台周期任务**：当前 plugin 只能被动响应 hook / tool 调用，不能主动启动定时器。需新增 `lifecycle.activate` 时 plugin 可注册 interval 任务的能力
2. **主动事件推送**：当前 plugin → 前端通信只有 tool RPC 响应（同步），没有「plugin 主动通知前端」的通道。需新增 `plugin.emit(channel, payload)` 让 plugin 主动推额度更新事件到前端
3. **数据目录隔离**：plugin 的凭证文件需存到 `<dataDir>/plugins/<plugin-id>/secrets/`（遵守架构约定 #1 + #2 动态路径），plugin API 需提供 `getDataDir()` 注入

**plugin 内部结构草案**：

```
@xyz-agent/quota-provider/
├── package.json              # 依赖 @zhushanwen/pi-quota-providers
├── plugin.json               # plugin 元数据 + capabilities 声明
└── src/
    ├── index.ts              # activate/deactivate 生命周期
    ├── scheduler.ts          # 周期拉取（复用共享包 cache TTL）
    ├── credential-store.ts   # 凭证读写（plugin dataDir 隔离）
    ├── tool-handlers.ts      # 暴露 quota.list / quota.refresh tool RPC
    └── event-emitter.ts      # 主动推送额度更新事件
```

#### 方案 A：共享包 + runtime 直接集成（**短期方案，快速落地**）

**思路**：xyz-agent runtime 以 npm 依赖引入 `@zhushanwen/pi-quota-providers`，在 `packages/runtime/src/services/` 下新增 `QuotaService` 周期拉取并缓存，前端经 RPC 订阅。

| 维度 | 评价 |
|---|---|
| 复用度 | 5 个 provider 实现零成本复用，新增 provider 改共享包即可 |
| 落地速度 | ✅ 最快。无需扩展 plugin 协议，直接在 runtime 加一个 service 即可 |
| 架构正确性 | ⚠️ 中等。额度查询混入 runtime 核心，但它其实是「可插拔能力」。短期可接受，长期应迁移到方案 D |
| 隔离性 | ⚠️ 弱。某 provider 查询 throw 会影响 runtime（虽然 allSettled 兜底 reject，但解析异常可能冒泡） |
| 维护成本 | 共享包升级，xyz-agent 跟版本即可；凭证存 xyz-agent 自己的数据目录 |
| 数据隔离 | 凭证存 `~/.xyz-agent/`（遵守架构约定 #1，与 pi 数据目录完全隔离），不读 `~/.pi/agent/secrets/` |
| 风险 | 共享包当前写死 pi 的路径（`~/.pi/.zhipu_auth_token` 等），需给共享包加「数据目录注入」参数 |

**短期性**：快速验证产品形态（demo → MVP → 用户反馈），验证通过后再投入方案 D 的 plugin 协议扩展工程量。**建议作为方案 D 的前置步骤**：先用方案 A 跑通端到端流程，确认产品形态无误，再做 plugin 化迁移。

#### 方案 B：runtime 内独立实现 5 个 provider（不推荐）

**思路**：把共享包的 5 个 provider 实现复制/重写到 `packages/runtime/src/services/quota-service.ts`，凭证读 xyz-agent 自己的路径。

| 维度 | 评价 |
|---|---|
| 复用度 | 零复用，5 个 provider 重新写一遍（约 800 行） |
| 维护成本 | 共享包修了 bug，两边都要改；statusline 修了 endpoint 变化，这边不知道 |
| 数据隔离 | 天然隔离（读自己的路径） |
| 风险 | 复制粘贴 5 个 provider 的实现细节（normalize 反转、cookie 过期判定、SSR HTML 正则解析等）极易出错 |

**短期性**：绕过「共享包需要适配数据目录注入」的工程量，但留下双份维护债务。仅在共享包无法短期适配时作为过渡。

#### 方案 C：调用 pi 子进程跑 statusline（不推荐）

**思路**：让 pi 子进程加载 statusline extension，xyz-agent 经 RPC 读 pi 的缓存文件。

| 维度 | 评价 |
|---|---|
| 复用度 | 100% 复用 pi 已有实现 |
| 架构正确性 | ❌ 违反架构约定 #1（xyz-agent 数据目录与 pi 完全隔离）。凭证必须存 pi 的目录，xyz-agent 写 pi 目录 = 跨边界污染 |
| 耦合度 | xyz-agent 的额度查询依赖 pi 是否安装 statusline extension，pi 没装则功能失效 |
| 用户体验 | 凭证要在两个地方配（xyz-agent settings 写一次，pi secrets 又得有一份），违反 SSOT |

**结论**：方案 C 违反既有架构约定，排除。

### 2.2 推荐路径：方案 A（短期）→ 方案 D（长期）

| 阶段 | 方案 | 目的 |
|---|---|---|
| **Phase 1（MVP）** | 方案 A | 快速跑通端到端流程，验证产品形态（demo → 用户反馈）。runtime 加 QuotaService，最小工程量 |
| **Phase 2（plugin 化）** | 方案 D | 产品形态验证通过后，扩展 plugin 协议（后台任务 + 事件推送），迁移为独立 plugin 包 |

**为什么不直接做方案 D**：方案 D 需要先扩展 Plugin System 协议（后台周期任务 + 主动事件推送两个新能力），这是对核心架构的改动，工程量大且风险高。先用方案 A 验证「额度查询这个功能用户是否真的需要、UI 形态是否合适」，确认后再投入 plugin 化的工程量，避免「投入大量精力做完 plugin 协议扩展，结果发现产品形态不对」的浪费。

**方案 A 与方案 D 的迁移成本**：UI 层（Settings + Composer hover）和数据协议（`NormalizedQuotaRow`）两层完全复用，迁移只发生在 runtime 内部（QuotaService → plugin）。设计时确保这两层与具体实现解耦，迁移成本可控。

### 2.3 方案 A 详细设计（短期 MVP）

#### 2.2.1 内置 Provider 预设表

新增 `packages/shared/src/quota-presets.ts`（SSOT）：

```ts
export interface QuotaPreset {
  /** 匹配 @zhushanwen/pi-quota-providers 的 fetcher id */
  fetcher: 'zhipu' | 'opencode-go' | 'kimi-coding' | 'minimax' | 'mimo'
  /** 显示名（i18n key 或明文） */
  label: string
  /** 认证方式：决定 UI 表单渲染哪种凭证输入 */
  auth: 'api-key' | 'cookie'
  /** provider 匹配规则：用于自动关联「这个 ProviderInfo 是否启用额度查询」 */
  match: {
    /** 按 baseUrl 域名匹配，如 'bigmodel.cn' */
    baseUrlPattern?: string
    /** 按 provider name 关键字匹配（不区分大小写） */
    namePattern?: string
  }
  /** 帮助文案：教用户去哪拿 API key / cookie */
  helpUrl?: string
  /** 帮助说明（i18n key 或明文） */
  helpText?: string
}

export const QUOTA_PRESETS: QuotaPreset[] = [
  {
    fetcher: 'zhipu',
    label: '智谱 GLM Coding Plan',
    auth: 'api-key',
    match: { baseUrlPattern: 'bigmodel.cn', namePattern: 'zhipu|glm|zai' },
    helpUrl: 'https://bigmodel.cn/usercenter/glm-coding/usage',
    helpText: '在 bigmodel.cn 控制台 → API Keys 页面获取',
  },
  {
    fetcher: 'kimi-coding',
    label: 'Kimi Coding Plan',
    auth: 'api-key',
    match: { baseUrlPattern: 'kimi.com', namePattern: 'kimi' },
    helpUrl: 'https://platform.moonshot.cn/',
    helpText: '在 Kimi 开放平台 → API Key 管理页面获取',
  },
  {
    fetcher: 'minimax',
    label: 'MiniMax Coding Plan',
    auth: 'api-key',
    match: { baseUrlPattern: 'minimaxi.com', namePattern: 'minimax' },
    helpUrl: 'https://platform.minimaxi.com/',
    helpText: '在 MiniMax 开放平台 → 账户管理获取',
  },
  {
    fetcher: 'mimo',
    label: '小米 MiMo Coding Plan',
    auth: 'cookie',
    match: { baseUrlPattern: 'xiaomimimo.com', namePattern: 'mimo' },
    helpUrl: 'https://platform.xiaomimimo.com/',
    helpText: '登录 platform.xiaomimimo.com 后，从浏览器 DevTools → Application → Cookies 复制完整 cookie 字符串',
  },
  {
    fetcher: 'opencode-go',
    label: 'opencode.go',
    auth: 'cookie',
    match: { namePattern: 'opencode' },
    helpUrl: 'https://opencode.ai/',
    helpText: '登录 opencode.ai 后，从浏览器 DevTools → Application → Cookies 复制完整 cookie 字符串',
  },
]
```

**自动关联逻辑**：用户在 Provider 设置里填好 baseUrl + apiKey 后，前端按 `match` 规则匹配 `QUOTA_PRESETS`，命中则自动建议「启用 Coding Plan 额度查询」。

#### 2.2.2 Provider 配置扩展（数据模型）

在 `packages/shared/src/provider.ts` 的 `ProviderInfo` 上新增可选字段（不破坏现有数据）：

```ts
export interface ProviderInfo {
  // ... 现有字段
  /** Coding Plan 额度查询配置（可选；未配置 = 不查额度） */
  quota?: {
    /** 使用的 fetcher（匹配 QUOTA_PRESETS.fetcher） */
    fetcher: string
    /** 是否启用 */
    enabled: boolean
    /**
     * 凭证是否已配置（布尔态，与 apiKeySet 同模式——明文不入前端）。
     * api-key 类：复用 ProviderInfo.apiKeySet（已有字段，无需新增）
     * cookie 类：本字段标记 cookie 是否已写入 runtime
     */
    cookieSet?: boolean
  }
}
```

**为什么不直接存 cookie 明文**：与 `apiKeySet` 同模式——明文凭证只在 runtime 持有，前端只显示「已配置/未配置」布尔态。runtime 侧把 cookie 存到 `~/.xyz-agent/secrets/<providerId>-cookie.txt`（动态路径，遵守架构约定 #2）。

#### 2.2.3 runtime 侧 QuotaService

新增 `packages/runtime/src/services/quota-service.ts`：

| 职责 | 实现 |
|---|---|
| 引入共享包 | `import { buildRuntimeProviders, fetchAllQuota } from '@zhushanwen/pi-quota-providers'` |
| 凭证注入 | 从 `~/.xyz-agent/secrets/` 读 cookie 文件；API key 复用 pi-provider-store 已有的 key；通过环境变量或参数注入共享包 |
| **查询时机** | **hover 触发，非后台轮询**。前端 hover 进入容量 chip 时主动调 `quota.fetch(providerId)` RPC，runtime 即时拉取（不依赖共享包 TTL）|
| **缓存策略** | 查询成功 → 原子写缓存文件（复用共享包 cache.ts 的原子写机制）；查询失败 → **不删除旧缓存**，返回旧值给前端展示 |
| **并发保护** | 同一 provider 上一次查询未完成时，复用 pending Promise，不重复发起（避免快速 hover 进出触发并发请求）|
| **失败日志** | 查询失败时 runtime logger 落盘 log（`<dataDir>/logs/quota-*.log`，遵守架构约定 #4 日志规范），含 providerId + 错误原因（HTTP 状态/超时/解析异常）|
| RPC 暴露 | `quota.fetch(providerId)` 主动查询并返回最新额度（hover 触发）；`quota.getCached(providerId)` 读缓存不发起请求（浮层首屏快速展示）|
| 错误兜底 | 单 provider 失败不影响其他；凭证缺失返回 null（前端不显 coding-plan 区）；超时 5s（opencode-go 8s）|

**共享包适配点**：当前共享包的 paths.ts 基于 `getAgentDir()`（pi 用 `~/.pi/agent/`）。xyz-agent 集成时需要：
- 给共享包加 `setAgentDir(dir: string)` 注入函数（推荐提 PR 到 xyz-pi-extensions）
- 或本仓库临时 fork，把 paths.ts 改成参数化（方案 B 的退化版）

**与共享包 TTL 的关系**：共享包 cache.ts 自带 2 分钟 TTL（拉取后写本地缓存，2 分钟内读缓存不发请求）。xyz-agent **不走共享包的 TTL 自动节流**，而是自己控制查询时机（hover 触发）。共享包的 cache 机制仅用于「失败时保留旧值」和「跨会话持久化」，TTL 过期判断由 xyz-agent 的 `quota.fetch` 内部决定是否真正发请求（可加最小间隔保护，如 10s 内不重复发同一 provider 请求）。

#### 2.2.4 前端额度状态

新增 `packages/renderer/src/stores/quota.ts`：

```ts
interface QuotaState {
  // providerId → 额度数据
  byProvider: Map<string, NormalizedQuotaRow>
  // 加载状态
  loading: boolean
  // 最后刷新时间
  lastRefresh: number | null
}
```

数据流（hover 触发模式，非订阅广播）：
- **首屏快速展示**：`ContextCapacityPopover` hover-enter 时先调 `quota.getCached(providerId)` 读缓存即时填充浮层（避免空白等待）
- **主动查询**：紧接着调 `quota.fetch(providerId)` 触发实际 HTTP 查询，runtime 返回最新结果后更新 store，浮层响应式刷新
- **失败降级**：`quota.fetch` 失败时 runtime 返回旧缓存值（不抛错），前端无感知地展示旧数据；错误只在 runtime logger 落盘
- composer 浮层从 `quotaStore.byProvider.get(currentProviderId)` 读数据
- session 切换模型时，浮层自动切到新 provider 的额度（响应式）

#### 2.2.5 Settings UI 设计

在 `ProviderEditModal.vue` 的左侧「凭据配置」区下方，新增「Coding Plan 额度查询」Section（仅在 provider 命中 QUOTA_PRESETS 时显示）。**[HISTORICAL] 该「仅在命中 QUOTA_PRESETS 时显示」已失效**：实现早已改为始终显示，coding-plan-quota-config-ux.md（已删，git 可追溯） 的 D8 正式采纳用户决策「所有 provider 都显示，未选类型时只渲染类型下拉 + 一句说明」——旧条件会把「该 provider 能不能配额度」变成用户猜不到的隐规则。

```
┌─ 凭据配置（已有）──────────────────┐
│  Name / API / Base URL / API Key  │
└────────────────────────────────────┘
┌─ Coding Plan 额度查询（新增）─────┐
│  [✓] 启用额度查询                 │
│  认证方式：API Key（已配置 ✓）    │  ← api-key 类：复用上方 apiKey
│  ─ 或 ─                            │
│  Cookie：[粘贴 cookie 字符串]     │  ← cookie 类：单独输入框
│  [测试查询]  [查看额度 →]          │
│  ⓘ 在 bigmodel.cn 控制台获取      │
└────────────────────────────────────┘
```

交互细节：
- **开关**：默认关闭。打开后立即调 `quota.refresh` 测试一次，成功显示「✓ 已获取额度」，失败显示错误。**[HISTORICAL] 本句已被 coding-plan-quota-config-ux.md（已删，git 可追溯） 推翻（D4）**：开关退化为纯配置位——唯一语义是「要不要在对话框容量浮层里展示」，拨动只落盘、无任何网络副作用；「打开即测一次」正是失败模式 A（「已启用但永远查不到」）的直接成因，测试动作改为并入唯一按钮「保存并测试」（D2）。
- **api-key 类 provider**（智谱/kimi/minimax）：凭证复用上方的 API Key 输入框，不重复输入。**[HISTORICAL] 本句已被 coding-plan-quota-config-ux.md（已删，git 可追溯） 部分推翻（D3）**：继承仍然成立，但由「留空即复用」的隐式约定改为显式的「凭证来源」选择（Provider 凭据 / 专属 Key），且该选择持久化到 `ProviderInfo.quota.credentialSource`，UI 显示与 runtime 实际使用同源（消除「显示用 A、实际用 B」）。
- **cookie 类 provider**（mimo/opencode-go）：单独显示 Cookie 输入框（textarea，多行支持）+ 「如何获取 cookie」帮助链接
- **测试查询按钮**：调 `quota.refresh(providerId)` 立即拉取一次，UI 显示结果（成功/失败 + 错误原因）
- **查看额度按钮**：在浮层里直接展示当前额度（不离开设置页）

#### 2.2.6 Composer hover 浮层设计（合并到 ContextCapacity）

**挂载点**：`ContextCapacityPopover.vue`（已有 hover 浮层）。在现有「上下文容量」浮层内追加 Coding Plan 区，**不新建浮层、不挂 model chip**。Model chip 回归纯模型切换。

**设计理由**：容量与额度都是「用量」类信息，聚合在一个浮层比分散在两个 chip 更合理——用户心智模型是「这次对话消耗了多少资源」，上下文 token 和 coding-plan 配额是同一关切。

**视觉布局**（紧凑表格化，每窗口严格一行）：

```
┌─ 上下文容量 ───────────── GLM-4.6 ─┐  ← head（复用现有）
│                                       │
│  已用 / 总量    6.9K / 200K · 3.5%   │  ← 容量区（现有，保留）
│  ▓░░░░░░░░░░░░░░░░░░░░░░░░░░░       │
│  ──────────────────────────────────  │  ← divider
│  CODING PLAN   智谱                  │  ← section label + provider tag
│                                       │
│  5h    ▓▓▓▓▓▓▓▓░░░░░░  68%  剩1h23m │  ← 单行 4 列
│  本周  ▓▓▓▓▓▓░░░░░░░░  42%  剩3d12h │
│  本月  ───────────      ∞   未订阅   │
│                                       │
│  2 分钟前更新              [刷新]    │  ← footer（现有，保留）
└───────────────────────────────────────┘
```

**紧凑行布局**（grid 4 列，每个窗口严格一行）：

```
grid-template-columns: 32px 1fr 32px 52px;
                       标签 | 进度条 | 百分比 | 剩余时间
```

**分档配色**（复用现有规则）：
- `<70%`：`fill-accent`（蓝色渐变）
- `70-90%`：`fill-warning`，百分比文字转 `text-warning`
- `>90%`：`fill-danger`，百分比文字转 `text-danger`
- `null`（无限/未订阅/不支持）：进度条透明（width 0），百分比显 `∞`（`text-subtle`）

**未配置态**：provider 未启用 coding-plan 查询时，浮层**只保留容量区**，不渲染 divider + section-label + 三窗口行。浮层自然比已配置态矮一截——这是预期行为，不强求等高。footer 文案改为「<Provider名> 无 Coding Plan」+ 「配置」按钮（跳转 Settings → Provider 编辑）。**[HISTORICAL] 本段已被 coding-plan-quota-config-ux.md（已删，git 可追溯） 补齐（D11）**：原文只描述了未配置态的该入口；失败态（已启用但查询失败）同样需要它——「已启用但凭证缺失」的 provider 必有 matchedProviderId，只会拿到「刷新」，而刷新在凭证缺失时只会再失败一次，形成死路，故失败态 footer 同时给「刷新」与「配置」两个入口。

**数据源**：`ContextCapacityPopover.vue` hover-enter 时触发查询：
- 容量区（现有）：`context.update` / `session.state_changed` → `inputTokens / contextLimit / usagePercent`（已有订阅）
- Coding Plan 区（新增）：hover-enter 时先读 `quota.getCached` 即时填充，再调 `quota.fetch` 触发查询刷新。session 切换模型时，hover 重新触发查新 provider 的额度

**不破坏现有交互**：hover 行为、浮层位置（`side="top"`）、动画（fade + zoom 200ms）、footer 刷新按钮全部保留。新增内容只是浮层 body 的下半段追加。

---

## 3. 实施分期建议

### Phase 1 · 方案 A（短期 MVP，验证产品形态）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P0** | 共享包适配：给 `@zhushanwen/pi-quota-providers` 加 `setAgentDir()` 注入函数（PR 到 xyz-pi-extensions） | 无 |
| **P1** | runtime QuotaService + RPC 协议 + quota store | P0 |
| **P2** | Settings UI：内置预设表 + ProviderEditModal 额度查询 Section | P1 |
| **P3** | Composer hover 浮层：ModelSelectPopover 外层包 HoverCard | P1（数据） + 现有 HoverCard 组件 |
| **P4** | 自动关联：provider 配置完成后自动建议启用额度查询 | P2 |

P3 可以与 P2 并行（数据通路打通后，UI 两处独立）。

### Phase 2 · 方案 D（长期 plugin 化，产品验证通过后）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P5** | Plugin 协议扩展：后台周期任务能力（`lifecycle.activate` 可注册 interval） | Phase 1 验证通过 |
| **P6** | Plugin 协议扩展：主动事件推送能力（`plugin.emit(channel, payload)`） | P5 |
| **P7** | Plugin 数据目录隔离 API（`plugin.getDataDir()` → `<dataDir>/plugins/<id>/`） | P5 |
| **P8** | 迁移：runtime QuotaService → `@xyz-agent/quota-provider` plugin 包 | P5/P6/P7 |
| **P9** | 推荐安装：加入 Settings → Extensions 推荐列表 | P8 |

**迁移复用**：UI 层（Settings + Composer hover）和数据协议（`NormalizedQuotaRow`）两层在 P8 完全复用，迁移只发生在 runtime 内部。

---

## 4. 决策记录

### 已确认决策（2026-07-25）

| # | 问题 | 决策 | 说明 |
|---|---|---|---|
| 1 | 实现方式 | **方案 D · Plugin 化** | 额度查询作为可插拔能力，架构正确。短期先用方案 A 跑通 MVP，验证后做 plugin 化（P5-P8） |
| 2 | Cookie 存储 | **明文存储** | 暂存 `<dataDir>/plugins/<plugin-id>/secrets/<providerId>-cookie.txt`（方案 D）或 `<dataDir>/secrets/`（方案 A）。后续可迭代加密 |
| 3 | 查询时机与缓存 | **hover 触发查询 + 持久缓存不删除 + 失败用缓存 + log** | hover 进入容量 chip 时主动调 `quota.fetch(providerId)` 查询（非后台轮询）。成功 → 更新缓存；失败 → 展示旧缓存（**缓存永不删除**）+ runtime logger 落盘 log。并发保护：同一 provider pending 期间复用 Promise 不重复发起。最小间隔保护：10s 内不重复发同一 provider 请求 |
| 4 | Composer 浮层挂载点 | **合并到 ContextCapacity popover，不挂 model chip** | Coding-plan 信息合并到「上下文容量」hover 浮层下半区。Model chip 回归纯模型切换。理由：容量与额度都是「用量」类信息，聚合一个浮层比分散两个 chip 更合理。详见 demo 第 2 部分 |
| 5 | 共享包依赖 | **不依赖共享包，runtime 自研 5 个 provider fetcher** | 推翻原方案 A「集成 @zhushanwen/pi-quota-providers 共享包」。改为：runtime 新增 `quota-providers/` 目录，5 个 provider 各自实现 fetcher（zhipu/kimi/minimax/mimo/opencode），只参考 statusline 的 endpoint/认证/解析思路，代码用 xyz-agent 自己的风格重写。statusline 的实现仅作技术参考，不引入代码依赖 |
| 6 | fetcher 架构 | **可插拔 ProviderQuotaFetcher 接口 + 注册表** | 抽象 `ProviderQuotaFetcher` 接口（`fetchQuota(credential) → NormalizedQuotaRow`）+ 注册表（`QUOTA_FETCHERS: Map<fetcherId, ProviderQuotaFetcher>`）。5 个 provider 各自实现并注册。为后续 plugin 化铺路：Phase 2 每个 fetcher 可独立迁移成 plugin |

---

## 5. demo 说明

`draft.html` 演示 3 部分内容：

1. **Settings · Provider 编辑弹窗** 的「Coding Plan 额度查询」Section（4 种状态：未启用 / API Key 类已配置 / Cookie 类已配置 / 查询失败）
2. **Composer · 上下文容量 hover 合并浮层**（4 种状态：正常三窗口 / 高用量警告 / 仅月窗口 MiMo / 未配置 coding-plan）
3. **实际 hover 交互体验**（接近真实交互的 composer，鼠标移到容量 chip 上浮层淡入，model chip 回归纯模型切换）

demo 严格遵循 `docs/page-design/design-tokens.md` 的暗色冷蓝设计系统（色值、圆角、阴影、动效全部对齐）。打开 `draft.html` 即可在浏览器查看。
