/**
 * p1-retry-rules-extension —— W6 retryable 增强 extension 的执行层零 token 验收
 * （验收项 A8：改写触发 pi 原生重试 + settings 配置 round-trip + 停用回落；
 * 设计 SSOT = subagent-observability §3.3.12；装配通道 mock-http，非核心组）。
 *
 * 机制链（全部经实装核实，出处见各断言旁注）：
 *   成员/subagent 孙进程的 LLM 请求打到本机 mock → mock 返回「剧本耗尽」HTTP 404
 *   （body 的 message/model 字段内嵌成员模型 id 字面量 `tier_limit_exceeded`）→
 *   pi 产出 stopReason='error' 的 assistant 消息，errorMessage = `"<status>: <body>"` 拼法
 *   （pi-ai dist/utils/error-body.js formatProviderError 实装核对）→ retry-rules extension
 *   的 message_end 钩子判定（extensions/universal/retry-rules/src/index.ts）→ 命中基线规则
 *   generic-rpm-limit（RETRY_RULES_BASELINE，pattern `rpm limit exceeded|tier_limit_exceeded`，
 *   verdict=retryable）→ errorMessage 追加 ` [taiji-retry: rate limit 429 too many requests]`
 *   （追加式非替换式）→ pi-ai 原生词表命中（`rate.?limit`/`429`/`too many requests`，
 *   dist/utils/retry.js:23-100 实装核对）→ pi 原生重试循环（agent-session.js auto_retry）。
 *
 * 错误形态选型（关键裁决，gotchas 详述）：选 `tier_limit_exceeded` 而非 `429` 嵌入模型 id——
 * pi 原生 RETRYABLE 词表很宽（含 `429`/`500`/`timeout` 等），`429` 嵌 id 会被原生词表直接
 * 命中，断言无法区分「taiji 规则改写触发」与「pi 原生词表兜底」；`tier_limit_exceeded`
 * 经探针实测对 pi 双词表 0 命中（probe-retry-extension-feasibility.md:23，本剧本交付时
 * 再次对 node_modules 实装逐词核对）——改写是重试的唯一触发源，归因闭合。
 *
 * mock-llm 错误注入边界（选型约束）：mock-llm 只有两类 HTTP 错误（400 invalid_json /
 * 404 未知模型或剧本耗尽）+ 200 带 step.error 文本（后者产生的是正常文本消息
 * stopReason='stop'，进不了 message_end 的 error 判定分支）；404 耗尽 body 里唯一可由
 * 剧本控制的面 = 模型 id 字面量（ensureLlm 的 llm.models / engineDefaults.pi 可自由命名）。
 *
 * 三段设计（同一实例、同一 mock server、两个独立 session）：
 *   段 0 前置（默认生效路径，G1 修复 44f514c3f）：config.setRetryConfig 开启 pi 原生重试
 *     （enabled=true, maxRetries=2, baseDelayMs=0 零退避）——mock-http 装配默认
 *     retry.enabled=false（ensureLlm 防剧本耗尽慢速重放），不开则改写永远不触发重试；
 *     **不做任何 settings 写**，仅条件轮询等待 runtime 启动远程同步链自动补写 ext-config
 *     基线（启动延迟 30s + fetch 8s 量级；fail-safe 链保证拉取失败也补写）。
 *   段 1 规则生效链：主队 step0 派发成员（模型 mockllm/mock-sub-tier_limit_exceeded，
 *     成员队 = 空数组 → 每次请求 404 耗尽）→ 断言成员模型请求 ≥2 次（初错 + ≥1 重试，
 *     maxRetries=2 预期 3）+ record lastRound.retryAttempts = 2（G2 修复后全链透传）
 *     + raw mirror auto_retry_start 帧（C 通道双证）+ 改写标记持久化进子会话树
 *     （`[taiji-retry:` + 原文保留）。
 *   段 1.5 settings round-trip：config.setRetryRules 写一条自定义规则 → RPC 读回一致 →
 *     config.retryRules 广播帧（条件轮询）→ 直读 ext-config 文件断言形状
 *     （version/customRules/effectiveRules + custom source 条目 + builtin 基线）→
 *     setRetryRules([]) 删除恢复。
 *   段 2 停用回落（主队 step3 紧接段 1 通知轮，中间无备用纯文本步——a8 首跑错步教训）：
 *     config.setRetryConfig 关闭（enabled=false, maxRetries=0）→ 再派成员（同模型同
 *     错误形态）→ 断言只 1 次错误请求 + lastRound.retryAttempts 缺省 + 原始事件流无
 *     auto_retry_start（改写仍发生但 pi 前置门拦截——§3.3.12 停用通道语义：停用复用
 *     pi 原生 retry 配置，门在改写词表判定之前）。
 *   段间衔接：等主队游标 ≥3（p0-subagent-workflow-dispatch 同款 fail-fast 形态）。
 *
 * 断言通道：B（config.* RPC 回执 / getSubagents record）+ C（mock.requests 计数、
 * ext-config 文件、子会话树改写标记）。
 * 本剧本刻意不碰 UI（SystemRetryRulesSection.vue 的展示/编辑交互归 notProvable）。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAIN_MODEL = 'mock-1'
/** 成员模型 id 内嵌 `tier_limit_exceeded` 字面量——经 404 耗尽 body 进入 errorMessage，命中基线规则 generic-rpm-limit。 */
const SUB_MODEL = 'mock-sub-tier_limit_exceeded'
/** 追加式改写标记前缀（extensions/universal/retry-rules/src/rules.ts RETRY_REWRITE_MARKER_PREFIX 同源）。 */
const RETRY_MARKER_PREFIX = '[taiji-retry:'
/** 基线规则 id（packages/shared/src/retry-rules.ts RETRY_RULES_BASELINE 的 generic-rpm-limit）。 */
const BASELINE_RULE_ID = 'generic-rpm-limit'
/** 404 耗尽错误体的机读 type（mock-llm 耗尽分支固定值，作「错误形态按预期注入」的锚）。 */
const EXHAUSTED_ERROR_TYPE = 'mock_llm_script_exhausted'
/** round-trip 自定义规则（pattern 刻意选不命中 404 文本的字面量，防污染段 2 判定）。 */
const CUSTOM_RULE = {
  id: 'verify-roundtrip-rule',
  name: '验收 round-trip 规则',
  verdict: 'retryable',
  match: [{ kind: 'pattern', pattern: 'mock-verify-roundtrip-only' }],
  class: 'provider',
  source: 'custom',
}

/**
 * 主队队列：段 1（step0-2）+ 段 2（step3-5）+ 尾部备用（step6-7），两段共用同一
 * per-model 游标（mock-http 坑 2）。段 2 派发**紧接**段 1 通知轮（step2→step3）：
 * 段间没有多余纯文本步——a8 首跑实测教训：备用步夹在两段之间时，段 2 首轮会吃掉
 * 备用文本步（无 toolCall）→ 成员根本没派发（history 无 RETRY-OFF-DISPATCHED、
 * record 查无、计数 0）。备用步只能落在队列尾部（p0 同款：段间衔接等游标即消费完）。
 */
const mainQueue = [
  {
    text: '派一个子任务去核对重试规则：',
    toolCalls: [
      {
        name: 'subagent_start',
        args: {
          task: 'Report one word: ready. Nothing else.',
          slug: 'retry-on',
          model: `mockllm/${SUB_MODEL}`,
          fork: false,
        },
      },
    ],
    stopReason: 'toolUse',
  },
  { text: 'RETRY-ON-DISPATCHED 成员已派发，等待结果通知。', stopReason: 'stop' },
  { text: 'retry-on-notified', stopReason: 'stop' },
  {
    text: '再派一个子任务核对停用回落：',
    toolCalls: [
      {
        name: 'subagent_start',
        args: {
          task: 'Report one word: ready. Nothing else.',
          slug: 'retry-off',
          model: `mockllm/${SUB_MODEL}`,
          fork: false,
        },
      },
    ],
    stopReason: 'toolUse',
  },
  { text: 'RETRY-OFF-DISPATCHED 成员已派发，等待结果通知。', stopReason: 'stop' },
  { text: 'retry-off-notified', stopReason: 'stop' },
  { text: 'retry-off-idle', stopReason: 'stop' },
  { text: 'parent-idle-final', stopReason: 'stop' },
]

export const meta = {
  id: 'p1-retry-rules-extension',
  priority: 'P1',
  title: 'W6 retry-rules extension：message_end 改写触发 pi 原生重试 + settings 配置 round-trip + 停用回落（mock-http 孙进程可达）',
  covers: [
    // settings.retryRules 为本剧本建议新增的 capability id（矩阵回写随 dev-flow D4）；
    // 其余为既有能力面（复用 p0-subagent-workflow-dispatch 的装配与派发链）。
    'settings.retryRules',
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.wait',
    'subagent.dispatch', 'subagent.list',
    'protocol.rpc', 'protocol.events',
  ],
  requires: ['mock-http'],
  estimateSec: 300,
  llm: {
    responses: {
      [`mockllm/${MAIN_MODEL}`]: mainQueue,
      // 成员队 = 空数组：第一次请求即命中「剧本耗尽」HTTP 404（错误注入点）；耗尽分支
      // 不推进游标（mock-llm.mjs 耗尽检查在 cursors.set 之前），两段成员共享空队列无串扰。
      [`mockllm/${SUB_MODEL}`]: [],
    },
    mainModel: MAIN_MODEL,
    subModel: SUB_MODEL,
    // models.json 注册面收敛为两个模型（ensureLlm 默认会补 mock-sub-a/b，显式覆盖）。
    models: [MAIN_MODEL, SUB_MODEL],
  },
  provable: [
    'retry 配置经产品通道生效：config.setRetryConfig 开启（回读 enabled=true 且 settings.json retry 段落盘）与停用（回读 enabled=false）',
    'G1 默认生效路径：实例启动后不做任何 settings 写，runtime 启动远程同步链自动补写 ext-config（文件在场、version=1、effectiveRules 含 generic-rpm-limit 等基线条目、customRules 空）',
    '段 1 规则生效链：成员模型收到 ≥2 次请求（第一次 404 错误 + ≥1 次重试；maxRetries=2 预期 3 次）',
    '段 1 原生重试直接证据（record）：lastRound.retryAttempts = 2（G2 全链透传，与 maxRetries 精确吻合）',
    '段 1 原生重试双证（raw mirror）：孙进程原始事件流 auto_retry_start=2 / auto_retry_end=1',
    '改写标记持久化：子会话树含 [taiji-retry: 标记且原始 404 错误文本保留在前段（追加式非替换式）',
    '错误形态按预期注入：成员请求全部为 404 + body type=mock_llm_script_exhausted（模型 id 字面量进入 errorMessage 的载体）',
    'settings round-trip：config.setRetryRules 写入 → RPC 读回 customRules 含 source=custom 条目 + config.retryRules 广播帧到达',
    'ext-config 磁盘事实：retry-rules-ext-config.json 存在、version=1、customRules/effectiveRules 形状合法、effectiveRules 含 custom 条目与 builtin 基线（generic-rpm-limit）',
    '删除恢复：config.setRetryRules([]) 后 RPC 读回空且文件 effectiveRules 不再含 custom 条目',
    '段 2 停用回落：pi 原生门关闭（enabled=false/maxRetries=0）后同一错误形态只 1 次请求、lastRound.retryAttempts 缺省且原始事件流无 auto_retry_start（改写被前置门拦截，不触发重试）',
    '两段成员 record 都走到终态（重试耗尽后失败如实分类，档 A 回落）',
  ],
  notProvable: [
    'settings UI 面：SystemRetryRulesSection.vue 的展示/编辑交互与 retry-rules-* testid（本剧本刻意不碰 UI，round-trip 走 runtime WS 产品通道）',
    '重试请求的 messages 含改写标记：结构性不可达——pi _omitRecoveryAttempt 把失败尝试从模型上下文剔除（探针 probe-retry-extension-feasibility.md:24 实证）；改写标记证据走持久化面（子会话树断言）',
    '指数退避节奏：baseDelayMs=0 短路退避换验收速度；退避由 pi 原生承担（探针 auto_retry_start delayMs 已实证）',
    'remote 覆盖层的内容变化生效路径（configs/remote/retry-rules.json 实际拉到新规则时重写 effectiveRules）：需真实远端；本剧本只覆盖「基线默认补写 + 远程层可参与合并」形态',
    'conditional / non_retryable verdict 的运行时 keep 路径：错误形态选型为 retryable（generic-rpm-limit）；两层序排除语义由 shared/extension 单测对拍覆盖',
    '轮收条 failure 的 class/kind 分类值断言（§3.3.2 分类码表消费面，归 W1 域验收；a8 首跑实测 404 归 protocol_unsupported 即该域形态）',
    'mock 回复无真实模型语义：编排质量、工具选择、真实耗时与 token 成本',
  ],
}

function readTextFile(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** 递归读目录下所有文本文件（体积上限保护；p0-subagent-workflow-dispatch 同款）。 */
function readTreeText(root, maxBytes = 4_000_000) {
  let total = 0
  const parts = []
  const walk = (dir, depth = 0) => {
    if (depth > 6 || total > maxBytes) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (total > maxBytes) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      const st = fs.statSync(full, { throwIfNoEntry: false })
      if (!st || st.size > 2_000_000) continue
      const text = readTextFile(full)
      total += text.length
      parts.push(`# ${path.relative(root, full)}\n${text}`)
    }
  }
  if (fs.existsSync(root)) walk(root)
  return parts.join('\n')
}

/** 条件轮询主队游标（pending 形态兼容 queueKey 带不带 provider 前缀两种；p0 同款）。 */
async function waitMainQueueConsumed(instance, minSteps, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = -1
  while (Date.now() < deadline) {
    const pending = instance.mockLlm?.pending() ?? {}
    last = Object.entries(pending)
      .filter(([k]) => k === MAIN_MODEL || k.endsWith(`/${MAIN_MODEL}`))
      .reduce((acc, [, v]) => Math.max(acc, Number(v) || 0), 0)
    if (last >= minSteps) return { ok: true, consumed: last }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { ok: false, consumed: last }
}

/** 条件轮询成员请求计数（段内切片；requests 只追加 push，slice 边界稳定）。 */
async function waitMemberRequests(instance, since, minCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let seg = []
  while (Date.now() < deadline) {
    seg = (instance.mockLlm?.requests ?? []).slice(since).filter((r) => r.model === SUB_MODEL)
    if (seg.length >= minCount) return seg
    await new Promise((r) => setTimeout(r, 500))
  }
  return seg
}

/** 条件轮询 subagent record 终态（p0 同款：终态词表 + stopReason/outcome 兜底 break）。 */
async function waitRecordTerminal(protocol, sessionId, slug, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let records = []
  let record = null
  while (Date.now() < deadline) {
    const reply = await protocol.call('session.getSubagents', { sessionId }, { timeoutMs: 60_000 })
    records = reply.subagents ?? []
    record = records.find((r) => r.slug === slug) ?? null
    if (record && ['done', 'idle', 'cancelled', 'error', 'failed'].includes(String(record.status))) break
    if (record && (record.stopReason || record.outcome)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  return { records, record }
}

/**
 * 条件轮询 record 的 lastRound 字段（轮终收条投影经 record 事件 fold → getSubagents
 * 返回，轮终帧写入与投影刷新之间可能有短窗口）。predicate 命中即返回。
 */
async function waitRecordLastRound(protocol, sessionId, slug, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let record = null
  while (Date.now() < deadline) {
    const reply = await protocol.call('session.getSubagents', { sessionId }, { timeoutMs: 60_000 })
    record = (reply.subagents ?? []).find((r) => r.slug === slug) ?? null
    if (record && predicate(record)) return record
    await new Promise((r) => setTimeout(r, 500))
  }
  return record
}

/**
 * 读孙进程 stdout 原始事件镜像（runtime 侧落盘 <dataDir>/logs/pi-subagent-<date>-
 * <recordId>.jsonl；镜像读取侧 = infra/subagent-control/mirror.ts，写入器 =
 * pi-subagent-cli/src/raw-mirror.ts）。这是「pi 到底 emit 了什么」的最原始证据面——
 * 不依赖 core/runtime 的任何字段透传。
 */
/** 列出 logs 下全部孙进程 raw mirror 文件（兜底通道；按 recordId 匹配失败时用文件集差分）。 */
function listRawMirrorFiles(dataDir) {
  const logDir = path.join(dataDir, 'logs')
  if (!fs.existsSync(logDir)) return []
  return fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith('pi-subagent-') && f.endsWith('.jsonl'))
    .map((f) => path.join(logDir, f))
}

function findRawMirrorFiles(dataDir, recordId) {
  const safe = String(recordId ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
  if (safe === '') return []
  return listRawMirrorFiles(dataDir).filter((f) => path.basename(f).includes(safe))
}

/** 读镜像文件文本（多文件按文件名序拼接）。 */
function readRawMirrorText(files) {
  return files.map((f) => readTextFile(f)).join('\n')
}

/** 计数原始事件流里的某类帧（JSONL 逐行 `"type":"<name>"`）。 */
function countEventType(text, type) {
  return [...text.matchAll(new RegExp(`"type"\\s*:\\s*"${type}"`, 'g'))].length
}

/**
 * 条件轮询 raw mirror：文件在场且谓词满足（原始流写盘实时，record 终态后应就位）。
 * 匹配策略：优先按 recordId（文件名含之）；找不到时退化为「全部镜像文件」——调用方
 * 用 `exclude` 传段前文件快照做差分（段 2 场景），段 1 无旧文件可直接用全集。
 */
async function waitRawMirror(dataDir, recordId, predicate, timeoutMs, exclude = []) {
  const excluded = new Set(exclude)
  const deadline = Date.now() + timeoutMs
  let files = []
  let text = ''
  while (Date.now() < deadline) {
    files = findRawMirrorFiles(dataDir, recordId)
    if (files.length === 0) files = listRawMirrorFiles(dataDir).filter((f) => !excluded.has(f))
    text = readRawMirrorText(files)
    if (files.length > 0 && predicate(text)) return { files, text }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { files, text }
}

/** 读 <dataDir>/logs 下指定前缀的日志文本（诊断附件：扩展 argv / 孙进程 stderr）。 */
function readLogsByPrefix(dataDir, prefixes) {
  const logDir = path.join(dataDir, 'logs')
  if (!fs.existsSync(logDir)) return ''
  return fs
    .readdirSync(logDir)
    .filter((f) => prefixes.some((p) => f.startsWith(p)))
    .map((f) => `# ${f}\n${readTextFile(path.join(logDir, f))}`)
    .join('\n')
}

/** 条件轮询文件内容满足谓词（原子写窗口内可能读到空/半截：重读不盲等）。 */
async function waitFileParsed(filePath, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let parsed = null
  while (Date.now() < deadline) {
    const raw = readTextFile(filePath)
    if (raw !== '') {
      try {
        parsed = JSON.parse(raw)
        if (predicate(parsed)) return parsed
      } catch {
        /* 半截 JSON：重读 */
      }
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return parsed
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    'G1 默认生效路径（44f514c3f 修复后）：syncRetryRulesRemote 拉取先行 + ext-config 缺席即补写基线。触发点 = runtime 启动延迟链（index.ts:1883 REMOTE_CONFIG_STARTUP_DELAY_MS=30_000）→ 补写最早在实例就绪约 30s 后（+ fetch 8s 超时量级）；本剧本用条件轮询（预算 150s）等文件出现，不做任何 settings 写。若文件始终不出现 = G1 挂点覆盖缺口，如实报红',
    '错误形态选型：mock-llm 无 HTTP 429/500 注入通道（仅 400/404 + 200 step.error 文本——后者是 stopReason=stop 的正常消息，进不了 message_end 的 error 判定）；唯一可控错误文本面 = 404 耗尽 body 内嵌的模型 id 字面量。选 tier_limit_exceeded（基线规则 generic-rpm-limit）而非 429：pi-ai RETRYABLE 词表含 429/500/timeout 等宽词表（node_modules retry.js 实装逐词核对），429 嵌 id 会被原生词表直接命中，无法区分「taiji 规则改写触发」与「pi 原生词表兜底」；tier_limit_exceeded 对 pi 双词表 0 命中——改写是重试唯一触发源',
    'mock-http 装配默认 retry.enabled=false（lib/instance.mjs ensureLlm 防剧本耗尽慢速重放）——断言①前必须经 config.setRetryConfig 产品通道开启；停用回落（段 2）即回到该默认语义',
    '热重载边界：extension 侧 loadConfig 为读时刷新（mtime+size，llm-shared 契约），message_end 判定点每次直读文件——写 ext-config 后无需等待窗口，下一轮判定即生效；在途退避不中断（重试状态机由 pi 持有）。本剧本等落盘后立即派成员，未依赖任何等待窗口',
    '成员请求全部 HTTP 404 是设计内形态（错误注入即「剧本耗尽」）——与 p0 剧本「404 = 耗尽噪音、铁证只计 200」口径相反，本剧本计数必须含 404',
    'provider 层重试默认 0（llm-retry.ts「provider.maxRetries 未设 = 0」）——若 models.json 显式配 provider.maxRetries>0，pi-ai 会在 message_end 之前重试，污染「改写触发」归因',
    '主队游标 per-model 共享（mock-http README 坑 2）——段 2 派发步紧接段 1 通知轮（中间无备用纯文本步；a8 首跑实测：备用步夹在两段之间会被段 2 首轮吃掉，成员不派发），衔接等游标 ≥3',
    '重试次数语义：agent-session.js:787 门为 _retryAttempt >= maxRetries——maxRetries=2 预期 3 次请求 / 2 个 auto_retry_start；record 断言精确 = 2',
    'G2 修复（44f514c3f）后 record 判断通道恢复：lastRound.retryAttempts 全链透传（AgentOutcome → SDK 契约 → AgentResult → 两条 markRoundIdle → RoundSettlementOutcome → 轮终帧 → lastRound 投影）；raw mirror 的 auto_retry_start 保留为 C 通道双证（不依赖字段透传的原始面）',
  ]

  // ══ 装配自检 ══════════════════════════════════════════════════
  const topo = instance.llm
  const modelsJson = JSON.parse(readTextFile(path.join(dataDir, 'agent', 'models.json')) || '{}')
  const provider = modelsJson.providers?.[topo.providerId]
  ev.assert('装配：models.json 的 mock provider 指向本机 mock 服务', provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions', {
    channel: 'C',
    expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
    actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
  })
  ev.assert('装配：成员模型 id 内嵌 tier_limit_exceeded 字面量（错误形态载体就位）', SUB_MODEL.includes('tier_limit_exceeded') && (provider?.models ?? []).some((m) => m.id === SUB_MODEL), {
    channel: 'C',
    expected: `models.json 注册 ${SUB_MODEL}`,
    actual: (provider?.models ?? []).map((m) => m.id).join(',') || '<缺>',
  })
  const subCfg = JSON.parse(readTextFile(path.join(dataDir, 'agent', 'subagents', 'config.json')) || '{}')
  ev.assert('装配：孙进程缺省模型 = mock-sub-tier_limit_exceeded（engineDefaults.pi）', String(subCfg.engineDefaults?.pi ?? '').includes(SUB_MODEL), {
    channel: 'C',
    expected: `engineDefaults.pi 含 ${SUB_MODEL}`,
    actual: subCfg.engineDefaults?.pi ?? '<缺>',
  })
  // 装配默认 retry.enabled=false（ensureLlm）——作为段 2「停用回落」的出厂基线证据留档。
  const settingsJson = JSON.parse(readTextFile(path.join(dataDir, 'agent', 'settings.json')) || '{}')
  ev.attach('装配 settings.json retry 段（开启前）', JSON.stringify(settingsJson.retry ?? null))

  // ══ 前置：开启 pi 原生重试（产品通道 config.setRetryConfig） ════
  // SystemLlmRetrySection 同款 RPC（core config.ts:404；runtime retry-config-message-handler）。
  // baseDelayMs=0 = 重试零退避（retryDelayMs = baseDelayMs * 2^(n-1) = 0），验收不等退避。
  const RETRY_ON = { enabled: true, maxRetries: 2, baseDelayMs: 0 }
  let retryOnReply = null
  try {
    retryOnReply = await protocol.call('config.setRetryConfig', { config: RETRY_ON }, { replyType: 'config.retryConfig', timeoutMs: 60_000 })
  } catch (e) {
    ev.assert('前置：config.setRetryConfig 开启重试', false, {
      channel: 'B',
      expected: '回执 config.enabled=true',
      actual: `RPC error: ${String(e?.message ?? e).slice(0, 300)}`,
    })
    return { uncovered: ['重试开启失败，段 1/段 2 未执行（改写无门可过，断言无意义）'], gotchas }
  }
  ev.assert('前置：retry 配置开启（enabled=true, maxRetries=2, baseDelayMs=0）', retryOnReply?.config?.enabled === true && retryOnReply?.config?.maxRetries === 2, {
    channel: 'B',
    expected: 'config.retryConfig 回执 enabled=true maxRetries=2',
    actual: JSON.stringify(retryOnReply?.config ?? retryOnReply ?? {}).slice(0, 300),
  })
  ev.step({ step: 'retry.enable', channel: 'B', exitCode: 0, stats: { enabled: retryOnReply?.config?.enabled, maxRetries: retryOnReply?.config?.maxRetries, baseDelayMs: retryOnReply?.config?.baseDelayMs } })

  // ══ 段 0：基线规则默认生效（G1 修复后的强验收锚） ═════════════
  // G1 修复（44f514c3f）：syncRetryRulesRemote 改为「拉取先行 + ext-config 缺席即补写
  // 基线」（remote-retry-rules.ts，effectiveRules = 编译期基线 ⊕ 可用远程层，custom 空）。
  // 触发点 = runtime 启动延迟链（index.ts:1883 REMOTE_CONFIG_STARTUP_DELAY_MS=30_000）
  // → refreshRemoteProviders → syncRetryRulesRemote。本段不做任何 settings 写，只等
  // 启动链自动补写：文件必须在场且 effectiveRules 含基线条目（否则 = G1 挂点未覆盖，
  // 如实报红，不放宽断言）。
  const extConfigPath = path.join(dataDir, 'agent', 'config', 'retry-rules-ext-config.json')
  const settingsPath = path.join(dataDir, 'agent', 'settings.json')
  // 孙进程读取面：settings.json 的 retry 段必须落盘（pi 重试门读它，不是 RPC 回执）。
  const settingsAfter = await waitFileParsed(settingsPath, (p) => p?.retry?.enabled === true, 15_000)
  ev.assert('段 0：settings.json retry 段落盘（enabled=true, maxRetries=2——孙进程重试门读取面）', settingsAfter?.retry?.enabled === true && settingsAfter?.retry?.maxRetries === 2, {
    channel: 'C',
    expected: 'retry={enabled:true, maxRetries:2, baseDelayMs:0}',
    actual: JSON.stringify(settingsAfter?.retry ?? null).slice(0, 300),
  })
  // 默认路径：等待 runtime 启动远程同步链补写 ext-config（30s 延迟 + 8s fetch 超时量级，
  // 预算 150s；fail-safe 链保证拉取失败也补写基线）。条件轮询，不盲等。
  // 等待期间每 2s 采样文件状态（诊断附件：定位「补写写入了什么/是否被覆盖」）。
  const seedStartedAt = Date.now()
  const extConfigSamples = []
  const sampler = setInterval(() => {
    const st = fs.statSync(extConfigPath, { throwIfNoEntry: false })
    let snap = null
    if (st) {
      try {
        const p = JSON.parse(readTextFile(extConfigPath))
        snap = { version: p?.version, custom: (p?.customRules ?? []).length, effective: (p?.effectiveRules ?? []).length }
      } catch {
        snap = '<parse-fail>'
      }
    }
    extConfigSamples.push({ tMs: Date.now() - seedStartedAt, exists: Boolean(st), mtimeMs: st?.mtimeMs, size: st?.size, snap })
  }, 2_000)
  const defaultConfig = await waitFileParsed(
    extConfigPath,
    (p) => p?.version === 1 && Array.isArray(p?.effectiveRules) && p.effectiveRules.some((r) => r.id === BASELINE_RULE_ID),
    150_000,
  )
  clearInterval(sampler)
  const seedWaitMs = Date.now() - seedStartedAt
  ev.step({ step: 'ext-config.default-seed', channel: 'C', exitCode: 0, stats: { waitMs: seedWaitMs, ruleCount: (defaultConfig?.effectiveRules ?? []).length } })
  ev.attach('ext-config-samples', JSON.stringify(extConfigSamples, null, 2).slice(0, 60_000))
  ev.assert('段 0（G1 默认路径）：ext-config 由 runtime 启动链自动补写（未做任何 settings 写）', defaultConfig?.version === 1 && Array.isArray(defaultConfig?.effectiveRules), {
    channel: 'C',
    expected: `文件在场且 version=1（等待 ${seedWaitMs}ms）`,
    actual: defaultConfig ? `version=${defaultConfig.version} custom=${(defaultConfig.customRules ?? []).length} effective=${(defaultConfig.effectiveRules ?? []).length}` : `文件缺失或不可解析：${extConfigPath}（runtime 启动链未补写 = G1 挂点覆盖缺口）`,
  })
  ev.assert('段 0（G1 默认路径）：effectiveRules 含编译期基线条目（generic-rpm-limit 等）', defaultConfig?.effectiveRules?.some((r) => r.id === BASELINE_RULE_ID) === true, {
    channel: 'C',
    expected: `effectiveRules 含 ${BASELINE_RULE_ID}`,
    actual: (defaultConfig?.effectiveRules ?? []).map((r) => r.id).join(',') || '<缺>',
  })
  ev.assert('段 0（G1 默认路径）：customRules 为空（默认生效不依赖用户自定义）', Array.isArray(defaultConfig?.customRules) && defaultConfig.customRules.length === 0, {
    channel: 'C',
    expected: 'customRules=[]',
    actual: JSON.stringify(defaultConfig?.customRules ?? null).slice(0, 200),
  })
  ev.attach('ext-config-default', JSON.stringify(defaultConfig ?? null, null, 2).slice(0, 40_000))
  // 诊断附件：runtime 日志中的扩展 argv 行（孙进程白名单池的输入面——若段 1 仍不重试，
  // 此附件用于判定「扩展是否进孙进程」与「规则是否命中」的分叉）。
  const runtimeLog = readLogsByPrefix(dataDir, ['runtime-'])
  ev.attach(
    'runtime-extension-argv',
    runtimeLog
      .split('\n')
      .filter((l) => l.includes('--extension') || l.includes('pi-retry-rules'))
      .join('\n') || '(runtime 日志无 --extension / pi-retry-rules 行)',
  )
  ev.attach(
    'runtime-remote-config-log',
    runtimeLog
      .split('\n')
      .filter((l) => /retry-rules|remote.?config|syncRetryRules|\[remote\]/i.test(l))
      .join('\n') || '(runtime 日志无 retry-rules / remote-config 行)',
  )
  ev.attach('pi-task-stderr', readLogsByPrefix(dataDir, ['pi-task-stderr-']).slice(0, 80_000) || '(无 pi-task-stderr-*.log)')

  // ══ 段 1：规则生效链（改写 → pi 原生重试） ════════════════════
  const createdA = await protocol.call('session.create', { cwd: repo, label: 'p1-retry-on' }, { timeoutMs: 120_000 })
  const sidA = createdA.session?.id
  ev.assert('段 1：session.create 返回 sessionId', Boolean(sidA), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(createdA.session ?? {}).slice(0, 300),
  })
  await protocol.subscribe(sidA)
  ev.step({ step: 'session.create.A', channel: 'B', exitCode: 0, stats: { sessionId: sidA, modelId: createdA.session?.modelId } })

  const sinceA = protocol.events.length
  await protocol.send(sidA, 'dispatch one subagent (p1-retry-rules-extension 段 1, retry on)')
  const endA = await protocol.waitTurnEnd(sidA, { since: sinceA, timeoutMs: 180_000 })
  ev.assert('段 1：主轮完成（message.complete 非 error）', endA.type === 'message.complete' && endA.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${endA.type} stop=${endA.payload?.stopReason ?? 'n/a'}`,
  })
  const histA = await protocol.history(sidA, { limitTurns: 10 })
  ev.assert('段 1 控制组：主会话文本来自主队剧本（RETRY-ON-DISPATCHED）', JSON.stringify(histA.messages ?? []).includes('RETRY-ON-DISPATCHED'), {
    channel: 'B',
    expected: 'history 含 RETRY-ON-DISPATCHED',
    actual: `messages=${(histA.messages ?? []).length}`,
  })

  // 等 record 终态（重试耗尽后失败如实分类——档 A 回落；对 status 具体值不做硬断言，
  // 失败归类的词表消费归 W1 域，这里只锚「不再 running」的终态事实）。
  const recA = await waitRecordTerminal(protocol, sidA, 'retry-on', 180_000)
  ev.step({
    step: 'subagent.observe.A', channel: 'B', exitCode: 0,
    stats: { count: recA.records.length, status: recA.record?.status, model: recA.record?.model, stopReason: recA.record?.stopReason },
  })
  ev.assert('段 1：成员 record 走到终态（重试耗尽后不再 running）', Boolean(recA.record) && !['running', 'pending'].includes(String(recA.record?.status)), {
    channel: 'B',
    expected: 'record.status 为终态（error/failed 预期）',
    actual: `status=${recA.record?.status} stopReason=${recA.record?.stopReason}`,
  })
  ev.attach('subagent-records-A', JSON.stringify(recA.records, null, 2).slice(0, 40_000))

  // 铁证①：成员模型请求计数 ≥2（第一次 404 错误 + ≥1 次重试；maxRetries=2 预期 3）。
  // 成员请求全部 404 是设计内形态（见 gotchas），计数含 404。
  const memberSegA = await waitMemberRequests(instance, 0, 2, 120_000)
  const exhaustedOk = memberSegA.filter((r) => JSON.stringify(r.messages ?? []).includes(EXHAUSTED_ERROR_TYPE) || r.error?.includes(EXHAUSTED_ERROR_TYPE) || r.status === 404)
  ev.step({
    step: 'mock.requests.A', channel: 'C', exitCode: 0,
    stats: { memberRequests: memberSegA.length, all404: memberSegA.filter((r) => r.status === 404).length },
  })
  ev.assert('铁证①：成员模型收到 ≥2 次请求（第一次错误 + ≥1 次重试，改写触发 pi 原生重试）', memberSegA.length >= 2, {
    channel: 'C',
    expected: `≥2 × model=${SUB_MODEL}（maxRetries=2 预期 3）`,
    actual: `${memberSegA.length} 条（status=${memberSegA.map((r) => r.status).join(',')}）`,
  })
  ev.assert('铁证①形态：成员请求为 404 耗尽错误（错误注入按预期命中成员进程）', exhaustedOk.length === memberSegA.length && memberSegA.length > 0, {
    channel: 'C',
    expected: `全部 404 + ${EXHAUSTED_ERROR_TYPE}`,
    actual: `${exhaustedOk.length}/${memberSegA.length} 条命中形态`,
  })
  ev.attach(
    'mock-requests-A',
    JSON.stringify(
      memberSegA.map((r) => ({ model: r.model, status: r.status, at: r.at, messageCount: r.messageCount, error: String(r.error ?? '').slice(0, 400) })),
      null,
      2,
    ).slice(0, 60_000),
  )

  // 铁证②：改写标记持久化进子会话树（探针实证改写写入 pi 会话记录；「追加式非替换式」
  // = 原始 404 错误文本保留在前段）。孙进程 pi session 落 <dataDir>/ext-sessions/<sid>/
  // subagents/<encodeCwd>/sessions/（pi-paths.ts:168），readTreeText 递归覆盖。
  const subagentsTreeA = path.join(dataDir, 'ext-sessions', String(sidA), 'subagents')
  const markerDeadline = Date.now() + 60_000
  let diskTextA = ''
  let markerHit = false
  while (Date.now() < markerDeadline) {
    diskTextA = readTreeText(subagentsTreeA)
    markerHit = diskTextA.includes(RETRY_MARKER_PREFIX)
    if (markerHit) break
    await new Promise((r) => setTimeout(r, 500))
  }
  ev.assert('铁证②：改写标记持久化进子会话树（[taiji-retry: 出现）', markerHit, {
    channel: 'C',
    expected: `subagents 树含 ${RETRY_MARKER_PREFIX}`,
    actual: `bytes=${diskTextA.length} hit=${markerHit}`,
  })
  ev.assert('铁证②：追加式非替换式（原始 404 耗尽文本与标记同存）', markerHit && diskTextA.includes(EXHAUSTED_ERROR_TYPE) && diskTextA.indexOf(EXHAUSTED_ERROR_TYPE) < diskTextA.indexOf(RETRY_MARKER_PREFIX), {
    channel: 'C',
    expected: `${EXHAUSTED_ERROR_TYPE} 在 ${RETRY_MARKER_PREFIX} 之前（原文保留在前段）`,
    actual: `exhaustedAt=${diskTextA.indexOf(EXHAUSTED_ERROR_TYPE)} markerAt=${diskTextA.indexOf(RETRY_MARKER_PREFIX)}`,
  })
  // 铁证③（record，G2 修复后的主断言）：lastRound.retryAttempts = auto_retry_start 帧数。
  // 全链 = 引擎 AgentOutcome（spawn-runner.ts:573-577）→ SDK 契约（contract-types.ts:593）
  // → AgentResult（record-model.ts:155）→ markRoundIdle 两条路径（run-orchestration.ts
  // :802/:813）→ RoundSettlementOutcome → record-round-idle 帧 → lastRound 投影
  // （events-projection-last-round.ts）。与 maxRetries=2 精确吻合 = 2 次重试。
  const recAFinal = await waitRecordLastRound(
    protocol,
    sidA,
    'retry-on',
    (r) => r?.lastRound?.retryAttempts !== undefined,
    15_000,
  )
  const retryAttemptsA = recAFinal?.lastRound?.retryAttempts
  ev.assert('铁证③(record)：lastRound.retryAttempts = 2（G2 全链透传，与 maxRetries 精确吻合）', retryAttemptsA === 2, {
    channel: 'B',
    expected: 'lastRound.retryAttempts = 2（maxRetries=2）',
    actual: `retryAttempts=${retryAttemptsA} lastRound=${JSON.stringify(recAFinal?.lastRound ?? null).slice(0, 300)}`,
  })
  // 铁证③（raw mirror，C 通道双证）：孙进程 stdout 原始事件流出现 auto_retry_start/end
  // ——pi 原生重试循环真实发生的最原始证据面，不依赖任何字段透传。独立探针已实证
  // pi 1.0.0 --mode rpc 输出该帧。
  const mirrorA = await waitRawMirror(
    dataDir,
    recA.record?.subagentId,
    (t) => countEventType(t, 'auto_retry_start') >= 1,
    60_000,
  )
  const retryStartsA = countEventType(mirrorA.text, 'auto_retry_start')
  const retryEndsA = countEventType(mirrorA.text, 'auto_retry_end')
  ev.assert('铁证③(raw mirror 双证)：孙进程原始事件流在盘', mirrorA.files.length > 0, {
    channel: 'C',
    expected: `logs/pi-subagent-*-${recA.record?.subagentId}.jsonl 存在`,
    actual: mirrorA.files.length > 0 ? mirrorA.files.map((f) => path.basename(f)).join(',') : `未找到（logs 目录：${fs.existsSync(path.join(dataDir, 'logs')) ? fs.readdirSync(path.join(dataDir, 'logs')).slice(0, 20).join(',') : '缺失'}）`,
  })
  ev.assert('铁证③(raw mirror 双证)：原始事件流出现 auto_retry_start（预期 2 次 = maxRetries）', retryStartsA >= 1, {
    channel: 'C',
    expected: 'auto_retry_start ≥1（maxRetries=2 预期 2）',
    actual: `auto_retry_start=${retryStartsA} auto_retry_end=${retryEndsA}`,
  })
  ev.step({ step: 'native.retry.frames', channel: 'C', exitCode: 0, stats: { autoRetryStart: retryStartsA, autoRetryEnd: retryEndsA } })
  ev.attach('raw-mirror-A', mirrorA.text.slice(0, 160_000))
  ev.attach('subagents-disk-A', diskTextA.slice(0, 120_000))

  // ══ 段间衔接：等段 1 通知轮把主队游标推到 step3（p0 同款 fail-fast） ══
  const queue = await waitMainQueueConsumed(instance, 3, 90_000)
  if (!queue.ok) {
    ev.attach('pending-snapshot', JSON.stringify(instance.mockLlm?.pending() ?? {}, null, 2))
    ev.assert('衔接：段 1 通知轮已消费主队前 3 步（防段 2 主轮错步）', false, {
      channel: 'C',
      expected: 'mock-1 队列已消费 ≥3 步',
      actual: `consumed=${queue.consumed}（pending 快照见附件）`,
    })
    return { uncovered: [...uncovered, '衔接失败：段 1.5 / 段 2 未执行（防错步消费的误导性失败组合）'], gotchas }
  }
  ev.assert('衔接：段 1 通知轮已消费主队前 3 步', true, {
    channel: 'C',
    expected: 'mock-1 队列已消费 ≥3 步',
    actual: `consumed=${queue.consumed}`,
  })

  // ══ 段 1.5：settings round-trip + ext-config 磁盘事实 ═════════
  // 写侧命令 config.setRetryRules（runtime retry-rules-config-message-handler.ts:28 case →
  // remote-retry-rules.ts setRetryRulesCustom 唯一写方）；读侧 config.getRetryRules 回
  // config.retryRules（view = { builtinRules, customRules }，不含 effectiveRules——
  // effectiveRules 断言走 ext-config 文件直读）。
  let setRulesReply = null
  let setRulesErr = ''
  // 广播截点必须在 RPC 之前取：runtime handler 先 reply 再 broadcast（两次 ws.send），
  // reply 帧 resolve 时广播帧可能还在同一 tick 之后到达——直接同步快照会漏帧
  // （a8 首跑实测：config.retryRules 帧未入 events，但写侧断言全绿）。改条件轮询。
  const sinceBroadcast = protocol.events.length
  try {
    setRulesReply = await protocol.call('config.setRetryRules', { customRules: [CUSTOM_RULE] }, { replyType: 'config.retryRules', timeoutMs: 60_000 })
  } catch (e) {
    setRulesErr = String(e?.message ?? e)
  }
  const customInReply = (setRulesReply?.customRules ?? []).find((r) => r.id === CUSTOM_RULE.id)
  ev.assert('round-trip 写：setRetryRules 回读 customRules 含新规则且 source=custom（写侧归一）', Boolean(customInReply) && customInReply?.source === 'custom', {
    channel: 'B',
    expected: `customRules 含 id=${CUSTOM_RULE.id} source=custom`,
    actual: setRulesErr ? `RPC error: ${setRulesErr.slice(0, 300)}` : JSON.stringify(setRulesReply?.customRules ?? []).slice(0, 300),
  })
  ev.assert('round-trip 读：builtinRules 非空（内置预设展示面 = 编译期基线 ⊕ 远程）', (setRulesReply?.builtinRules ?? []).length > 0, {
    channel: 'B',
    expected: 'builtinRules.length > 0（RETRY_RULES_BASELINE 16 条量级）',
    actual: `builtinRules=${(setRulesReply?.builtinRules ?? []).length}`,
  })
  // 保存成功后广播 config.retryRules（retry-rules-config-message-handler.ts:40-44）。
  // 条件轮询等待（删掉 a8 首跑的同步快照断言——那是采集时机缺陷，不是广播缺失）。
  let broadcastOk = false
  let broadcastSeen = ''
  try {
    const evt = await protocol.waitFor((e) => e.type === 'config.retryRules', { since: sinceBroadcast, timeoutMs: 15_000 })
    broadcastOk = true
    broadcastSeen = JSON.stringify(evt.payload ?? {}).slice(0, 200)
  } catch (e) {
    broadcastSeen = String(e?.message ?? e).slice(0, 300)
  }
  ev.assert('round-trip 广播：config.retryRules 帧到达（多窗口同步通道）', broadcastOk, {
    channel: 'B',
    expected: 'since 截点后 events 出现 config.retryRules',
    actual: broadcastOk ? broadcastSeen : `未等到（${broadcastSeen}）`,
  })

  // ext-config 文件直读（断言④）：runtime 写侧与 extension 读侧共 <dataDir>/agent/config/
  // retry-rules-ext-config.json（remote-retry-rules.ts RETRY_RULES_CONFIG_REL ↔ llm-shared
  // getConfigPath('retry-rules') 契约一致；extConfigPath 在段 0 已声明）。
  const extConfig = await waitFileParsed(
    extConfigPath,
    (p) => p?.version === 1 && Array.isArray(p?.effectiveRules) && p.effectiveRules.some((r) => r.id === CUSTOM_RULE.id),
    15_000,
  )
  ev.assert('ext-config 磁盘事实：文件存在且形状合法（version=1 + customRules/effectiveRules 数组）', extConfig?.version === 1 && Array.isArray(extConfig?.customRules) && Array.isArray(extConfig?.effectiveRules), {
    channel: 'C',
    expected: 'version=1 + customRules[] + effectiveRules[]',
    actual: extConfig ? `version=${extConfig.version} custom=${(extConfig.customRules ?? []).length} effective=${(extConfig.effectiveRules ?? []).length}` : `文件缺失或不可解析：${extConfigPath}`,
  })
  const customEffective = (extConfig?.effectiveRules ?? []).find((r) => r.id === CUSTOM_RULE.id)
  ev.assert('ext-config 合并视图：effectiveRules 含 source=custom 的自定义条目', Boolean(customEffective) && customEffective?.source === 'custom', {
    channel: 'C',
    expected: `effectiveRules 含 id=${CUSTOM_RULE.id} source=custom`,
    actual: customEffective ? JSON.stringify(customEffective).slice(0, 300) : '<缺>',
  })
  ev.assert('ext-config 合并视图：builtin 基线在 effectiveRules（extension 判定唯一消费段含 generic-rpm-limit）', (extConfig?.effectiveRules ?? []).some((r) => r.id === BASELINE_RULE_ID), {
    channel: 'C',
    expected: `effectiveRules 含 id=${BASELINE_RULE_ID}`,
    actual: (extConfig?.effectiveRules ?? []).map((r) => r.id).join(',') || '<缺>',
  })
  ev.attach('ext-config-after-set', readTextFile(extConfigPath).slice(0, 40_000))

  // 删除恢复：setRetryRules([]) → 读回空 + 文件 effectiveRules 不含 custom。
  let clearReply = null
  try {
    clearReply = await protocol.call('config.setRetryRules', { customRules: [] }, { replyType: 'config.retryRules', timeoutMs: 60_000 })
  } catch (e) {
    ev.assert('round-trip 删除：setRetryRules([]) 成功', false, {
      channel: 'B',
      expected: '回读 customRules 为空',
      actual: `RPC error: ${String(e?.message ?? e).slice(0, 300)}`,
    })
  }
  ev.assert('round-trip 删除：读回 customRules 为空', Array.isArray(clearReply?.customRules) && clearReply.customRules.length === 0, {
    channel: 'B',
    expected: 'customRules=[]',
    actual: JSON.stringify(clearReply?.customRules ?? []).slice(0, 200),
  })
  const clearedRaw = readTextFile(extConfigPath)
  let cleared = null
  try {
    cleared = JSON.parse(clearedRaw)
  } catch {
    cleared = null
  }
  ev.assert('round-trip 恢复：文件 effectiveRules 不再含 custom 条目（builtin 保留）', Array.isArray(cleared?.effectiveRules) && !cleared.effectiveRules.some((r) => r.source === 'custom') && cleared.effectiveRules.some((r) => r.id === BASELINE_RULE_ID), {
    channel: 'C',
    expected: 'effectiveRules 无 custom source 且含 generic-rpm-limit',
    actual: cleared ? `effective=${cleared.effectiveRules.length} customSource=${cleared.effectiveRules.filter((r) => r.source === 'custom').length}` : '文件不可解析',
  })

  // ══ 段 2：停用回落（pi 原生门关闭 → 改写不触发重试） ══════════
  // 停用通道语义（§3.3.12 定稿）：extension 无独立开关——停用复用 pi 原生 retry 配置
  // （enabled=false / maxRetries=0）；pi 重试决策点（agent-session.js:787
  // `!settings.enabled || _retryAttempt >= settings.maxRetries`）位于 errorMessage 词表
  // 判定之前，改写仍会发生但被前置门拦截 → 不重试。
  const RETRY_OFF = { enabled: false, maxRetries: 0, baseDelayMs: 0 }
  let retryOffReply = null
  try {
    retryOffReply = await protocol.call('config.setRetryConfig', { config: RETRY_OFF }, { replyType: 'config.retryConfig', timeoutMs: 60_000 })
  } catch (e) {
    ev.assert('段 2：config.setRetryConfig 停用', false, {
      channel: 'B',
      expected: '回执 config.enabled=false',
      actual: `RPC error: ${String(e?.message ?? e).slice(0, 300)}`,
    })
    return { uncovered: [...uncovered, '停用失败，段 2 未执行'], gotchas }
  }
  ev.assert('段 2：retry 配置停用（enabled=false, maxRetries=0）', retryOffReply?.config?.enabled === false && retryOffReply?.config?.maxRetries === 0, {
    channel: 'B',
    expected: 'config.retryConfig 回执 enabled=false maxRetries=0',
    actual: JSON.stringify(retryOffReply?.config ?? {}).slice(0, 300),
  })

  const createdB = await protocol.call('session.create', { cwd: repo, label: 'p1-retry-off' }, { timeoutMs: 120_000 })
  const sidB = createdB.session?.id
  await protocol.subscribe(sidB)
  ev.step({ step: 'session.create.B', channel: 'B', exitCode: 0, stats: { sessionId: sidB } })

  // 段 2 前的 raw mirror 文件快照（段 2 断言用文件集差分，防 recordId 语义漂移）。
  const mirrorFilesBefore = listRawMirrorFiles(dataDir)

  const seg2Start = (instance.mockLlm?.requests ?? []).length
  const sinceB = protocol.events.length
  await protocol.send(sidB, 'dispatch one subagent (p1-retry-rules-extension 段 2, retry off)')
  const endB = await protocol.waitTurnEnd(sidB, { since: sinceB, timeoutMs: 180_000 })
  ev.assert('段 2：主轮完成（message.complete 非 error）', endB.type === 'message.complete' && endB.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${endB.type} stop=${endB.payload?.stopReason ?? 'n/a'}`,
  })
  const histB = await protocol.history(sidB, { limitTurns: 10 })
  ev.assert('段 2 控制组：主会话文本来自主队剧本（RETRY-OFF-DISPATCHED）', JSON.stringify(histB.messages ?? []).includes('RETRY-OFF-DISPATCHED'), {
    channel: 'B',
    expected: 'history 含 RETRY-OFF-DISPATCHED',
    actual: `messages=${(histB.messages ?? []).length}`,
  })

  const recB = await waitRecordTerminal(protocol, sidB, 'retry-off', 180_000)
  ev.step({
    step: 'subagent.observe.B', channel: 'B', exitCode: 0,
    stats: { count: recB.records.length, status: recB.record?.status, stopReason: recB.record?.stopReason },
  })
  ev.assert('段 2：成员 record 走到终态（首败即终局，不再 running）', Boolean(recB.record) && !['running', 'pending'].includes(String(recB.record?.status)), {
    channel: 'B',
    expected: 'record.status 为终态',
    actual: `status=${recB.record?.status} stopReason=${recB.record?.stopReason}`,
  })
  ev.attach('subagent-records-B', JSON.stringify(recB.records, null, 2).slice(0, 40_000))

  // 停用回落铁证：段 2 切片内成员模型只 1 次请求（错误后不重试）。门开着会复现段 1 的 ≥2。
  const memberSegB = await waitMemberRequests(instance, seg2Start, 1, 120_000)
  ev.step({
    step: 'mock.requests.B', channel: 'C', exitCode: 0,
    stats: { memberRequests: memberSegB.length, all404: memberSegB.filter((r) => r.status === 404).length },
  })
  ev.assert('停用回落：同一错误形态下成员只 1 次请求（pi 前置门拦截，改写不触发重试）', memberSegB.length === 1, {
    channel: 'C',
    expected: `恰好 1 × model=${SUB_MODEL}（对照段 1 的 ≥2）`,
    actual: `${memberSegB.length} 条`,
  })
  // 停用态 record：lastRound.retryAttempts 应缺省（无重试事实，G2 契约「无重试 = 缺省不落键」）。
  const retryAttemptsB = recB.record?.lastRound?.retryAttempts
  ev.assert('停用回落：段 2 lastRound.retryAttempts 缺省（无重试事实，与段 1 的 2 对照）', retryAttemptsB === undefined || retryAttemptsB === 0, {
    channel: 'B',
    expected: 'lastRound.retryAttempts 缺省（undefined/0）',
    actual: `retryAttempts=${retryAttemptsB} lastRound=${JSON.stringify(recB.record?.lastRound ?? null).slice(0, 300)}`,
  })
  // 停用态原始事件流应无 auto_retry_start（与段 1 的 ≥1 成对照）。先断镜像文件在盘
  // （否则「0 帧」是假绿）。
  const mirrorB = await waitRawMirror(dataDir, recB.record?.subagentId, () => true, 30_000, mirrorFilesBefore)
  const retryStartsB = countEventType(mirrorB.text, 'auto_retry_start')
  ev.assert('停用回落：段 2 原始事件流在盘（raw mirror 存在，防假绿前提）', mirrorB.files.length > 0, {
    channel: 'C',
    expected: `logs/pi-subagent-*-${recB.record?.subagentId}.jsonl 存在`,
    actual: mirrorB.files.length > 0 ? mirrorB.files.map((f) => path.basename(f)).join(',') : '<未找到>',
  })
  ev.assert('停用回落：段 2 原始事件流无 auto_retry_start（门关闭后 pi 未进入重试循环）', retryStartsB === 0, {
    channel: 'C',
    expected: 'auto_retry_start = 0（对照段 1 的 ≥1）',
    actual: `auto_retry_start=${retryStartsB}`,
  })
  ev.attach('raw-mirror-B', mirrorB.text.slice(0, 80_000))

  log(`done sidA=${sidA} sidB=${sidB} segA=${memberSegA.length} segB=${memberSegB.length}`)
  return { uncovered, gotchas }
}
