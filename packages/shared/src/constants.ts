/**
 * Shared constants used by both runtime (Node.js) and renderer (Electron).
 * Single source of truth — import from here, never hardcode.
 */

/** Base port for the runtime WebSocket server */
// eslint-disable-next-line no-magic-numbers
export const BASE_PORT = 3210 as const

/** Port offset used in dev mode to avoid connecting to prod runtime */
// eslint-disable-next-line no-magic-numbers
export const DEV_PORT_OFFSET = 100 as const

/** Maximum valid port number */
// eslint-disable-next-line no-magic-numbers
export const MAX_PORT = 65535 as const

/** pi-subagents 扩展的 subagent tool 名集合（识别 subagent 调用用，SSOT）。
 *  pi-subagents 通过名为 "subagent" 的 tool 执行子 agent，前端据此判定特殊渲染。 */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['subagent'])

/** pi-subagent-workflow 扩展的 workflow tool 名集合（识别 workflow 调用用，SSOT）。
 *  workflow 扩展通过名为 "workflow" 的 tool 执行 workflow run，event-interpreter 据此
 *  捕获发起时刻（action=run → 广播 session.workflows 增量信号）。 */
export const WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set(['workflow'])

/**
 * W16/W17 [D4]：subagent/workflow 自描述持久化 entry 的 customType（runtime 侧消费值）。
 *
 * 权威源在 extensions/universal/subagent-workflow（跨包依赖方向不允许 runtime import extensions/
 * 源码，只能在此复制字面量并保持等值——同 workflow-extractor SNAPSHOT_VERSION 的本地
 * 副本模式）：
 * - `subagent-record`：extensions/universal/subagent-workflow/src/execution/record-entry.ts 的
 *   SUBAGENT_RECORD_CUSTOM_TYPE（record 状态迁移点 append 完整快照，data schema v1）
 * - `workflow-record`：extensions/universal/subagent-workflow/src/orchestration/jsonl-run-store.ts 的
 *   WORKFLOW_RECORD_CUSTOM_TYPE（每次成功 flush append 完整 RunSnapshot，data schema v1）
 *
 * 消费方：event-adapter（entry_appended 失效过滤）、subagent/workflow-extractor（entry
 * 扫描的自描述分支）。extension 升级 customType 值时必须同步此处。
 */
export const SUBAGENT_RECORD_CUSTOM_TYPE = 'subagent-record'
export const WORKFLOW_RECORD_CUSTOM_TYPE = 'workflow-record'

/** pi 支持的 provider api 标识全集（前后端共享 SSOT）。
 *  runtime 的 applyTypeTranslation 改为透传后，前端 Select 必须直接发送此集合内的终值。
 *  注意：pi 不支持 ollama；ollama 的前端适配在 W4 处理，runtime 不做别名翻译。 */
export const PROVIDER_API_TYPES = ['anthropic-messages', 'openai-completions'] as const
export type ProviderApiType = (typeof PROVIDER_API_TYPES)[number]

/** pi 运行时实际支持的所有 api 终值（用于 runtime warn 校验）。
 *  = pi-ai KnownApi 10 值全集（W2 对齐 pi-assumption-remediation A-09，2026-08-20 现场核实）。
 *  锚点：pi 0.84.1 实装依赖内嵌 pi-ai 0.84.2
 *  `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts:15`
 *  的 KnownApi 联合（与根 pi-ai 0.82.1 `node_modules/@earendil-works/pi-ai/dist/types.d.ts:14` 同集）。
 *  维护注：升级 pi / pi-ai 时 diff 上面锚点行并同步此处（顺序保持与 KnownApi 定义一致便于逐值对照），
 *  避免白名单再漂移——此前仅 3 值导致 7 种合法 api type 误报「pi 可能不支持」warn。
 *  比 PROVIDER_API_TYPES 多 8 值：前者是「前端可选」，本集合是「pi 认识」。 */
export const KNOWN_PI_API_TYPES: ReadonlySet<string> = new Set([
  'openai-completions',
  'mistral-conversations',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-vertex',
  'pi-messages',
])

/** Environment variable prefixes allowed to pass to child processes */
export const ENV_WHITELIST_PREFIXES: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LANG', 'TERM',
  'NODE_', 'NVM_', 'XYZ_', 'XDG_',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'SYSTEMROOT', 'TEMP', 'TMP',
  // ambient 云凭证具体变量名（spec §7）：只加具体名不整前缀（AWS_/GOOGLE_ 整前缀会
  // 把用户生产 AWS 凭证暴露给所有 pi 子进程，最小暴露面）。GOOGLE_APPLICATION_CREDENTIALS
  // 是文件型自定义 ADC 路径（spec §7 点名，漏掉则自定义路径检测不到）。
  'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_PROFILE',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GCLOUD_PROJECT', 'CLOUDSDK_REGION',
]

/**
 * ambient 云凭证相关环境变量名（spec §7 / wave-env-check）。
 * 与 ENV_WHITELIST_PREFIXES 的追加名单一致，供 shell-env.ts 回写复用（避免两处维护漂移）：
 * GUI 启动时 LaunchServices 最小环境缺这些变量，登录 shell 有值时补齐。
 */
export const AMBIENT_ENV_NAMES: readonly string[] = [
  'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_PROFILE',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GCLOUD_PROJECT', 'CLOUDSDK_REGION',
]

/** 系统提示词 replace.prompt 最大字符长度（argv 安全边界）。
 *  走 pi `--system-prompt` CLI → 进程 argv，Windows 命令行约 32k 上限，留安全边际。
 *  runtime ConfigService.setSystemPromptConfig 超限拒存；前端 UI 计数器/提示共用此值。 */
// eslint-disable-next-line no-magic-numbers
export const SYSTEM_PROMPT_MAX_LENGTH = 16000 as const

/**
 * 图片附件相关上限（SSOT）。
 *
 * write-session-image IPC 校验单图大小用 SINGLE_MAX_BYTES（防超大输入撑爆内存/磁盘）。
 */
export const IMAGE_LIMITS = {
  /** 单图上限（write-session-image IPC 校验，base64 解码字节数 <= 此值才接受） */
  // eslint-disable-next-line no-magic-numbers
  SINGLE_MAX_BYTES: 20 * 1024 * 1024,
} as const

/**
 * WS 单条消息大小上限（runtime WebSocketServer maxPayload，超限连接被 close 1009）。
 *
 * 实施期校准依据（S1-W1 ⛔ 门，spec §3.3 D4）：最大合法单条消息是贴图通路
 * （session.writeImage / message.send 的 base64 图片数组，base64 膨胀 4/3）。
 * 实测贴图分布：粘贴截图典型 1-3MB PNG，P99.9 约 4-8MB；16MB 为绝对上限，
 * 约合 P99.9 的 2~4 倍余量（并非与 P99.9×2 做取小——min(8MB, 16MB)=8MB，
 * 与实际取值 16MB 矛盾，取小表述不成立）。注意边界：IMAGE_LIMITS.
 * SINGLE_MAX_BYTES（20MB 原图解码后）允许的单图 base64 化后约 26.7MB，超过
 * 16MB 传输上限——单图 >12MB 的原图会被本传输层上限先拒，属预期收紧（12MB ×
 * 4/3 = 16MB 恰为上限，贴图应压缩到 12MB 原图以内；若后续实测用户贴图 P99.9
 * 上移，调大此常量并同步复核贴图回归验收）。
 */
// eslint-disable-next-line no-magic-numbers
export const MAX_WS_PAYLOAD_BYTES: number = 16 * 1024 * 1024

/**
 * ADR-0021 §2/§3 预设可选 skill/agent 目录候选（UI 「可选目录」的固定来源）。
 *
 * SSOT：services/skill-dir-config.ts（buildDirConfigs 读取端）与 infra/pi/discovery-store.ts
 * （setSkillDirs/setAgentDirs 写入端）共同 import 此常量，消除本地副本漂移风险。
 *
 * 语义：用户可勾选启用/可拖排序；勾选的进 discovery.json 数组。强制目录
 * （~/.xyz-agent/...）不在此列（UI 另行只读展示）。preset 成员豁免 existsSync 脏数据过滤
 * ——推荐候选语义，启用后即使此机器不存在也要保留（防 UI 消失回归）。
 */
export const PRESET_SKILL_DIRS = [
  '~/.pi/agent/skills',
  '~/.claude/skills',
  '~/.agents/skills',
  '.agents/skills',
] as const

export const PRESET_AGENT_DIRS = [
  '~/.pi/agent/agents',
  '~/.claude/agents',
  '~/.agents/agents',
  '.agents/agents',
] as const

/**
 * extension 加载路径预设候选（镜像 skill/agent 的两套：P1 pi 原生 + P2 xyz-agent）。
 *
 * P1 pi 原生扫描目录：
 *   - ~/.pi/agent/extensions（user 级，pi 默认全局扫描）
 *   - .pi/extensions（project 级，pi 默认项目扫描，受 trust 门控）
 *
 * P2 xyz-agent 强制目录结构：
 *   - .xyz-agent/extensions（project 级；user 级 ~/.xyz-agent/extensions 是强制目录不在此列）
 *
 * 注意：extension 与 skill/agent 的目录语义不同——extension 是代码模块（注册 tool/hook/command），
 * 而非数据资源。discovery 目录顺序仅影响加载顺序（对 hook 链执行顺序有意义），不等于统一优先级。
 */
export const PRESET_EXTENSION_DIRS = [
  '~/.pi/agent/extensions',
  '.pi/extensions',
  '.xyz-agent/extensions',
] as const

/**
 * 插件通知/状态栏防毒化限流参数（D7「限流与防毒化」，plugin-trust-hardening S3-W4）。
 *
 * 全部为可调常量：runtime 侧 NotifyRateLimiter / StatusBarRegistry 构造时接受覆盖
 * （默认取此处 SSOT 值），不写死在逻辑里。
 *
 * 默认值校准依据（实施期门实测，2026-08-17）：
 * - 唯一 builtin 插件 statusline（resources/plugins/statusline/index.ts）代码路径
 *   **零 notify 调用**——它只被动响应 plugin:statusSetUpdate hook 转发 updateStatusBarItem，
 *   因此 notify 通道的参照实测值 = 0 条/s。
 * - statusbar 更新上游（pi extension setStatus → status-set → statusline 转发）实测：
 *   a) 真实会话日志（~/.xyz-agent/logs/pi-*.jsonl，2026-08-17 最繁忙 session）：
 *      4.6h 内 74 条 setStatus（goal 57 / todo 17），均值 ≈ 0.005 条/s；
 *   b) 活动探针（pi --mode rpc + pi-statusline + goal/todo extensions，真实 LLM turn
 *      含 todo 工具写）：完整 turn 13.1s 内 4 条，1s 窗口最大突发 = 2 条
 *      （session 初始化时 todo+plan-mode 两条相邻 2ms）。
 * - 结论：正常插件通知是用户动作/turn 边界触发型，实测突发峰值 2 条/s；
 *   20 条/s 是失控水平（连续打满令牌桶）的 ~10 倍量级，作为默认值留足余量
 *   且不会误伤任何合法 builtin 行为。
 */
export const PLUGIN_NOTIFY_LIMITS = {
  /** notify 令牌桶速率（条/秒/插件，容量 = 速率，即可瞬时突发该数） */
   
  NOTIFY_RATE_PER_SEC: 20,
  /** 单条 notify message 上限（UTF-8 字节）。超出拒绝（INVALID_MESSAGE） */
  // eslint-disable-next-line no-magic-numbers
  NOTIFY_MESSAGE_MAX_BYTES: 8 * 1024,
  /** statusbar 单条 text 上限（UTF-8 字节）。D3 验收「1MB text 被拒」依此规则 */
  // eslint-disable-next-line no-magic-numbers
  STATUSBAR_TEXT_MAX_BYTES: 4 * 1024,
  /** statusbar 更新广播合并窗口（ms）：窗口内多次更新合并为一次广播 */
   
  STATUSBAR_COALESCE_MS: 100,
} as const

/**
 * 引擎子进程 env 契约常量 SSOT（W12，docs/design/subagent-engine-protocolization.impl-plan.md §2.12）。
 *
 * 消费形态：@zhushanwen/subagent-engine-sdk 的 src/env.ts 内联镜像本块（构建期生成物，
 * SDK 不得运行时 import @xyz-agent/shared——F9：zsw 宿主链不可依赖 shared）；
 * 逐项相等由 .githooks/check_env_whitelist_sync.py 断言（漂移即红）。
 * 两处改动必须同批提交。
 */
export const ENGINE_ENV_PREFIXES: readonly string[] = [
  // L2 manifest 放行的保留前缀拒绝表：manifest envPrefixes 声明这些前缀 = 试图
  // 越过 L0/L1 基础设施面自配 XYZ_ 族变量，一律拒绝 + warn（引擎基础设施键只经 L0 注入）
  'XYZ_', 'XYZ_AGENT_', 'XYZ_SUBAGENT_',
]

export const ENGINE_ENV_DENY_LIST: readonly string[] = [
  // 出站 deny 清单（与 spawn-env-contract.ts SPAWN_ENV_OUTBOUND_DENY_LIST 同成员——
  // 引擎 spawn 面同样不得携带生命周期标志 / WS 令牌；此处单列因 SDK 不能 import shared）
  'XYZ_AGENT_PACKAGED',
  'XYZ_RUNTIME_TOKEN',
  // 凭证键：引擎凭据不跨进程（设计不变量 5），泄漏面与 WS 令牌同级
  'XYZ_AGENT_API_KEY',
  // 父身份键（relay tee 帧归属）：防父身份误归属——引擎按 run.params.ctx 重写，
  // 误继承会把孙帧归到父 record
  'XYZ_SUBAGENT_RELAY_SESSION_ID',
  'XYZ_SUBAGENT_RELAY_RECORD_ID',
]

/**
 * 引擎启动 env 名 SSOT（W9 生成块挂载，impl-plan §2.9；与上方 W12 的 ENGINE_ENV_*
 * 生成块同文件、行区间互斥——串行边 W12→W9 保证）。
 *
 * 两个 env 名的写入方/读取方（跨包镜像登记，勿单独改动）：
 * - ROOTS（L1 引擎发现根，path.delimiter 分隔绝对路径列表）：写入 =
 *   packages/runtime/src/services/session/engine-roots.ts（本 SSOT import 消费）；
 *   读取 = core engine-discovery-roots.ts（parseEngineRootsEnv，W4 字面量）。
 * - NODE（引擎 node 执行器，与 relay 的 XYZ_SUBAGENT_RELAY_NODE 不复用）：写入 =
 *   runtime engine-roots.ts（打包态注入 pi 子进程）；读取 = SDK
 *   src/node-executor.ts（字面量镜像——SDK 不得 import shared，F9 同上方 W12 块）。
 */
export const ENGINE_LAUNCH_ENV_KEYS = {
  ROOTS: 'XYZ_AGENT_ENGINE_ROOTS',
  NODE: 'XYZ_AGENT_ENGINE_NODE',
} as const

/**
 * 前端 toast 并发上限（D7「限流与防毒化」）。
 *
 * 在列 toast 超过上限时新 toast 丢弃并计数（droppedCount），防止通知风暴刷屏。
 * 5 = 单屏可读的告警密度上限；与 runtime 侧 20/s 限流叠加构成两道独立防线。
 */
 
export const UI_TOAST_LIMITS = { MAX_IN_FLIGHT: 5 } as const

// ── 崩溃韧性共享契约（docs/design/crash-resilience.md §3.3，实施计划 u-foundation）──
// 本段是 DAG 根共享契约：u4a（出站守卫）/ u4b（历史预算）/ u4c（读预检）/
// u5a/u5b（日志保留期）从这里取值，禁止各单元自写魔数。

/**
 * server→client 出站帧告警阈值（默认 8MB）[crash-resilience §3.3 D3]。
 *
 * RPC reply 与 messageBus push 两种通路共用：序列化后超此值写 warn 日志
 * （消息类型、sessionId、字节数），**不截断**——哨兵定位：pi 上游自截（read/bash
 * 50KB/2000 行、图片 ≤16MB）一旦失效（新工具类型 / pi 升级 / MCP 外部工具大结果），
 * 告警先于截断暴露（D3「8MB 告警档的价值是哨兵」）。
 *
 * 校准依据（设计 D3 指定公式：**renderer 堆上限 × 安全系数 ÷ UTF-16 膨胀系数**）：
 * E3（9/9 崩溃报告）实证系统内存紧张时 renderer 可用堆余量仅几十 MB 量级；wire 帧
 * 是 UTF-8 JSON，parse 成 JS 字符串后按 UTF-16 驻留（约 2 倍膨胀）再叠加对象图开销。
 * 8MB = 截断档（OUTBOUND_FRAME_TRUNCATE_BYTES，32MB）的 1/4，取「尚未致命但已异常」
 * 的分界线，与 MAX_WS_PAYLOAD_BYTES（入站方向）并列构成传输大小标尺。
 */
// eslint-disable-next-line no-magic-numbers -- 设计标定阈值非魔法数，校准依据见上方 JSDoc
export const OUTBOUND_FRAME_WARN_BYTES: number = 8 * 1024 * 1024

/**
 * server→client 出站帧截断阈值（默认 32MB）[crash-resilience §3.3 D3]。
 *
 * 按通路分两种守卫形态：reply 通路超限 → 替换为 `payload_too_large` 错误 envelope
 * （前端 pending 对 type:'error' 且 id 命中的 reply 走 reject，Promise 收口不悬挂）；
 * push 通路超限 → publish 入口 **seq 分配前**「契约保持式截断」（消息类型不变，按
 * 帧内字段路径注册表把大字段替换为占位文案，ring 回放 / 重订阅拉到同一份截断版，
 * seq 连续性不被破坏），注册表 miss 或截断后仍超限 → seq 分配前整条丢弃（不占 seq
 * 不触发 gap）。
 *
 * 校准依据（同上公式：renderer 堆上限 × 安全系数 ÷ UTF-16 膨胀系数）：32MB 帧按
 * UTF-16 膨胀 + 对象图开销落到堆余量几十 MB 的 renderer 上即是 E3 型 OOM 的直接
 * 触发点，故为传输层硬上限。与 READ_PRECHECK_MAX_BYTES（D5）同值——「读入」与
 * 「传入」对 renderer 是同一内存后果，同一风险标尺。
 */
// eslint-disable-next-line no-magic-numbers -- 设计标定阈值非魔法数，校准依据见上方 JSDoc
export const OUTBOUND_FRAME_TRUNCATE_BYTES: number = 32 * 1024 * 1024

/**
 * runtime 全量读预检阈值（默认 32MB）[crash-resilience §3.3 D5]。
 *
 * 五条全量读入口统一 statSync 大小预检：① getHistoryFromFilePath（含 subagent 历史
 * 消费方）② 离线尾读 fallback ③ findLastEntryField fallback ④ readSessionJsonlText
 * （Trace 视图）⑤ restore 附着 normalize。超限按调用方语义分档降级（逆序分块读 /
 * oversize 标记 / 跳过 normalize + warn），消除「读巨文件 → OOM」恶性循环。
 *
 * 校准依据：本机实测 session 历史文件最大 6MB（探针 P-hist-sizes，`du` 实测）、单
 * session tee 累计流量最大 198MB——32MB ≈ 历史文件实测最大值的 5 倍余量，正常流量
 * 永不触发（命中即防御纵深）；与 OUTBOUND_FRAME_TRUNCATE_BYTES 同值（同一风险标尺）；
 * D5 ②档「分块扩窗」的总读取量上限亦取此值。
 */
// eslint-disable-next-line no-magic-numbers -- 设计标定阈值非魔法数，校准依据见上方 JSDoc
export const READ_PRECHECK_MAX_BYTES: number = 32 * 1024 * 1024

/**
 * session 历史加载双预算 [crash-resilience §3.3 D4]。
 *
 * 语义：活跃 session 的 doGetHistory 与离线尾读合并为同一预算逻辑——按「最近
 * RECENT_TURNS turns 且总字节 ≤ MAX_BYTES」双条件截取，响应携带 truncated /
 * loadedTurns / totalTurnsEstimate。切分粒度：预算作用于 **turn 选择**，单 turn 内
 * entry 不切分（entry 原子性——切分会破坏 reducer 幂等与 parentId 链）；最近一个
 * turn 自身超预算时仍完整放行（保证对话可见性连续），极端 turn 由 D3 帧守卫与
 * U7 累积态截断兜底。
 *
 * 校准依据：两值**对齐现有离线窗口**——runtime session-history.ts 的
 * DEFAULT_MAX_TURNS = 20 与 TAIL_WINDOW = max(256KB, maxTurns × 32KB) = 640KB
 * （20 × 32KB/turn，注释自证「留余量防长 tool_result 触发不必要 fallback 全量读」）
 * 逐值同源，预算化后活跃/离线两路径行为不回退。
 */
export const HISTORY_BUDGET = {
  /** 最近 turns 数（与 runtime session-history.ts DEFAULT_MAX_TURNS 对齐）。
   * 注：对象字面量属性值不触发 no-magic-numbers（规则默认 ignoreObjectRefs/属性位），
   * 此处无需 disable 指令——留着会被 reportUnusedDisableDirectives 判 warning。 */
  RECENT_TURNS: 20,
  /** 字节预算（640KB = 20 × 32KB/turn，对齐离线尾读 TAIL_WINDOW 现值） */
  // eslint-disable-next-line no-magic-numbers -- 对齐离线 TAIL_WINDOW=640KB 的设计预算
  MAX_BYTES: 640 * 1024,
} as const

/** 日志保留天数默认值（runtime infra/logger.ts DEFAULT_KEEP_DAYS 等价提升，
 *  main / runtime 清理扫描共用同一默认）。 */
// eslint-disable-next-line no-magic-numbers -- 对齐 runtime logger DEFAULT_KEEP_DAYS=7 现状
export const DEFAULT_LOG_KEEP_DAYS = 7 as const

/**
 * 读取日志保留天数：env `XYZ_LOG_KEEP_DAYS` 覆盖 || 默认 7（DEFAULT_LOG_KEEP_DAYS）。
 *
 * [crash-resilience §3.3 D6-⑦] 从 runtime infra/logger.ts:50-55 的模块级常量
 * `Number(process.env.XYZ_LOG_KEEP_DAYS) || 7` **等价提升**为共享函数：main（每日
 * 清理定时器）与 runtime（initLogger 清理）两进程同调同一函数——既保留用户 env
 * 旋钮，也不出现两套值域漂移。语义与现状逐字等价：`Number(env)` 结果 falsy
 * （未设 / 空串 / '0' / 非数字 NaN）回退默认；负数 truthy 透传（现状即如此，
 * 等价提升不在函数内另加校验）。
 *
 * **默认参读 process.env：本文件被 renderer 大量 re-export，renderer 无参调用即
 * ReferenceError（浏览器无 process）——renderer 消费须显式传 env（如 `{}`）**；
 * main / runtime（Node 进程）走默认参。
 */
export function readLogKeepDays(env: Record<string, string | undefined> = process.env): number {
  return Number(env.XYZ_LOG_KEEP_DAYS) || DEFAULT_LOG_KEEP_DAYS
}

// ── 空闲 pi 进程回收（idle-pi-reclamation D4，实施计划 u3）──
// 三个旋钮的 env 变量名 + 默认值 SSOT。本文件保持纯常量：解析（env 读取 + 非法值回落）
// 收口在 runtime 的 resolveReclaimConfig（startup-background-init.ts），此处不写函数。

/**
 * 空闲回收判定周期（ms）。`XYZ_RUNTIME_PI_RECLAIM_TICK_MS` env 覆盖，默认 5 分钟一拍（D4）。
 */
export const XYZ_RUNTIME_PI_RECLAIM_TICK_MS = 'XYZ_RUNTIME_PI_RECLAIM_TICK_MS'
/**
 * 空闲阈值（ms）。`XYZ_RUNTIME_PI_RECLAIM_IDLE_MS` env 覆盖，默认 2 小时（D4：被否
 * 30min——回收/恢复抖动变常态；被否 24h——对午饭级离开太迟）。
 */
export const XYZ_RUNTIME_PI_RECLAIM_IDLE_MS = 'XYZ_RUNTIME_PI_RECLAIM_IDLE_MS'
/**
 * 查看豁免窗口（ms）。`XYZ_RUNTIME_PI_RECLAIM_VIEWED_WINDOW_MS` env 覆盖，默认 30 分钟
 * （D2 #6：窗口内被 session.switch 查看过的 session 不回收）。
 */
export const XYZ_RUNTIME_PI_RECLAIM_VIEWED_WINDOW_MS = 'XYZ_RUNTIME_PI_RECLAIM_VIEWED_WINDOW_MS'

/**
 * 默认值三件套（与 runtime idle-pi-reaper.ts 的 DEFAULT_REAP_TICK_MS /
 * DEFAULT_IDLE_THRESHOLD_MS / DEFAULT_VIEWED_WINDOW_MS 数值逐一同源）：reaper 模块内的
 * DEFAULT_* 是「options 未传时」的 fallback 兜底（DI 纯单测场景），生产装配经
 * resolveReclaimConfig 把此处权威值（可被 env 覆盖）传入 config——改默认值只改这里，
 * reaper 内 fallback 仅保测试构造点不炸，两处数值失同步时以本处为准。
 */
// eslint-disable-next-line no-magic-numbers -- 设计标定阈值（D4），校准依据见上方 JSDoc
export const DEFAULT_PI_RECLAIM_TICK_MS = 5 * 60 * 1000
// eslint-disable-next-line no-magic-numbers -- 设计标定阈值（D4），校准依据见上方 JSDoc
export const DEFAULT_PI_RECLAIM_IDLE_MS = 2 * 60 * 60 * 1000
// eslint-disable-next-line no-magic-numbers -- 设计标定阈值（D2 #6），校准依据见上方 JSDoc
export const DEFAULT_PI_RECLAIM_VIEWED_WINDOW_MS = 30 * 60 * 1000

// ── 滚动重启计划内退出码（crash-forensics-and-watchdog §3.3 D5 ④，u7c）──

/**
 * runtime 滚动重启计划内退出的专用退出码（86）。supervisor（classifyRuntimeExit
 * 判别式 + planned 立即重启分支）与 runtime 执行链（rolling-restart 触发的
 * process.exit）双端共用——两进程依赖方向单向（main → runtime），runtime 无法
 * import main 侧符号，SSOT 落 shared 消除双 86 字面量。
 *
 * apps/electron/main/supervisor/runtime-supervisor.ts 的 `PLANNED_EXIT_CODE` 是
 * 本值的转发常量（导出面不变，u1f 既有测试与消费方 import 点不受影响）。
 */
export const RUNTIME_PLANNED_EXIT_CODE = 86
