/**
 * 重试规则域契约测试（subagent-observability §3.3.12，shared SSOT）。
 *
 * 覆盖：verdict 词表封闭 + 校验错误信封（逐项收集 + 修复动作）+ ReDoS 危险构造拒绝 +
 * JSON 片段平衡提取 + 双通道匹配 + 两层序判定管线（verdict 排除先于来源）+ 合并视图
 * （同 id 覆盖 + 新 id 追加）+ 改写标记追加式幂等 + 基线数据形状 guard + ext-config/
 * remote payload guard。
 */
import { describe, expect, it } from 'vitest'

import {
  appendRetryMarker,
  DEFAULT_RETRY_RULES_EXT_CONFIG,
  evaluateRetryRules,
  extractJsonSegment,
  isDangerousRetryPattern,
  isRetryRulesExtConfig,
  isRetryRulesRemoteConfig,
  mergeRetryRules,
  RETRY_REWRITE_MARKER,
  RETRY_REWRITE_MARKER_PREFIX,
  RETRY_RULES_BASELINE,
  RETRY_RULES_DOMAIN,
  RETRY_RULE_VERDICTS,
  validateRetryRuleFields,
  validateRetryRuleList,
  type RetryableErrorRule,
} from '../retry-rules.js'

/** 构造规则（测试便捷，字段取合法最小形态）。 */
function rule(overrides: Partial<RetryableErrorRule>): RetryableErrorRule {
  return {
    id: 'test-rule',
    name: '测试规则',
    verdict: 'retryable',
    match: [{ kind: 'pattern', pattern: 'rate limit' }],
    class: 'provider',
    source: 'builtin',
    ...overrides,
  }
}

describe('verdict 词表封闭', () => {
  it('三态字面为下划线形态定稿（retryable / non_retryable / conditional）', () => {
    expect([...RETRY_RULE_VERDICTS]).toEqual(['retryable', 'non_retryable', 'conditional'])
  })
})

describe('kind 字段校验（per-class 闭合值域，分类侧消费域）', () => {
  it('class 词表内的合法 kind 放行', () => {
    expect(validateRetryRuleFields(rule({ kind: 'rate_limited' }))).toEqual({ ok: true })
    expect(validateRetryRuleFields(rule({ class: 'harness', kind: 'turn_budget_exhausted' }))).toEqual({ ok: true })
    expect(validateRetryRuleFields(rule({ class: 'user', kind: 'cancelled' }))).toEqual({ ok: true })
  })

  it('词表外 kind 拒绝且消息含该 class 的合法值清单（错误 → 恢复动作闭环）', () => {
    const result = validateRetryRuleFields(rule({ kind: 'turn_budget_exhausted' as never }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join(';')).toContain('rate_limited / protocol_unsupported')
    }
  })

  it('engine 类走开放前缀面：engine_ 前缀放行、非前缀拒绝', () => {
    expect(validateRetryRuleFields(rule({ class: 'engine', kind: 'engine_aborted' }))).toEqual({ ok: true })
    const bad = validateRetryRuleFields(rule({ class: 'engine', kind: 'aborted' as never }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.join(';')).toContain('engine_')
  })

  it('kind 缺省合法（可选字段——分类侧按 class+verdict 推导表落 kind）', () => {
    expect(rule({}).kind).toBeUndefined()
    expect(validateRetryRuleFields(rule({}))).toEqual({ ok: true })
  })

  it('class 缺失/非法时不单独判 kind 值域（class 自身错误已收集，不重复报错）', () => {
    const noClass = validateRetryRuleFields({ ...rule({}), class: undefined, kind: 'rate_limited' })
    expect(noClass.ok).toBe(false)
    if (!noClass.ok) expect(noClass.errors.join(';')).not.toContain('kind')
  })
})

describe('validateRetryRuleFields 错误信封', () => {
  it('合法规则通过', () => {
    expect(validateRetryRuleFields(rule({}))).toEqual({ ok: true })
  })

  it('非对象输入整体拒绝且不抛异常（对象性守卫）', () => {
    for (const bad of [null, 42, 'x', []]) {
      const result = validateRetryRuleFields(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors[0]).toContain('必须是对象')
    }
  })

  it('verdict 词表外值拒绝且消息含合法值清单', () => {
    const result = validateRetryRuleFields(rule({ verdict: 'non-retryable' as never }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(';')).toContain('non_retryable')
  })

  it('match 缺失/空清单逐项拒绝', () => {
    const missing = validateRetryRuleFields({ ...rule({}), match: undefined })
    expect(missing.ok).toBe(false)
    const empty = validateRetryRuleFields(rule({ match: [] }))
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.errors.join(';')).toContain('至少添加一条')
  })

  it('正则超长、语法非法、危险构造分别拒绝且文案指向恢复动作', () => {
    const tooLong = validateRetryRuleFields(rule({ match: [{ kind: 'pattern', pattern: 'a'.repeat(RETRY_RULES_DOMAIN.patternMaxLen + 1) }] }))
    expect(tooLong.ok).toBe(false)

    const invalid = validateRetryRuleFields(rule({ match: [{ kind: 'pattern', pattern: 'a(' }] }))
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.errors.join(';')).toContain('语法无效')

    const dangerous = validateRetryRuleFields(rule({ match: [{ kind: 'pattern', pattern: '(.+)*x' }] }))
    expect(dangerous.ok).toBe(false)
    if (!dangerous.ok) expect(dangerous.errors.join(';')).toContain('嵌套量词')
  })

  it('jsonPath 缺 value（equals/contains）拒绝，exists 允许缺 value', () => {
    const noValue = validateRetryRuleFields(rule({ match: [{ kind: 'jsonPath', path: 'error.code', operator: 'equals' }] }))
    expect(noValue.ok).toBe(false)
    const exists = validateRetryRuleFields(rule({ match: [{ kind: 'jsonPath', path: 'error.code', operator: 'exists' }] }))
    expect(exists.ok).toBe(true)
  })

  it('jsonPath 路径含空白拒绝', () => {
    const result = validateRetryRuleFields(rule({ match: [{ kind: 'jsonPath', path: 'error code', operator: 'exists' }] }))
    expect(result.ok).toBe(false)
  })
})

describe('validateRetryRuleList', () => {
  it('id 重复拒绝', () => {
    const result = validateRetryRuleList([rule({ id: 'dup' }), rule({ id: 'dup' })], '自定义规则')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(';')).toContain('重复')
  })

  it('条数超上限拒绝', () => {
    const many = Array.from({ length: RETRY_RULES_DOMAIN.customRulesMax + 1 }, (_, i) => rule({ id: `r${i}` }))
    const result = validateRetryRuleList(many, '自定义规则')
    expect(result.ok).toBe(false)
  })
})

describe('isDangerousRetryPattern', () => {
  it('嵌套量词构造判危险', () => {
    expect(isDangerousRetryPattern('(.+)*')).toBe(true)
    expect(isDangerousRetryPattern('(?:a|b+)+')).toBe(true)
    expect(isDangerousRetryPattern('a{2,4}{3,}')).toBe(true)
  })

  it('普通业务码正则不误报', () => {
    expect(isDangerousRetryPattern('"code"\\s*:\\s*"?(?:1308|1310)"?')).toBe(false)
    expect(isDangerousRetryPattern('rpm limit exceeded|tier_limit_exceeded')).toBe(false)
    expect(isDangerousRetryPattern('a'.repeat(RETRY_RULES_DOMAIN.patternMaxLen + 1))).toBe(true)
  })
})

describe('extractJsonSegment 平衡提取', () => {
  it('openai 拼法（status 前缀 + body JSON）提取 body 段', () => {
    const message = '429: {"error":{"code":"1302","message":"速率限制"}}'
    expect(extractJsonSegment(message)).toBe('{"error":{"code":"1302","message":"速率限制"}}')
  })

  it('字符串字面量内的括号不参与平衡计数', () => {
    const message = '400: {"error":{"message":"bad {brace} input"}} trailing'
    expect(extractJsonSegment(message)).toBe('{"error":{"message":"bad {brace} input"}}')
  })

  it('无 JSON / 未闭合返回 null', () => {
    expect(extractJsonSegment('plain text error')).toBeNull()
    expect(extractJsonSegment('400: {"error":')).toBeNull()
  })
})

describe('evaluateRetryRules 两层序判定管线', () => {
  const zhipu1302 = rule({
    id: 'zhipu-1302',
    verdict: 'retryable',
    match: [{ kind: 'jsonPath', path: 'error.code', operator: 'equals', value: '1302' }],
  })
  const zhipuAccount = rule({
    id: 'zhipu-account',
    verdict: 'non_retryable',
    match: [{ kind: 'pattern', pattern: '"code"\\s*:\\s*"?(?:1113|1309)"?' }],
  })
  const windowLimit = rule({
    id: 'zhipu-window',
    verdict: 'conditional',
    match: [{ kind: 'pattern', pattern: '"code"\\s*:\\s*"?(?:1310)"?' }],
  })
  const customRetryable = rule({ id: 'custom-a', verdict: 'retryable', source: 'custom', match: [{ kind: 'pattern', pattern: 'custom-marker' }] })
  const customExempt = rule({ id: 'custom-exempt', verdict: 'non_retryable', source: 'custom', match: [{ kind: 'pattern', pattern: 'my-quota' }] })

  it('命中 retryable 规则 → rewrite', () => {
    const message = '429: {"error":{"code":"1302"}}'
    expect(evaluateRetryRules(message, [zhipu1302])).toEqual({ action: 'rewrite' })
  })

  it('第一层排除：non_retryable 命中优先于 source 更靠前的 retryable（用户规则击穿被结构封死）', () => {
    const message = '429: {"error":{"code":"1113"}}'
    // custom retryable 规则在前（source 序更优），但 1113 命中 non_retryable 排除档 → keep
    const userRetryAll = rule({ id: 'user-all', verdict: 'retryable', source: 'custom', match: [{ kind: 'pattern', pattern: '429' }] })
    expect(evaluateRetryRules(message, [userRetryAll, zhipuAccount])).toEqual({
      action: 'keep',
      reason: 'non_retryable_hit',
    })
  })

  it('conditional 命中不改写（执行语义：等不到的动作 extension 做不了）', () => {
    const message = '429: {"error":{"code":"1310"}}'
    expect(evaluateRetryRules(message, [zhipu1302, windowLimit])).toEqual({ action: 'keep', reason: 'conditional_hit' })
  })

  it('第二层 source 序：custom > remote > builtin，命中即断', () => {
    const message = 'error: custom-marker'
    const remote = rule({ id: 'remote-a', verdict: 'retryable', source: 'remote', match: [{ kind: 'pattern', pattern: 'custom-marker' }] })
    const builtin = rule({ id: 'builtin-a', verdict: 'conditional', source: 'builtin', match: [{ kind: 'pattern', pattern: 'custom-marker' }] })
    // custom retryable 命中（断，不再看 remote/builtin）
    expect(evaluateRetryRules(message, [builtin, remote, customRetryable])).toEqual({ action: 'rewrite' })
    // 无 custom 时 remote 命中
    expect(evaluateRetryRules(message, [builtin, remote])).toEqual({ action: 'rewrite' })
    // 仅 builtin conditional → keep
    expect(evaluateRetryRules(message, [builtin])).toEqual({ action: 'keep', reason: 'conditional_hit' })
  })

  it('用户 non_retryable 规则同样进第一层排除（自定义业务码 → 命中即不重试，UC-23）', () => {
    const message = 'error: my-quota exceeded'
    expect(evaluateRetryRules(message, [customExempt, customRetryable])).toEqual({
      action: 'keep',
      reason: 'non_retryable_hit',
    })
  })

  it('无命中 → 不改写（pi 原生词表兜底）', () => {
    expect(evaluateRetryRules('some unknown error', [zhipu1302])).toEqual({ action: 'keep', reason: 'no_rule_match' })
  })

  it('空文本不判定', () => {
    expect(evaluateRetryRules('   ', [customRetryable])).toEqual({ action: 'keep', reason: 'empty_message' })
  })

  it('超长文本截断后匹配（成本封顶）', () => {
    const long = 'x'.repeat(RETRY_RULES_DOMAIN.textMaxLen + 100) + ' custom-marker'
    // 超出截断窗口的命中键被截掉 → 不命中
    expect(evaluateRetryRules(long, [customRetryable])).toEqual({ action: 'keep', reason: 'no_rule_match' })
    const inside = 'x'.repeat(RETRY_RULES_DOMAIN.textMaxLen - 20) + ' custom-marker'
    expect(evaluateRetryRules(inside, [customRetryable]).action).toBe('rewrite')
  })
})

describe('mergeRetryRules 合并视图', () => {
  it('同 id 覆盖（保留基线位置、source 记 remote）+ 新 id 追加到尾部', () => {
    const baseline = [rule({ id: 'a', name: '基线A' }), rule({ id: 'b', name: '基线B' })]
    const remote = [rule({ id: 'b', name: '远程B', source: 'remote' }), rule({ id: 'c', name: '新增C', source: 'remote' })]
    const custom = [rule({ id: 'u', source: 'custom' })]
    const merged = mergeRetryRules(baseline, remote, custom)
    expect(merged.map((r) => `${r.id}:${r.source}:${r.name}`)).toEqual([
      'u:custom:测试规则',
      'a:builtin:基线A',
      'b:remote:远程B',
      'c:remote:新增C',
    ])
  })
})

describe('appendRetryMarker 改写标记（追加式 + 幂等）', () => {
  it('追加标记保留原文（追加式非替换式）', () => {
    const original = 'membership rpm limit exceeded: 101/100 resets 2026-10-23T12:00:00.000Z'
    const rewritten = appendRetryMarker(original)
    expect(rewritten.startsWith(original)).toBe(true)
    expect(rewritten).toContain(RETRY_REWRITE_MARKER_PREFIX)
    expect(rewritten).toBe(`${original}${RETRY_REWRITE_MARKER}`)
  })

  it('已带标记原样返回（幂等）', () => {
    const once = appendRetryMarker('boom')
    expect(appendRetryMarker(once)).toBe(once)
  })
})

describe('基线数据与 payload guard', () => {
  it('内置基线全部通过域校验且 id 唯一（基线数据形状 guard，损坏 = 仓库内数据错误）', () => {
    const result = validateRetryRuleList(RETRY_RULES_BASELINE, '基线')
    expect(result).toEqual({ ok: true })
    const ids = new Set(RETRY_RULES_BASELINE.map((r) => r.id))
    expect(ids.size).toBe(RETRY_RULES_BASELINE.length)
  })

  it('内置基线含第一层排除档（non_retryable）与业务码可重试档', () => {
    expect(RETRY_RULES_BASELINE.some((r) => r.verdict === 'non_retryable')).toBe(true)
    expect(RETRY_RULES_BASELINE.some((r) => r.verdict === 'retryable' && r.id.startsWith('zhipu-'))).toBe(true)
  })

  it('tier-limit-window 基线条目在场且形态 = 场景 1 分类码表（400 tier_limit_exceeded → rate_limited/conditional）', () => {
    const entry = RETRY_RULES_BASELINE.find((r) => r.id === 'tier-limit-window')
    expect(entry).toMatchObject({
      verdict: 'conditional',
      class: 'provider',
      kind: 'rate_limited',
      httpStatusClass: 400,
    })
    expect(entry?.match).toEqual([{ kind: 'pattern', pattern: 'tier_limit_exceeded' }])
    expect(entry?.waitHint).toContain('resets')
    // tier_limit_exceeded 文本只由 conditional 条目承接（generic-rpm-limit 已收窄为
    // rpm limit exceeded 专用——同一文本两档 verdict 会靠数组序隐式决胜，码表卫生拒绝）
    expect(
      RETRY_RULES_BASELINE.filter((r) => r.match.some((m) => m.kind === 'pattern' && m.pattern.includes('tier_limit_exceeded'))).map((r) => r.id),
    ).toEqual(['tier-limit-window'])
  })

  it('remote payload guard：合法通过、非法整体拒用', () => {
    expect(isRetryRulesRemoteConfig({ version: 1, rules: [] })).toBe(true)
    expect(isRetryRulesRemoteConfig({ version: 1, rules: [{ ...rule({}) }] })).toBe(true)
    expect(isRetryRulesRemoteConfig({ version: 2, rules: [] })).toBe(false)
    expect(isRetryRulesRemoteConfig({ version: 1, rules: 'x' })).toBe(false)
    expect(isRetryRulesRemoteConfig({ version: 1, rules: [{ ...rule({}), verdict: 'bogus' }] })).toBe(false)
  })

  it('ext-config guard：默认配置合法；段缺失/条目非法拒绝', () => {
    expect(isRetryRulesExtConfig(DEFAULT_RETRY_RULES_EXT_CONFIG)).toBe(true)
    expect(isRetryRulesExtConfig({ version: 1, customRules: [rule({ source: 'custom' })], effectiveRules: RETRY_RULES_BASELINE })).toBe(true)
    expect(isRetryRulesExtConfig({ version: 1, customRules: [] })).toBe(false)
    expect(isRetryRulesExtConfig({ version: 1, customRules: [], effectiveRules: [{ nonsense: true }] })).toBe(false)
  })
})
