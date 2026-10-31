/**
 * async-compaction-background —— 后台上下文压缩（async-compaction）D3 真机验收剧本。
 *
 * 单剧本分段覆盖设计文档 §4.1 的 V1→V6 六个场景（权威源：
 * ~/.agents/skill-data/tech-design/feat-async-compaction-e49f375a/async-compaction/
 * async-compaction.rendered.md，下称「设计文档」）：
 *
 *   段 1 = V1  工具触发后台压缩，压缩执行期间连续发两条消息不被拒/不被掐断/不挂起（GL1/GL2）
 *   段 2 = V2  压缩完成后下一次请求自动切换压缩后上下文（摘要 + 保留段）（GL3/GL4）
 *   段 3 = V3  执行窗口内把投影推过窗口上限 → 原生同步压缩兜底恢复，后台任务放弃不落第二条（GL2/GL4）
 *   段 4 = V4  执行期间会话内回退（revoke = navigateTree 树回退）→ 回退不取消压缩、落盘无错位（GL4）
 *   段 5 = V5  执行期间手动 /compact（同步豁免路径）→ /compact 正常完成、后台放弃、仅一条 entry（GL4）
 *   段 6 = V6  切走再切回该会话 → live ≡ reload + 提醒档位不因重载复燃（GL3/GL4）
 *
 * ── LLM 通道选型：mock-http（meta.llm），不用 faux ──
 *
 * 压缩生成本身是一次独立 LLM 调用（设计 §1.1/AS8）：
 *   - same-model 模式走 completeSimple 直调当前模型 provider（src/llm.ts callSameModelCompaction）；
 *   - cross-model 模式走包导出 nativeCompact 调配置的 compactModel（src/compact-handler.ts
 *     generateCrossMode）。两条路都是真实 HTTP 请求。通道判定的实测依据：
 *   - faux：extension 双注册共享同一响应队列，「主 loop turn 与 extension 内 LLM 调用按全局
 *     到达序 shift 消费同一脚本」（packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts 头注）；
 *     faux 的 model-keyed 是 per-进程按 argv --model 选队（loadScript），同一 pi 进程内压缩调用
 *     与回合调用无法按模型分队列——V1 的并发窗口（压缩在途 + 用户消息回合）下消费顺序非确定。
 *   - mock-http：model-keyed 队列按请求体 model 字段选队（scripts/lib/mock-llm.mjs，per-model
 *     单游标），配合 cross-model 模式（compactModel 配独立 mock 模型）把「回合回复」与「压缩
 *     生成」分成两条互不干扰的队列；instance.mockLlm.requests 全量留档每次请求——「压缩生成
 *     调用真的发生、打到独立模型、携带全量上下文」均有铁证。
 * 因此本剧本固定 cross-model 装配：主会话模型 mockllm/mock-main（回合演员）、压缩模型
 * mockllm/mock-compact（压缩演员；pickMode 判 cross-model 的依据：compactModel.ref ≠ 当前模型，
 * src/pure.ts:127-131）。
 *
 * ── 装配（技能 helper，scenario 不自起进程）──
 *
 * 实例装配 = meta.llm 声明 → runner 调 scripts/lib/instance.mjs 的 ensureLlm（起 mock server、
 * 写 <dataDir>/agent/models.json / settings.json / subagents/config.json；models.json 里模型
 * contextWindow 硬编码 128_000、maxTokens 16_384）。meta.env 注入 TAIJI_AGENT_DEBUG=1：
 * smart-context 扩展 debugLog 落 <dataDir>/agent/logs/smart-context-<date>.log
 * （extensions/shared/extension-logger/src/index.ts fileLog），承载 V2 落盘 / V3·V5 放弃的
 * C 通道日志证据。剧本自身零自持进程：mock server 与实例生命周期全归 runner。
 *
 * ── 触发线算术（本装配下的路径选择，设计 AS10 漂移代价量级②）──
 *
 * mock 模型窗口 = 128_000；pi 原生 threshold 自动压缩兜底点 = 窗口 − reserveTokens =
 * 128_000 − 16_384 = 111_616（pi compaction.js DEFAULT_COMPACTION_SETTINGS / shouldCompact，
 * 实码核实）；后台自动触发线默认 = 0.9 × 128_000 = 115_200 > 111_616 → 本装配下
 * 「agent_settled 自动触发」被原生兜底反转（窗口 < 163_840 的既有边界），后台触发一律走
 * compact_context 工具入口（设计入口矩阵①，V1 步骤②明确两条触发路径任一）。V3 恰好利用
 * 该反转验证原生同步压缩兜底。V3 的 oversize 回合 settle 时自动触发被后台任务互斥挡住
 * （compact-handler.ts maybeStart 首判 state.active）——竞态由工具路径受控发起。
 *
 * ── 造上下文布局的硬约束（findCutPoint 的 keepRecentTokens=20000 预算，pi compaction.js
 *    findCutPoint 实码核实：从尾回溯累计 estimateTokens（chars/4），首次 ≥ keepRecentTokens
 *    的 entry 即切点；累计永不达标时切点回退第一条消息 → 被压段为空 → preparation undefined
 *    → startForTool 抛「没有可压缩内容」）──
 *
 * 两条等长大消息（各 12_000 tokens）尾部累计 24_000 在「加完第一条」时才越 20_000 → 切点
 * 落回第一条 → 无可压。因此每个会话造 **三条** 等长大消息（各 48_000 chars ≈ 12_000 tokens）：
 * 回溯在第二条 user 消息处越线 → 切点 = 第二条 user entry → 被压段 = [第一条]（非空），
 * 保留段 = [第二条…]；切点 entry 是 turn 起点（user 消息）→ isSplitTurn=false → nativeCompact
 * 单次生成调用（pi compaction.js compact()：split-turn 且 turnPrefix 非空才双调用）——
 * mock-compact 每次压缩恰消费 1 步，队列步数确定。
 *
 * ── mock 通道下 tokens 的可用性（pi 实码核实）──
 *
 * mock 响应不携带 usage → estimateContextTokens 在无任何 assistant usage 时对全量消息
 * chars/4 估算、tokens 非 null（pi compaction.js !usageInfo 分支）→ 工具阈值保护、三档提醒、
 * 压缩 entry 判定全部可用。唯一例外：压缩 entry 之后无新 usage 的窗口内 getContextUsage 返回
 * tokens:null → 工具触发被阈值保护拒绝。因此 V3/V4/V5 各用独立新会话（taiji 每 session 独立
 * pi 进程，compact-handler.ts 校验①注释），V1+V2 共享会话 1，V6 切走（到段 3 会话）再切回会话 1。
 *
 * ── 顶部声明 ──
 *
 * - REPO：feat-async-compaction worktree 根（由 runner --repo flag 注入 ctx.repo，剧本不硬编码
 *   本机绝对路径）。工作目录样例 = <repo>/e2e/fixtures/sample-project。
 * - 数据目录：runner 分配的 ~/.taiji-dev/verify-<runId>（verify- 前缀一次性目录；dispose 时
 *   整树删除）。剧本经 ctx.dataDir 消费，不自定路径。
 * - artifactsDir：run.mjs --artifacts-dir（dev-flow D3 节点产物根）；verdict.json /
 *   summary.jsonl 由 runner 镜像到其根，inspect 节点读根。
 * - summary.jsonl 契约：本剧本每个业务步骤经 ctx.ev.step({step, command, exitCode, stats,
 *   channel}) 追加一行（六键恒在：step/command/exitCode/stats/channel/at）。
 * - 超时预算：
 *     实例就绪            180s（runner waitReady 缺省）
 *     单回合完成          60s（TURN_BUDGET_MS）
 *     压缩在途轮询        45s/次（COMPACT_INFLIGHT_MS；后台摘要经 tps 节流 ≈30s 窗口 + 余量）
 *     原生同步压缩窗口    30s（NATIVE_COMPACT_MS；同步接管 cross-model 生成 ≈10s + 余量）
 *     整体 estimateSec    1200s（六段串行 + 启动/收尾余量）
 *
 * ── 常量回填来源（feat-async-compaction 实码，2026-11-01 核实）──
 *
 * - 工具成功回执文案：extensions/universal/smart-context/src/tool.ts:200
 *   「压缩已启动（cross-model 模式，使用 <ref>）。压缩在后台进行，…」；
 *   幂等回执（已进行中）：tool.ts:183「后台压缩进行中，本次请求已并入该任务…」。
 * - 完成通知：src/notices.ts buildCompactCompleteNotice
 *   「[smart-context] 后台压缩完成（<mode> 模式）：上下文 X → Y tokens。…」。
 * - 失败通知：src/notices.ts buildCompactFailureNotice
 *   「[smart-context] 后台压缩已放弃/失败：…」。cancelled（事件取消）不回调 onSettled、
 *   不发通知（compact-handler.ts runBackgroundTask；D3 取消非失败）——故 V3/V5 的放弃
 *   断言落「恰 1 条 entry + 扩展日志放弃标记」，不硬断言失败通知文案。
 * - 扩展调试日志标记：src/compact-handler.ts debugLog 文案统一前缀「background compaction」
 *   （started(tool/auto) / persisted / persist rejected: preempted / cancelled: session_compact）。
 * - entry details：src/compact-handler.ts SmartContextDetails {engine:'smart-context', mode,
 *   model}（generateCrossMode 落 cross-model + mockllm/mock-compact）。
 *
 * Cleanup（技能 SKILL.md §5）由 runner 承载：停实例（SIGTERM 优雅链）→ 端口释放核对 → mock
 * server 随 instance.stop 关闭 → verify-* 数据目录删除 → 证据幸存核对。本剧本无自持子进程/
 * 服务，run() 的 finally 段只做剧本侧自查登记，不重复 dispose。
 */
import fs from 'node:fs'
import path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// 已落地常量（读自 feat-async-compaction worktree 实码，来源行号随行标注）
// ─────────────────────────────────────────────────────────────────────────────

/** compact_context 工具名（src/tool.ts registerTool name）。 */
const TOOL_NAME = 'compact_context'
/** compaction entry 的 type（src/pure.ts countCompactions 判据）。 */
const ENTRY_TYPE_COMPACTION = 'compaction'
/** 已提醒档位 marker 的 custom entry 类型（src/pure.ts FIRED_ENTRY_CUSTOM_TYPE，V6 复燃判据）。 */
const FIRED_ENTRY_CUSTOM_TYPE = 'smart-context:fired'
/** smart-context 通知文案前缀（src/notices.ts SMART_CONTEXT_NOTICE_CUSTOM_TYPE 文案）。 */
const NOTICE_TAG = '[smart-context]'
/** 三档提醒文案首行特征（src/reminder.ts buildThresholdReminder）。 */
const REMINDER_TEXT_MARK = '已越提醒阈值'
/** U4 后台化成功回执文案模式（src/tool.ts:200；幂等回执「后台压缩进行中」不含此模式）。 */
const BG_TOOL_ACK_PATTERN = '压缩已启动（cross-model 模式'
/** U5 完成通知文案模式（src/notices.ts buildCompactCompleteNotice）。 */
const BG_COMPLETE_NOTICE_PATTERN = `${NOTICE_TAG} 后台压缩完成`
/** U5 失败（dropped 被抢先放弃）通知文案模式（src/notices.ts buildCompactFailureNotice）。
 *  cancelled 事件取消不回调 onSettled 不发通知——本常量仅记录文案模式，V3/V5 不硬断言。 */
const BG_FAIL_NOTICE_PATTERN = `${NOTICE_TAG} 后台压缩已放弃`
/** U2/U3 后台任务扩展调试日志统一前缀（src/compact-handler.ts debugLog 文案；C 通道证据）。
 *  具体行：started(tool|auto) / persisted / persist rejected: preempted /
 *  cancelled: session_compact。 */
const BG_DEBUG_LOG_MARKER = 'background compaction'

/** compaction entry details.engine 标记（src/compact-handler.ts SmartContextDetails）。 */
const DETAILS_ENGINE = 'smart-context'
/** U3 后台路径 compaction entry 的 details 形态（src/compact-handler.ts SmartContextDetails
 *  + generateCrossMode：cross-model 模式 model = 配置的压缩模型 ref）。 */
const BG_ENTRY_DETAILS = { engine: DETAILS_ENGINE, mode: 'cross-model', model: 'mockllm/mock-compact' }

/** pi 手动压缩期对 prompt 的拒绝文案（设计文档 §1.1 引 pi agent-session.js）。 */
const REJECT_MARK = 'Cannot submit a prompt while compaction is in progress'

/** 主会话模型（settings.json defaultModel，instance.mjs ensureLlm 写入）。 */
const MOCK_PROVIDER = 'mockllm'
const MOCK_MAIN_REF = `${MOCK_PROVIDER}/mock-main`
/** 压缩模型（cross-model 模式：compactModel.ref ≠ 当前模型 → pickMode 返回 cross-model）。 */
const MOCK_COMPACT_REF = `${MOCK_PROVIDER}/mock-compact`
/** mock 模型窗口（instance.mjs ensureLlm 硬编码 contextWindow）。 */
const MOCK_WINDOW = 128_000
/** pi 原生 threshold 自动压缩保留量（pi DEFAULT_COMPACTION_SETTINGS.reserveTokens）。 */
const PI_RESERVE_TOKENS = 16_384
/** 原生兜底触发点（tokens 越过即下轮请求前同步压缩；pi shouldCompact 严格大于）。 */
const PI_BACKSTOP_TOKENS = MOCK_WINDOW - PI_RESERVE_TOKENS
/** pi 原生切点保留预算（pi DEFAULT_COMPACTION_SETTINGS.keepRecentTokens——布局约束来源）。 */
const PI_KEEP_RECENT_TOKENS = 20_000
/** 工具阈值保护与提醒共用的档位配置（工具放行要求 tokens ≥ 最小档，src/pure.ts）。 */
const REMINDER_TIERS = [8_000, 16_000]

/** 被压段哨兵：只存在于被压缩早期消息里的事实码（V2 断言其离开请求上下文）。 */
const SHADOW_SENTINEL = 'FACT-CODE-7703'
/** 摘要哨兵：mock 压缩演员摘要文本必含的被压段要点改写（V2 断言其进入请求上下文）。 */
const SUMMARY_SENTINEL = 'SUMMARY-KEEPS-FACT-CODE-7703'

/** GL1 断言预算：工具调用到工具结果落盘 ≤1s（设计 V1 通过标准原文）。 */
const TOOL_ACK_BUDGET_MS = 1_000
/** 单回合完成预算。 */
const TURN_BUDGET_MS = 60_000
/** 压缩在途轮询预算（后台摘要节流窗口 + 余量）。 */
const COMPACT_INFLIGHT_MS = 45_000
/** 原生同步压缩完成预算。 */
const NATIVE_COMPACT_MS = 30_000
/** mock 流式节流（tps：内容按 4 字符≈1 token 切块；mock-llm.mjs perCharMs=1000/(tps*4)）。 */
const MOCK_TPS = 10
/** 后台摘要 step 文本长度（1200 chars × 25ms/char @tps10 ≈ 30s 执行窗口）。 */
const BG_SUMMARY_CHARS = 1_200
/** 原生同步摘要 step 文本长度（≈400 chars ≈ 10s，同步阻塞期预算内）。 */
const NATIVE_SUMMARY_CHARS = 400
/** 造上下文单条消息字符量（48_000 chars ≈ 12_000 tokens；三条布局见文件头「硬约束」）。 */
const CONTEXT_MSG_CHARS = 48_000
/** 造上下文消息条数（三条布局：切点落第二条 user entry，被压段 = 第一条，非空）。 */
const CONTEXT_MSG_COUNT = 3
/** V3 大消息字符量（360_000 chars ≈ 90_000 tokens；造上下文 ≈36.1K + 90K ≈ 126.1K，
 *  过原生兜底点 111_616、低于窗口 128_000；WS 单帧上限 16MB，单条可行无需分片）。 */
const OVERSIZE_MSG_CHARS = 360_000
/** 造上下文每条消息的 token 估算（chars/4，pi estimateTokens 口径）。 */
const CONTEXT_MSG_TOKENS = Math.ceil(CONTEXT_MSG_CHARS / 4)

// ─────────────────────────────────────────────────────────────────────────────
// mock 演员队列（model-keyed；串行段执行下 per-model 单游标全局连续。
// 段消费数用 mockLlm.pending() 游标差计量，requests 全程留证不 reset。
// 演员文本无语义，断言靠 requests/messages/JSONL/日志四处证据源。）
// ─────────────────────────────────────────────────────────────────────────────

/** 造上下文消息文本（哨兵埋在每条；label 唯一化供 entry 定位与原文前缀断言）。 */
function contextMessage(label) {
  return `async-compaction 背景材料 ${label}：本段细节含 ${SHADOW_SENTINEL}（关键事实码，压缩后应经摘要保留）。${'填充'.repeat(CONTEXT_MSG_CHARS / 2 - 100)}`
}

/** 被压段原文前缀（V2/GL3「被压段原文离场」断言的探针——contextMessage 首部唯一片段）。 */
function shadowPrefix(label) {
  return contextMessage(label).slice(0, 80)
}

/** 后台压缩摘要 step 文本（长文本 = tps 节流下的执行窗口）。 */
function bgSummaryStep(tag) {
  const filler = `背景与决策回顾 ${tag}。`.repeat(Math.ceil(BG_SUMMARY_CHARS / 12))
  return { text: `${SUMMARY_SENTINEL}：${filler}`.slice(0, BG_SUMMARY_CHARS), stopReason: 'stop' }
}

/** 原生同步压缩摘要 step 文本（短，控制同步阻塞期在预算内）。 */
function nativeSummaryStep(tag) {
  const filler = `原生压缩摘要 ${tag}。`.repeat(Math.ceil(NATIVE_SUMMARY_CHARS / 10))
  return { text: `${SUMMARY_SENTINEL}：${filler}`.slice(0, NATIVE_SUMMARY_CHARS), stopReason: 'stop' }
}

/** mock-main 回合演员队列（顺序 = 段执行顺序；步注释标注消费段）。 */
function buildMainQueue() {
  return [
    // ── 会话 1（段 1 V1 + 段 2 V2）──
    { text: 'ack-1a 收到背景材料 A（V1 造上下文 1/3）', stopReason: 'stop' },
    { text: 'ack-1b 收到背景材料 B（V1 造上下文 2/3）', stopReason: 'stop' },
    { text: 'ack-1c 收到背景材料 C（V1 造上下文 3/3）', stopReason: 'stop' },
    { toolCalls: [{ name: TOOL_NAME, args: {} }] }, // V1 诱导轮：模型决定调压缩工具
    { text: 'ack-1d 压缩已请求，继续工作（工具结果后的收尾轮）', stopReason: 'stop' },
    { text: 'ack-1e 压缩期第一条消息照常回复', stopReason: 'stop' },
    { text: 'ack-1f 压缩期第二条消息照常回复', stopReason: 'stop' },
    { text: `ack-2a 依据摘要回答：${SHADOW_SENTINEL} 的要点见压缩摘要（V2 问答轮）`, stopReason: 'stop' },
    // ── 会话 2（段 3 V3；接在会话 1 游标之后，无 reset）──
    { text: 'ack-3a 收到背景材料 A3（V3 造上下文 1/3）', stopReason: 'stop' },
    { text: 'ack-3b 收到背景材料 B3（V3 造上下文 2/3）', stopReason: 'stop' },
    { text: 'ack-3c 收到背景材料 C3（V3 造上下文 3/3）', stopReason: 'stop' },
    { toolCalls: [{ name: TOOL_NAME, args: {} }] }, // V3 诱导轮：工具触发后台压缩
    { text: 'ack-3d 后台压缩已请求（收尾轮）', stopReason: 'stop' },
    { text: 'ack-3e 大消息回合照常回复（窗口已超限，回合不拒）', stopReason: 'stop' },
    { text: 'ack-3f 原生同步压缩兜底后的恢复回合', stopReason: 'stop' },
    // ── 会话 3（段 4 V4）──
    { text: 'ack-4a 收到背景材料 V4-A（V4 造上下文 1/3，被压段）', stopReason: 'stop' },
    { text: 'ack-4b 收到背景材料 V4-B（V4 造上下文 2/3，切点）', stopReason: 'stop' },
    { text: 'ack-4c 收到背景材料 V4-C（V4 造上下文 3/3）', stopReason: 'stop' },
    { toolCalls: [{ name: TOOL_NAME, args: {} }] }, // V4 诱导轮
    { text: 'ack-4d 后台压缩已请求（收尾轮）', stopReason: 'stop' },
    { text: 'ack-4e 回退后新分支上的对话回复', stopReason: 'stop' },
    { text: 'ack-4f 落盘后的投影验证轮回复', stopReason: 'stop' },
    // ── 会话 4（段 5 V5：session.compact RPC 为同步路径，不消费 mock-main）──
    { text: 'ack-5a 收到背景材料 V5-A（V5 造上下文 1/3，被压段）', stopReason: 'stop' },
    { text: 'ack-5b 收到背景材料 V5-B（V5 造上下文 2/3，切点）', stopReason: 'stop' },
    { text: 'ack-5c 收到背景材料 V5-C（V5 造上下文 3/3）', stopReason: 'stop' },
    { toolCalls: [{ name: TOOL_NAME, args: {} }] }, // V5 诱导轮
    { text: 'ack-5d 后台压缩已请求（收尾轮）', stopReason: 'stop' },
    // ── 会话 1 切回（段 6 V6）──
    { text: 'ack-6a 切回后继续对话回复（压缩后形态）', stopReason: 'stop' },
    { text: 'ack-6b 档位复燃检查轮回复', stopReason: 'stop' },
  ]
}

/** mock-compact 压缩演员队列（每次压缩恰消费 1 步：三条消息布局下切点 = turn 起点 user
 *  entry → isSplitTurn=false → nativeCompact 单次生成调用，pi compaction.js compact() 实码；
 *  步序 = 请求到达序（FIFO）：各竞态段内「后台生成先发起→长文本 step（拉出执行窗口），
 *  原生/手动压缩后到→短文本 step（控制同步阻塞期，保证原生先落盘、后台后被取消/放弃）」）。 */
function buildCompactQueue() {
  return [
    bgSummaryStep('v1'), // 段 1：V1 后台压缩生成（长文本 = ≈30s 执行窗口）
    bgSummaryStep('v3-bg'), // 段 3：V3 后台压缩生成（先到，长文本窗口）
    nativeSummaryStep('v3-native'), // 段 3：V3 threshold 同步压缩（后到，先完成 → session_compact 取消后台）
    bgSummaryStep('v4'), // 段 4：V4 后台压缩生成（回退不取消，正常落盘）
    bgSummaryStep('v5-bg'), // 段 5：V5 后台压缩生成（先到；被 /compact 抢先后放弃）
    nativeSummaryStep('v5-compact'), // 段 5：V5 session.compact 同步压缩（后到，先完成）
  ]
}

export const meta = {
  id: 'async-compaction-background',
  priority: 'P2', // 设计文档头部「功能分级 P2」
  title: '后台上下文压缩 V1-V6：触发回执 / 执行期不受限 / 上下文切换 / 兜底与竞态放弃 / 回退不取消 / 持久化一致',
  covers: ['session.create', 'chat.send', 'chat.wait', 'chat.revoke', 'session.switch', 'session.history'],
  requires: ['mock-http'],
  estimateSec: 1200,
  // TAIJI_AGENT_DEBUG=1：smart-context debugLog 落 <dataDir>/agent/logs/smart-context-*.log
  // （extensions/shared/extension-logger fileLog）——V2 落盘与 V3/V5 放弃的 C 通道日志证据。
  env: { TAIJI_AGENT_DEBUG: '1' },
  llm: {
    // mainModel/models 必须显式给：ensureLlm 缺省 mainModel='mock-1'、actors=['mock-sub-a','mock-sub-b']，
    // 与本剧本演员队列（mock-main/mock-compact）错位会导致 settings.json defaultModel 落空。
    // subModel 不传（缺省 mock-sub-a 写进 subagents/config.json engineDefaults，本剧本无孙进程不消费）。
    mainModel: 'mock-main',
    models: ['mock-main', 'mock-compact'],
    responses: {
      [MOCK_MAIN_REF]: buildMainQueue(),
      [MOCK_COMPACT_REF]: buildCompactQueue(),
    },
    tps: MOCK_TPS,
  },
  provable: [
    'V1/GL1: compact_context 工具结果在 1s 内返回成功回执（JSONL toolCall→toolResult timestamp 差）',
    'V1/GL2: 压缩执行期间两条消息均正常进入回合（无 pi 拒绝文案、无被掐断回合、完成早于压缩落盘）',
    'V1: 压缩生成调用真实发生（mock-compact 队列被消费、请求体携带全量上下文）',
    'V1: 压缩期间新消息 entry 在 session JSONL 中 parentId 链正常衔接',
    'V2/GL3: 压缩完成后下一次请求上下文 = 摘要 + 保留段（请求体含摘要哨兵与完成通知、不含被压段哨兵原文）',
    'V2/GL4: compaction entry 落盘（type/summary/firstKeptEntryId/tokensBefore/details 形态/fromHook 齐全）',
    'V3/GL2: 推过窗口上限后由原生同步压缩完成恢复（会话不卡死，可继续对话）',
    'V3/GL4: 原生压缩与后台任务同窗竞态下，该周期 compaction entry 恰一条（后台放弃不落第二条）',
    'V4/GL4: 执行期间 revoke 树回退不取消压缩，后台 entry 正常落盘且投影无被撤子树内容',
    'V5/GL4: 执行期间 session.compact 同步完成，最终仅该次压缩产生的一条 compaction entry',
    'V6/GL3: 切走再切回后 live ≡ reload（history 结构一致 + 继续对话请求仍为压缩后上下文）',
    'V6/GL4: 对话流压缩检查点可见（UI），提醒档位不因重载复燃（fired marker 在盘、切回后无新增提醒注入）',
  ],
  notProvable: [
    '真实模型智能下的摘要质量与「经摘要可答」的语义正确性（mock 摘要由剧本编排，非模型生成）',
    '压缩耗时的真实量级（mock 秒级返回；「执行窗口」由 tps 流式节流模拟 ≈30s，非真实十几秒到几十秒）',
    'overflow 400 硬溢出路径（mock 通道不产 400；V3 的「原生同步压缩恢复」由 threshold 自动压缩承载，'
      + '两者同为 pi 原生同步路径，见设计 D5/AX1 例外清单）',
    'V6 的「完全退出并重启 taiji」半边（runner 生命周期内整机重启未纳入；以「切走再切回」承载重载半边，'
      + '设计 V6 步骤②允许二选一）',
    'agent_settled 自动触发路径（本装配 128K 窗口下触发线被原生兜底反转，见文件头算术；'
      + '自动路径的窗口>163840 形态需另一装配，设计 AS10 量级②已登记该人群边界）',
    '失败通知文案的 UI/上下文呈现（cancelled 事件取消不回调 onSettled 不发通知——设计 D3；'
      + 'V3/V5 竞态以「恰 1 条 entry + 扩展日志放弃标记」承载，BG_FAIL_NOTICE_PATTERN 仅记录文案模式）',
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// 剧本 helper（只做驱动 / 断言 / 取证，不实现产品语义——API-CONTRACT §0）
// ─────────────────────────────────────────────────────────────────────────────

/** 写 smart-context 配置（<agentDir>/config/smart-context-ext-config.json，llm-shared config；
 *  loadConfig 按 mtime+size 读时刷新——launch 后写入即刻生效）。 */
function writeSmartContextConfig(dataDir) {
  const file = path.join(dataDir, 'agent', 'config', 'smart-context-ext-config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const config = {
    enabled: true,
    compactModel: { type: 'ref', ref: MOCK_COMPACT_REF },
    reminderThresholds: [...REMINDER_TIERS],
    excludedModels: [],
    autoCompactThresholdRatio: 0.9, // 默认值显式落盘（src/pure.ts DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO）
  }
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return { file, config }
}

/**
 * 定位 session JSONL。pi SessionManager 文件名 = `<fileTimestamp>_<sessionId>.jsonl`
 * （pi session-manager.js:713 实码，带毫秒时间戳前缀）——按「文件名含 sessionId」匹配，
 * 不按精确名。目录：<dataDir>/agent/sessions/<编码cwd>/（cwd 编码规则是 pi 内部实现，
 * 不进剧本——按会话 id 递归查找）。找不到时返回诊断信息（dir 列表）而非裸 null。
 */
function findSessionJsonl(dataDir, sessionId) {
  const root = path.join(dataDir, 'agent', 'sessions')
  if (!fs.existsSync(root)) return null
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    const hit = names.find((n) => n.endsWith('.jsonl') && n.includes(sessionId))
    if (hit) return path.join(dir, hit)
    for (const n of names) {
      const full = path.join(dir, n)
      try {
        if (fs.statSync(full).isDirectory()) stack.push(full)
      } catch {
        /* 竞态删除跳过 */
      }
    }
  }
  return null
}

/** sessions 目录下全部 jsonl 文件（诊断用：找不到目标文件时 dump 对照）。 */
function listSessionJsonlFiles(dataDir) {
  const root = path.join(dataDir, 'agent', 'sessions')
  const out = []
  if (!fs.existsSync(root)) return out
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      const full = path.join(dir, n)
      try {
        if (fs.statSync(full).isDirectory()) stack.push(full)
        else if (n.endsWith('.jsonl')) out.push(path.relative(root, full))
      } catch {
        /* 竞态删除跳过 */
      }
    }
  }
  return out
}

/** 读 session JSONL 为 entry 数组（坏行跳过并计数，不抛错——断言侧对行数留痕）。 */
function readSessionEntries(jsonlFile) {
  const raw = fs.readFileSync(jsonlFile, 'utf8')
  const entries = []
  let badLines = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }
  return { entries, badLines }
}

/** 统计 compaction entry。 */
function compactionEntries(entries) {
  return entries.filter((e) => e?.type === ENTRY_TYPE_COMPACTION)
}

/** 在 entry 流中提取文本（message content 的 text 块拼接；宽松形状，取不到返回空串）。 */
function entryText(entry) {
  const msg = entry && typeof entry === 'object' ? entry.message : undefined
  const content = msg && typeof msg === 'object' ? msg.content : undefined
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('')
  }
  return ''
}

/**
 * 提取工具调用对（V1/GL1 数据源；pi SessionEntry 实码形态：
 * - toolCall = message entry，message.role='assistant'，content 含 {type:'toolCall', name} 块；
 * - toolResult = message entry，message.role='toolResult'，content text 含工具回执文案；
 * - entry.timestamp 为 ISO string（SessionEntryBase）→ Date.parse 换算 ms。
 */
function extractToolPair(entries, toolName, resultTextMark) {
  const callEntry = entries.find(
    (e) =>
      e?.type === 'message' &&
      e?.message?.role === 'assistant' &&
      Array.isArray(e?.message?.content) &&
      e.message.content.some((b) => b?.type === 'toolCall' && b?.name === toolName),
  )
  const resultEntry = entries.find(
    (e) =>
      e?.type === 'message' &&
      e?.message?.role === 'toolResult' &&
      e?.message?.toolName === toolName &&
      entryText(e).includes(resultTextMark),
  )
  const callTs = typeof callEntry?.timestamp === 'string' ? Date.parse(callEntry.timestamp) : NaN
  const resultTs = typeof resultEntry?.timestamp === 'string' ? Date.parse(resultEntry.timestamp) : NaN
  const ackMs = Number.isFinite(callTs) && Number.isFinite(resultTs) ? resultTs - callTs : -1
  return { callEntry, resultEntry, ackMs }
}

/** 在 entry 流中定位含目标文本前缀的 user 消息 entry（V4 revoke 的 targetId 数据源）。 */
function findUserEntryByPrefix(entries, prefix) {
  return entries.find((e) => e?.type === 'message' && e?.message?.role === 'user' && entryText(e).includes(prefix))
}

/** parentId 链校验：每条 entry 的 parentId 都指向流中存在的更早 entry id（设计 V1 通过标准）。 */
function parentChainBroken(entries) {
  const seen = new Set()
  for (const e of entries) {
    const pid = e?.parentId
    if (typeof pid === 'string' && pid !== '' && !seen.has(pid)) {
      return { broken: e?.id ?? '?', missingParent: pid }
    }
    if (typeof e?.id === 'string') seen.add(e.id)
  }
  return null
}

/** 等 mock server 收到指定模型的下一次请求（条件等待，禁固定 sleep——API-CONTRACT §5.1）。 */
async function waitForMockRequest(instance, modelBareId, sinceCount, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    const hits = (instance.mockLlm?.requests ?? []).filter(
      (r) => r.status === 200 && (r.model === modelBareId || r.model?.endsWith(`/${modelBareId}`)),
    )
    if (hits.length > sinceCount) return hits
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `等待 mock 请求超时（${label}）：model=${modelBareId} 期望 >${sinceCount} 次，实际 ${hits.length}；` +
          `全部请求=${JSON.stringify((instance.mockLlm?.requests ?? []).map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex })))}`,
      )
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** mock 请求体的消息文本拼接（messages 各 role content 抽平，供上下文断言）。 */
function requestMessagesText(request) {
  return (request?.messages ?? [])
    .map((m) => {
      if (typeof m?.content === 'string') return m.content
      if (Array.isArray(m?.content)) {
        return m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
      }
      return ''
    })
    .join('\n')
}

/** 读 smart-context 扩展调试日志（<dataDir>/agent/logs/smart-context-*.log 全量拼接；无文件 = ''）。 */
function readSmartContextLog(dataDir) {
  const dir = path.join(dataDir, 'agent', 'logs')
  if (!fs.existsSync(dir)) return ''
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('smart-context-') && f.endsWith('.log'))
    .map((f) => {
      try {
        return fs.readFileSync(path.join(dir, f), 'utf8')
      } catch {
        return ''
      }
    })
    .join('\n')
}

/** 统计子串出现次数（提醒注入计数口径：nextTurn 提醒注入后常驻请求上下文，比出现次数不增）。 */
function countOccurrences(haystack, needle) {
  if (typeof haystack !== 'string' || haystack === '') return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count += 1
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

// ─────────────────────────────────────────────────────────────────────────────
// 剧本主体
// ─────────────────────────────────────────────────────────────────────────────

export async function run(ctx) {
  const { instance, protocol: proto, ev, log, dataDir, repo } = ctx
  const cwd = path.join(repo, 'e2e', 'fixtures', 'sample-project')
  const uncovered = []
  const gotchas = []

  /** 记段级 main/compact 队列游标（段消费数 = 差值，requests 全程留证）。 */
  const cursor = () => ({
    main: instance.mockLlm?.pending()?.[MOCK_MAIN_REF] ?? 0,
    compact: instance.mockLlm?.pending()?.[MOCK_COMPACT_REF] ?? 0,
  })

  /** 等待 compaction entry 落盘（条件轮询 JSONL；超时抛错并附放弃路径诊断：扩展日志尾部 +
   *  mock-compact 请求摘要 + JSONL 尾部 entry——区分「生成失败 / 校验放弃 / 落盘缺失」三类归因）。 */
  async function waitForCompactionEntry(sid, sinceCount, timeoutMs, label) {
    const t0 = Date.now()
    for (;;) {
      const f = findSessionJsonl(dataDir, sid)
      if (f) {
        const snapshot = readSessionEntries(f)
        const comps = compactionEntries(snapshot.entries)
        if (comps.length > sinceCount) return { file: f, ...snapshot, comps }
      }
      if (Date.now() - t0 > timeoutMs) {
        const f = findSessionJsonl(dataDir, sid)
        const scLog = readSmartContextLog(dataDir)
        const logTail = scLog.split('\n').filter(Boolean).slice(-12).join(' ⏎ ')
        // mock 请求体的 model 是裸 id（pi-ai openai-completions buildParams；mock-llm.mjs 实测），
        // 匹配须同时容忍裸 id 与 provider/id 全形。
        const isCompactReq = (r) => r.model === 'mock-compact' || r.model?.endsWith('/mock-compact')
        const compactReqs = (instance.mockLlm?.requests ?? [])
          .filter(isCompactReq)
          .map((r) => ({
            status: r.status,
            stepIndex: r.stepIndex,
            at: r.at ? new Date(r.at).toISOString() : null,
            messageCount: r.messageCount,
            bodyChars: (r.messages ?? []).reduce((n, m) => n + (typeof m?.content === 'string' ? m.content.length : Array.isArray(m?.content) ? m.content.reduce((k, b) => k + (b?.text?.length ?? 0), 0) : 0), 0),
            tail: (r.summary ?? []).map((s) => `${s.role}:${String(s.text ?? '').slice(0, 60)}`),
          }))
        const tail = f
          ? readSessionEntries(f)
              .entries.slice(-10)
              .map((e) => ({
                type: e?.type,
                customType: e?.customType,
                role: e?.message?.role,
                text: entryText(e).slice(0, 100) || JSON.stringify(e?.data ?? '').slice(0, 100),
              }))
          : null
        throw new Error(
          `${label}: 等待 compaction entry 落盘超时（${timeoutMs}ms；sinceCount=${sinceCount}）；` +
            `extLogTail=${logTail || '<empty>'}；compactReqs=${JSON.stringify(compactReqs)}；jsonlTail=${JSON.stringify(tail)}`,
        )
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  try {
    // ═══════════════════ 段 0：装配自检 ═══════════════════
    // 实例已由 runner launch + ready；此处写 smart-context 配置（热生效）并核对装配拓扑。
    const cfg = writeSmartContextConfig(dataDir)
    const cfgReread = JSON.parse(fs.readFileSync(cfg.file, 'utf8'))
    ev.step({
      step: 's0.smart-context-config',
      command: `write ${path.relative(dataDir, cfg.file)}`,
      exitCode: cfgReread.autoCompactThresholdRatio === 0.9 && cfgReread.compactModel?.ref === MOCK_COMPACT_REF ? 0 : 1,
      stats: { file: cfg.file, tiers: REMINDER_TIERS, compactModel: MOCK_COMPACT_REF, ratio: 0.9 },
      channel: 'C',
    })
    ev.assert('段0: smart-context 配置落盘且字段符合装配意图（cross-model + 档位 + 0.9）', cfgReread.compactModel?.ref === MOCK_COMPACT_REF && cfgReread.reminderThresholds?.[0] === REMINDER_TIERS[0], {
      channel: 'C',
      expected: `compactModel=${MOCK_COMPACT_REF}, tiers[0]=${REMINDER_TIERS[0]}`,
      actual: JSON.stringify(cfgReread),
    })
    const topo = instance.llm
    ev.assert('段0: mock-http 拓扑就绪（main + compact 两演员可达同一 mock server）', Boolean(topo?.baseUrl) && Array.isArray(instance.mockLlm?.requests), {
      channel: 'C',
      expected: 'llm.baseUrl 存在且 mock.requests 数组可用',
      actual: JSON.stringify({ baseUrl: topo?.baseUrl ?? null, models: topo?.models ?? null }),
    })
    // 造上下文布局自检（findCutPoint keepRecentTokens 预算约束的可证伪前提：单条消息累计
    // 低于预算、两条消息累计越线 → 回溯首次超线停在第二条 user entry，被压段 = 第一条，非空）。
    ev.assert(
      '段0: 布局算术自检（单条消息累计 < keepRecentTokens ≤ 两条累计，切点落第二条 user entry）',
      CONTEXT_MSG_TOKENS < PI_KEEP_RECENT_TOKENS && 2 * CONTEXT_MSG_TOKENS >= PI_KEEP_RECENT_TOKENS,
      {
        channel: 'C',
        expected: `${CONTEXT_MSG_TOKENS} < ${PI_KEEP_RECENT_TOKENS} ≤ ${2 * CONTEXT_MSG_TOKENS}`,
        actual: `1×=${CONTEXT_MSG_TOKENS}, 2×=${2 * CONTEXT_MSG_TOKENS}, keepRecent=${PI_KEEP_RECENT_TOKENS}`,
      },
    )

    // ═══════════════════ 段 1 = V1：工具触发后台压缩 + 执行期两条消息不受限 ═══════════════════
    // 设计 V1 步骤：①造超线会话 ②触发后台压缩（工具路径）③执行期间连发两条消息 ④观察不被拒/不挂起。
    let cur0 = cursor()
    const created1 = await proto.call('session.create', { cwd, label: 'async-compaction-s1' }, { timeoutMs: 120_000 })
    const sid1 = created1.session?.id
    if (!sid1) throw new Error(`session.create 未返回 session.id：${JSON.stringify(created1).slice(0, 300)}`)
    await proto.subscribe(sid1)
    ev.step({ step: 's1.session-create', command: 'session.create', exitCode: 0, stats: { sessionId: sid1, cwd }, channel: 'B' })

    // ①造上下文：三条带哨兵的大消息（tokens 过工具档位 + keepRecentTokens 布局约束；此间
    // agent_settled 会 fire 提醒——V6 复燃判据的 fired marker 在此落盘）。
    const ctxLabels = ['V1-A', 'V1-B', 'V1-C']
    for (const tag of ctxLabels) {
      await proto.send(sid1, contextMessage(tag))
      await proto.waitTurnEnd(sid1, { timeoutMs: TURN_BUDGET_MS })
    }
    ev.step({
      step: 's1.context-seeded',
      command: 'proto.send x3 + waitTurnEnd',
      exitCode: 0,
      stats: { charsEach: CONTEXT_MSG_CHARS, tokensEach: CONTEXT_MSG_TOKENS, sentinel: SHADOW_SENTINEL, keepRecentBudget: PI_KEEP_RECENT_TOKENS },
      channel: 'B',
    })

    // ②诱导工具触发：演员回 toolCall(compact_context)（U4 = 启动后台任务立即返回回执）。
    await proto.send(sid1, '上下文已经很重了，请压缩当前会话上下文。')
    await waitForMockRequest(instance, 'mock-main', cur0.main, COMPACT_INFLIGHT_MS, 'V1 诱导轮主模型请求')
    // 工具结果落盘伴随信号：后台生成请求已到达 mock server（start() 同步返回后立即发起）。
    await waitForMockRequest(instance, 'mock-compact', cur0.compact, COMPACT_INFLIGHT_MS, 'V1 后台压缩生成请求')
    // 轮询等 toolResult entry 落盘（≤5s；GL1 断言对象）。失败时 dump JSONL 文件清单与
    // 尾部 entry 摘要（可归因：文件没找到 vs entry 形态/文本不匹配）。
    const jsonl1 = await (async () => {
      const t0 = Date.now()
      for (;;) {
        const f = findSessionJsonl(dataDir, sid1)
        if (f) {
          const snapshot = readSessionEntries(f)
          const { resultEntry } = extractToolPair(snapshot.entries, TOOL_NAME, BG_TOOL_ACK_PATTERN)
          if (resultEntry) return f
        }
        if (Date.now() - t0 > 5_000) {
          const tail = f
            ? readSessionEntries(f)
                .entries.slice(-8)
                .map((e) => ({
                  type: e?.type,
                  role: e?.message?.role,
                  toolName: e?.message?.toolName,
                  text: entryText(e).slice(0, 120),
                }))
            : null
          throw new Error(
            `V1: 工具结果 entry 5s 内未落盘（toolResult 提取失败）；jsonlFiles=${JSON.stringify(listSessionJsonlFiles(dataDir))}，targetSid=${sid1}，tail=${JSON.stringify(tail)}`,
          )
        }
        await new Promise((r) => setTimeout(r, 200))
      }
    })()
    const { callEntry: toolCallEntry, resultEntry: toolResultEntry, ackMs } = extractToolPair(
      readSessionEntries(jsonl1).entries,
      TOOL_NAME,
      BG_TOOL_ACK_PATTERN,
    )
    ev.assert('V1/GL1: compact_context 工具结果在 1s 内返回成功回执', ackMs >= 0 && ackMs <= TOOL_ACK_BUDGET_MS, {
      channel: 'C',
      expected: `0 ≤ Δtimestamp ≤ ${TOOL_ACK_BUDGET_MS}ms`,
      actual:
        `Δ=${ackMs}ms（call=${toolCallEntry?.id ?? '缺'}/${toolCallEntry?.timestamp ?? '缺'}，` +
        `result=${toolResultEntry?.id ?? '缺'}/${toolResultEntry?.timestamp ?? '缺'}）`,
    })
    ev.step({
      step: 's1.tool-triggered',
      command: 'compact_context（mock 演员诱导）',
      exitCode: ackMs >= 0 ? 0 : 1,
      stats: {
        ackMs,
        // mock 请求体 model 是裸 id（pi-ai buildParams），匹配容忍裸 id 与全形
        compactRequests: instance.mockLlm.requests.filter((r) => (r.model === 'mock-compact' || r.model?.endsWith('/mock-compact')) && r.status === 200).length,
      },
      channel: 'C',
    })

    // 收尾轮完成（工具结果后的下一轮回复）——此后 turn 空闲，D/E 的回合边界才确定。
    await proto.waitTurnEnd(sid1, { timeoutMs: TURN_BUDGET_MS })

    // ③压缩执行期间连发两条消息：此刻 mock-compact 在途（tps 节流 ≈30s 窗口），立即发 D/E。
    const rejectsSeen = []
    const duringMsgs = []
    for (const [tag, stepIdx] of [
      ['D', 's1.during-1'],
      ['E', 's1.during-2'],
    ]) {
      const text = `压缩执行期间的普通消息 ${tag}：请直接确认收到。`
      const tSend = Date.now()
      await proto.send(sid1, text)
      const end = await proto.waitTurnEnd(sid1, { timeoutMs: TURN_BUDGET_MS })
      const turnMs = Date.now() - tSend
      duringMsgs.push({ tag, text, completedAt: end.at, ok: end.ok })
      // 拒绝/挂起双断言：回合正常完成（waitTurnEnd 未抛且 stopReason 非 error）+ 事件流无 pi 拒绝文案。
      const rejectHit = proto.events.some((e) => JSON.stringify(e.payload ?? {}).includes(REJECT_MARK))
      if (rejectHit) rejectsSeen.push(tag)
      ev.assert(`V1/GL2: 压缩执行期间消息 ${tag} 正常进入回合（无拒绝、无挂起到压缩结束）`, !rejectHit && end.ok, {
        channel: 'B',
        expected: '回合正常完成且事件流无 pi 压缩期拒绝文案',
        actual: `turnMs=${turnMs}, rejectHit=${rejectHit}, endType=${end.type}, stopReason=${end.payload?.stopReason ?? '?'}`,
      })
      ev.step({ step: stepIdx, command: 'proto.send + waitTurnEnd', exitCode: rejectHit || !end.ok ? 1 : 0, stats: { tag, turnMs }, channel: 'B' })
    }
    ev.assert('V1/GL2: 全程无「Cannot submit a prompt while compaction is in progress」', rejectsSeen.length === 0, {
      channel: 'B',
      expected: '0 次拒绝',
      actual: `${rejectsSeen.length} 次（${rejectsSeen.join(', ') || '无'}）`,
    })

    // ④parentId 链衔接（C 通道）。
    const v1Jsonl = readSessionEntries(findSessionJsonl(dataDir, sid1))
    const chain1 = parentChainBroken(v1Jsonl.entries)
    ev.assert('V1: session JSONL 中压缩期间新消息 entry 的 parentId 链正常衔接', chain1 === null && v1Jsonl.badLines === 0, {
      channel: 'C',
      expected: '每条 entry 的 parentId 指向流中更早的 entry',
      actual: chain1 ? `断裂于 ${chain1.broken}（缺父 ${chain1.missingParent}）` : `坏行 ${v1Jsonl.badLines}`,
    })

    // ═══════════════════ 段 2 = V2：压缩完成 + 上下文切换 ═══════════════════
    // 设计 V2 步骤：①JSONL 出现 compaction entry ②发送依赖早期上下文的问题 ③观察下一次请求上下文。
    const v2Snap = await waitForCompactionEntry(sid1, 0, COMPACT_INFLIGHT_MS, 'V2')
    const comp = v2Snap.comps.at(-1)
    const firstKept = typeof comp?.firstKeptEntryId === 'string' ? v2Snap.entries.find((e) => e.id === comp.firstKeptEntryId) : null
    ev.assert('V2/GL4: compaction entry 落盘且 firstKeptEntryId 指向流中切点 entry', Boolean(comp?.firstKeptEntryId) && Boolean(firstKept), {
      channel: 'C',
      expected: 'firstKeptEntryId 可在 entry 流中解析',
      actual: JSON.stringify({ firstKeptEntryId: comp?.firstKeptEntryId ?? null, found: Boolean(firstKept), tokensBefore: comp?.tokensBefore ?? null }),
    })
    ev.assert(
      'V2/GL4: entry details 形态符合后台落盘契约（engine/mode/model/fromHook）',
      comp?.details?.engine === BG_ENTRY_DETAILS.engine && comp?.details?.mode === BG_ENTRY_DETAILS.mode && comp?.details?.model === BG_ENTRY_DETAILS.model && comp?.fromHook === true,
      {
        channel: 'C',
        expected: JSON.stringify({ ...BG_ENTRY_DETAILS, fromHook: true }),
        actual: JSON.stringify({ details: comp?.details ?? null, fromHook: comp?.fromHook ?? null }),
      },
    )
    ev.assert('V2/GL4: entry summary 含被压段要点（摘要哨兵在 summary 中）', typeof comp?.summary === 'string' && comp.summary.includes(SUMMARY_SENTINEL), {
      channel: 'C',
      expected: `summary 含 ${SUMMARY_SENTINEL}`,
      actual: `summary 长度=${typeof comp?.summary === 'string' ? comp.summary.length : '非字符串'}`,
    })
    // D/E 位于切点之后的保留段（树结构口径：切点 entry 行序早于 D；append-only 行序 = branch 序）。
    const msgDIndex = v2Snap.entries.findIndex((e) => entryText(e).includes('压缩执行期间的普通消息 D'))
    const firstKeptIndex = v2Snap.entries.findIndex((e) => e.id === comp?.firstKeptEntryId)
    ev.assert('V2/GL4: 压缩期间新消息（D）位于切点之后的保留段', firstKeptIndex >= 0 && msgDIndex > firstKeptIndex, {
      channel: 'C',
      expected: 'firstKeptEntryId 行序早于消息 D 行序（D 在保留段）',
      actual: `firstKeptIndex=${firstKeptIndex}, msgDIndex=${msgDIndex}`,
    })
    // V1/GL2 时序证据：D/E 回合完成早于压缩落盘（执行期不受限的直接后果）。
    const compTs = typeof comp?.timestamp === 'string' ? Date.parse(comp.timestamp) : NaN
    const duringEarlier = duringMsgs.every((m) => Number.isFinite(compTs) && m.completedAt < compTs)
    ev.assert('V1/GL2: 压缩期间两条消息的回合完成早于压缩落盘（未被挂起到压缩结束）', duringEarlier, {
      channel: 'B',
      expected: `D/E 完成时刻 < compaction entry 时刻（${Number.isFinite(compTs) ? new Date(compTs).toISOString() : '缺'}）`,
      actual: JSON.stringify(duringMsgs.map((m) => ({ tag: m.tag, completedAt: new Date(m.completedAt).toISOString(), ok: m.ok }))),
    })
    ev.step({
      step: 's2.compaction-entry',
      command: 'readSessionEntries',
      exitCode: 0,
      stats: { entryId: comp?.id, tokensBefore: comp?.tokensBefore ?? null, engine: comp?.details?.engine ?? null, fromHook: comp?.fromHook ?? null },
      channel: 'C',
    })

    // ③下一请求上下文 = 摘要 + 保留段 + 完成通知：发依赖早期上下文的问题，查请求体。
    const mainCountBeforeV2 = instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-main') && r.status === 200).length
    await proto.send(sid1, `${SHADOW_SENTINEL} 对应的关键事实是什么？请依据上下文回答。`)
    await proto.waitTurnEnd(sid1, { timeoutMs: TURN_BUDGET_MS })
    const v2Reqs = instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-main') && r.status === 200)
    const v2Request = v2Reqs[mainCountBeforeV2]
    const v2Ctx = requestMessagesText(v2Request)
    ev.assert('V2/GL3: 压缩后请求上下文含摘要（摘要哨兵进入消息列表）', v2Ctx.includes(SUMMARY_SENTINEL), {
      channel: 'B',
      expected: `请求 messages 含 ${SUMMARY_SENTINEL}`,
      actual: `含=${v2Ctx.includes(SUMMARY_SENTINEL)}，messages=${v2Request?.messages?.length ?? 0} 条`,
    })
    ev.assert('V2/GL3: 压缩后请求上下文不含被压段原文（被压段哨兵原文离开消息列表）', !v2Ctx.includes(shadowPrefix('V1-A')), {
      channel: 'B',
      expected: '被压段长文本不再出现在请求 messages',
      actual: `含=${v2Ctx.includes(shadowPrefix('V1-A'))}`,
    })
    ev.assert('V2: 后台压缩完成通知经 nextTurn 注入下一次请求（U5/D6）', v2Ctx.includes(BG_COMPLETE_NOTICE_PATTERN), {
      channel: 'B',
      expected: `请求 messages 含「${BG_COMPLETE_NOTICE_PATTERN}」`,
      actual: `含=${v2Ctx.includes(BG_COMPLETE_NOTICE_PATTERN)}`,
    })
    ev.step({
      step: 's2.context-switched',
      command: 'mock.requests 断言',
      exitCode: v2Ctx.includes(SUMMARY_SENTINEL) && v2Ctx.includes(BG_COMPLETE_NOTICE_PATTERN) ? 0 : 1,
      stats: { requestMessages: v2Request?.messages?.length ?? 0 },
      channel: 'B',
    })
    // C 通道：扩展调试日志的启动与落盘标记（U2/U3 证据）。
    const scLog1 = readSmartContextLog(dataDir)
    ev.assert(
      'V2/C: 扩展日志含后台任务启动与落盘标记（started(tool) + persisted）',
      scLog1.includes(`${BG_DEBUG_LOG_MARKER} started(tool)`) && scLog1.includes(`${BG_DEBUG_LOG_MARKER} persisted`),
      {
        channel: 'C',
        expected: `「${BG_DEBUG_LOG_MARKER} started(tool)」与「${BG_DEBUG_LOG_MARKER} persisted」均在 <agentDir>/logs/smart-context-*.log`,
        actual: `started=${scLog1.includes(`${BG_DEBUG_LOG_MARKER} started(tool)`)}, persisted=${scLog1.includes(`${BG_DEBUG_LOG_MARKER} persisted`)}, logBytes=${scLog1.length}`,
      },
    )
    ev.attach('v1v2-mock-requests', JSON.stringify(instance.mockLlm.requests.map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex, messageCount: r.messageCount })), null, 2))

    // ═══════════════════ 段 3 = V3：执行窗口推过窗口上限 → 原生同步压缩兜底 + 后台放弃 ═══════════════════
    // 新会话（会话 1 已有 compaction entry → tokens=null 挡工具触发，见文件头「mock 通道下 tokens 的可用性」）。
    const created2 = await proto.call('session.create', { cwd, label: 'async-compaction-s3' }, { timeoutMs: 120_000 })
    const sid3 = created2.session?.id
    await proto.subscribe(sid3)
    ev.step({ step: 's3.session-create', command: 'session.create', exitCode: 0, stats: { sessionId: sid3, backstopTokens: PI_BACKSTOP_TOKENS }, channel: 'B' })
    // ①三条造上下文（同 V1 布局）。
    const curV3 = cursor()
    for (const tag of ['V3-A', 'V3-B', 'V3-C']) {
      await proto.send(sid3, contextMessage(tag))
      await proto.waitTurnEnd(sid3, { timeoutMs: TURN_BUDGET_MS })
    }
    // ②工具触发后台压缩。compactBaseV3 = 本段开始前的压缩队列消费数。
    const compactBaseV3 = curV3.compact
    await proto.send(sid3, '请压缩当前会话上下文。')
    await proto.waitTurnEnd(sid3, { timeoutMs: TURN_BUDGET_MS }) // 收尾轮
    await waitForMockRequest(instance, 'mock-compact', compactBaseV3, COMPACT_INFLIGHT_MS, 'V3 后台压缩生成请求')
    ev.step({ step: 's3.bg-triggered', command: 'compact_context（mock 演员诱导）', exitCode: 0, stats: {}, channel: 'C' })
    // ③大消息把 tokens 推过原生兜底点（回合不拒——pi 发送侧无上限检查，mock 不产 400；
    //  settle 时自动触发被后台任务互斥挡住）。
    const oversize = `V3 大消息：${'超限填充'.repeat(OVERSIZE_MSG_CHARS / 4)}`
    await proto.send(sid3, oversize)
    await proto.waitTurnEnd(sid3, { timeoutMs: TURN_BUDGET_MS })
    ev.step({ step: 's3.oversize-sent', command: 'proto.send + waitTurnEnd', exitCode: 0, stats: { chars: oversize.length, backstopTokens: PI_BACKSTOP_TOKENS }, channel: 'B' })
    // ④再发恢复消息：下一轮请求前 pi shouldCompact（tokens > 兜底点）→ 原生同步压缩
    //   （session_before_compact 接管 cross-model → mock-compact 消费短文本 step）→
    //   落盘后 session_compact 事件取消后台任务（或后台落盘校验② preempted 放弃）。
    await proto.send(sid3, 'V3 恢复消息：请确认会话仍可用。')
    await proto.waitTurnEnd(sid3, { timeoutMs: TURN_BUDGET_MS + NATIVE_COMPACT_MS })
    const v3Snap = await waitForCompactionEntry(sid3, 0, NATIVE_COMPACT_MS, 'V3')
    const v3Compactions = v3Snap.comps
    ev.assert('V3/GL2: 推过窗口上限后由原生同步压缩完成恢复（会话可继续对话）', v3Compactions.length >= 1, {
      channel: 'C',
      expected: '≥1 条 compaction entry（原生产生）',
      actual: `${v3Compactions.length} 条`,
    })
    ev.assert('V3/GL4: 竞态周期 compaction entry 恰一条（后台任务放弃，不产生第二条）', v3Compactions.length === 1, {
      channel: 'C',
      expected: '恰 1 条（原生兜底的 entry；后台放弃不留痕）',
      actual: `${v3Compactions.length} 条（事件层 session_compact 先行取消时后台更早终止，两种放弃形态均合规——设计 V3 通过标准）`,
    })
    ev.assert('V3: 原生兜底 entry 由 smart-context 接管产生（details.engine 标记）', v3Compactions[0]?.details?.engine === DETAILS_ENGINE, {
      channel: 'C',
      expected: `details.engine=${DETAILS_ENGINE}`,
      actual: JSON.stringify(v3Compactions[0]?.details ?? null),
    })
    // C 通道：后台放弃的日志证据（cancelled: session_compact 或 persist rejected: preempted 二择一）。
    const scLog3 = readSmartContextLog(dataDir)
    const v3CancelMark = scLog3.includes(`${BG_DEBUG_LOG_MARKER} cancelled: session_compact`)
    const v3PreemptMark = scLog3.includes(`${BG_DEBUG_LOG_MARKER} persist rejected: preempted`)
    ev.assert('V3/C: 扩展日志含后台任务放弃标记（cancelled: session_compact 或 persist rejected: preempted）', v3CancelMark || v3PreemptMark, {
      channel: 'C',
      expected: '两形态择一在场（D3 双层防线：事件取消层或落盘校验层）',
      actual: `cancelled=${v3CancelMark}, preempted=${v3PreemptMark}`,
    })
    ev.step({
      step: 's3.native-backstop',
      command: 'readSessionEntries + smart-context log',
      exitCode: v3Compactions.length === 1 && (v3CancelMark || v3PreemptMark) ? 0 : 1,
      stats: { compactions: v3Compactions.length, bgDebugMarker: BG_DEBUG_LOG_MARKER, cancelled: v3CancelMark, preempted: v3PreemptMark },
      channel: 'C',
    })
    gotchas.push('V3 的「溢出错误处理」以 threshold 自动压缩承载（mock 通道不产 overflow 400）；两种放弃形态（事件取消 / 落盘校验②）按设计均合规。')

    // ═══════════════════ 段 4 = V4：执行期间 revoke 树回退 → 不取消、落盘无错位 ═══════════════════
    // 新会话；三条布局切点 = V4-B（user entry）。revoke V4-B（targetId 语义：该 entry（含）离开
    // 活跃链，revoke-orchestrator.ts verifyRewind）→ leaf 回到 ack-4a = 早于切点。
    const created3 = await proto.call('session.create', { cwd, label: 'async-compaction-s4' }, { timeoutMs: 120_000 })
    const sid4 = created3.session?.id
    await proto.subscribe(sid4)
    const curV4 = cursor()
    for (const tag of ['V4-A', 'V4-B', 'V4-C']) {
      await proto.send(sid4, contextMessage(tag))
      await proto.waitTurnEnd(sid4, { timeoutMs: TURN_BUDGET_MS })
    }
    // 工具触发后台压缩（在途期间执行回退）。
    const compactBaseV4 = curV4.compact
    await proto.send(sid4, '请压缩当前会话上下文。')
    await proto.waitTurnEnd(sid4, { timeoutMs: TURN_BUDGET_MS }) // 收尾轮（revoke 需 turn 空闲）
    await waitForMockRequest(instance, 'mock-compact', compactBaseV4, COMPACT_INFLIGHT_MS, 'V4 后台压缩生成请求')
    // revoke 切点 entry（V4-B）：回退到早于切点的位置（runtime revoke = sendSystemCommand 触发
    // pi navigateTree，packages/runtime/src/services/session/revoke-orchestrator.ts）。
    const cutEntry = findUserEntryByPrefix(readSessionEntries(findSessionJsonl(dataDir, sid4)).entries, shadowPrefix('V4-B'))
    if (!cutEntry?.id) throw new Error('V4: 未定位到切点 entry（V4-B user message）')
    const revoke = await proto.call('session.revokeMessage', { sessionId: sid4, targetId: cutEntry.id }, { timeoutMs: 60_000 })
    ev.assert('V4: revokeMessage 回执确认（树回退已发生，目标离开活跃链）', revoke?.revoked === true, {
      channel: 'B',
      expected: 'revoked:true',
      actual: JSON.stringify(revoke).slice(0, 200),
    })
    // 回退后继续对话 + 等后台压缩完成落盘。
    await proto.send(sid4, 'V4 回退后新分支消息。')
    await proto.waitTurnEnd(sid4, { timeoutMs: TURN_BUDGET_MS })
    const v4Snap = await waitForCompactionEntry(sid4, 0, COMPACT_INFLIGHT_MS, 'V4')
    ev.assert('V4/GL4: 会话内回退不取消压缩（后台 entry 正常落盘）', v4Snap.comps.length === 1, {
      channel: 'C',
      expected: '恰 1 条后台落盘 entry（回退不取消——设计 D3 rejected 论证）',
      actual: `${v4Snap.comps.length} 条`,
    })
    // 落盘后验证轮：投影 = 摘要 + 回退后新分支，无被撤子树内容、无被压段原文复活。
    const mainCountBeforeV4F = instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-main') && r.status === 200).length
    await proto.send(sid4, 'V4 落盘后验证：请概括当前上下文。')
    await proto.waitTurnEnd(sid4, { timeoutMs: TURN_BUDGET_MS })
    const v4CtxAfter = instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-main') && r.status === 200)[mainCountBeforeV4F]
    const v4CtxText = requestMessagesText(v4CtxAfter)
    const v4Leak = [shadowPrefix('V4-B'), shadowPrefix('V4-C'), 'V4 回退后新分支消息'].filter((t) => v4CtxText.includes(t))
    ev.assert('V4/GL4: 落盘后请求投影无被撤子树内容（V4-B/V4-C 原文不复活）', v4Leak.length === 0, {
      channel: 'B',
      expected: '请求 messages 不含被回退消息（V4-B/V4-C 原文）',
      actual: `leak=${JSON.stringify(v4Leak)}，messages=${v4CtxAfter?.messages?.length ?? 0} 条`,
    })
    // C 通道：session_tree 观测告警（回退不取消的机制证据）。
    const scLog4 = readSmartContextLog(dataDir)
    ev.assert('V4/C: 扩展日志含 session_tree 观测告警（回退期间任务保持）', scLog4.includes('session_tree during background compaction: keeping task'), {
      channel: 'C',
      expected: '「session_tree during background compaction: keeping task」（src/index.ts session_tree 监听）',
      actual: `含=${scLog4.includes('session_tree during background compaction: keeping task')}`,
    })
    ev.step({
      step: 's4.revoke-during-compact',
      command: 'session.revokeMessage + waitTurnEnd',
      exitCode: v4Snap.comps.length === 1 && v4Leak.length === 0 ? 0 : 1,
      stats: { compactions: v4Snap.comps.length, leaks: v4Leak.length },
      channel: 'B',
    })
    gotchas.push('V4 后台 entry 的 firstKeptEntryId（V4-B）已被回退带离活跃链——pi 投影对该形态的处理属设计 A1 已登记差异（快照集合判定落盘），本剧本以「落盘恰 1 条 + 投影无被撤内容」为验收口径。')

    // ═══════════════════ 段 5 = V5：执行期间手动压缩（同步豁免）→ 竞态、仅一条 entry ═══════════════════
    // 新会话；工具触发后台压缩在途 → 手动压缩走同步豁免路径。驱动通道 = session.compact RPC
    // （renderer /compact 命令的同一协议入口，packages/core/src/transport/api/domains/chat.ts
    // compact() → sendCommand('session.compact')；UI 键入交互登记 uncovered）。
    const created4 = await proto.call('session.create', { cwd, label: 'async-compaction-s5' }, { timeoutMs: 120_000 })
    const sid5 = created4.session?.id
    await proto.subscribe(sid5)
    const curV5 = cursor()
    for (const tag of ['V5-A', 'V5-B', 'V5-C']) {
      await proto.send(sid5, contextMessage(tag))
      await proto.waitTurnEnd(sid5, { timeoutMs: TURN_BUDGET_MS })
    }
    const compactBaseV5 = curV5.compact
    await proto.send(sid5, '请压缩当前会话上下文。')
    await proto.waitTurnEnd(sid5, { timeoutMs: TURN_BUDGET_MS }) // 收尾轮
    await waitForMockRequest(instance, 'mock-compact', compactBaseV5, COMPACT_INFLIGHT_MS, 'V5 后台压缩生成请求')
    // 手动压缩（同步完成 = 原生接管 cross-model 消费 mock-compact 短文本 step → 落盘 →
    // session_compact 事件取消后台任务）。
    await proto.call('session.compact', { sessionId: sid5 }, { timeoutMs: NATIVE_COMPACT_MS + 60_000 })
    const v5Snap = await waitForCompactionEntry(sid5, 0, NATIVE_COMPACT_MS, 'V5')
    ev.assert('V5/GL4: 手动压缩同步完成（原生产生 entry）', v5Snap.comps.length >= 1, {
      channel: 'C',
      expected: '≥1 条（/compact 同步路径产生）',
      actual: `${v5Snap.comps.length} 条`,
    })
    // 等后台任务了结：放弃发生在其生成完成后（cancelled 不落盘；若事件取消先到则更早终止）——
    // 确定性信号 = 该周期两步压缩生成请求均已被 mock server 消费，随后稳定窗口核对「仅一条」。
    await waitForMockRequest(instance, 'mock-compact', compactBaseV5 + 1, COMPACT_INFLIGHT_MS, 'V5 后台压缩生成请求（放弃路径的生成消费）')
    const tV5Stable = Date.now()
    let v5Final = []
    for (;;) {
      v5Final = compactionEntries(readSessionEntries(findSessionJsonl(dataDir, sid5)).entries)
      if (Date.now() - tV5Stable > 3_000) break
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert('V5/GL4: 竞态了结后 session JSONL 仅手动压缩的一条 compaction entry', v5Final.length === 1, {
      channel: 'C',
      expected: '恰 1 条',
      actual: `${v5Final.length} 条`,
    })
    const scLog5 = readSmartContextLog(dataDir)
    const v5CancelMark = scLog5.includes(`${BG_DEBUG_LOG_MARKER} cancelled: session_compact`)
    const v5PreemptMark = scLog5.includes(`${BG_DEBUG_LOG_MARKER} persist rejected: preempted`)
    ev.assert('V5/C: 扩展日志含后台任务放弃标记（cancelled: session_compact 或 persist rejected: preempted）', v5CancelMark || v5PreemptMark, {
      channel: 'C',
      expected: '两形态择一在场（D3 双层防线）',
      actual: `cancelled=${v5CancelMark}, preempted=${v5PreemptMark}`,
    })
    ev.step({
      step: 's5.manual-compact-race',
      command: 'session.compact（同步豁免路径）',
      exitCode: v5Final.length === 1 && (v5CancelMark || v5PreemptMark) ? 0 : 1,
      stats: { compactions: v5Final.length, cancelled: v5CancelMark, preempted: v5PreemptMark },
      channel: 'C',
    })
    uncovered.push('V5 手动压缩的 UI 键入交互（contenteditable 敲 /compact + 命令面板补全 + Enter）未覆盖——以 renderer compact() 的同一协议入口 session.compact RPC 承载（packages/core/src/transport/api/domains/chat.ts:217），压缩同步语义与竞态路径不受驱动通道影响。')

    // ═══════════════════ 段 6 = V6：切走再切回 → live ≡ reload + 档位不复燃 ═══════════════════
    // 切走 = session.switch 到段 3 会话；切回 = session.switch 回会话 1（压缩后形态）。
    const hist1Before = await proto.call('session.history', { sessionId: sid1 }, { timeoutMs: 30_000 })
    const hist1BeforeLen = hist1Before?.messages?.length ?? hist1Before?.entries?.length ?? -1
    await proto.call('session.switch', { sessionId: sid3 }, { timeoutMs: 60_000 })
    ev.step({ step: 's6.switch-away', command: 'session.switch → sid3', exitCode: 0, stats: { away: sid3 }, channel: 'B' })
    await proto.call('session.switch', { sessionId: sid1 }, { timeoutMs: 60_000 })
    await proto.subscribe(sid1)
    ev.step({ step: 's6.switch-back', command: 'session.switch → sid1', exitCode: 0, stats: { back: sid1 }, channel: 'B' })
    // live ≡ reload：切回后 history 结构与切走前一致。
    const hist1After = await proto.call('session.history', { sessionId: sid1 }, { timeoutMs: 30_000 })
    const hist1AfterLen = hist1After?.messages?.length ?? hist1After?.entries?.length ?? -1
    ev.assert('V6/GL3: 切走再切回后 history 结构一致（live ≡ reload）', hist1AfterLen >= 0 && hist1AfterLen === hist1BeforeLen, {
      channel: 'B',
      expected: `messages=${hist1BeforeLen}`,
      actual: `messages=${hist1AfterLen}`,
    })
    // 继续对话：restore 重建的 pi 从 JSONL 现算投影 → 请求仍为压缩后形态。
    const mainCountBeforeV6 = instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-main') && r.status === 200).length
    await proto.send(sid1, 'V6 切回后继续对话：请确认上下文正常。')
    await proto.waitTurnEnd(sid1, { timeoutMs: TURN_BUDGET_MS })
    const v6Reqs = instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-main') && r.status === 200)
    const v6Request = v6Reqs[mainCountBeforeV6]
    const v6Ctx = requestMessagesText(v6Request)
    ev.assert('V6/GL3: 切回后请求仍为压缩后形态（含摘要哨兵、不含被压段原文）', v6Ctx.includes(SUMMARY_SENTINEL) && !v6Ctx.includes(shadowPrefix('V1-A')), {
      channel: 'B',
      expected: '摘要哨兵在场且被压段原文离场',
      actual: `summaryIn=${v6Ctx.includes(SUMMARY_SENTINEL)}, shadowIn=${v6Ctx.includes(shadowPrefix('V1-A'))}`,
    })
    // 提醒档位不复燃：fired marker 在盘（C）+ 切回后无新增提醒注入（B）。
    // 口径：提醒经 nextTurn 注入后常驻请求上下文——切回后两条连续请求的提醒文案出现次数
    // 相等 = 中间 settle 无新增注入（若 seed 失效/复燃，第一条请求的 settle 会再 fire，
    // 第二条请求次数 +1）。新压缩周期首告（V2 问答 settle）合规，不在本断言禁止之列。
    const firedMarkers = readSessionEntries(findSessionJsonl(dataDir, sid1)).entries.filter(
      (e) => e?.type === 'custom' && e?.customType === FIRED_ENTRY_CUSTOM_TYPE,
    )
    ev.assert('V6/GL4: 已提醒档位 marker 持久化在 session entries（V1/V2 期落盘）', firedMarkers.length >= 1, {
      channel: 'C',
      expected: `≥1 条 ${FIRED_ENTRY_CUSTOM_TYPE} entry`,
      actual: `${firedMarkers.length} 条`,
    })
    const reminderCountAt6a = countOccurrences(requestMessagesText(v6Reqs.at(-1)), REMINDER_TEXT_MARK)
    await proto.send(sid1, 'V6 档位复燃检查：请直接确认。')
    await proto.waitTurnEnd(sid1, { timeoutMs: TURN_BUDGET_MS })
    const v6ReqsAfter = instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-main') && r.status === 200)
    const reminderCountAt6b = countOccurrences(requestMessagesText(v6ReqsAfter.at(-1)), REMINDER_TEXT_MARK)
    ev.assert('V6/GL4: 切回后同一档位不重复告警（相邻两请求的提醒注入数相等，无新增）', reminderCountAt6b === reminderCountAt6a, {
      channel: 'B',
      expected: `提醒文案出现次数恒定（切回后首请求 ${reminderCountAt6a}）`,
      actual: `检查轮 ${reminderCountAt6b}`,
    })
    // 压缩检查点 UI 可见（A 通道锚 + 截图）：UI 侧栏点击切到会话 1，对话流渲染压缩分隔行
    // （testid system-notice-text，文案「已压缩上下文」——docs/testing/02 与 panel.ts locale）。
    const page = await instance.page()
    const sid1Row = page.locator('.session-item', { hasText: 'async-compaction-s1' }).first()
    await sid1Row.click({ timeout: 15_000 })
    const checkpointVisible = await page
      .locator(`[data-testid="system-notice-text"]`, { hasText: '已压缩上下文' })
      .first()
      .isVisible()
      .catch(() => false)
    ev.assert('V6/GL4: 对话流压缩检查点可见（UI 分隔行）', checkpointVisible, {
      channel: 'A',
      expected: '[data-testid="system-notice-text"] 含「已压缩上下文」',
      actual: `visible=${checkpointVisible}`,
    })
    await ev.shot(page, 'v6-checkpoint-after-switch-back')
    ev.step({
      step: 's6.persistence',
      command: 'session.switch + history + UI',
      exitCode: checkpointVisible && reminderCountAt6b === reminderCountAt6a ? 0 : 1,
      stats: { historyMsgs: hist1AfterLen, firedMarkers: firedMarkers.length, reminderAt6a: reminderCountAt6a, reminderAt6b: reminderCountAt6b },
      channel: 'A',
    })

    log('async-compaction-background: V1-V6 全段执行完毕')
  } finally {
    // ── Cleanup（SKILL.md §5 顺序）──
    // §5 各步由 runner 承载（run.mjs）：1) kill 实例 PID（SIGTERM 优雅链）；2) 端口释放核对；
    // 3) mock pi 置换恢复（本剧本未置换）；4) verify-* 一次性数据目录删除；5) 证据幸存核对。
    // mock server 随 instance.stop 关闭。本剧本无自持子进程/监听端口，此处仅登记自查结果，
    // 不重复 dispose（幂等但会打乱 runner 的 keep 语义与断言记录）。
    const selfHeld = { childProcesses: 0, servers: 0, replacedPi: false }
    ev.step({
      step: 'cleanup.scenario-side',
      command: 'self-check（§5 主流程归 runner）',
      exitCode: 0,
      stats: { ...selfHeld, note: '剧本侧无自持资源；§5 顺序由 run.mjs disposeInstance → dataDir.cleanup → 证据幸存核对承载' },
      channel: 'C',
    })
  }

  return { uncovered, gotchas }
}
