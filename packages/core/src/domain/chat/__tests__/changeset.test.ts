/**
 * domain/chat changeset 单测（MF-3 扩展：纯函数 + createChangeSetController controller 行为）。
 *
 * Part 1（mergeFileChanges，w2 原样迁移）：锁定纯函数增量合并语义（ADR-0024 D5 baseline diff）：
 * - 同 filePath 取 incoming 最新项（status 覆盖）
 * - addLines/delLines：incoming 未带则沿用 baseline（继承语义）
 * - ready 全集替换：baseline=[] 时纯取 incoming
 *
 * Part 2（createChangeSetController，MF-3 新增）：直接调工厂构造实例，messages ref 用
 * shallowRef 构造（参照 streaming-state-machine.test.ts），不 mock 被测模块内部依赖
 *（commitMessages / findLastAssistantIndex / mergeFileChanges 走真实实现）。覆盖 applyFileChanges
 * 全分支（messageId 命中/未命中 fallback / isFullSet 全集替换 vs 增量合并 / status key 编码）
 * 与 markChangeSetsSuperseded 的 resolved 豁免。
 */
import { describe, it, expect } from 'vitest'
import type { ShallowRef } from 'vue'
import { shallowRef } from 'vue'
import type { FileChange, Message } from '@taiji/shared'
import { mergeFileChanges, createChangeSetController } from '../changeset'

function fc(filePath: string, extra: Partial<FileChange> = {}): FileChange {
  return { filePath, status: 'modified', ...extra } as FileChange
}

describe('mergeFileChanges', () => {
  it('incoming 为空时原样返回 baseline', () => {
    const baseline = [fc('a.ts'), fc('b.ts')]
    expect(mergeFileChanges([], baseline)).toEqual(baseline)
  })

  it('baseline 为空时原样返回 incoming（ready 全集替换语义）', () => {
    const incoming = [fc('a.ts', { status: 'added' })]
    expect(mergeFileChanges(incoming, [])).toEqual(incoming)
  })

  it('同 filePath：incoming 覆盖 baseline 的 status', () => {
    const baseline = [fc('a.ts', { status: 'modified' })]
    const incoming = [fc('a.ts', { status: 'deleted' })]
    const result = mergeFileChanges(incoming, baseline)
    expect(result).toHaveLength(1)
    expect(result[0].filePath).toBe('a.ts')
    expect(result[0].status).toBe('deleted') // 被覆盖
  })

  it('不同 filePath：incoming 与 baseline 并集', () => {
    const baseline = [fc('a.ts')]
    const incoming = [fc('b.ts')]
    const result = mergeFileChanges(incoming, baseline)
    expect(result.map((c) => c.filePath).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('addLines/delLines 继承：incoming 未带时沿用 baseline', () => {
    const baseline = [fc('a.ts', { addLines: 10, delLines: 2 })]
    const incoming = [fc('a.ts', { status: 'modified' })] // 未带 addLines/delLines
    const result = mergeFileChanges(incoming, baseline)
    expect(result[0].addLines).toBe(10) // 沿用 baseline
    expect(result[0].delLines).toBe(2) // 沿用 baseline
  })

  it('addLines/delLines 覆盖：incoming 带时用 incoming 的', () => {
    const baseline = [fc('a.ts', { addLines: 10, delLines: 2 })]
    const incoming = [fc('a.ts', { addLines: 5, delLines: 1 })]
    const result = mergeFileChanges(incoming, baseline)
    expect(result[0].addLines).toBe(5) // incoming 覆盖
    expect(result[0].delLines).toBe(1) // incoming 覆盖
  })

  it('addLines/delLines 双向独立继承：incoming 只带 addLines 时 delLines 沿用 baseline', () => {
    const baseline = [fc('a.ts', { addLines: 10, delLines: 2 })]
    const incoming = [fc('a.ts', { addLines: 7 })] // 只带 addLines
    const result = mergeFileChanges(incoming, baseline)
    expect(result[0].addLines).toBe(7) // incoming
    expect(result[0].delLines).toBe(2) // 沿用 baseline
  })

  it('baseline 与 incoming 都不带 addLines/delLines：结果也不带', () => {
    const baseline = [fc('a.ts')]
    const incoming = [fc('a.ts', { status: 'modified' })]
    const result = mergeFileChanges(incoming, baseline)
    expect(result[0].addLines).toBeUndefined()
    expect(result[0].delLines).toBeUndefined()
  })
})

// ── Part 2: createChangeSetController（MF-3 controller 行为） ──

/** 构造 assistant 消息（可选 overrides，如 fileChanges） */
function assistantMsg(id: string, overrides: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content: '', status: 'complete', timestamp: 1, ...overrides }
}

/** 构造 user 消息（用于测试 fallback 时 message 列表含非 assistant 项） */
function userMsg(id: string): Message {
  return { id, role: 'user', content: '', status: 'complete', timestamp: 1 }
}

/** 构造一个持有 messages ref 的 controller 实例（D-1 容器：内层分区为 ShallowRef） */
function makeController(initial: Map<string, Message[]> = new Map()) {
  const messages = shallowRef<Map<string, ShallowRef<Message[]>>>(
    new Map([...initial].map(([sid, msgs]) => [sid, shallowRef(msgs)])),
  )
  const controller = createChangeSetController(messages)
  return { controller, messages }
}

describe('createChangeSetController — changeSetStatuses / get / set + key 编码', () => {
  it('初始 changeSetStatuses 为空 Map，getChangeSetStatus 返回 undefined', () => {
    const { controller } = makeController()
    expect(controller.changeSetStatuses.value).toBeInstanceOf(Map)
    expect(controller.changeSetStatuses.value.size).toBe(0)
    expect(controller.getChangeSetStatus('s1', 'm1')).toBeUndefined()
  })

  it('setChangeSetStatus 写入后 getChangeSetStatus 返回该状态', () => {
    const { controller } = makeController()
    controller.setChangeSetStatus('s1', 'm1', 'ready')
    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('ready')
    expect(controller.changeSetStatuses.value.size).toBe(1)
  })

  it('key 编码 `${sessionId}:${messageId}`：同 messageId 不同 session 各自独立', () => {
    const { controller } = makeController()
    controller.setChangeSetStatus('s1', 'm1', 'ready')
    controller.setChangeSetStatus('s2', 'm1', 'resolved') // 同 messageId 不同 session

    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('ready')
    expect(controller.getChangeSetStatus('s2', 'm1')).toBe('resolved')
    expect(controller.changeSetStatuses.value.size).toBe(2)
    // 内部 key 形态校验
    expect([...controller.changeSetStatuses.value.keys()]).toEqual(['s1:m1', 's2:m1'])
  })

  it('setChangeSetStatus 不可变写：整体替换 changeSetStatuses.value', () => {
    const { controller } = makeController()
    controller.setChangeSetStatus('s1', 'm1', 'ready')
    const before = controller.changeSetStatuses.value
    controller.setChangeSetStatus('s1', 'm1', 'resolved')
    const after = controller.changeSetStatuses.value
    expect(after).not.toBe(before) // 新 Map 引用
    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('resolved')
  })
})

describe('createChangeSetController — applyFileChanges messageId 命中/未命中 fallback', () => {
  it('messageId 命中：更新该 assistant message 的 fileChanges', () => {
    const { controller, messages } = makeController(
      new Map([['s1', [assistantMsg('m1')]]]),
    )
    controller.applyFileChanges('s1', 'm1', [fc('a.ts', { status: 'added' })], 'accumulating', false)

    const after = messages.value.get('s1')!.value
    expect(after[0].fileChanges).toEqual([fc('a.ts', { status: 'added' })])
  })

  it('messageId 未命中 → fallback findLastAssistantIndex：更新最后一条 assistant message', () => {
    // 列表含 user + 两条 assistant，messageId 命中不到任何一条 → fallback 到最后一条 assistant
    const { controller, messages } = makeController(
      new Map([['s1', [userMsg('u1'), assistantMsg('a1'), assistantMsg('a2', { fileChanges: [fc('old.ts')] })]]]),
    )
    controller.applyFileChanges('s1', 'wrongId', [fc('new.ts', { status: 'added' })], 'accumulating', false)

    const after = messages.value.get('s1')!.value
    expect(after[2].id).toBe('a2') // fallback 命中最后一条 assistant（未变 id）
    // 增量合并：incoming new.ts 与旧 old.ts 并集
    expect(after[2].fileChanges!.map((c) => c.filePath).sort()).toEqual(['new.ts', 'old.ts'])
    // a1 不受影响
    expect(after[1].fileChanges).toBeUndefined()
  })

  it('messageId 未命中且无 assistant（targetIdx<0）：no-op，不抛错不写', () => {
    const { controller, messages } = makeController(
      new Map([['s1', [userMsg('u1'), userMsg('u2')]]]),
    )
    const before = messages.value
    controller.applyFileChanges('s1', 'wrongId', [fc('a.ts')], 'accumulating', false)
    expect(messages.value).toBe(before) // 引用稳定，未写入
    expect(messages.value.get('s1')!.value[1].fileChanges).toBeUndefined()
  })

  it('session 无消息（prev.length===0）：no-op return', () => {
    const { controller, messages } = makeController(new Map())
    controller.applyFileChanges('ghost', 'm1', [fc('a.ts')], 'accumulating', false)
    expect(messages.value.has('ghost')).toBe(false)
    // changeSetStatus 也不应记录（early return 在记 status 之前）
    expect(controller.changeSetStatuses.value.size).toBe(0)
  })

  it('messageId 未命中 fallback 时 status key 仍用传入的 messageId（按源码实际行为锁定）', () => {
    const { controller } = makeController(new Map([['s1', [assistantMsg('a1')]]]))
    controller.applyFileChanges('s1', 'mFallback', [fc('a.ts')], 'ready', true)
    // status 记在传入的 messageId key 上（与 fileChanges 落地的 message.id 可能不一致——源码设计）
    expect(controller.getChangeSetStatus('s1', 'mFallback')).toBe('ready')
    expect([...controller.changeSetStatuses.value.keys()]).toEqual(['s1:mFallback'])
  })
})

describe('createChangeSetController — applyFileChanges isFullSet 全集替换 vs 增量合并', () => {
  it('isFullSet=false 增量合并：incoming 与已有 fileChanges 并集（同 filePath 取最新）', () => {
    const { controller, messages } = makeController(
      new Map([['s1', [assistantMsg('m1', { fileChanges: [fc('a.ts', { addLines: 10 }), fc('b.ts')] })]]]),
    )
    controller.applyFileChanges('s1', 'm1', [fc('a.ts', { status: 'deleted' }), fc('c.ts')], 'accumulating', false)

    const after = messages.value.get('s1')!.value[0].fileChanges!
    const byPath = new Map(after.map((c) => [c.filePath, c]))
    expect([...byPath.keys()].sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(byPath.get('a.ts')!.status).toBe('deleted') // incoming 覆盖
    expect(byPath.get('a.ts')!.addLines).toBe(10) // incoming 未带，沿用 baseline
    expect(byPath.get('b.ts')).toBeDefined() // baseline 保留
    expect(byPath.get('c.ts')).toBeDefined() // incoming 新增
  })

  it('isFullSet=true 全集替换：丢弃已有 fileChanges，只取 incoming', () => {
    const { controller, messages } = makeController(
      new Map([['s1', [assistantMsg('m1', { fileChanges: [fc('old.ts'), fc('stale.ts')] })]]]),
    )
    controller.applyFileChanges('s1', 'm1', [fc('fresh.ts', { status: 'added' })], 'ready', true)

    const after = messages.value.get('s1')!.value[0].fileChanges!
    expect(after).toHaveLength(1)
    expect(after[0].filePath).toBe('fresh.ts') // 只剩 incoming
    expect(after[0].status).toBe('added')
  })

  it('isFullSet=true 空 incoming：清空已有 fileChanges（baseline=[] 全集替换为空集）', () => {
    const { controller, messages } = makeController(
      new Map([['s1', [assistantMsg('m1', { fileChanges: [fc('old.ts')] })]]]),
    )
    controller.applyFileChanges('s1', 'm1', [], 'ready', true)
    expect(messages.value.get('s1')!.value[0].fileChanges).toEqual([])
  })

  it('applyFileChanges 写入后容器不可变替换：外层 Map 恒等 + 分区 ref 恒等 + 内层 .value 数组替换', () => {
    const { controller, messages } = makeController(
      new Map([['s1', [assistantMsg('m1')]]]),
    )
    const mapBefore = messages.value
    const partition = messages.value.get('s1')!
    const arrBefore = partition.value
    controller.applyFileChanges('s1', 'm1', [fc('a.ts')], 'accumulating', false)
    // D-1（07 文档 §3.3.2）：同 sid commit 不替换外层 Map，只替换分区 ref 的 .value
    expect(messages.value).toBe(mapBefore)
    expect(messages.value.get('s1')).toBe(partition)
    expect(partition.value).not.toBe(arrBefore) // 数组整体替换触发 shallowRef 响应
  })

  it('applyFileChanges 记录 changeSetStatus 到 `${sid}:${msgId}` key', () => {
    const { controller } = makeController(new Map([['s1', [assistantMsg('m1')]]]))
    controller.applyFileChanges('s1', 'm1', [fc('a.ts')], 'ready', true)
    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('ready')
    expect([...controller.changeSetStatuses.value.keys()]).toEqual(['s1:m1'])
  })
})

describe('createChangeSetController — applyFileChanges 单向守卫（W18 纵深防御，03 D3-3）', () => {
  it('ready 后迟到的 accumulating 帧：status 不回退 + fileChanges 不合并（整体丢弃）', () => {
    const { controller, messages } = makeController(
      new Map([['s1', [assistantMsg('m1', { fileChanges: [fc('ready.ts')] })]]]),
    )
    controller.applyFileChanges('s1', 'm1', [fc('ready.ts')], 'ready', true)

    // 迟到的 accumulating：若未守卫会把 status 写回 accumulating 且增量合并污染 ready 全集
    controller.applyFileChanges('s1', 'm1', [fc('late.ts', { status: 'added' })], 'accumulating', false)

    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('ready') // 不回退
    const after = messages.value.get('s1')!.value[0].fileChanges!
    expect(after.map((c) => c.filePath)).toEqual(['ready.ts']) // 不合并
  })

  it('审查态（partially-reviewed/resolved/superseded）后 accumulating 同样丢弃', () => {
    const { controller } = makeController(new Map([['s1', [assistantMsg('m1')]]]))
    for (const status of ['partially-reviewed', 'resolved', 'superseded'] as const) {
      controller.setChangeSetStatus('s1', 'm-review', status)
      controller.applyFileChanges('s1', 'm-review', [fc('x.ts')], 'accumulating', false)
      expect(controller.getChangeSetStatus('s1', 'm-review')).toBe(status)
    }
  })

  it('审查态（partially-reviewed/resolved/superseded）后迟到的 ready 帧同样丢弃：status 不回退 + fileChanges 不替换', () => {
    // W18 review：runtime 的 ready 绕过 turnGen 代际守卫恒推（否则卡片永久停在 accumulating），
    // 迟到 ready 可能晚于用户审查操作到达——前端守卫拦其覆盖审查态
    for (const status of ['partially-reviewed', 'resolved', 'superseded'] as const) {
      const { controller, messages } = makeController(
        new Map([['s1', [assistantMsg('m1', { fileChanges: [fc('reviewed.ts')] })]]]),
      )
      controller.setChangeSetStatus('s1', 'm1', status)

      // 迟到的 ready：若未扩展守卫会把 status 写回 ready 且全集替换污染已审查内容
      controller.applyFileChanges('s1', 'm1', [fc('late-ready.ts', { status: 'added' })], 'ready', true)

      expect(controller.getChangeSetStatus('s1', 'm1')).toBe(status) // 不回退
      const after = messages.value.get('s1')!.value[0].fileChanges!
      expect(after.map((c) => c.filePath)).toEqual(['reviewed.ts']) // 不替换
    }
  })

  it('ready → ready 幂等重放放行（runtime 绕过代际守卫恒推的重推场景）：status 保持 + 全集替换', () => {
    const { controller, messages } = makeController(
      new Map([['s1', [assistantMsg('m1', { fileChanges: [fc('stale.ts')] })]]]),
    )
    controller.applyFileChanges('s1', 'm1', [fc('first.ts')], 'ready', true)
    controller.applyFileChanges('s1', 'm1', [fc('second.ts')], 'ready', true)

    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('ready')
    expect(messages.value.get('s1')!.value[0].fileChanges!.map((c) => c.filePath)).toEqual(['second.ts'])
  })

  it('accumulating → accumulating（正常流）允许；accumulating → ready 允许', () => {
    const { controller, messages } = makeController(
      new Map([['s1', [assistantMsg('m1')]]]),
    )
    controller.applyFileChanges('s1', 'm1', [fc('a.ts')], 'accumulating', false)
    controller.applyFileChanges('s1', 'm1', [fc('b.ts')], 'accumulating', false)
    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('accumulating')
    expect(messages.value.get('s1')!.value[0].fileChanges).toHaveLength(2)

    controller.applyFileChanges('s1', 'm1', [fc('final.ts')], 'ready', true)
    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('ready')
    expect(messages.value.get('s1')!.value[0].fileChanges!.map((c) => c.filePath)).toEqual(['final.ts'])
  })

  it('守卫按 messageId 分区：m1 已 ready 不影响 m2 的 accumulating 首帧', () => {
    const { controller } = makeController(
      new Map([['s1', [assistantMsg('m1'), assistantMsg('m2')]]]),
    )
    controller.applyFileChanges('s1', 'm1', [fc('a.ts')], 'ready', true)
    controller.applyFileChanges('s1', 'm2', [fc('b.ts')], 'accumulating', false)
    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('ready')
    expect(controller.getChangeSetStatus('s1', 'm2')).toBe('accumulating')
  })

  it('accumulating 首帧（prevStatus undefined）不受守卫影响', () => {
    const { controller } = makeController(new Map([['s1', [assistantMsg('m1')]]]))
    controller.applyFileChanges('s1', 'm1', [fc('a.ts')], 'accumulating', false)
    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('accumulating')
    expect(controller.changeSetStatuses.value.size).toBe(1)
  })
})

describe('createChangeSetController — markChangeSetsSuperseded resolved 豁免', () => {
  it('非 resolved 态推 superseded（accumulating/ready/partially-reviewed/superseded 全覆盖）', () => {
    const { controller } = makeController()
    controller.setChangeSetStatus('s1', 'm1', 'accumulating')
    controller.setChangeSetStatus('s1', 'm2', 'ready')
    controller.setChangeSetStatus('s1', 'm3', 'partially-reviewed')
    controller.setChangeSetStatus('s1', 'm4', 'superseded')

    controller.markChangeSetsSuperseded('s1')

    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('superseded')
    expect(controller.getChangeSetStatus('s1', 'm2')).toBe('superseded')
    expect(controller.getChangeSetStatus('s1', 'm3')).toBe('superseded')
    expect(controller.getChangeSetStatus('s1', 'm4')).toBe('superseded') // 已是 superseded 保持
  })

  it('resolved 态豁免：保留不动（用户已接受的审查记录不因后续 commit 丢失）', () => {
    const { controller } = makeController()
    controller.setChangeSetStatus('s1', 'm1', 'resolved')
    controller.setChangeSetStatus('s1', 'm2', 'ready')

    controller.markChangeSetsSuperseded('s1')

    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('resolved') // 豁免
    expect(controller.getChangeSetStatus('s1', 'm2')).toBe('superseded')
  })

  it('只影响指定 session：其他 session 的 changeSet 不变', () => {
    const { controller } = makeController()
    controller.setChangeSetStatus('s1', 'm1', 'ready')
    controller.setChangeSetStatus('s2', 'm1', 'ready') // 同 messageId 不同 session

    controller.markChangeSetsSuperseded('s1')

    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('superseded')
    expect(controller.getChangeSetStatus('s2', 'm1')).toBe('ready') // s2 不受影响
  })

  it('prefix 不误匹配：session s1 不影响 s10/s11 的 changeSet', () => {
    // key 形态 `${sid}:${msgId}`，startsWith(`${sid}:`) —— s1: 不应前缀匹配 s10:/s11:
    const { controller } = makeController()
    controller.setChangeSetStatus('s1', 'm1', 'ready')
    controller.setChangeSetStatus('s10', 'm1', 'ready')
    controller.setChangeSetStatus('s11', 'm1', 'ready')

    controller.markChangeSetsSuperseded('s1')

    expect(controller.getChangeSetStatus('s1', 'm1')).toBe('superseded')
    expect(controller.getChangeSetStatus('s10', 'm1')).toBe('ready') // 不受影响
    expect(controller.getChangeSetStatus('s11', 'm1')).toBe('ready') // 不受影响
  })

  it('无匹配 changeSet：引用稳定（changed=false 不替换）', () => {
    const { controller } = makeController()
    controller.setChangeSetStatus('s2', 'm1', 'ready') // 不在 s1
    const before = controller.changeSetStatuses.value

    controller.markChangeSetsSuperseded('s1') // s1 无 changeSet

    expect(controller.changeSetStatuses.value).toBe(before) // 引用未变
    expect(controller.getChangeSetStatus('s2', 'm1')).toBe('ready')
  })
})
