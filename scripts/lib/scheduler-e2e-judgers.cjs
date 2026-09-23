/**
 * pi-scheduler e2e 驱动器（scripts/verify-scheduler-e2e.cjs）的判定器纯函数族。
 *
 * 职责边界：输入 → 判定/投影 的确定性纯函数（无 IO、无进程、无时钟）；
 * 场景编排（runS*）、pi 进程 spawn、JSONL 文件读取等副作用面留在驱动器本体。
 * 抽出动机：判定器自错（协议形状判定漂移 / 分支回归）= e2e 假绿 / 假红不可辨，
 * 须有直接单测锁定（scripts/__tests__/verify-scheduler-e2e.test.mjs）。
 */
'use strict'

/**
 * 从统一表单请求帧提取 schedule 问题（cjs 端口）：options[0] payload 的
 * formQuestions[0] 为 type='schedule'（initial 预填 draft）时返回该问题，否则 null。
 * payload 非法 JSON / 缺字段同样返回 null——调用方不应答（挂起暴露协议故障，
 * 不静默造回包）。
 * @param {{ options?: string[] }} request
 * @returns {{ type: 'schedule', header?: string, question: string, initial?: object } | null}
 */
function getScheduleQuestionFromRequest(request) {
  if (!request || !Array.isArray(request.options) || request.options.length < 1) return null
  try {
    const payload = JSON.parse(request.options[0])
    const q = payload && Array.isArray(payload.formQuestions) ? payload.formQuestions[0] : null
    if (q && q.type === 'schedule') return q
  } catch {
    return null
  }
  return null
}

/** ScheduleDraft 顶层形状守卫：非 null 的普通对象（排除数组）。 */
function isDraftPayloadObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** ScheduleDraft 可选字段守卫：undefined（未提供）或 string。 */
function isOptionalString(v) {
  return v === undefined || typeof v === 'string'
}

/** ScheduleDraft kind 字段守卫：'once' 或 'recurring'。 */
function isScheduleDraftKind(kind) {
  return kind === 'once' || kind === 'recurring'
}

/**
 * 对象是否为合法 ScheduleDraft 形状（cjs 端口；字段判定与
 * packages/extension-protocol/src/extensions/scheduler-create/helpers.ts 的
 * isScheduleDraft 一致，改动须同步）。驱动器用于断言请求帧 payload 的协议形状。
 * 判定顺序与端口源一致（顶层形状 → kind → 各字段），不可调换。
 * @param {unknown} value
 * @returns {boolean}
 */
function isScheduleDraftShape(value) {
  if (!isDraftPayloadObject(value)) return false
  const d = value
  return isScheduleDraftKind(d.kind)
    && typeof d.schedule === 'string'
    && isOptionalString(d.model)
    && typeof d.prompt === 'string'
    && isOptionalString(d.name)
    && isOptionalString(d.expires)
    && Array.isArray(d.models)
    && d.models.every((m) => typeof m === 'string')
    && isOptionalString(d.currentModel)
}

/** entry 类型分布摘要（failure 详情用）。 */
function describeEntryTypeCounts(entries) {
  const counts = new Map()
  for (const e of entries || []) {
    const t = e && typeof e.type === 'string' ? e.type : '?'
    counts.set(t, (counts.get(t) || 0) + 1)
  }
  return [...counts.entries()].map(([t, n]) => `${t}:${n}`).join(',') || '(empty)'
}

/**
 * 解析 JSONL 文本为 entry 数组：按行切分，跳过空行与 JSON.parse 失败行
 * （banner / 半行）。文件级 IO（existsSync / readFileSync）留在驱动器的
 * readJsonlEntries——本函数是其判定核心，畸形行容错语义的测试锚点。
 * @param {string} raw 会话文件全文
 * @returns {unknown[]}
 */
function parseJsonlEntries(raw) {
  /** @type {unknown[]} */
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* 跳过 banner / 半行 */
    }
  }
  return out
}

/**
 * 命令路径表单请求帧契约校验：options[0] payload 的 formQuestions[0] 为 schedule 问题
 * 且 initial 是合法 ScheduleDraft，并可选校验预填值（expected.schedule / .prompt / .kind）。
 * 调用方另断言 reqs.length（各命令路径场景恒恰 1 次请求）。
 * @param {Array<{ id: string, options: string[] }>} reqs getScheduleFormRequests 产物
 * @param {{ schedule?: string, prompt?: string, kind?: string }} [expected] 预填值期望
 * @returns {{ ok: boolean, desc: string, draft: object | null }} ok=契约成立；
 *   desc=请求侧诊断（未取到 draft 时 '(none)'）；draft=解析到的 ScheduleDraft
 */
function checkScheduleFormDraftContract(reqs, expected = {}) {
  let desc = '(none)'
  if (reqs.length < 1 || reqs[0].options.length < 1) return { ok: false, desc, draft: null }
  const q = getScheduleQuestionFromRequest(reqs[0])
  if (!q) return { ok: false, desc, draft: null }
  const draft = q.initial
  let ok = isScheduleDraftShape(draft)
  if (ok && expected.schedule !== undefined) ok = draft.schedule === expected.schedule
  if (ok && expected.prompt !== undefined) ok = draft.prompt === expected.prompt
  if (ok && expected.kind !== undefined) ok = draft.kind === expected.kind
  desc = isDraftPayloadObject(draft)
    ? `kind=${draft.kind} schedule=${draft.schedule} prompt=${String(draft.prompt).slice(0, 40)} models=${Array.isArray(draft.models) ? draft.models.length : '?'}`
    : '(none)'
  return { ok, desc, draft: isDraftPayloadObject(draft) ? draft : null }
}

module.exports = {
  getScheduleQuestionFromRequest,
  isDraftPayloadObject,
  isOptionalString,
  isScheduleDraftKind,
  isScheduleDraftShape,
  describeEntryTypeCounts,
  parseJsonlEntries,
  checkScheduleFormDraftContract,
}
