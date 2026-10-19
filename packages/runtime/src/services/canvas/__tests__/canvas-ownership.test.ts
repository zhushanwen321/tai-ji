/**
 * 画布归属矩阵单测（session-store-layout-inversion D4 + 前序 6 条裁决的验收条款）：
 * 跨会话拒绝（forbidden + 恢复指引）/ 清单过滤 / 崩溃恢复回推 / 1:N 多画布。
 * （级联删除项不在本文件——画布随 ext-sessions 整树回收由 u-deletion 的 commit 门
 * 补跑断言，任务书明示本单元不写级联单测。）
 */
import { describe, expect, it } from 'vitest'
import { CanvasService } from '../canvas-service.js'
import { createCanvas, expectRejected, expectThrown, growCanvas, makeService, makeTmpCanvasDir, removeDir, SID, SID_B } from './canvas-helpers.js'

describe('归属矩阵：跨会话拒绝（forbidden）', () => {
  it('B 会话 mutate A 的画布 → forbidden，恢复指引指回归属会话', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      const reply = h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.rootId, content: '越会话改写', reason: 'r' } }, 'user', SID_B)
      expectRejected(reply, 'forbidden')
      if (!reply.ok) {
        expect(reply.error.message).toContain(c.canvasId)
        expect(reply.error.message).toContain('归属会话')
        expect(reply.error.recover).toContain('归属会话')
      }
      // 拒绝后画布状态未被改动（写面零副作用）
      expect(c.state().root.statement).toBe('如何落地多引擎支持')
    } finally {
      h.dispose()
    }
  })

  it('B 会话 readState / enter（读全量）A 的画布 → forbidden（throw 形态）', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      expectThrown(() => h.svc.readState(c.canvasId, SID_B), 'forbidden')
    } finally {
      h.dispose()
    }
  })

  it('越权探测不泄漏存在性：未知 id 对任何会话都是 canvas_not_found（先存在性后归属的判定次序）', () => {
    const h = makeService()
    try {
      expectThrown(() => h.svc.readState('cvs-ghost', SID_B), 'canvas_not_found')
      expectRejected(h.svc.mutate({ action: 'patch', params: { canvasId: 'cvs-ghost', nodeId: 'n1', content: 'x', reason: 'r' } }, 'user', SID_B), 'canvas_not_found')
    } finally {
      h.dispose()
    }
  })

  it('非法 sessionId（路径穿越形态）create → invalid_params（树分区键同域校验先行）', () => {
    const h = makeService()
    try {
      expectRejected(h.svc.mutate({ action: 'create', params: { statement: 's', criterias: ['c'], scopeExclusions: [] } }, 'agent', '../evil'), 'invalid_params')
      // 零文件系统泄漏：非法分区键未触落盘
      expect(h.svc.listCanvases(SID).canvases).toHaveLength(0)
    } finally {
      h.dispose()
    }
  })
})

describe('归属矩阵：清单过滤与 1:N', () => {
  it('listCanvases(sid) 只返回归属该会话的画布（1:N 两张都在；B 清单为空）', () => {
    const h = makeService()
    try {
      const c1 = createCanvas(h.svc, 'agent', '画布一')
      const c2 = createCanvas(h.svc, 'agent', '画布二')
      const mine = h.svc.listCanvases(SID).canvases
      expect(mine.map((e) => e.canvasId).sort()).toEqual([c1.canvasId, c2.canvasId].sort())
      // 清单条目回显归属（CanvasListEntry.ownerSessionId）
      expect(mine.every((e) => e.ownerSessionId === SID)).toBe(true)
      // 跨会话清单为空（隔离：B 看不到 A 的任何画布）
      expect(h.svc.listCanvases(SID_B).canvases).toEqual([])
    } finally {
      h.dispose()
    }
  })

  it('多画布互不串分区：同会话两张画布各自独立落盘（1:N 由 canvasId 层承载）', () => {
    const h = makeService()
    try {
      const c1 = createCanvas(h.svc, 'agent', '画布一')
      const c2 = createCanvas(h.svc, 'agent', '画布二')
      growCanvas(h.svc, c1)
      expect(h.svc.readState(c1.canvasId, SID).nodes.length).toBeGreaterThan(1)
      expect(h.svc.readState(c2.canvasId, SID).nodes.length).toBe(1)
      expect(h.svc.readState(c1.canvasId, SID).name).toBe('画布一')
      expect(h.svc.readState(c2.canvasId, SID).name).toBe('画布二')
    } finally {
      h.dispose()
    }
  })
})

describe('归属矩阵：崩溃恢复回推（跨实例）', () => {
  it('runtime 重启后 owner 回推通道恢复、B 仍被拒（owner 持久在路径，重启不丢归属）', () => {
    const dir = makeTmpCanvasDir()
    const first = new CanvasService({ dataDir: dir })
    let canvasId = ''
    try {
      const c = createCanvas(first)
      canvasId = c.canvasId
    } finally {
      first.dispose()
    }
    // 模拟重启：新实例同树扫描重建
    const reborn = new CanvasService({ dataDir: dir })
    try {
      expect(reborn.getBoundSessions(canvasId)).toEqual([SID])
      expect(reborn.readState(canvasId, SID).canvasId).toBe(canvasId)
      // B 的写读在重启后依然被拒（归属随路径持久化，不随进程消亡）
      expectThrown(() => reborn.readState(canvasId, SID_B), 'forbidden')
      expectRejected(reborn.mutate({ action: 'patch', params: { canvasId, nodeId: reborn.readState(canvasId, SID).root.nodeId, content: 'x', reason: 'r' } }, 'user', SID_B), 'forbidden')
    } finally {
      reborn.dispose()
      removeDir(dir)
    }
  })
})
