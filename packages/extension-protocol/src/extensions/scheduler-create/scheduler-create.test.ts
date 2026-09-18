// scheduler-create.test.ts — scheduler 创建确认协议：
// 时间折叠往返（dateToOnceCron / onceCronToDate）/ isScheduleDraft 守卫 /
// scheduleCreateInteract 四态折叠。
// 经 barrel（../../index）导入：单测同时锚定新增导出面。

import { describe, it, expect, vi } from 'vitest'
import {
  SCHEDULE_CREATE_MARKER,
  dateToOnceCron,
  onceCronToDate,
  isScheduleDraft,
  scheduleCreateInteract,
  type GuiContext,
  type ScheduleDraft,
} from '../../index'

type SelectImpl = (
  marker: string,
  options: string[],
  opts?: { signal?: AbortSignal; timeout?: number },
) => Promise<string | undefined>

/** mock ctx：select 实现由用例注入（缺省 resolve undefined） */
function makeCtx(impl?: SelectImpl): { ctx: GuiContext; selectMock: ReturnType<typeof vi.fn> } {
  const selectMock = vi.fn(impl ?? (async () => undefined))
  const ctx: GuiContext = { mode: 'rpc', hasUI: true, ui: { select: selectMock } }
  return { ctx, selectMock }
}

const NOW = new Date(2026, 8, 18, 12, 0) // 2026-09-18 12:00 本地墙钟

const draft: ScheduleDraft = {
  kind: 'once',
  schedule: '0 9 19 9 *',
  prompt: '总结昨天的工作进展',
  models: ['deepseek-flash'],
  currentModel: 'mimo-v2.5-pro',
}

describe('dateToOnceCron（本地墙钟 → 5 段一次性 cron）', () => {
  it('基本折叠：2026-09-19 09:00 → "0 9 19 9 *"', () => {
    expect(dateToOnceCron(new Date(2026, 8, 19, 9, 0))).toBe('0 9 19 9 *')
  })

  it('分/时不补前导零：09:05 → "5 9 19 9 *"', () => {
    expect(dateToOnceCron(new Date(2026, 8, 19, 9, 5))).toBe('5 9 19 9 *')
  })

  it('月末边界：9/30 23:59 → "59 23 30 9 *"', () => {
    expect(dateToOnceCron(new Date(2026, 8, 30, 23, 59))).toBe('59 23 30 9 *')
  })

  it('年末月界：12/31 08:30 → "30 8 31 12 *"', () => {
    expect(dateToOnceCron(new Date(2026, 11, 31, 8, 30))).toBe('30 8 31 12 *')
  })

  it('跨日月界（1 号 0 点）："0 0 1 5 *"', () => {
    expect(dateToOnceCron(new Date(2026, 4, 1, 0, 0))).toBe('0 0 1 5 *')
  })
})

describe('onceCronToDate（一次性 cron → 本地墙钟下一次发生）', () => {
  it('当年未来时刻：直接还原', () => {
    expect(onceCronToDate('0 9 19 9 *', NOW)).toEqual(new Date(2026, 8, 19, 9, 0))
  })

  it('当年已过期：顺延到明年', () => {
    expect(onceCronToDate('0 9 19 9 *', new Date(2026, 8, 19, 10, 0)))
      .toEqual(new Date(2027, 8, 19, 9, 0))
  })

  it('恰好等于 now：视为未过期（>= now 语义）', () => {
    expect(onceCronToDate('0 12 18 9 *', NOW)).toEqual(NOW)
  })

  it('月末边界：1 月 31 日 23:59', () => {
    expect(onceCronToDate('59 23 31 1 *', new Date(2026, 0, 1)))
      .toEqual(new Date(2026, 0, 31, 23, 59))
  })

  it('2 月末：2/28 还原', () => {
    expect(onceCronToDate('0 8 28 2 *', new Date(2026, 0, 1)))
      .toEqual(new Date(2026, 1, 28, 8, 0))
  })

  it('闰日：非闰年基准顺延到下一个闰年（2026 基准 → 2028-02-29）', () => {
    expect(onceCronToDate('30 9 29 2 *', new Date(2026, 0, 1)))
      .toEqual(new Date(2028, 1, 29, 9, 30))
  })

  it('多空白分隔宽容解析', () => {
    expect(onceCronToDate('0  9  19  9  *', NOW)).toEqual(new Date(2026, 8, 19, 9, 0))
  })

  it('非 once 形态 → null：循环 cron（日位 *）不做时刻还原', () => {
    expect(onceCronToDate('0 9 * * *', NOW)).toBeNull()
  })

  it('6 段（含秒位形态）→ null：本协议折叠产物恒 5 段', () => {
    expect(onceCronToDate('0 0 9 19 9 *', NOW)).toBeNull()
  })

  it('星期位非 * → null', () => {
    expect(onceCronToDate('0 9 19 9 1', NOW)).toBeNull()
  })

  it.each([
    ['60 9 19 9 *'], // 分越界
    ['0 24 19 9 *'], // 时越界
    ['0 9 32 9 *'], // 日越界
    ['0 9 0 9 *'], // 日下界
    ['0 9 19 13 *'], // 月越界
    ['0 9 19 0 *'], // 月下界
  ])('数字段范围越界 → null：%s', (cron) => {
    expect(onceCronToDate(cron, NOW)).toBeNull()
  })

  it.each([
    ['a 9 19 9 *'], // 非数字段
    ['0 9 19 9'], // 4 段
    [''],
    ['0 9 19 9 * * extra'], // 7 段
  ])('畸形输入 → null：%s', (cron) => {
    expect(onceCronToDate(cron, NOW)).toBeNull()
  })

  it('往返：dateToOnceCron 产物经 onceCronToDate 还原为同一本地墙钟时刻（跨日/月末/年末采样）', () => {
    const samples = [
      new Date(2026, 8, 18, 12, 0),
      new Date(2026, 8, 30, 23, 59), // 月末
      new Date(2026, 11, 31, 8, 30), // 年末
      new Date(2027, 0, 1, 0, 0), // 跨日跨年
    ]
    for (const sample of samples) {
      // now 取样本前 1 分钟 → 还原应精确回到样本时刻
      const before = new Date(sample.getTime() - 60_000)
      expect(onceCronToDate(dateToOnceCron(sample), before)).toEqual(sample)
    }
  })
})

describe('isScheduleDraft 守卫', () => {
  const validDraft: ScheduleDraft = {
    kind: 'recurring',
    schedule: '0 9 * * *',
    prompt: '总结昨天的工作进展',
    models: ['deepseek-flash', 'mimo-v2.5-pro'],
  }

  it('最小合法 draft（必填字段齐）→ true', () => {
    expect(isScheduleDraft(validDraft)).toBe(true)
  })

  it('全字段 draft → true', () => {
    expect(isScheduleDraft({
      kind: 'once',
      schedule: '0 9 19 9 *',
      model: 'deepseek-flash',
      prompt: 'p',
      name: '每日总结',
      expires: '7d',
      models: ['deepseek-flash'],
      currentModel: 'mimo-v2.5-pro',
    })).toBe(true)
  })

  it('缺 kind → false', () => {
    expect(isScheduleDraft({ schedule: '0 9 * * *', prompt: 'p', models: [] })).toBe(false)
  })

  it('缺 schedule → false', () => {
    expect(isScheduleDraft({ kind: 'once', prompt: 'p', models: [] })).toBe(false)
  })

  it('缺 prompt → false', () => {
    expect(isScheduleDraft({ kind: 'once', schedule: '0 9 * * *', models: [] })).toBe(false)
  })

  it('缺 models → false', () => {
    expect(isScheduleDraft({ kind: 'once', schedule: '0 9 * * *', prompt: 'p' })).toBe(false)
  })

  it('kind 非法值 → false', () => {
    expect(isScheduleDraft({ ...validDraft, kind: 'daily' })).toBe(false)
  })

  it('models 含非 string → false', () => {
    expect(isScheduleDraft({ ...validDraft, models: ['ok', 42] })).toBe(false)
  })

  it('models 非数组 → false', () => {
    expect(isScheduleDraft({ ...validDraft, models: 'deepseek-flash' })).toBe(false)
  })

  it('可选字段类型错（model 非字符串）→ false', () => {
    expect(isScheduleDraft({ ...validDraft, model: 42 })).toBe(false)
  })

  it('多字段（未知附加字段）→ true：字段白名单校验，多余字段忽略（isAskUserQuestion 同构语义）', () => {
    expect(isScheduleDraft({ ...validDraft, unknownFutureField: true })).toBe(true)
  })

  it('null / undefined / 非对象 / 数组 → false', () => {
    expect(isScheduleDraft(null)).toBe(false)
    expect(isScheduleDraft(undefined)).toBe(false)
    expect(isScheduleDraft('draft')).toBe(false)
    expect(isScheduleDraft([validDraft])).toBe(false)
  })
})

describe('scheduleCreateInteract（RPC 确认交互，四态折叠）', () => {
  it('成功：回传 FormResult JSON → ok:true + 收窄 result', async () => {
    const formResult = {
      action: 'create',
      kind: 'once',
      schedule: '0 9 21 9 *',
      prompt: '用户调整后的提示词',
      model: 'deepseek-flash',
    }
    const { ctx } = makeCtx(async () => JSON.stringify(formResult))

    const outcome = await scheduleCreateInteract(ctx, draft)

    expect(outcome).toEqual({ ok: true, result: formResult })
  })

  it('select 参数：marker / [draft JSON] / signal 透传', async () => {
    const signal = new AbortController().signal
    const { ctx, selectMock } = makeCtx(async () => JSON.stringify({
      action: 'create', kind: 'once', schedule: '0 9 19 9 *', prompt: 'p',
    }))

    await scheduleCreateInteract(ctx, draft, { signal })

    expect(selectMock).toHaveBeenCalledTimes(1)
    const [marker, options, opts] = selectMock.mock.calls[0] as [string, string[], { signal?: AbortSignal }]
    expect(marker).toBe(SCHEDULE_CREATE_MARKER)
    expect(JSON.parse(options[0])).toEqual(draft)
    expect(options).toHaveLength(1)
    expect(opts.signal).toBe(signal)
  })

  it('draft 的 undefined 可选字段不进 payload（JSON.stringify 天然丢弃）', async () => {
    const { ctx, selectMock } = makeCtx(async () => JSON.stringify({
      action: 'create', kind: 'once', schedule: '0 9 19 9 *', prompt: 'p',
    }))
    const minimal: ScheduleDraft = { kind: 'once', schedule: '0 9 19 9 *', prompt: 'p', models: [] }

    await scheduleCreateInteract(ctx, minimal)

    const payload = (selectMock.mock.calls[0] as [string, string[]])[1][0]
    expect(payload).not.toContain('"model"')
    expect(payload).not.toContain('"name"')
    expect(payload).not.toContain('"currentModel"')
    expect(payload).toContain('"models":[]')
  })

  it('回传 FormResult 可选字段缺省 → ok:true（model 未选 = 缺省）', async () => {
    const { ctx } = makeCtx(async () => JSON.stringify({
      action: 'create', kind: 'recurring', schedule: '5m', prompt: 'p',
    }))

    const outcome = await scheduleCreateInteract(ctx, draft)

    expect(outcome).toEqual({
      ok: true,
      result: { action: 'create', kind: 'recurring', schedule: '5m', prompt: 'p' },
    })
  })

  it('回包 undefined + signal 已 abort → cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ctx } = makeCtx(async () => undefined)

    const outcome = await scheduleCreateInteract(ctx, draft, { signal: controller.signal })

    expect(outcome).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('回包 undefined 无 signal → timeout（仅由未 abort 的 undefined resolve 产生）', async () => {
    const { ctx } = makeCtx(async () => undefined)

    const outcome = await scheduleCreateInteract(ctx, draft)

    expect(outcome).toEqual({ ok: false, reason: 'timeout' })
  })

  it('select throw → channel-error + log 留痕', async () => {
    const log = vi.fn()
    const { ctx } = makeCtx(async () => {
      throw new Error('channel closed')
    })

    const outcome = await scheduleCreateInteract(ctx, draft, { log })

    expect(outcome).toEqual({ ok: false, reason: 'channel-error' })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('非 JSON 回包 → non-json', async () => {
    const log = vi.fn()
    const { ctx } = makeCtx(async () => 'plain text response')

    const outcome = await scheduleCreateInteract(ctx, draft, { log })

    expect(outcome).toEqual({ ok: false, reason: 'non-json' })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['空对象', '{}'],
    ['action 非法', JSON.stringify({ action: 'cancel', kind: 'once', schedule: '0 9 19 9 *', prompt: 'p' })],
    ['kind 非法', JSON.stringify({ action: 'create', kind: 'daily', schedule: '0 9 * * *', prompt: 'p' })],
    ['缺 prompt', JSON.stringify({ action: 'create', kind: 'once', schedule: '0 9 19 9 *' })],
    ['数组形态', '["create"]'],
  ])('JSON 合法但非本协议形状 → non-json（协议版本错配同折叠）：%s', async (_label, raw) => {
    const log = vi.fn()
    const { ctx } = makeCtx(async () => raw)

    const outcome = await scheduleCreateInteract(ctx, draft, { log })

    expect(outcome).toEqual({ ok: false, reason: 'non-json' })
    expect(log).toHaveBeenCalledWith(
      'schedule-create response is not a ScheduleFormResult',
      expect.objectContaining({ responseHead: expect.any(String) }),
    )
  })

  it('TUI 模式 → throw（extension 须自行 ctx.ui.custom，返回 null 会与用户取消混淆）', async () => {
    const ctx: GuiContext = { mode: 'tui', hasUI: true }

    await expect(scheduleCreateInteract(ctx, draft)).rejects.toThrow(/only available in RPC mode/)
  })

  it('RPC 但 ui.select 缺席 → throw（与 TUI 同一门控，恢复动作同指 ctx.ui.custom）', async () => {
    const ctx: GuiContext = { mode: 'rpc', hasUI: true }

    await expect(scheduleCreateInteract(ctx, draft)).rejects.toThrow(/only available in RPC mode/)
  })
})
