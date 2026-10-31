/**
 * async-compaction-background —— 后台上下文压缩（async-compaction）D3 真机验收剧本骨架。
 *
 * 单剧本分段覆盖设计文档 §4.1 的 V1→V6 六个场景（权威源：
 * ~/.agents/skill-data/tech-design/feat-async-compaction-e49f375a/async-compaction/
 * async-compaction.rendered.md，下称「设计文档」）：
 *
 *   段 1 = V1  工具触发后台压缩，压缩执行期间连续发两条消息不被拒/不被掐断/不挂起（GL1/GL2）
 *   段 2 = V2  压缩完成后下一次请求自动切换压缩后上下文（摘要 + 保留段）（GL3/GL4）
 *   段 3 = V3  执行窗口内把投影推过窗口上限 → 原生同步压缩兜底恢复，后台任务落盘兜底校验放弃（GL2/GL4）
 *   段 4 = V4  执行期间会话内回退（revoke = navigateTree 树回退）→ 回退不取消压缩、落盘无错位（GL4）
 *   段 5 = V5  执行期间手动 /compact（同步豁免路径）→ /compact 正常完成、后台放弃、仅一条 entry（GL4）
 *   段 6 = V6  切走再切回该会话 → live ≡ reload + 提醒档位不因重载复燃（GL3/GL4）
 *
 * ── LLM 通道选型：mock-http（meta.llm），不用 faux ──
 *
 * 压缩生成本身是一次独立 LLM 调用（设计 §1.1/AS8）：
 *   - same-model 模式走 completeSimple 直调当前模型 provider（src/llm.ts:100 callSameModelCompaction）；
 *   - cross-model 模式走包导出 nativeCompact 调配置的 compactModel（src/compact-handler.ts:252-262）。
 * 两条路都是真实 HTTP 请求。通道判定的实测依据：
 *   - faux：extension 双注册共享同一响应队列，「主 loop turn 与 extension 内 LLM 调用按全局
 *     到达序 shift 消费同一脚本」（packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts 头注，
 *     探针实证）；faux 的 model-keyed 是 per-进程按 argv --model 选队（loadScript），同一 pi
 *     进程内压缩调用与回合调用无法按模型分队列——V1 的并发窗口（压缩在途 + 用户消息回合）
 *     下消费顺序非确定，队列排布不可稳定。
 *   - mock-http：model-keyed 队列按请求体 model 字段选队（scripts/lib/mock-llm.mjs:57-86，
 *     per-model 单游标），配合 cross-model 模式（compactModel 配独立 mock 模型）把「回合回复」
 *     与「压缩生成」分成两条互不干扰的队列；instance.mockLlm.requests 全量留档每次请求的
 *     model/messages/stepIndex（mock-llm.mjs:248-261）——「压缩生成调用真的发生、打到独立模型、
 *     携带全量上下文」均有铁证。
 * 因此本剧本固定 cross-model 装配：主会话模型 mockllm/mock-main（回合演员）、压缩模型
 * mockllm/mock-compact（压缩演员，pickMode 判 cross-model 的依据：compactModel.ref ≠ 当前模型，
 * src/pure.ts:127-131）。
 *
 * ── 装配（技能 helper，scenario 不自起进程）──
 *
 * 实例装配 = meta.llm 声明 → runner 调 scripts/lib/instance.mjs 的 ensureLlm（起 mock server、
 * 写 <dataDir>/agent/models.json / settings.json / subagents/config.json；models.json 里模型
 * contextWindow 硬编码 128_000、maxTokens 16_384，见 instance.mjs:429-437）。faux 通道的
 * seed-faux.mjs 不适用于本剧本（faux 队列语义不适配压缩调用，见上）。
 * 剧本自身零自持进程：mock server 与实例生命周期全归 runner（launch/dispose）。
 *
 * ── 触发线算术（本装配下的路径选择，设计 AS10 漂移代价量级②）──
 *
 * mock 模型窗口 = 128_000（instance.mjs 硬编码）；pi 原生 threshold 自动压缩兜底点 =
 * 窗口 − reserveTokens = 128_000 − 16_384 = 111_616（pi DEFAULT_COMPACTION_SETTINGS，设计 AS10）；
 * 后台触发线默认 = 0.9 × 128_000 = 115_200 > 111_616 → 本装配下「agent_settled 自动触发」
 * 被原生兜底反转（窗口 < 163_840 的既有边界），后台触发一律走 compact_context 工具入口
 * （设计入口矩阵①，V1 步骤②明确两条触发路径任一）。V3 恰好利用该反转验证原生同步压缩兜底。
 *
 * ── mock 通道下 tokens 的可用性（已核实 pi 源码）──
 *
 * mock 响应不携带 usage → pi 侧 estimateContextTokens 在无任何 assistant usage 时对全量消息
 * chars/4 估算、tokens 非 null（pi dist/core/compaction/compaction.js:110-135 的 !usageInfo 分支）
 * → 工具阈值保护、三档提醒、压缩 entry 判定全部可用。唯一例外：压缩 entry 之后无新 usage 的
 * 窗口内 getContextUsage 返回 tokens:null（pi dist/core/agent-session.js:3417-3423）——压缩后
 * tokens 不可知，工具触发会被阈值保护拒绝。因此 V3/V4/V5 各用独立新会话（新会话无 compaction
 * entry，tokens 恢复全量估算），V1+V2 共享会话 1，V6 切走（到段 3 会话）再切回会话 1。
 *
 * ── 顶部声明 ──
 *
 * - REPO：feat-async-compaction worktree 根（由 runner --repo flag / dev-flow D0 wrapper 注入
 *   ctx.repo，剧本不硬编码本机绝对路径）。工作目录样例 = <repo>/e2e/fixtures/sample-project。
 * - 数据目录：runner 分配的 ~/.taiji-dev/verify-<runId>（verify- 前缀一次性目录，run.mjs 缺省
 *   形态；dispose 时整树删除，见 run.mjs:439-456）。剧本经 ctx.dataDir 消费，不自定路径。
 * - artifactsDir：run.mjs --artifacts-dir（dev-flow D3 节点产物根）；verdict.json /
 *   summary.jsonl 由 runner 镜像到其根（run.mjs:527-542），inspect 节点读根。
 * - summary.jsonl 契约：本剧本每个业务步骤经 ctx.ev.step({step, command, exitCode, stats,
 *   channel}) 追加一行（六键恒在：step/command/exitCode/stats/channel/at；evidence.mjs §1.4）。
 * - 超时预算：
 *     实例就绪            180s（runner waitReady 缺省，run.mjs:349）
 *     单回合完成          60s（TURN_BUDGET_MS）
 *     压缩在途轮询        45s/次（COMPACT_INFLIGHT_MS；后台摘要经 tps 节流 ≈30s 窗口 + 余量）
 *     原生同步压缩窗口    30s（NATIVE_COMPACT_MS；同步接管 cross-model 生成 ≈10s + 余量）
 *     整体 estimateSec    1200s（六段串行：V1≈120 + V2≈60 + V3≈180 + V4≈120 + V5≈120 + V6≈90
 *                          + 启动/收尾余量）
 *
 * ── TODO-待实现落地（后台压缩代码并行落地中，本骨架按设计终态写断言）──
 *
 * 截至骨架编写（feat-async-compaction @ a872aab36），worktree 实码状态：
 *   - 已落地：pure.ts 的 autoCompactThresholdRatio 配置字段（默认 0.9、clamp [0,1]，含 normalize，
 *     commit a872aab36「u-foundation §3.3-D4」）；compact-handler 同步接管 / 工具 R2 降级态 /
 *     通知通道（现状行为，即 V7 反向基线）。
 *   - 未落地：U1 生成解耦、U2 后台任务状态机与事件取消、U3 落盘兜底校验、U4 工具纯触发化、
 *     U5 完成通知与进行中呈现（src/index.ts 无 agent_settled 后台触发接线；src/tool.ts 仍是
 *     ctx.compact() fire-and-forget 同步路径）。本剧本直接跑在现状代码上时 V1/V2 的后台断言
 *     应当失败（现状工具路径会掐断回合）——这正是验收对象。
 * 占位常量（BG_* 区）须在对应单元落地后回填，回填前剧本不可作为 D3 门槛证据。
 *
 * Cleanup（技能 SKILL.md §5）由 runner 承载：停实例（SIGTERM 优雅链）→ 端口释放核对 → mock
 * server 随 instance.stop 关闭 → verify-* 数据目录删除 → 证据幸存核对（run.mjs:293-325、
 * 434-456、458-466）。本剧本无自持子进程/服务，run() 的 finally 段只做剧本侧自查登记，
 * 不重复 dispose（幂等但会打乱 runner 的 keep 语义与断言记录）。
 */
import fs from 'node:fs'
import path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// 已落地常量（读自 feat-async-compaction worktree 实码，来源行号随行标注）
// ─────────────────────────────────────────────────────────────────────────────

/** compact_context 工具名（src/tool.ts:151 registerTool name）。 */
const TOOL_NAME = 'compact_context'
/** compaction entry 的 type（src/pure.ts:276 countCompactions 判据）。 */
const ENTRY_TYPE_COMPACTION = 'compaction'
/** 已提醒档位 marker 的 custom entry 类型（src/pure.ts:289，V6 复燃判据）。 */
const FIRED_ENTRY_CUSTOM_TYPE = 'smart-context:fired'
/** smart-context 通知文案前缀（src/reminder.ts:40、src/tool.ts:203）。 */
const NOTICE_TAG = '[smart-context]'
/** 三档提醒文案首行特征（src/reminder.ts:40 buildThresholdReminder）。 */
const REMINDER_TEXT_MARK = '已越提醒阈值'
/** 现状同步回执文案前缀（src/tool.ts:235「压缩已启动（…）」；U4 落地后改写，见 BG 区）。 */
const SYNC_ACK_PREFIX = '压缩已启动'
/** 同步完成通知文案前缀（src/tool.ts:203「[smart-context] 压缩完成。模式：…」）。 */
const SYNC_COMPLETE_MARK = `${NOTICE_TAG} 压缩完成`
/** pi 手动压缩期对 prompt 的拒绝文案（设计文档 §1.1 引 pi agent-session.js:1498-1500）。 */
const REJECT_MARK = 'Cannot submit a prompt while compaction is in progress'
/** compaction entry details.engine 标记（src/compact-handler.ts:72-77 SmartContextDetails）。 */
const DETAILS_ENGINE = 'smart-context'

/** 主会话模型（settings.json defaultModel，instance.mjs ensureLlm 写入）。 */
const MOCK_PROVIDER = 'mockllm'
const MOCK_MAIN_REF = `${MOCK_PROVIDER}/mock-main`
/** 压缩模型（cross-model 模式：compactModel.ref ≠ 当前模型 → pickMode 返回 cross-model）。 */
const MOCK_COMPACT_REF = `${MOCK_PROVIDER}/mock-compact`
/** mock 模型窗口（instance.mjs:434 硬编码 contextWindow）。 */
const MOCK_WINDOW = 128_000
/** pi 原生 threshold 自动压缩保留量（设计 AS10：pi DEFAULT_COMPACTION_SETTINGS.reserveTokens）。 */
const PI_RESERVE_TOKENS = 16_384
/** 原生兜底触发点（tokens 越过即下轮请求前同步压缩）。 */
const PI_BACKSTOP_TOKENS = MOCK_WINDOW - PI_RESERVE_TOKENS
/** 工具阈值保护与提醒共用的档位配置（工具放行要求 tokens ≥ 最小档，src/pure.ts:152-164）。 */
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
/** mock 流式节流（tps：内容按 4 字符≈1 token 切块；mock-llm.mjs:284-309）。 */
const MOCK_TPS = 10
/** 后台摘要 step 文本长度（≈1200 chars × 25ms/char @tps10 ≈ 30s 执行窗口，实现期校准）。 */
const BG_SUMMARY_CHARS = 1_200
/** 原生同步摘要 step 文本长度（≈400 chars ≈ 10s，同步阻塞期预算内）。 */
const NATIVE_SUMMARY_CHARS = 400
/** 造上下文单条消息的字符量（≈20KB chars ≈ 5_000 tokens，两条过 8_000 档）。 */
const CONTEXT_MSG_CHARS = 20_000
/** V3 大消息字符量（> PI_BACKSTOP_TOKENS × 4 chars，推过原生兜底点）。 */
const OVERSIZE_MSG_CHARS = PI_BACKSTOP_TOKENS * 4 + 20_000

// ─────────────────────────────────────────────────────────────────────────────
// TODO-待实现落地：占位常量（后台压缩代码落地后回填，回填前剧本不可作 D3 门槛证据）
// ─────────────────────────────────────────────────────────────────────────────

/** TODO(U4 工具纯触发化)：后台化后 compact_context 的成功回执文案模式（设计 checkpoint：措辞
 *  实现期定稿）。落地前用现状前缀占位（现状即同步回执，见 SYNC_ACK_PREFIX）。 */
const BG_TOOL_ACK_PATTERN = SYNC_ACK_PREFIX
/** TODO(U5 完成通知)：后台落盘成功通知的文案模式（现状同步路径文案 = SYNC_COMPLETE_MARK；
 *  U5 后含压缩前后 token 数与模式，设计 D6）。 */
const BG_COMPLETE_NOTICE_PATTERN = SYNC_COMPLETE_MARK
/** TODO(U5 失败通知)：后台失败通知文案模式（现状 = `${NOTICE_TAG} 压缩失败：`，src/tool.ts:220）。 */
const BG_FAIL_NOTICE_PATTERN = `${NOTICE_TAG} 压缩失败`
/** TODO(U2 后台任务)：扩展调试日志里「后台压缩启动/落盘/放弃」的日志标记（debugLog 文案未定稿；
 *  落地后用于 V1 时序与 V3/V5 放弃路径的 C 通道日志证据）。 */
const BG_DEBUG_LOG_MARKER = null
/** TODO(U3 落盘)：后台路径 compaction entry 的 details 形态（现状 SmartContextDetails 三字段
 *  engine/mode/model 预计沿用；后台 mode 取值与 cross-model 落地后核对）。 */
const BG_ENTRY_DETAILS = { engine: DETAILS_ENGINE }

// ─────────────────────────────────────────────────────────────────────────────
// mock 演员队列（model-keyed；串行段执行下 per-model 单游标全局连续，见 mock-llm.mjs:26-33。
// 段消费数用 mockLlm.pending() 游标差计量，requests 全程留证不 reset。
// 步数与文本为实现期校准基线：演员文本无语义，断言靠 requests/messages/JSONL 三处证据源。）
// ─────────────────────────────────────────────────────────────────────────────

/** 造上下文消息文本（哨兵埋在被压段）。 */
function contextMessage(label) {
  return `async-compaction 背景材料 ${label}：本段细节含 ${SHADOW_SENTINEL}（关键事实码，压缩后应经摘要保留）。${'填充'.repeat(CONTEXT_MSG_CHARS / 2 - 100)}`
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
    { text: 'ack-1a 收到背景材料（V1 造上下文 A）', stopReason: 'stop' },
    { text: 'ack-1b 收到背景材料（V1 造上下文 B）', stopReason: 'stop' },
    { toolCalls: [{ name: TOOL_NAME, args: {} }] }, // V1 诱导轮：模型决定调压缩工具
    { text: 'ack-1c 压缩已请求，继续工作（工具结果后的收尾轮）', stopReason: 'stop' },
    { text: 'ack-1d 压缩期第一条消息照常回复', stopReason: 'stop' },
    { text: 'ack-1e 压缩期第二条消息照常回复', stopReason: 'stop' },
    { text: `ack-2a 依据摘要回答：${SHADOW_SENTINEL} 的要点见压缩摘要（V2 问答轮）`, stopReason: 'stop' },
    // ── 会话 2（段 3 V3；接在会话 1 游标之后，无 reset）──
    { text: 'ack-3a 大消息回合照常回复（窗口已超限，回合不拒）', stopReason: 'stop' },
    { toolCalls: [{ name: TOOL_NAME, args: {} }] }, // V3 诱导轮：工具触发后台压缩
    { text: 'ack-3b 后台压缩已请求（收尾轮）', stopReason: 'stop' },
    { text: 'ack-3c 原生同步压缩兜底后的恢复回合', stopReason: 'stop' },
    // ── 会话 3（段 4 V4）──
    { text: 'ack-4a 保留段消息 B（V4 造上下文）', stopReason: 'stop' },
    { text: 'ack-4b 保留段消息 C（V4 造上下文）', stopReason: 'stop' },
    { toolCalls: [{ name: TOOL_NAME, args: {} }] }, // V4 诱导轮
    { text: 'ack-4c 后台压缩已请求（收尾轮）', stopReason: 'stop' },
    { text: 'ack-4d 回退后新分支上的对话回复', stopReason: 'stop' },
    // ── 会话 4（段 5 V5：/compact 为本地命令，不消费 mock-main）──
    { text: 'ack-5a 造上下文回复', stopReason: 'stop' },
    { toolCalls: [{ name: TOOL_NAME, args: {} }] }, // V5 诱导轮
    { text: 'ack-5b 后台压缩已请求（收尾轮）', stopReason: 'stop' },
    // ── 会话 1 切回（段 6 V6）──
    { text: 'ack-6a 切回后继续对话回复（压缩后形态）', stopReason: 'stop' },
    { text: 'ack-6b 档位复燃检查轮回复', stopReason: 'stop' },
  ]
}

/** mock-compact 压缩演员队列（每次压缩生成消费 1-2 步：cross-model 的 nativeCompact 在
 *  split-turn 形态下发 history + turnPrefix 两次调用，设计 AS8；步数给足余量，实现期按
 *  pending() 游标差校准每次压缩的真实消费数）。
 *  步序 = 请求到达序（FIFO）：各竞态段内「后台生成先发起→长文本 step（拉出执行窗口），
 *  原生/手动压缩后到→短文本 step（控制同步阻塞期）」。 */
function buildCompactQueue() {
  return [
    bgSummaryStep('v1'), // 段 1：V1 后台压缩生成（长文本 = ≈30s 执行窗口）
    bgSummaryStep('v3-bg'), // 段 3：V3 后台压缩生成（先到，长文本窗口；完成后落盘校验②放弃）
    nativeSummaryStep('v3-native'), // 段 3：V3 原生 threshold 同步压缩（后到；before_compact 接管 cross-model）
    bgSummaryStep('v4'), // 段 4：V4 后台压缩生成（回退不取消，正常落盘）
    bgSummaryStep('v5-bg'), // 段 5：V5 后台压缩生成（先到；完成后放弃，仅 /compact 一条 entry）
    nativeSummaryStep('v5-compact'), // 段 5：V5 /compact 同步压缩（后到；接管 cross-model）
  ]
}

export const meta = {
  id: 'async-compaction-background',
  priority: 'P2', // 设计文档头部「功能分级 P2」
  title: '后台上下文压缩 V1-V6：触发回执 / 执行期不受限 / 上下文切换 / 兜底与竞态放弃 / 回退不取消 / 持久化一致',
  covers: ['session.create', 'chat.send', 'chat.wait', 'chat.revoke', 'session.switch', 'session.history'],
  requires: ['mock-http'],
  estimateSec: 1200,
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
    'V2/GL3: 压缩完成后下一次请求上下文 = 摘要 + 保留段（请求体含摘要哨兵、不含被压段哨兵原文）',
    'V2/GL4: compaction entry 落盘（type/summary 含被压段要点/firstKeptEntryId/tokensBefore 字段齐全）',
    'V3/GL2: 推过窗口上限后由原生同步压缩完成恢复（会话不卡死，可继续对话）',
    'V3/GL4: 原生压缩与后台任务同窗竞态下，该周期 compaction entry 恰一条（后台放弃不落第二条）',
    'V4/GL4: 执行期间 revoke 树回退不取消压缩，后台 entry 正常落盘且投影无被撤子树内容',
    'V5/GL4: 执行期间 /compact 同步完成，最终仅 /compact 产生的一条 compaction entry',
    'V6/GL3: 切走再切回后 live ≡ reload（history 结构一致 + 继续对话请求仍为压缩后上下文）',
    'V6/GL4: 对话流压缩检查点可见（UI），提醒档位不因重载复燃（fired marker 在盘、无新提醒）',
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
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// 剧本 helper（只做驱动 / 断言 / 取证，不实现产品语义——API-CONTRACT §0）
// ─────────────────────────────────────────────────────────────────────────────

/** 写 smart-context 配置（<agentDir>/config/smart-context-ext-config.json，llm-shared config.ts:39-41；
 *  loadConfig 按 mtime+size 读时刷新——launch 后写入即刻生效，extensions/shared/llm-shared/src/config.ts）。 */
function writeSmartContextConfig(dataDir) {
  const file = path.join(dataDir, 'agent', 'config', 'smart-context-ext-config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const config = {
    enabled: true,
    compactModel: { type: 'ref', ref: MOCK_COMPACT_REF },
    reminderThresholds: [...REMINDER_TIERS],
    excludedModels: [],
    autoCompactThresholdRatio: 0.9, // 默认值显式落盘（src/pure.ts:32 DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO）
  }
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return { file, config }
}

/** 定位 session JSONL（<dataDir>/agent/sessions/<编码cwd>/<sid>.jsonl，startup-records-fixture.mjs:10；
 *  cwd 编码规则是 pi 内部实现，不进剧本——按会话 id 递归查找）。 */
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
    const hit = names.find((n) => n === `${sessionId}.jsonl`)
    if (hit) return path.join(dir, hit)
    for (const n of names) {
      const full = path.join(dir, n)
      if (fs.statSync(full).isDirectory()) stack.push(full)
    }
  }
  return null
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
  return entries.filter((e) => e.type === ENTRY_TYPE_COMPACTION)
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

/** 在 entry 流中定位含目标文本的 user 消息 entry（V4 revoke 的 targetId 数据源）。 */
function findUserEntryBySentinel(entries, sentinel) {
  return entries.find(
    (e) =>
      e?.type === 'message' &&
      e?.message?.role === 'user' &&
      entryText(e).includes(sentinel),
  )
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

// ─────────────────────────────────────────────────────────────────────────────
// 剧本主体
// ─────────────────────────────────────────────────────────────────────────────

export async function run(ctx) {
  const { instance, protocol: proto, ev, log, dataDir, repo } = ctx
  const cwd = path.join(repo, 'e2e', 'fixtures', 'sample-project')
  const uncovered = []
  const gotchas = []

  /** 记段级 main/compact 队列游标（段消费数 = 差值，requests 全程留证）。 */
  const cursor = () => ({ main: instance.mockLlm?.pending()?.[MOCK_MAIN_REF] ?? 0, compact: instance.mockLlm?.pending()?.[MOCK_COMPACT_REF] ?? 0 })

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

    // ═══════════════════ 段 1 = V1：工具触发后台压缩 + 执行期两条消息不受限 ═══════════════════
    // 设计 V1 步骤：①造超线会话 ②触发后台压缩（工具路径）③执行期间连发两条消息 ④观察不被拒/不挂起。
    let cur0 = cursor()
    const created1 = await proto.call('session.create', { cwd, label: 'async-compaction-s1' }, { timeoutMs: 120_000 })
    const sid1 = created1.session?.id
    if (!sid1) throw new Error(`session.create 未返回 session.id：${JSON.stringify(created1).slice(0, 300)}`)
    await proto.subscribe(sid1)
    ev.step({ step: 's1.session-create', command: 'session.create', exitCode: 0, stats: { sessionId: sid1, cwd }, channel: 'B' })

    // ①造上下文：两条带哨兵的大消息（tokens 过工具档位 REMINDER_TIERS[0]；此间 agent_settled
    // 会 fire 第一档提醒——V6 复燃判据的 fired marker 在此落盘）。
    for (const tag of ['A', 'B']) {
      await proto.send(sid1, contextMessage(tag))
      await proto.waitTurnEnd(sid1, { timeoutMs: TURN_BUDGET_MS })
    }
    ev.step({ step: 's1.context-seeded', command: 'proto.send x2 + waitTurnEnd', exitCode: 0, stats: { charsEach: CONTEXT_MSG_CHARS, sentinel: SHADOW_SENTINEL }, channel: 'B' })

    // ②诱导工具触发：演员回 toolCall(compact_context)（U4 落地后 = 启动后台任务立即返回回执）。
    await proto.send(sid1, '上下文已经很重了，请压缩当前会话上下文。')
    await waitForMockRequest(instance, 'mock-main', cur0.main, COMPACT_INFLIGHT_MS, 'V1 诱导轮主模型请求')
    const jsonl1 = await (async () => {
      // 工具结果落盘需要一点时间——以 mock-compact 请求出现（后台生成已启动）为「回执已产出」的
      // 伴随信号，再读 JSONL 提取 toolCall/toolResult 对。
      await waitForMockRequest(instance, 'mock-compact', cur0.compact, COMPACT_INFLIGHT_MS, 'V1 后台压缩生成请求')
      const f = findSessionJsonl(dataDir, sid1)
      if (!f) throw new Error(`未定位到 session JSONL：sid=${sid1}`)
      return f
    })()
    const entriesAfterTool = readSessionEntries(jsonl1)
    const toolCallEntry = entriesAfterTool.entries.find(
      (e) => JSON.stringify(e).includes(TOOL_NAME) && JSON.stringify(e).includes('"toolCall"'),
    )
    const toolResultEntry = entriesAfterTool.entries.find(
      (e) => JSON.stringify(e).includes(TOOL_NAME) && entryText(e).includes(BG_TOOL_ACK_PATTERN),
    )
    const ackMs =
      toolCallEntry && toolResultEntry && typeof toolCallEntry.timestamp === 'number' && typeof toolResultEntry.timestamp === 'number'
        ? toolResultEntry.timestamp - toolCallEntry.timestamp
        : -1
    ev.assert('V1/GL1: compact_context 工具结果在 1s 内返回成功回执', ackMs >= 0 && ackMs <= TOOL_ACK_BUDGET_MS, {
      channel: 'C',
      expected: `0 ≤ Δtimestamp ≤ ${TOOL_ACK_BUDGET_MS}ms`,
      actual: `Δ=${ackMs}ms（toolCall/toolResult entry 提取${toolCallEntry && toolResultEntry ? '成功' : '失败——实现期按 entry 实际形态校准提取函数'}）`,
    })
    ev.step({ step: 's1.tool-triggered', command: 'compact_context（mock 演员诱导）', exitCode: ackMs >= 0 ? 0 : 1, stats: { ackMs, compactRequests: instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-compact') && r.status === 200).length }, channel: 'C' })

    // ③压缩执行期间连发两条消息：此刻 mock-compact 在途（tps 节流 ≈30s 窗口），立即发 MSG-D/E。
    const rejectsSeen = []
    for (const [tag, stepIdx] of [['D', 's1.during-1'], ['E', 's1.during-2']]) {
      const tSend = Date.now()
      await proto.send(sid1, `压缩执行期间的普通消息 ${tag}：请直接确认收到。`)
      await proto.waitTurnEnd(sid1, { timeoutMs: TURN_BUDGET_MS })
      const turnMs = Date.now() - tSend
      // 拒绝/挂起双断言：回合正常完成（waitTurnEnd 未抛）+ 事件流无 pi 拒绝文案。
      const rejectHit = proto.events.some((e) => JSON.stringify(e.payload ?? {}).includes(REJECT_MARK))
      if (rejectHit) rejectsSeen.push(tag)
      ev.assert(`V1/GL2: 压缩执行期间消息 ${tag} 正常进入回合（无拒绝、无挂起到压缩结束）`, !rejectHit, {
        channel: 'B',
        expected: '回合正常完成且事件流无 pi 压缩期拒绝文案',
        actual: `turnMs=${turnMs}, rejectHit=${rejectHit}`,
      })
      ev.step({ step: stepIdx, command: 'proto.send + waitTurnEnd', exitCode: rejectHit ? 1 : 0, stats: { tag, turnMs }, channel: 'B' })
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
    // 等待后台压缩落盘：mock-compact 消费推进（生成完成）后轮询 JSONL 出现 entry。
    const tCompact = Date.now()
    let v2Entries = null
    for (;;) {
      const snapshot = readSessionEntries(findSessionJsonl(dataDir, sid1))
      if (compactionEntries(snapshot.entries).length > 0) {
        v2Entries = snapshot
        break
      }
      if (Date.now() - tCompact > COMPACT_INFLIGHT_MS) {
        throw new Error(`V2: 等待 compaction entry 落盘超时（${COMPACT_INFLIGHT_MS}ms）——后台压缩未落盘`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    const comp = compactionEntries(v2Entries.entries).at(-1)
    const firstKept = typeof comp?.firstKeptEntryId === 'string' ? v2Entries.entries.find((e) => e.id === comp.firstKeptEntryId) : null
    ev.assert('V2/GL4: compaction entry 落盘且 firstKeptEntryId 指向流中切点 entry', Boolean(comp?.firstKeptEntryId) && Boolean(firstKept), {
      channel: 'C',
      expected: 'firstKeptEntryId 可在 entry 流中解析',
      actual: JSON.stringify({ firstKeptEntryId: comp?.firstKeptEntryId ?? null, found: Boolean(firstKept), tokensBefore: comp?.tokensBefore ?? null }),
    })
    ev.assert('V2/GL4: entry summary 含被压段要点（摘要哨兵在 summary 中）', typeof comp?.summary === 'string' && comp.summary.includes(SUMMARY_SENTINEL), {
      channel: 'C',
      expected: `summary 含 ${SUMMARY_SENTINEL}`,
      actual: `summary 长度=${typeof comp?.summary === 'string' ? comp.summary.length : '非字符串'}`,
    })
    ev.assert('V2: 压缩期间新消息（D/E）位于 entry 之后的保留段（append-only 顺序）', v2Entries.entries.indexOf(comp) < v2Entries.entries.findIndex((e) => entryText(e).includes('压缩执行期间的普通消息 D')), {
      channel: 'C',
      expected: 'compaction entry 行序早于压缩期间新消息行',
      actual: `compactionIndex=${v2Entries.entries.indexOf(comp)}, msgDIndex=${v2Entries.entries.findIndex((e) => entryText(e).includes('压缩执行期间的普通消息 D'))}`,
    })
    ev.step({ step: 's2.compaction-entry', command: 'readSessionEntries', exitCode: 0, stats: { entryId: comp?.id, tokensBefore: comp?.tokensBefore ?? null, engine: comp?.details?.engine ?? null }, channel: 'C' })

    // ③下一请求上下文 = 摘要 + 保留段：发依赖早期上下文的问题，查请求体。
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
    ev.assert('V2/GL3: 压缩后请求上下文不含被压段原文（被压段哨兵原文离开消息列表）', !v2Ctx.includes(contextMessage('A').slice(0, 80)), {
      channel: 'B',
      expected: '被压段长文本不再出现在请求 messages',
      actual: `含=${v2Ctx.includes(contextMessage('A').slice(0, 80))}`,
    })
    ev.step({ step: 's2.context-switched', command: 'mock.requests 断言', exitCode: v2Ctx.includes(SUMMARY_SENTINEL) ? 0 : 1, stats: { requestMessages: v2Request?.messages?.length ?? 0 }, channel: 'B' })
    ev.attach('v1v2-mock-requests', JSON.stringify(instance.mockLlm.requests.map((r) => ({ model: r.model, status: r.status, stepIndex: r.stepIndex, messageCount: r.messageCount })), null, 2))

    // ═══════════════════ 段 3 = V3：执行窗口推过窗口上限 → 原生同步压缩兜底 + 后台放弃 ═══════════════════
    // 新会话（会话 1 已有 compaction entry → tokens=null 挡工具触发，见文件头「mock 通道下 tokens 的可用性」）。
    const created2 = await proto.call('session.create', { cwd, label: 'async-compaction-s3' }, { timeoutMs: 120_000 })
    const sid3 = created2.session?.id
    await proto.subscribe(sid3)
    ev.step({ step: 's3.session-create', command: 'session.create', exitCode: 0, stats: { sessionId: sid3, backstopTokens: PI_BACKSTOP_TOKENS }, channel: 'B' })
    // ①大消息把 tokens 推过原生兜底点（回合不拒——pi 发送侧无上限检查，mock 不产 400）。
    const oversize = `V3 大消息：${'超限填充'.repeat(OVERSIZE_MSG_CHARS / 4)}`
    await proto.send(sid3, oversize)
    await proto.waitTurnEnd(sid3, { timeoutMs: TURN_BUDGET_MS })
    ev.step({ step: 's3.oversize-sent', command: 'proto.send + waitTurnEnd', exitCode: 0, stats: { chars: oversize.length, backstopTokens: PI_BACKSTOP_TOKENS }, channel: 'B' })
    // ②工具触发后台压缩（大消息已过工具档位）。compactBase = 本段开始前的压缩队列消费数
    // （等待条件「消费数越过基线」= V3 的后台生成请求已到达 mock server）。
    const compactBaseV3 = cursor().compact
    await proto.send(sid3, '请压缩当前会话上下文。')
    await waitForMockRequest(instance, 'mock-compact', compactBaseV3, COMPACT_INFLIGHT_MS, 'V3 后台压缩生成请求')
    ev.step({ step: 's3.bg-triggered', command: 'compact_context（mock 演员诱导）', exitCode: 0, stats: {}, channel: 'C' })
    // ③再发一条消息：下一轮请求前 pi shouldCompact（tokens > 兜底点）→ 原生同步压缩（before_compact
    // 接管 cross-model → mock-compact 消费）→ 完成后回合恢复。
    await proto.send(sid3, 'V3 恢复消息：请确认会话仍可用。')
    await proto.waitTurnEnd(sid3, { timeoutMs: TURN_BUDGET_MS + NATIVE_COMPACT_MS })
    const v3Jsonl = readSessionEntries(findSessionJsonl(dataDir, sid3))
    const v3Compactions = compactionEntries(v3Jsonl.entries)
    ev.assert('V3/GL2: 推过窗口上限后由原生同步压缩完成恢复（会话可继续对话）', v3Compactions.length >= 1, {
      channel: 'C',
      expected: '≥1 条 compaction entry（原生产生）',
      actual: `${v3Compactions.length} 条`,
    })
    ev.assert('V3/GL4: 竞态周期 compaction entry 恰一条（后台任务落盘校验②放弃，不产生第二条）', v3Compactions.length === 1, {
      channel: 'C',
      expected: '恰 1 条（原生兜底的 entry；后台放弃不留痕）',
      actual: `${v3Compactions.length} 条（事件层 session_compact 先行取消时后台更早终止，两种放弃形态均合规——设计 V3 通过标准）`,
    })
    ev.step({ step: 's3.native-backstop', command: 'readSessionEntries', exitCode: v3Compactions.length === 1 ? 0 : 1, stats: { compactions: v3Compactions.length, bgDebugMarker: BG_DEBUG_LOG_MARKER }, channel: 'C' })
    gotchas.push('V3 的「溢出错误处理」以 threshold 自动压缩承载（mock 通道不产 overflow 400）；扩展日志中的后台放弃标记（BG_DEBUG_LOG_MARKER）待 U2 落地后补抓 C 通道日志证据。')

    // ═══════════════════ 段 4 = V4：执行期间 revoke 树回退 → 不取消、落盘无错位 ═══════════════════
    // 新会话；造「被压段 + 保留段」布局，revoke 保留段首条 user 消息 = navigateTree 回退到早于切点。
    const created3 = await proto.call('session.create', { cwd, label: 'async-compaction-s4' }, { timeoutMs: 120_000 })
    const sid4 = created3.session?.id
    await proto.subscribe(sid4)
    await proto.send(sid4, contextMessage('V4-被压段'))
    await proto.waitTurnEnd(sid4, { timeoutMs: TURN_BUDGET_MS })
    await proto.send(sid4, 'V4 保留段消息 C（切点后第一条，将被回退）')
    await proto.waitTurnEnd(sid4, { timeoutMs: TURN_BUDGET_MS })
    // 工具触发后台压缩（在途期间执行回退）。
    const compactBaseV4 = cursor().compact
    await proto.send(sid4, '请压缩当前会话上下文。')
    await waitForMockRequest(instance, 'mock-compact', compactBaseV4, COMPACT_INFLIGHT_MS, 'V4 后台压缩生成请求')
    // revoke 保留段首条 user 消息（C 之后全部离开活跃路径 → leaf 回到早于切点位置；runtime 侧
    // revoke = sendSystemCommand 触发 pi navigateTree，packages/runtime/src/services/session/revoke-orchestrator.ts:7）。
    const keptEntry = findUserEntryBySentinel(readSessionEntries(findSessionJsonl(dataDir, sid4)).entries, 'V4 保留段消息 C')
    const revoke = await proto.call('session.revokeMessage', { sessionId: sid4, targetId: keptEntry?.id }, { timeoutMs: 60_000 })
    ev.assert('V4: revokeMessage 回执确认（树回退已发生）', revoke?.revoked === true, {
      channel: 'B',
      expected: 'revoked:true',
      actual: JSON.stringify(revoke).slice(0, 200),
    })
    // 回退后继续对话 + 等后台压缩完成落盘。
    await proto.send(sid4, 'V4 回退后新分支消息。')
    await proto.waitTurnEnd(sid4, { timeoutMs: TURN_BUDGET_MS })
    const tV4 = Date.now()
    let v4Compactions = []
    for (;;) {
      v4Compactions = compactionEntries(readSessionEntries(findSessionJsonl(dataDir, sid4)).entries)
      if (v4Compactions.length > 0) break
      if (Date.now() - tV4 > COMPACT_INFLIGHT_MS) break
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert('V4/GL4: 会话内回退不取消压缩（后台 entry 正常落盘）', v4Compactions.length === 1, {
      channel: 'C',
      expected: '恰 1 条后台落盘 entry（回退不取消——设计 D3 rejected 论证）',
      actual: `${v4Compactions.length} 条`,
    })
    const v4CtxAfter = instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-main') && r.status === 200).at(-1)
    const v4CtxText = requestMessagesText(v4CtxAfter)
    ev.assert('V4/GL4: 回退后请求投影无被撤子树内容（被压段原文不复活、回退消息不出现）', !v4CtxText.includes('V4 保留段消息 C'), {
      channel: 'B',
      expected: '请求 messages 不含被回退消息',
      actual: `含=${v4CtxText.includes('V4 保留段消息 C')}，messages=${v4CtxAfter?.messages?.length ?? 0} 条`,
    })
    ev.step({ step: 's4.revoke-during-compact', command: 'session.revokeMessage + waitTurnEnd', exitCode: v4Compactions.length === 1 ? 0 : 1, stats: { compactions: v4Compactions.length }, channel: 'B' })
    gotchas.push('V4 的「session_tree 仅观测告警」日志证据依赖 U2 的事件监听落地（BG_DEBUG_LOG_MARKER），骨架以落盘结果反证不取消。')

    // ═══════════════════ 段 5 = V5：执行期间手动 /compact（同步豁免）→ 竞态、仅一条 entry ═══════════════════
    // 新会话；工具触发后台压缩在途 → UI 输入区敲 /compact（slash 命令需 pressSequentially 逐字输入，
    // SKILL.md §3）。/compact 是 pi 内置命令（设计 D5：保持同步阻塞）。
    const created4 = await proto.call('session.create', { cwd, label: 'async-compaction-s5' }, { timeoutMs: 120_000 })
    const sid5 = created4.session?.id
    await proto.subscribe(sid5)
    await proto.send(sid5, contextMessage('V5-造上下文'))
    await proto.waitTurnEnd(sid5, { timeoutMs: TURN_BUDGET_MS })
    const compactBaseV5 = cursor().compact
    await proto.send(sid5, '请压缩当前会话上下文。')
    await waitForMockRequest(instance, 'mock-compact', compactBaseV5, COMPACT_INFLIGHT_MS, 'V5 后台压缩生成请求')
    // UI 路径敲 /compact（真实用户路径；命令面板交互实现期按 UI 实测校准）。
    const page = await instance.page()
    const editor = page.locator('[contenteditable="true"]').first()
    await editor.click()
    await editor.pressSequentially('/compact')
    await page.keyboard.press('Enter')
    // /compact 同步完成 = 原生压缩落盘（接管 cross-model 生成消费 mock-compact）。等该周期 entry。
    const tV5 = Date.now()
    let v5Compactions = []
    for (;;) {
      v5Compactions = compactionEntries(readSessionEntries(findSessionJsonl(dataDir, sid5)).entries)
      if (v5Compactions.length > 0) break
      if (Date.now() - tV5 > NATIVE_COMPACT_MS + COMPACT_INFLIGHT_MS) break
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert('V5/GL4: /compact 同步完成（原生产生 entry）', v5Compactions.length >= 1, {
      channel: 'C',
      expected: '≥1 条（/compact 产生）',
      actual: `${v5Compactions.length} 条`,
    })
    // 等后台任务了结：放弃发生在其生成完成后（落盘校验②判定，无落盘动作）——确定性信号 =
    // 该周期后台生成请求已被 mock server 消费（游标越过基线），随后轮询 JSONL 稳定后核对「仅一条」。
    await waitForMockRequest(instance, 'mock-compact', compactBaseV5, COMPACT_INFLIGHT_MS, 'V5 后台压缩生成请求（放弃路径的生成消费）')
    const tV5Stable = Date.now()
    let v5Final = []
    for (;;) {
      v5Final = compactionEntries(readSessionEntries(findSessionJsonl(dataDir, sid5)).entries)
      const settled = v5Final.length >= 1
      if ((settled && Date.now() - tV5Stable > 2_000) || Date.now() - tV5Stable > COMPACT_INFLIGHT_MS) break
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert('V5/GL4: 竞态了结后 session JSONL 仅 /compact 的一条 compaction entry', v5Final.length === 1, {
      channel: 'C',
      expected: '恰 1 条',
      actual: `${v5Final.length} 条`,
    })
    await ev.shot(page, 'v5-after-compact')
    ev.step({ step: 's5.manual-compact-race', command: '/compact（UI pressSequentially）', exitCode: v5Final.length === 1 ? 0 : 1, stats: { compactions: v5Final.length }, channel: 'A' })
    uncovered.push('V5 /compact 命令面板的交互细节（自动补全高亮/Enter 提交）按 UI 实测校准后回填精确选择器——骨架用「contenteditable 逐字输入 + Enter」的宽松驱动。')

    // ═══════════════════ 段 6 = V6：切走再切回 → live ≡ reload + 档位不复燃 ═══════════════════
    // 切走 = session.switch 到段 3 会话；切回 = session.switch 回会话 1（压缩后形态）。
    const hist1Before = await proto.call('session.history', { sessionId: sid1 }, { timeoutMs: 30_000 })
    await proto.call('session.switch', { sessionId: sid3 }, { timeoutMs: 60_000 })
    ev.step({ step: 's6.switch-away', command: 'session.switch → sid3', exitCode: 0, stats: { away: sid3 }, channel: 'B' })
    await proto.call('session.switch', { sessionId: sid1 }, { timeoutMs: 60_000 })
    await proto.subscribe(sid1)
    ev.step({ step: 's6.switch-back', command: 'session.switch → sid1', exitCode: 0, stats: { back: sid1 }, channel: 'B' })
    // live ≡ reload：切回后 history 结构与切走前一致。
    const hist1After = await proto.call('session.history', { sessionId: sid1 }, { timeoutMs: 30_000 })
    ev.assert('V6/GL3: 切走再切回后 history 结构一致（live ≡ reload）', (hist1After?.messages?.length ?? -1) === (hist1Before?.messages?.length ?? -2), {
      channel: 'B',
      expected: `messages=${hist1Before?.messages?.length ?? '?'}`,
      actual: `messages=${hist1After?.messages?.length ?? '?'}`,
    })
    // 继续对话：restore 重建的 pi 从 JSONL 现算投影 → 请求仍为压缩后形态。
    const mainCountBeforeV6 = instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-main') && r.status === 200).length
    await proto.send(sid1, 'V6 切回后继续对话：请确认上下文正常。')
    await proto.waitTurnEnd(sid1, { timeoutMs: TURN_BUDGET_MS })
    const v6Request = instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-main') && r.status === 200)[mainCountBeforeV6]
    const v6Ctx = requestMessagesText(v6Request)
    ev.assert('V6/GL3: 切回后请求仍为压缩后形态（含摘要哨兵、不含被压段原文）', v6Ctx.includes(SUMMARY_SENTINEL) && !v6Ctx.includes(contextMessage('A').slice(0, 80)), {
      channel: 'B',
      expected: '摘要哨兵在场且被压段原文离场',
      actual: `summaryIn=${v6Ctx.includes(SUMMARY_SENTINEL)}, shadowIn=${v6Ctx.includes(contextMessage('A').slice(0, 80))}`,
    })
    // 提醒档位不复燃：fired marker 在盘（C）+ 切回后无新提醒（B）。
    // 口径：提醒经 nextTurn 注入后常驻请求上下文——单看事件流无法区分「旧提醒常驻」与「新注入」，
    // 改比请求体内提醒文案出现次数：切回后第一条请求的出现次数 ≤ 切走前最后一条 = 无新增注入。
    const firedMarkers = readSessionEntries(findSessionJsonl(dataDir, sid1)).entries.filter(
      (e) => e?.type === 'custom' && e?.customType === FIRED_ENTRY_CUSTOM_TYPE,
    )
    ev.assert('V6/GL4: 已提醒档位 marker 持久化在 session entries（V1 期落盘）', firedMarkers.length >= 1, {
      channel: 'C',
      expected: `≥1 条 ${FIRED_ENTRY_CUSTOM_TYPE} entry`,
      actual: `${firedMarkers.length} 条`,
    })
    const mainReqsAll = instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-main') && r.status === 200)
    const reminderCountBefore = countOccurrences(requestMessagesText(mainReqsAll.at(-2)), REMINDER_TEXT_MARK)
    await proto.send(sid1, 'V6 档位复燃检查：请直接确认。')
    await proto.waitTurnEnd(sid1, { timeoutMs: TURN_BUDGET_MS })
    const mainReqsAfter = instance.mockLlm.requests.filter((r) => r.model?.endsWith('/mock-main') && r.status === 200)
    const reminderCountAfter = countOccurrences(requestMessagesText(mainReqsAfter.at(-1)), REMINDER_TEXT_MARK)
    ev.assert('V6/GL4: 切回后同一档位不重复告警（请求体内提醒注入数不增）', reminderCountAfter <= reminderCountBefore, {
      channel: 'B',
      expected: `提醒文案出现次数 ≤ 切走前（${reminderCountBefore}）`,
      actual: `切回后 ${reminderCountAfter}`,
    })
    // 压缩检查点 UI 可见（A 通道锚 + 截图；检查点文案/重载兜底行 =「上下文已压缩」，设计 G4 差异②）。
    const checkpointVisible = await page
      .locator(`text=${'上下文已压缩'}`)
      .first()
      .isVisible()
      .catch(() => false)
    ev.assert('V6/GL4: 对话流压缩检查点可见（UI）', checkpointVisible, {
      channel: 'A',
      expected: '检查点行可见（实时链路或重载兜底行，两形态均过——设计 V8 下界语义）',
      actual: `visible=${checkpointVisible}（实现期按 docs/testing/01 对话主链 testid 校准选择器）`,
    })
    await ev.shot(page, 'v6-checkpoint-after-switch-back')
    ev.step({ step: 's6.persistence', command: 'session.switch + history + UI', exitCode: checkpointVisible ? 0 : 1, stats: { historyMsgs: hist1After?.messages?.length ?? 0, firedMarkers: firedMarkers.length }, channel: 'A' })

    log('async-compaction-background: V1-V6 全段执行完毕')
  } finally {
    // ── Cleanup（SKILL.md §5 顺序）──
    // §5 各步由 runner 承载（run.mjs）：1) kill 实例 PID（SIGTERM 优雅链：runtime stop → 销毁 pi
    // → 应用退出，run.mjs:293-325 disposeInstance）；2) 端口释放核对；3) mock pi 置换恢复（本剧本
    // 未置换）；4) verify-* 一次性数据目录删除（run.mjs:439-456）；5) 证据幸存核对（run.mjs:458-466）。
    // mock server 随 instance.stop 关闭（instance.mjs:774-781）。本剧本无自持子进程/监听端口，
    // 此处仅登记自查结果，不重复 dispose（幂等但会打乱 runner 的 keep 语义与断言记录）。
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

/** 统计子串出现次数（提醒注入计数口径：nextTurn 提醒常驻请求上下文，比出现次数不增而非计事件数）。 */
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
