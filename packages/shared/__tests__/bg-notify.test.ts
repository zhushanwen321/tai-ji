import { describe, it, expect } from 'vitest'
import { parseBgNotifyDetails } from '../src/message'
import type { BgNotifyRecord } from '../src/message'

describe('parseBgNotifyDetails', () => {
  const validRecord: Record<string, unknown> = {
    id: 'job-1',
    status: 'done',
    agent: 'coder',
    model: 'claude-4.5',
    result: 'Done.',
    startedAt: 1000,
    endedAt: 13000,
  }

  it('单条形态：返回 BgNotifyRecord', () => {
    const d = parseBgNotifyDetails(validRecord)
    expect(d).not.toBeNull()
    expect(!('batch' in (d as object))).toBe(true)
    const rec = d as BgNotifyRecord
    expect(rec.id).toBe('job-1')
    expect(rec.status).toBe('done')
    expect(rec.agent).toBe('coder')
    expect(rec.model).toBe('claude-4.5')
    expect(rec.startedAt).toBe(1000)
    expect(rec.endedAt).toBe(13000)
  })

  it('批量形态：{batch, items} → 返回批量', () => {
    const d = parseBgNotifyDetails({
      batch: true,
      items: [validRecord, { ...validRecord, id: 'job-2', status: 'failed' }],
    })
    expect(d).not.toBeNull()
    expect('batch' in (d as object)).toBe(true)
    const batch = d as { batch: boolean; items: BgNotifyRecord[] }
    expect(batch.items).toHaveLength(2)
    expect(batch.items[1].status).toBe('failed')
  })

  it('批量中过滤掉非法 item（缺必需字段）', () => {
    const d = parseBgNotifyDetails({
      batch: true,
      items: [
        validRecord,
        { status: 'done' }, // 缺 id/agent/startedAt
      ],
    })
    const batch = d as { batch: boolean; items: BgNotifyRecord[] }
    expect(batch.items).toHaveLength(1)
    expect(batch.items[0].id).toBe('job-1')
  })

  it('批量 items 全非法 → 返回 null', () => {
    const d = parseBgNotifyDetails({ batch: true, items: [{ foo: 'bar' }] })
    expect(d).toBeNull()
  })

  it('批量 items 为空数组 → null（滑动窗口 flush 无完成的合法中间态）', () => {
    expect(parseBgNotifyDetails({ batch: true, items: [] })).toBeNull()
  })

  it('null / undefined / 非 object → null', () => {
    expect(parseBgNotifyDetails(null)).toBeNull()
    expect(parseBgNotifyDetails(undefined)).toBeNull()
    expect(parseBgNotifyDetails('string')).toBeNull()
    expect(parseBgNotifyDetails(123)).toBeNull()
  })

  it('单条缺必需字段（id/status/agent/startedAt）→ null', () => {
    expect(parseBgNotifyDetails({ status: 'done', agent: 'x', startedAt: 1 })).toBeNull() // 缺 id
    expect(parseBgNotifyDetails({ id: 'x', agent: 'y', startedAt: 1 })).toBeNull() // 缺 status
    expect(parseBgNotifyDetails({ id: 'x', status: 'done', startedAt: 1 })).toBeNull() // 缺 agent
    expect(parseBgNotifyDetails({ id: 'x', status: 'done', agent: 'y' })).toBeNull() // 缺 startedAt
  })

  it('status 非法值 → null（idle 为 v4 已删除的死值，按非法处理）', () => {
    expect(parseBgNotifyDetails({ ...validRecord, status: 'unknown' })).toBeNull()
    expect(parseBgNotifyDetails({ ...validRecord, status: 'idle' })).toBeNull()
  })

  it('可选字段缺失时正常解析', () => {
    const minimal = { id: 'x', status: 'cancelled', agent: 'y', startedAt: 1 }
    const rec = parseBgNotifyDetails(minimal) as BgNotifyRecord
    expect(rec.id).toBe('x')
    expect(rec.status).toBe('cancelled')
    expect(rec.model).toBeUndefined()
    expect(rec.result).toBeUndefined()
    expect(rec.endedAt).toBeUndefined()
    expect(rec.patchFile).toBeUndefined()
    expect(rec.closedReason).toBeUndefined()
    expect(rec.round).toBeUndefined()
  })

  it('running 状态（对话模式轮次完成）+ round 字段正常解析', () => {
    const runningRecord = { id: 'r1', status: 'running', agent: 'coder', startedAt: 100, round: 3, result: 'Round 3 done.' }
    const rec = parseBgNotifyDetails(runningRecord) as BgNotifyRecord
    expect(rec.status).toBe('running')
    expect(rec.round).toBe(3)
    expect(rec.result).toBe('Round 3 done.')
    expect(rec.closedReason).toBeUndefined()
  })

  it('closed 状态 + closedReason 正常解析', () => {
    const closedRecord = { id: 'r2', status: 'closed', agent: 'coder', startedAt: 100, closedReason: 'gc' }
    const rec = parseBgNotifyDetails(closedRecord) as BgNotifyRecord
    expect(rec.status).toBe('closed')
    expect(rec.closedReason).toBe('gc')
  })

  // ── parseSingleRecord 空串拒绝语义（必需字段空串视为缺失，非仅 undefined）──────
  it('id 为空串 → null（空串拒绝，非 string 类型缺失分支）', () => {
    expect(parseBgNotifyDetails({ id: '', status: 'done', agent: 'x', startedAt: 1 })).toBeNull()
  })

  it('agent 为空串 → null（空串拒绝）', () => {
    expect(parseBgNotifyDetails({ id: 'x', status: 'done', agent: '', startedAt: 1 })).toBeNull()
  })

  it('可选字段类型非法 → 字段不写入（保持 undefined，不抛错）', () => {
    const rec = parseBgNotifyDetails({
      id: 'x',
      status: 'running',
      agent: 'y',
      startedAt: 1,
      model: 123,
      result: null,
      error: [1],
      endedAt: 'later',
      patchFile: {},
      closedReason: true,
      round: '3',
    }) as BgNotifyRecord
    expect(rec.model).toBeUndefined()
    expect(rec.result).toBeUndefined()
    expect(rec.error).toBeUndefined()
    expect(rec.endedAt).toBeUndefined()
    expect(rec.patchFile).toBeUndefined()
    expect(rec.closedReason).toBeUndefined()
    expect(rec.round).toBeUndefined()
  })

  it('record 属性写入顺序锁定（JSON.stringify 依赖属性序，重排即 WS 帧/落盘字节漂移）', () => {
    const rec = parseBgNotifyDetails({
      id: 'x',
      status: 'done',
      agent: 'y',
      startedAt: 1,
      model: 'm',
      result: 'r',
      error: 'e',
      endedAt: 2,
      patchFile: 'p',
      closedReason: 'c',
      round: 1,
    }) as BgNotifyRecord
    expect(Object.keys(rec)).toEqual([
      'id',
      'status',
      'agent',
      'startedAt',
      'model',
      'result',
      'error',
      'endedAt',
      'patchFile',
      'closedReason',
      'round',
    ])
  })
})
