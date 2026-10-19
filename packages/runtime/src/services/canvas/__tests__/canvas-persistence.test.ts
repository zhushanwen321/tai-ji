/**
 * 落盘与重建（problem-solve-canvas U2 验收条款）。
 *
 * 权威声明与写入顺序的守护检查（设计 §4 unit 清单原文）：
 * - 快照 + 重放 ≡ 直写（live ≡ reload 同构判据）
 * - 崩溃窗口截断重放一致性：对事件流任意前缀 P 断言**锚点对齐**而非仅状态等价——
 *   重建（canvas.json + 截断流增量重放）的结果 ≡ 从 P 全量重放的结果，且断言
 *   「快照锚点 eventId ≤ 截断流末条 eventId（快照永不超前）」。反向写入顺序（先快照
 *   后事件）会因锚点对齐失败而红——仅断言「可重建出某个一致态」在错误顺序下同样通过、
 *   检查空转，本用例是唯一权威声明与写入顺序的守护检查用例。
 * - 回推通道（owner 持久在落盘路径）：session 真删除摘内存（模块级分发）/ owner 重启重建。
 * - 导出落盘（exports/）：未收敛拒绝；收敛后产物落盘且五要素可读。
 */
import { describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasService, unbindCanvasOnSessionDeleted, CANVAS_SNAPSHOT_INTERVAL } from '../canvas-service.js'
import { getSessionCanvasesDir } from '@taiji/shared/paths'
import { buildConvergedCanvas, createCanvas, expectOk, expectThrown, growCanvas, makeService, makeTmpCanvasDir, removeDir, SID, SID_B } from './canvas-helpers.js'

interface PersistedLine { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  seq: number
  eventId: string
  type: string
  action: string
  actor: string
  at: string
  data: Record<string, unknown>
}

/** 画布域目录（D4 布局：`<dataDir>/ext-sessions/<SID>/canvases/`；断言经 shared SSOT 推导）。 */
function canvasesRootOf(dir: string): string {
  return getSessionCanvasesDir(SID, dir)
}

function readLines(dir: string, canvasId: string): PersistedLine[] {
  return readFileSync(join(canvasesRootOf(dir), canvasId, 'events.jsonl'), 'utf-8')
    .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as PersistedLine)
}

describe('快照 + 重放 ≡ 直写', () => {
  it('跨快照边界的事件流（> N 条）：新实例重建 ≡ 直写终态；删快照全量重放 ≡ 直写终态', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      // 累计跨过快照间隔的事件数（create 1 条 + 多轮 patch，每轮 patch(user) 产 2 条：附属 + 主）
      const rounds = Math.ceil((CANVAS_SNAPSHOT_INTERVAL + 7) / 2)
      for (let i = 0; i < rounds; i++) {
        expectOk(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.rootId, content: `改述 v${i}`, reason: `第 ${i} 轮修订` } }, 'user', SID))
      }
      expect(c.state().dirtyPaths.length).toBeGreaterThan(0)
      const directWrite = h.svc.readState(c.canvasId, SID)
      expect(existsSync(join(canvasesRootOf(h.dir), c.canvasId, 'canvas.json'))).toBe(true)
      // 形状分叉守护：activeBindings（绑定徽标的 canvas.get 查询侧派生，transport 附加）
      // 不得进快照——绑定是 runtime 内存态，落盘会污染「快照可由事件流全量重放推导」
      // 的唯一权威承诺（CanvasState.activeBindings 契约注释）
      const snapState = (JSON.parse(readFileSync(join(canvasesRootOf(h.dir), c.canvasId, 'canvas.json'), 'utf-8')) as { state: Record<string, unknown> }).state
      expect(snapState).not.toHaveProperty('activeBindings')

      // 新实例（模拟 runtime 重启）从磁盘重建
      const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
      try {
        expect(reborn.readState(c.canvasId, SID)).toEqual(directWrite)
      } finally {
        reborn.dispose()
      }
      // 删除快照 → 全量重放路径（「一律以事件流为准」）
      rmSync(join(canvasesRootOf(h.dir), c.canvasId, 'canvas.json'))
      const fullReplay = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
      try {
        expect(fullReplay.readState(c.canvasId, SID)).toEqual(directWrite)
      } finally {
        fullReplay.dispose()
      }
    } finally {
      h.dispose()
    }
  })
})

describe('comment 事件重放 ≡ 直写（评论 id 随事件落盘按值恢复）', () => {
  it('含用户评论的画布重启重建（快照 + 增量重放 / 删快照全量重放）≡ 直写终态，评论 id 逐字还原', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.rootId, text: '根判据第二条可量化吗' } }, 'user', SID))
      const directWrite = h.svc.readState(c.canvasId, SID)
      expect(directWrite.comments).toHaveLength(1)
      // 新实例重建（模拟 runtime 重启）——comment 主事件不经附属事件过滤，重放必触
      // applyComment 的 id 生成点：按落盘 generated.commentId 恢复，不得触恒抛生成器
      const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
      try {
        const rebornState = reborn.readState(c.canvasId, SID)
        expect(rebornState).toEqual(directWrite)
        // 评论 id 逐字还原（`${anchorId}#c-<生成段>` 契约形态，非重造）
        expect(rebornState.comments[0]!.id).toBe(directWrite.comments[0]!.id)
      } finally {
        reborn.dispose()
      }
      // 删快照走全量重放分支（create + comment 未跨快照间隔，快照不存在为正常形态：
      // force 幂等删除——有则删、无则本用例等价于全量重放主链的重复验证）
      rmSync(join(canvasesRootOf(h.dir), c.canvasId, 'canvas.json'), { force: true })
      const fullReplay = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
      try {
        expect(fullReplay.readState(c.canvasId, SID)).toEqual(directWrite)
      } finally {
        fullReplay.dispose()
      }
    } finally {
      h.dispose()
    }
  })

  it('评论跨快照锚点两侧：锚点前评论由快照承载、锚点后评论走增量重放，重建 ≡ 直写', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      // 锚点前评论（快照将携带其状态，重放循环按 seq 跳过）
      expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.rootId, text: '锚点前的议题' } }, 'user', SID))
      // 跨过快照间隔（每轮 user patch 产 2 条事件：附属 + 主）
      const rounds = Math.ceil((CANVAS_SNAPSHOT_INTERVAL + 3) / 2)
      for (let i = 0; i < rounds; i++) {
        expectOk(h.svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.rootId, content: `改述 v${i}`, reason: 'r' } }, 'user', SID))
      }
      // 锚点后评论（增量重放执行该 comment 行）
      expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.rootId, text: '锚点后的议题' } }, 'user', SID))
      const directWrite = h.svc.readState(c.canvasId, SID)
      expect(directWrite.comments).toHaveLength(2)
      expect(existsSync(join(canvasesRootOf(h.dir), c.canvasId, 'canvas.json'))).toBe(true)
      const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'replay-unused-id' })
      try {
        expect(reborn.readState(c.canvasId, SID)).toEqual(directWrite)
      } finally {
        reborn.dispose()
      }
    } finally {
      h.dispose()
    }
  })

  it('comment 事件缺生成 id（事件流数据损坏）→ fail-fast 指向权威源，不静默另造 id', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.rootId, text: '议题' } }, 'user', SID))
      // 手工抹掉 comment 行的 generated（模拟损坏 / 非本服务产出的历史数据）
      const eventsFile = join(canvasesRootOf(h.dir), c.canvasId, 'events.jsonl')
      const stripped = readFileSync(eventsFile, 'utf-8')
        .split('\n').filter((l) => l.trim() !== '')
        .map((l) => {
          const ev = JSON.parse(l) as { action?: string; data: Record<string, unknown> }
          if (ev.action !== 'comment') return l
          const data = { ...ev.data }
          delete data.generated
          return JSON.stringify({ ...ev, data })
        })
      writeFileSync(eventsFile, `${stripped.join('\n')}\n`, 'utf-8')
      const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'u' })
      try {
        expectThrown(() => reborn.readState(c.canvasId, SID), 'invalid_params')
      } finally {
        reborn.dispose()
      }
    } finally {
      h.dispose()
    }
  })
})

describe('崩溃窗口截断重放一致性（锚点对齐守护用例）', () => {
  /** 构造带快照的画布：返回事件流全量行与快照文件路径。 */
  function buildEventStream(dir: string): { canvasId: string; lines: PersistedLine[]; total: number } {
    const svc = new CanvasService({ dataDir: dir, generateId: makeDeterministicId() })
    try {
      const c = createCanvas(svc)
      const rounds = Math.ceil((CANVAS_SNAPSHOT_INTERVAL + 13) / 2)
      for (let i = 0; i < rounds; i++) {
        expectOk(svc.mutate({ action: 'patch', params: { canvasId: c.canvasId, nodeId: c.rootId, content: `v${i}`, reason: 'r' } }, 'user', SID))
      }
      const lines = readLines(dir, c.canvasId)
      return { canvasId: c.canvasId, lines, total: lines.length }
    } finally {
      svc.dispose()
    }
  }

  function makeDeterministicId(): () => string {
    let i = 0
    return () => `d${++i}`
  }

  /** 在副本目录组装「崩溃窗口截断」现场：事件流前 k 行 + （若 k 覆盖到快照锚点）快照原样保留。 */
  function assembleTruncated(sourceDir: string, canvasId: string, lines: PersistedLine[], k: number, snapshotAnchor: number): string {
    const copy = mkdtempSync(join(tmpdir(), 'taiji-canvas-trunc-'))
    mkdirSync(join(canvasesRootOf(copy), canvasId), { recursive: true })
    writeFileSync(join(canvasesRootOf(copy), canvasId, 'events.jsonl'), lines.slice(0, k).map((l) => `${JSON.stringify(l)}\n`).join(''), 'utf-8')
    const snapSrc = join(canvasesRootOf(sourceDir), canvasId, 'canvas.json')
    if (k >= snapshotAnchor && existsSync(snapSrc)) copyFileSync(snapSrc, join(canvasesRootOf(copy), canvasId, 'canvas.json'))
    return copy
  }

  it('对多个截断点断言：锚点 ≤ 流末 eventId 且 重建 ≡ 截断流全量重放', () => {
    const src = makeTmpCanvasDir()
    try {
      const { canvasId, lines, total } = buildEventStream(src)
      const snapshotAnchor = Number((JSON.parse(readFileSync(join(canvasesRootOf(src), canvasId, 'canvas.json'), 'utf-8')) as { anchorEventId: string }).anchorEventId)
      // 锚点 = 首次跨过 N 倍数那批的流末 eventId（≥ N；锚点 ≤ 流末恒成立——快照永不超前）
      expect(snapshotAnchor).toBeGreaterThanOrEqual(CANVAS_SNAPSHOT_INTERVAL)
      expect(snapshotAnchor).toBeLessThanOrEqual(total)
      const truncationPoints = [10, CANVAS_SNAPSHOT_INTERVAL - 1, CANVAS_SNAPSHOT_INTERVAL, CANVAS_SNAPSHOT_INTERVAL + 7, total]
      for (const k of truncationPoints) {
        const copy = assembleTruncated(src, canvasId, lines, k, snapshotAnchor)
        try {
          const lastSeq = lines[k - 1]!.seq
          const snapPath = join(canvasesRootOf(copy), canvasId, 'canvas.json')
          if (k >= snapshotAnchor) {
            // 锚点对齐断言（唯一权威声明的守护断言）：快照锚点 ≤ 截断流末 eventId
            const anchor = Number((JSON.parse(readFileSync(snapPath, 'utf-8')) as { anchorEventId: string }).anchorEventId)
            expect(anchor, `截断点 ${k}：快照永不超前`).toBeLessThanOrEqual(lastSeq)
          }
          // 重建（快照 + 增量重放，快照存在时）
          const rebuilt = new CanvasService({ dataDir: copy, generateId: makeDeterministicId() })
          let rebuiltState
          try {
            rebuiltState = rebuilt.readState(canvasId, SID)
          } finally {
            rebuilt.dispose()
          }
          // 基准：截断流全量重放（删快照走「以事件流为准」路径）
          rmSync(snapPath, { force: true })
          const full = new CanvasService({ dataDir: copy, generateId: makeDeterministicId() })
          let fullState
          try {
            fullState = full.readState(canvasId, SID)
          } finally {
            full.dispose()
          }
          expect(rebuiltState, `截断点 ${k}：重建 ≡ 截断流全量重放`).toEqual(fullState)
          // 与直写前缀终态交叉核对：重建态的 updatedAt 事件序列与流一致（防两边同错）
          expect(rebuiltState.updatedAt).toBe(lines[k - 1]!.at)
        } finally {
          removeDir(copy)
        }
      }
    } finally {
      removeDir(src)
    }
  })

  it('快照滞后（事件已 append、快照未写——两写之间崩溃）：丢弃快照场景与增量重放场景皆 ≡ 直写', () => {
    const src = makeTmpCanvasDir()
    try {
      const svc = new CanvasService({ dataDir: src, generateId: ((): () => string => { let i = 0; return () => `d${++i}` })() })
      let canvasId: string
      try {
        const c = createCanvas(svc)
        canvasId = c.canvasId
        for (let i = 0; i < CANVAS_SNAPSHOT_INTERVAL / 2; i++) {
          expectOk(svc.mutate({ action: 'patch', params: { canvasId, nodeId: c.rootId, content: `v${i}`, reason: 'r' } }, 'user', SID))
        }
        // 恰在快照锚点：快照已写
        expectOk(svc.mutate({ action: 'patch', params: { canvasId, nodeId: c.rootId, content: 'final', reason: 'r' } }, 'user', SID))
      } finally {
        svc.dispose()
      }
      const directWrite = new CanvasService({ dataDir: src, generateId: ((): () => string => { let i = 0; return () => `x${++i}` })() })
      let expected
      try {
        expected = directWrite.readState(canvasId, SID)
      } finally {
        directWrite.dispose()
      }
      // 场景 A：快照仍在（滞后于流末）——增量重放收敛
      const withStaleSnap = new CanvasService({ dataDir: src, generateId: ((): () => string => { let i = 0; return () => `y${++i}` })() })
      try {
        expect(withStaleSnap.readState(canvasId, SID)).toEqual(expected)
      } finally {
        withStaleSnap.dispose()
      }
      // 场景 B：快照丢失（写失败 / 未及写）——全量重放收敛
      rmSync(join(canvasesRootOf(src), canvasId, 'canvas.json'))
      const noSnap = new CanvasService({ dataDir: src, generateId: ((): () => string => { let i = 0; return () => `z${++i}` })() })
      try {
        expect(noSnap.readState(canvasId, SID)).toEqual(expected)
      } finally {
        noSnap.dispose()
      }
    } finally {
      removeDir(src)
    }
  })

  it('锚点超前的快照（写入顺序违约的产物）被丢弃并全量重放——「一律以事件流为准」', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      const expected = h.svc.readState(c.canvasId, SID)
      // 手工构造超前快照：锚点 999 > 流末 1
      const snapPath = join(canvasesRootOf(h.dir), c.canvasId, 'canvas.json')
      writeFileSync(snapPath, JSON.stringify({ version: 1, anchorEventId: '999', state: { ...expected, converged: true, name: '被污染的快照' } }), 'utf-8')
      const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'u' })
      try {
        const state = reborn.readState(c.canvasId, SID)
        expect(state).toEqual(expected)
        expect(state.converged).toBe(false)
      } finally {
        reborn.dispose()
      }
    } finally {
      h.dispose()
    }
  })

  it('事件流行损坏 fail-fast（无更高权威可对，不静默跳过；启动扫描留痕不拖垮服务）', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      const eventsFile = join(canvasesRootOf(h.dir), c.canvasId, 'events.jsonl')
      writeFileSync(eventsFile, `${readFileSync(eventsFile, 'utf-8')}{broken-json\n`, 'utf-8')
      // 启动扫描：单画布损坏不拖垮服务（catch 留痕），但该画布读路径 fail-fast（指向权威源 events.jsonl）
      const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'u' })
      try {
        expect(() => reborn.readState(c.canvasId, SID)).toThrow(/行损坏/)
      } finally {
        reborn.dispose()
      }
    } finally {
      h.dispose()
    }
  })

  it('listCanvases 经重建恢复（冷启动托盘列表恢复——A5 场景的数据半边）', () => {
    const h = makeService()
    try {
      const c1 = createCanvas(h.svc, 'agent', '画布一')
      createCanvas(h.svc, 'agent', '画布二')
      const sortById = (l: { canvases: Array<{ canvasId: string }> }): Array<{ canvasId: string }> =>
        [...l.canvases].sort((a, b) => a.canvasId.localeCompare(b.canvasId))
      const listBefore = sortById(h.svc.listCanvases(SID))
      expect(listBefore).toHaveLength(2)
      const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'u' })
      try {
        expect(sortById(reborn.listCanvases(SID))).toEqual(listBefore)
        expect(reborn.readState(c1.canvasId, SID).name).toBe('画布一')
      } finally {
        reborn.dispose()
      }
    } finally {
      h.dispose()
    }
  })
})

describe('回推通道（owner 持久在落盘路径，D4 回推收窄）', () => {
  it('getBoundSessions = [owner]（回推对象即归属会话，创建即建立——无 enter 登记语义）', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      expect(h.svc.getBoundSessions(c.canvasId)).toEqual([SID])
    } finally {
      h.dispose()
    }
  })

  it('session 真删除摘内存经模块级分发（session-lifecycle delete 编排侧的调用目标）', () => {
    const h = makeService()
    try {
      const c1 = createCanvas(h.svc)
      const c2 = createCanvas(h.svc)
      unbindCanvasOnSessionDeleted(SID)
      // 摘内存 = 回推通道与读路径都不可达（磁盘树随 ext-sessions 整树回收归 u-deletion）
      expect(h.svc.getBoundSessions(c1.canvasId)).toEqual([])
      expect(h.svc.getBoundSessions(c2.canvasId)).toEqual([])
      expectThrown(() => h.svc.readState(c1.canvasId, SID), 'canvas_not_found')
      // 幂等：重复摘除无副作用
      unbindCanvasOnSessionDeleted(SID)
      expect(h.svc.getBoundSessions(c1.canvasId)).toEqual([])
    } finally {
      h.dispose()
    }
  })

  it('owner 持久在落盘路径：runtime 重启（新实例）后回推通道与归属校验即恢复（崩溃恢复回推语义）', () => {
    const h = makeService()
    try {
      const c = createCanvas(h.svc)
      const reborn = new CanvasService({ dataDir: h.dir, generateId: (): string => 'u' })
      try {
        expect(reborn.getBoundSessions(c.canvasId)).toEqual([SID])
        // owner 查询照常可达（重启不丢归属——路径即归属的构造性承载）
        expect(reborn.readState(c.canvasId, SID).canvasId).toBe(c.canvasId)
      } finally {
        reborn.dispose()
      }
    } finally {
      h.dispose()
    }
  })
})

describe('导出（exports/ 落盘 + 不变量 10 同校验）', () => {
  it('未收敛 export → not_converged 且无产物文件', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      const reply = h.svc.mutate({ action: 'export', params: { canvasId: c.canvasId, target: { target: 'planning-doc' } } }, 'user', SID)
      expect(reply.ok).toBe(false)
      if (!reply.ok) {
        expect(reply.error.code).toBe('not_converged')
        expect(reply.error.recover).toContain('must-fix')
      }
      expect(existsSync(join(canvasesRootOf(h.dir), c.canvasId, 'exports'))).toBe(false)
    } finally {
      h.dispose()
    }
  })

  it('收敛后：方向规划文档落盘 exports/；需求卡五要素标题齐全；summary 含产物路径', () => {
    const h = makeService()
    try {
      const conv = buildConvergedCanvas(h.svc, createCanvas(h.svc))
      const doc = h.svc.mutate({ action: 'export', params: { canvasId: conv.canvasId, target: { target: 'planning-doc' } } }, 'user', SID)
      expectOk(doc)
      const card = h.svc.mutate({ action: 'export', params: { canvasId: conv.canvasId, target: { target: 'requirement-card', leafId: conv.leaf } } }, 'user', SID)
      expectOk(card)
      const exportsDir = join(canvasesRootOf(h.dir), conv.canvasId, 'exports')
      const files = readdirSync(exportsDir)
      expect(files.some((f) => f.startsWith('planning-doc-'))).toBe(true)
      expect(files.some((f) => f.startsWith(`requirement-card-${conv.leaf}-`))).toBe(true)
      const docContent = readFileSync(join(exportsDir, files.find((f) => f.startsWith('planning-doc-'))!), 'utf-8')
      expect(docContent).toContain('方向规划文档')
      expect(docContent).toContain('完成判据')
      expect(docContent).toContain('执行清单')
      const cardContent = readFileSync(join(exportsDir, files.find((f) => f.startsWith(`requirement-card-${conv.leaf}-`))!), 'utf-8')
      // 五要素：目标 / 上溯论证链 / 已排除方案及理由 / 关键论据引用 / 生效约束
      for (const section of ['1. 目标', '2. 上溯论证链', '3. 已排除方案及理由', '4. 关键论据引用', '5. 生效约束']) {
        expect(cardContent).toContain(section)
      }
      expect(doc.ok && doc.summary).toContain('exports/')
      // 导出是只读派生操作：画布状态不变（converged 保持、无图变更）
      expect(h.svc.readState(conv.canvasId, SID).converged).toBe(true)
    } finally {
      h.dispose()
    }
  })

  it('需求卡目标非执行叶子 → node_not_found', () => {
    const h = makeService()
    try {
      const conv = buildConvergedCanvas(h.svc, createCanvas(h.svc))
      const reply = h.svc.mutate({ action: 'export', params: { canvasId: conv.canvasId, target: { target: 'requirement-card', leafId: conv.q1 } } }, 'user', SID)
      expect(reply.ok).toBe(false)
      if (!reply.ok) expect(reply.error.code).toBe('node_not_found')
    } finally {
      h.dispose()
    }
  })
})

describe('子树读（readState subtree：节点 / 边 / 评论三维过滤）', () => {
  it('边锚评论随其所在边进入子树读（F1-12：锚点 = 节点 id 或边 id；两端点皆在子树内的边，其评论在）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      // argue 可指主干边（attachTo = 边 id）——grow 一条锚在 e-q1（root →(decompose) q1）上的反论据
      expectOk(h.svc.mutate({
        action: 'grow',
        params: { canvasId: c.canvasId, batch: [{ id: 'a1', type: 'argument', content: '该分解漏了迁移成本维度', attachTo: `e-${c.q1}`, edge: 'argue', edgePolarity: 'object' }], reason: '补反论据' },
      }, 'agent', SID))
      // 对该主干边评论（anchorId = 边 id——applyComment 合法允许）
      expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: `e-${c.q1}`, text: '这条分解边存疑' } }, 'user', SID))
      // 子树读父节点 root（decompose 子树 = {root, q1}；边 e-q1 两端点皆在子树内 → 边与评论都应在）
      const sub = h.svc.readState(c.canvasId, SID, c.rootId)
      expect(sub.nodes.map((n) => n.id).sort()).toEqual([c.rootId, c.q1].sort())
      expect(sub.edges.map((e) => e.id)).toEqual([`e-${c.q1}`])
      expect(sub.comments.map((cm) => cm.anchorId)).toEqual([`e-${c.q1}`])
    } finally {
      h.dispose()
    }
  })

  it('逆例：锚点边跨越子树边界时评论不进入（端点在外 = 边本身已被过滤，评论与边同判据）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      // 评论锚在 resolve 边 e-o1（q1 → o1）：root 的 decompose 子树不含 o1，边与评论都不进
      expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: 'e-o1', text: '这条 resolve 边对比充分吗' } }, 'user', SID))
      const sub = h.svc.readState(c.canvasId, SID, c.rootId)
      expect(sub.edges.map((e) => e.id)).not.toContain('e-o1')
      expect(sub.comments).toHaveLength(0)
    } finally {
      h.dispose()
    }
  })

  it('节点锚评论照常进入子树读（锚点在子树内的既有路径零回归）', () => {
    const h = makeService()
    try {
      const c = growCanvas(h.svc, createCanvas(h.svc))
      expectOk(h.svc.mutate({ action: 'comment', params: { canvasId: c.canvasId, anchorId: c.q1, text: '这里 MECE 吗' } }, 'user', SID))
      const sub = h.svc.readState(c.canvasId, SID, c.rootId)
      expect(sub.comments.map((cm) => cm.anchorId)).toEqual([c.q1])
    } finally {
      h.dispose()
    }
  })
})
