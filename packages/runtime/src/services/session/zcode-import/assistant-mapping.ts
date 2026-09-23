/**
 * zcode assistant → pi assistant 的字段映射域（converter 的无状态辅助层）：
 * T3c stopReason 映射（含取消/失败轮的 error 优先裁决）、step-finish tokens → pi usage、
 * 共享小型运行时守卫。纯函数、零 converter 依赖（防循环）；2026-09-21 毒消息事故后
 * 从 converter.ts 拆出（max-lines），行为零变化（测试仍锚在 converter 公共面）。
 */

const STOP_REASON_MAP: Readonly<Record<string, string>> = Object.freeze({
  'tool-calls': 'toolUse',
  stop: 'stop',
  completed: 'stop',
  length: 'length',
  interrupted: 'aborted',
  failed: 'error',
  stream_recovery_discarded: 'error',
  start_plan_admission_retry_discarded: 'error',
})

function mapStopReason(zcodeFinish: unknown): string {
  return typeof zcodeFinish === 'string' ? (STOP_REASON_MAP[zcodeFinish] ?? 'stop') : 'stop'
}

/**
 * 未收口段（无 step-finish 闭合）的 stopReason：消息级 data.error 优先（T3c 事故补强，
 * 2026-09-21 毒消息事故——取消轮无 step-finish，finish 兜底把它伪装成 'stop'，而 pi
 * 0.84.4 读面对「非 aborted/error 的 assistant」裸读 usage：stats 聚合 agent-session.js
 * :2678（reading 'input'）、turn 前上下文扫描 :2721（reading 'totalTokens'）、overflow
 * 检查 usage.input——伪 stop + 无 usage 导入后续聊即崩）。turnResult cancelled →
 * 'aborted'（pi 语义 = 用户中止），其余 error 家族 → 'error'；两态 pi 守卫均跳过。
 * 段自身有 step-finish 收口时不走本函数（见 converter closeSegment）。
 */
function unsealedStopReason(data: Record<string, unknown>): string {
  const error = isRecord(data.error) ? data.error : undefined
  if (error === undefined) return 'stop'
  const errData = isRecord(error.data) ? error.data : undefined
  const turnResult = typeof errData?.turnResult === 'string' ? errData.turnResult : undefined
  if (turnResult === 'cancelled') return 'aborted'
  return 'error'
}

/**
 * 产物不变量门（A3）：assistant entry 恒带 usage 对象——pi 读面三处裸读（见
 * unsealedStopReason 注释）以「stopReason 非 aborted/error ⇒ usage 在场」为隐式前提
 * （pi 原生写侧连错误轮都写全零 usage；全零 = pi 的「无测量数据」合法编码，守卫按
 * 无效跳过、零贡献进统计）。step-finish 缺席（取消轮）或 tokens 不可解时零值兜底；
 * 不进降级通道——这是期望内的忠实映射（非正常收口已由 stopReason 显形），非异常。
 */
function zeroUsage(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { total: 0 },
  }
}

/**
 * step-finish 的 tokens/cost → pi Usage（字段映射表见设计 §3.4 T3：同名直通/total→
 * totalTokens/…）。
 *
 * RT-5#1 缺省语义：可解分量才写键——「无数据」写成测量值 0 会永久污染落盘用量/费用
 * 统计（usage-stats 扫描聚合即读本产物；gen-stats 同款「禁 ?? 0」纪律：0 只允许作为
 * 真实测量值出现；不变量门的全零兜底与此不矛盾——那是缺整个对象的兜底，不是把缺失
 * 分量伪造成 0）。全部分量不可解 → usage 不写 + degradation 文本返回（调用方登记）。
 * 消费面已核实对缺键安全：usage-stats 的 `!message?.usage` 存在性守卫、
 * apply-entry-convert 的 isLooseRecord 均按「无数据」跳过。cost 是 number（zcode
 * 形态）→ usage.cost.total（pi Usage.cost 是对象形态，直塞 number 产出非法类型）；
 * cost 分量 zcode 不采集，缺省不写 0。
 */
function usageFromStepFinish(partData: Record<string, unknown>): {
  usage: Record<string, unknown> | undefined
  degradation: string | undefined
} {
  const tokens = partData.tokens
  if (!isRecord(tokens)) return { usage: undefined, degradation: undefined }
  const cache = isRecord(tokens.cache) ? tokens.cache : {}
  const input = asFinite(tokens.input)
  const output = asFinite(tokens.output)
  const cacheRead = asFinite(cache.read)
  const cacheWrite = asFinite(cache.write)
  const reasoning = asFinite(tokens.reasoning)
  const totalTokens = asFinite(tokens.total)
  const costTotal = asFinite(partData.cost)
  const usage: Record<string, unknown> = {
    ...(input !== undefined && { input }),
    ...(output !== undefined && { output }),
    ...(cacheRead !== undefined && { cacheRead }),
    ...(cacheWrite !== undefined && { cacheWrite }),
    ...(reasoning !== undefined && { reasoning }),
    ...(totalTokens !== undefined && { totalTokens }),
    ...(costTotal !== undefined && { cost: { total: costTotal } }),
  }
  if (Object.keys(usage).length === 0) {
    return {
      usage: undefined,
      degradation: 'step-finish tokens/cost 分量全部不可解，整条 usage 不写（零值兜底）',
    }
  }
  return { usage, degradation: undefined }
}

// ── 小型运行时守卫（输入是外部宽形态 JSON，禁 any，malformed 降级不抛错）────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asFinite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 非空字符串守卫（空串不作为有效指针参与解析——与 projection asNonEmptyString 同语义）。 */
function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export {
  asFinite,
  asNonEmptyString,
  isRecord,
  mapStopReason,
  unsealedStopReason,
  usageFromStepFinish,
  zeroUsage,
}
