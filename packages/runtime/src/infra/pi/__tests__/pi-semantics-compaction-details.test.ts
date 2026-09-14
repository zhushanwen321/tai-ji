/**
 * PS-28 探针：appendCompaction 对 hook 返回的 details 逐字透传落盘（D6 探针层）。
 *
 * 登记条目（docs/pi-semantics.json PS-28）：agent-session 两条压缩路径（manual/threshold
 * auto）在 session_before_compact hook 返回 compaction 时 details = extensionCompaction.details
 * 原样引用并传入 sessionManager.appendCompaction，后者 entry 字面量直接引用该对象（无克隆/
 * 字段白名单）——smart-context 在 details 写入的自定义字段（model 归属，usage-page-fixes
 * §3.3 ①）必然随 compaction entry 原样落盘；pi 升级若克隆/裁剪/改名 details，归属字段静默
 * 丢失（scanner ③ 回退 generic 行，不报错），由本探针拦截。
 *
 * 断言方式：静态形态断言（appendCompaction entry 字面量透传 + agent-session hook 分支与
 * 调用点的 details 标识符连续性）+ 行为级断言（动态 import dist/core/session-manager.js，
 * SessionManager 原型桩直调 appendCompaction，断言 details 同引用落账）。原型桩覆写
 * _appendEntry 捕获 entry，不触真实 session 文件（零 fs 写）。dist 不可达 / 动态 import
 * 失败时 skip 不 fail；不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-compaction-details.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { locatePiCodingAgentDist, methodWindowUntil } from './helpers/pi-semantics-probe.js'

const PI_DIST = locatePiCodingAgentDist()
const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!PI_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

/** 行为级断言用：动态 import session-manager.js（取 SessionManager 类做原型桩）。 */
type SessionManagerModule = {
  SessionManager?: { prototype: object }
}
const sessionManager: SessionManagerModule | null = await (async () => {
  if (!PI_DIST) return null
  try {
    return (await import(pathToFileURL(join(PI_DIST, 'core', 'session-manager.js')).href)) as SessionManagerModule
  } catch {
    return null
  }
})()

describe.skipIf(!PI_DIST)(
  `PS-28 探针：appendCompaction details 透传链静态断言（代码形态${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const sessionManagerSrc = readFileSync(join(PI_DIST as string, 'core', 'session-manager.js'), 'utf-8')
    const agentSessionSrc = readFileSync(join(PI_DIST as string, 'core', 'agent-session.js'), 'utf-8')

    it('appendCompaction：entry 字面量 details 字段逐字引用入参（无克隆/无白名单）', () => {
      const win = methodWindowUntil(
        sessionManagerSrc,
        'appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook, usage)',
        'appendCustomEntry(',
      )
      expect(
        win,
        'PS-28 漂移：appendCompaction 方法消失/改名——compaction 落盘入口改形，复核 PS-28 锚点',
      ).not.toBe('')
      // entry 字面量：details 入参逐字透传（summary/firstKeptEntryId/tokensBefore/details/usage/fromHook 六字段序）
      expect(
        win,
        'PS-28 漂移：entry 字面量不再逐字引用 details 入参（字段被克隆/裁剪/改名）——extension 写入 details 的自定义字段将静默丢失，复核 session-manager.js appendCompaction 与 PS-28',
      ).toMatch(/\{\s*type: "compaction",\s*id: generateId\(this\.byId\),\s*parentId: this\.leafId,\s*timestamp: new Date\(\)\.toISOString\(\),\s*summary,\s*firstKeptEntryId,\s*tokensBefore,\s*details,\s*usage,\s*fromHook,/)
      // 落盘仍走 _appendEntry（append-only 追加，与 PS-18 一致）
      expect(
        win.includes('this._appendEntry(entry);'),
        'PS-28 漂移：appendCompaction 不再经 _appendEntry 落盘——落盘管线改形，复核 PS-28 与 PS-18',
      ).toBe(true)
    })

    it('agent-session：hook 分支 details 原样引用 ×2，调用点与 appendCompaction 形参名一致 ×2', () => {
      // 两条压缩路径（manual/threshold auto）都从 hook result.compaction 取 details 原样引用
      const hookAssign = agentSessionSrc.match(/details = extensionCompaction\.details;/g) ?? []
      expect(
        hookAssign,
        'PS-28 漂移：hook 分支 details 引用点数量变化（≠2）——压缩路径改形，复核 agent-session.js 与 PS-28 锚点',
      ).toHaveLength(2)
      // 调用点：details 变量未经中间变换直接传入（标识符连续，两路径调用形态一致）
      const callRe = /this\.sessionManager\.appendCompaction\(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage\);/g
      const calls = agentSessionSrc.match(callRe) ?? []
      expect(
        calls,
        'PS-28 漂移：appendCompaction 调用点不再原样传 details（形参改形/加了变换）——details 落盘语义变化，复核 agent-session.js 两个调用点',
      ).toHaveLength(2)
    })
  },
)

describe.skipIf(!sessionManager?.SessionManager)(
  'PS-28 探针：appendCompaction 行为断言（动态 import 实装 dist，原型桩零 fs 写）',
  () => {
    /** 原型桩宿主形状（只暴露 appendCompaction 依赖的成员；_appendEntry 被覆写为捕获器）。 */
    type AppendCompactionHost = {
      byId: Set<string>
      leafId: string
      _appendEntry: (entry: Record<string, unknown>) => void
      appendCompaction: (
        summary: string,
        firstKeptEntryId: string,
        tokensBefore: number,
        details: unknown,
        fromHook: boolean,
        usage: unknown,
      ) => string
    }

    const Cls = sessionManager!.SessionManager!

    function makeHost(): { host: AppendCompactionHost; captured: Array<Record<string, unknown>> } {
      const host = Object.create(Cls.prototype) as AppendCompactionHost
      host.byId = new Set()
      host.leafId = 'leaf-0'
      const captured: Array<Record<string, unknown>> = []
      // 覆写落盘钩子：捕获 entry 即返回，不触 fileEntries/_persist（零 fs 写）
      host._appendEntry = (entry) => {
        captured.push(entry)
      }
      return { host, captured }
    }

    it('hook 返回的 details（含自定义 model 字段）同引用落账——逐字透传非克隆', () => {
      const { host, captured } = makeHost()
      const details = {
        engine: 'smart-context',
        mode: 'cross-model',
        model: 'zai-coding-cn/glm-5.3-flash',
        readFiles: ['/a.ts'],
      }
      const usage = { input: 1, output: 2 }
      host.appendCompaction('summary text', 'kept-1', 1234, details, true, usage)

      expect(captured).toHaveLength(1)
      const entry = captured[0]
      expect(entry.type).toBe('compaction')
      // 同一引用 = 逐字透传（克隆/重建对象会 here 红）
      expect(entry.details).toBe(details)
      const gotDetails = entry.details as Record<string, unknown>
      expect(gotDetails.model).toBe('zai-coding-cn/glm-5.3-flash')
      expect(gotDetails.readFiles).toEqual(['/a.ts'])
      // 其余透传字段同verbatim：usage / fromHook / 树形结构
      expect(entry.usage).toBe(usage)
      expect(entry.fromHook).toBe(true)
      expect(entry.parentId).toBe('leaf-0')
      expect(typeof entry.id).toBe('string')
      expect((entry.id as string).length).toBeGreaterThan(0)
      expect(typeof entry.timestamp).toBe('string')
    })
  },
)
