// @vitest-environment node

/**
 * partitioned-session-records 单测 —— 共享分区工厂行为直测（不 import 任何 store，无环）。
 *
 * - createPartitionedRecords：record 表四件套（state ref + 响应式视图 + 非响应式读 +
 *   不可变写/清）——apply 触发响应性 / 空数组兜底 / clear 幂等 / 多 sid 独立。
 * - createPartitionedLoadState：加载态三件套（loading / loadError / oversize，待裁决项 1
 *   收敛 2026-10-04）——缺省读取 / beginLoad 清错误 / endLoad 删条目不重生 / facet 独立 /
 *   clear 精确释放 / clearAll 整表替换。
 *
 * 两 store（subagent / workflow）的 facet 领域语义与工厂接线由各自 store 测试锁定；
 * 本文件锁工厂自身的分区范式（与 createPartitionedRecords 同风格的行为面）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/lib/partitioned-session-records.test.ts
 */
import { describe, it, expect } from 'vitest'
import { createPartitionedLoadState, createPartitionedRecords } from '@/lib/partitioned-session-records'

describe('createPartitionedRecords — record 表四件套', () => {
  it('get / recordsOf 缺省空数组（无条目不写 Map）', () => {
    const p = createPartitionedRecords<{ id: string }>()
    expect(p.get('s1')).toEqual([])
    expect(p.recordsOf('s1').value).toEqual([])
  })

  it('apply 写入分区并触发响应式视图重算（不可变替换整 Map）', () => {
    const p = createPartitionedRecords<{ id: string }>()
    const view = p.recordsOf('s1')
    expect(view.value).toEqual([])
    p.apply('s1', [{ id: 'a' }])
    expect(view.value).toEqual([{ id: 'a' }])
    expect(p.get('s1')).toEqual([{ id: 'a' }])
  })

  it('clear 精确释放指定 sid，其他 sid 不受影响；对缺失 sid 幂等', () => {
    const p = createPartitionedRecords<{ id: string }>()
    p.apply('s1', [{ id: 'a' }])
    p.apply('s2', [{ id: 'b' }])
    p.clear('s1')
    expect(p.get('s1')).toEqual([])
    expect(p.get('s2')).toEqual([{ id: 'b' }])
    expect(() => p.clear('never')).not.toThrow()
  })

  it('apply 空数组是合法写入（真实删空语义，分区存在但为空）', () => {
    const p = createPartitionedRecords<{ id: string }>()
    p.apply('s1', [{ id: 'a' }])
    p.apply('s1', [])
    expect(p.get('s1')).toEqual([])
  })
})

describe('createPartitionedLoadState — 加载态三件套（待裁决项 1 收敛）', () => {
  it('读取缺省：无条目 = loading false / error null / oversize false', () => {
    const load = createPartitionedLoadState()
    expect(load.isLoadingOf('s1')).toBe(false)
    expect(load.loadErrorOf('s1')).toBeNull()
    expect(load.oversizeOf('s1')).toBe(false)
  })

  it('beginLoad：loading 置位 + 该 sid 错误清除（loadXxx 入口语义单点）', () => {
    const load = createPartitionedLoadState()
    load.setLoadError('s1', 'stale error')
    load.beginLoad('s1')
    expect(load.isLoadingOf('s1')).toBe(true)
    expect(load.loadErrorOf('s1')).toBeNull()
  })

  it('endLoad：loading 条目删除（无条目残留 = 不在途语义，非 set false）', () => {
    const load = createPartitionedLoadState()
    load.beginLoad('s1')
    load.endLoad('s1')
    expect(load.isLoadingOf('s1')).toBe(false)
    // 未 begin 的 sid endLoad 是 no-op（不重生条目）
    load.endLoad('never')
    expect(load.isLoadingOf('never')).toBe(false)
  })

  it('setLoadError / oversize 置清：facet 各自独立，互不串扰', () => {
    const load = createPartitionedLoadState()
    load.beginLoad('s1')
    load.setLoadError('s1', 'rpc down')
    load.setOversize('s1')
    expect(load.loadErrorOf('s1')).toBe('rpc down')
    expect(load.oversizeOf('s1')).toBe(true)
    expect(load.isLoadingOf('s1')).toBe(true)

    load.clearOversize('s1')
    expect(load.oversizeOf('s1')).toBe(false)
    expect(load.loadErrorOf('s1')).toBe('rpc down')
  })

  it('clear：三分区精确释放（deleteSession 路径），其他 sid 不受影响', () => {
    const load = createPartitionedLoadState()
    load.beginLoad('s1')
    load.setLoadError('s1', 'e1')
    load.setOversize('s1')
    load.beginLoad('s2')
    load.setOversize('s2')

    load.clear('s1')

    expect(load.isLoadingOf('s1')).toBe(false)
    expect(load.loadErrorOf('s1')).toBeNull()
    expect(load.oversizeOf('s1')).toBe(false)
    expect(load.isLoadingOf('s2')).toBe(true)
    expect(load.oversizeOf('s2')).toBe(true)
  })

  it('clearAll：整表替换（clearSubagents / clearWorkflows 全局重置语义）', () => {
    const load = createPartitionedLoadState()
    load.beginLoad('s1')
    load.setLoadError('s2', 'e2')
    load.setOversize('s3')

    load.clearAll()

    expect(load.isLoadingOf('s1')).toBe(false)
    expect(load.loadErrorOf('s2')).toBeNull()
    expect(load.oversizeOf('s3')).toBe(false)
  })

  it('多 sid 分区独立（ADR-0049：split 双面板并行拉取互不遮蔽）', () => {
    const load = createPartitionedLoadState()
    load.beginLoad('a')
    expect(load.isLoadingOf('a')).toBe(true)
    expect(load.isLoadingOf('b')).toBe(false)
    load.setLoadError('b', 'pane-b down')
    expect(load.loadErrorOf('a')).toBeNull()
    expect(load.loadErrorOf('b')).toBe('pane-b down')
  })
})
