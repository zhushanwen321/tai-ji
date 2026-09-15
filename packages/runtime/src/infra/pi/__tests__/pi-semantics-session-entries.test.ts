/**
 * PS-09 探针：plain custom entry 不进 LLM 上下文（D6 探针层）。
 *
 * 登记条目（docs/pi-semantics.json）：「plain appendEntry 写入的 type=custom entry 不进
 * LLM 上下文；进上下文的是 custom_message entry（sessionEntryToContextMessages 对其余
 * 类型返回 []）」——事故 A 审查期实测；「live ≡ reload」等价性的 entry 投影依据。
 *
 * PS-29 探针（同文件）：appendCustomEntry 落盘形态含 customType/data/timestamp——entry
 * 字面量固定六字段 {type:"custom", customType, data, id, parentId, timestamp}（data 原样
 * 引用无克隆），core 绑定 appendEntry(customType, data) 同参数序直呼委托。rename-session
 * 计量落账（usage-page-fixes §3.3 ③④）依赖该形态；pi 升级若改字段名/裁剪 data/timestamp，
 * scanner ④ 分类静默失效（rename 账整桶消失），由本探针拦截。
 *
 * 断言方式：静态形态断言（函数窗口内的分支清单 + 兜底 return [] + 无 plain-custom 分支；
 * PS-29 的 entry 字面量正则 + core 绑定委托链）+ 行为级断言（动态 import
 * dist/core/session-manager.js：sessionEntryToContextMessages 投影直调；SessionManager
 * 原型桩直调 appendCustomEntry 断言落盘形态，不触真实 session 文件、零 fs 写）。dist
 * 不可达 / 动态 import 失败时 skip 不 fail；不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-session-entries.test.ts
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

/** 行为级断言用：动态 import session-manager.js（纯投影函数 + SessionManager 类，依赖 fs/crypto/pi-ai 均可解析）。 */
type SessionManagerModule = {
  sessionEntryToContextMessages?: (entry: Record<string, unknown>) => unknown[]
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

/** 提取函数窗口（到下一个 export function / 函数声明 / 文件尾）。 */
function functionWindow(text: string, header: string): string {
  const start = text.indexOf(header)
  if (start === -1) return ''
  const rest = text.slice(start + header.length)
  const next = /\n(?:export )?function /.exec(rest)
  return next ? rest.slice(0, next.index) : rest.slice(0, 3000)
}

describe.skipIf(!PI_DIST)(
  `PS-09 探针：sessionEntryToContextMessages 投影白名单（代码形态断言${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const src = readFileSync(join(PI_DIST as string, 'core', 'session-manager.js'), 'utf-8')

    it('白名单分支：message / custom_message / branch_summary / compaction，兜底 return []', () => {
      const win = functionWindow(src, 'export function sessionEntryToContextMessages(entry)')
      expect(win, 'PS-09 漂移：sessionEntryToContextMessages 函数消失/改名——entry→上下文投影改形，复核 PS-09 锚点').not.toBe('')
      for (const t of ['message', 'custom_message', 'branch_summary', 'compaction']) {
        expect(
          win.includes(`entry.type === "${t}"`),
          `PS-09 漂移：白名单分支 "${t}" 消失——投影面变化，复核 PS-09（live ≡ reload 等价性依据）`,
        ).toBe(true)
      }
      expect(win.includes('return []'), 'PS-09 漂移：兜底 return [] 消失——未知类型将进上下文？复核 PS-09').toBe(true)
    })

    it('无 plain custom 分支（type=custom 不被特判）', () => {
      const win = functionWindow(src, 'export function sessionEntryToContextMessages(entry)')
      expect(
        !/entry\.type === "custom"(?!_message)/.test(win),
        'PS-09 漂移：出现了 plain custom 特判分支——custom entry 开始进上下文，复核 PS-09 与 event-adapter 的 entry 映射',
      ).toBe(true)
    })
  },
)

describe.skipIf(!sessionManager?.sessionEntryToContextMessages)(
  'PS-09 探针：sessionEntryToContextMessages 行为断言（动态 import dist/core/session-manager.js）',
  () => {
    const fn = sessionManager!.sessionEntryToContextMessages!

    it('plain appendEntry 的 type=custom → []（不进 LLM 上下文）', () => {
      expect(fn({ type: 'custom', data: { foo: 1 }, timestamp: 1 })).toEqual([])
    })

    it('type=custom_message → 恰一条 role=custom 消息（customType 透传）', () => {
      const got = fn({ type: 'custom_message', customType: 'probe-type', content: [], display: 'hidden', timestamp: 1 })
      expect(got).toHaveLength(1)
      expect(got[0]).toMatchObject({ role: 'custom', customType: 'probe-type' })
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-29 探针：appendCustomEntry 落盘形态静态断言（代码形态${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const sessionManagerSrc = readFileSync(join(PI_DIST as string, 'core', 'session-manager.js'), 'utf-8')
    const agentSessionSrc = readFileSync(join(PI_DIST as string, 'core', 'agent-session.js'), 'utf-8')

    it('appendCustomEntry：entry 字面量固定六字段（customType/data 逐字引用，含 timestamp）', () => {
      const win = methodWindowUntil(sessionManagerSrc, 'appendCustomEntry(customType, data) {', 'appendSessionInfo(')
      expect(
        win,
        'PS-29 漂移：appendCustomEntry 方法消失/改名——custom entry 落盘入口改形，复核 PS-29 锚点',
      ).not.toBe('')
      expect(
        win,
        'PS-29 漂移：entry 字面量不再固定 {type:"custom", customType, data, id, parentId, timestamp}——scanner ④ 分类静默失效，复核 session-manager.js appendCustomEntry 与 PS-29',
      ).toMatch(
        /\{\s*type: "custom",\s*customType,\s*data,\s*id: generateId\(this\.byId\),\s*parentId: this\.leafId,\s*timestamp: new Date\(\)\.toISOString\(\),/,
      )
      expect(
        win.includes('this._appendEntry(entry);'),
        'PS-29 漂移：appendCustomEntry 不再经 _appendEntry 落盘——落盘管线改形，复核 PS-29',
      ).toBe(true)
    })

    it('agent-session：core 绑定 appendEntry(customType, data) 直呼 appendCustomEntry（同参数序零变换）', () => {
      const win = methodWindowUntil(agentSessionSrc, 'appendEntry: (customType, data) => {', 'setSessionName:')
      expect(
        win,
        'PS-29 漂移：core 绑定 appendEntry 消失/改名——extension 落账入口改形，复核 PS-29 锚点',
      ).not.toBe('')
      expect(
        win.includes('this.sessionManager.appendCustomEntry(customType, data)'),
        'PS-29 漂移：appendEntry 不再直呼 appendCustomEntry(customType, data)（参数序/中间变换改形）——custom entry 形态漂移，复核 agent-session.js _bindExtensionCore',
      ).toBe(true)
    })
  },
)

describe.skipIf(!sessionManager?.SessionManager)(
  'PS-29 探针：appendCustomEntry 行为断言（动态 import 实装 dist，原型桩零 fs 写）',
  () => {
    /** 原型桩宿主形状（只暴露 appendCustomEntry 依赖的成员；_appendEntry 被覆写为捕获器）。 */
    type AppendCustomEntryHost = {
      byId: Set<string>
      leafId: string
      _appendEntry: (entry: Record<string, unknown>) => void
      appendCustomEntry: (customType: string, data: unknown) => string
    }

    const Cls = sessionManager!.SessionManager!

    function makeHost(): { host: AppendCustomEntryHost; captured: Array<Record<string, unknown>> } {
      const host = Object.create(Cls.prototype) as AppendCustomEntryHost
      host.byId = new Set()
      host.leafId = 'leaf-0'
      const captured: Array<Record<string, unknown>> = []
      // 覆写落盘钩子：捕获 entry 即返回，不触 fileEntries/_persist（零 fs 写）
      host._appendEntry = (entry) => {
        captured.push(entry)
      }
      return { host, captured }
    }

    it('rename-session custom entry 落盘形态：六字段齐全、data 同引用、timestamp 为可解析 ISO 串', () => {
      const { host, captured } = makeHost()
      const data = { model: 'xiaomi-token-plan-cn/mimo-v2.5', usage: { input: 10, output: 5 } }
      host.appendCustomEntry('rename-session', data)

      expect(captured).toHaveLength(1)
      const entry = captured[0]
      expect(entry.type).toBe('custom')
      expect(entry.customType).toBe('rename-session')
      // 同一引用 = 逐字透传（克隆/重建对象会 here 红）
      expect(entry.data).toBe(data)
      expect((entry.data as Record<string, unknown>).model).toBe('xiaomi-token-plan-cn/mimo-v2.5')
      expect((entry.data as Record<string, unknown>).usage).toEqual({ input: 10, output: 5 })
      expect(typeof entry.id).toBe('string')
      expect((entry.id as string).length).toBeGreaterThan(0)
      expect(entry.parentId).toBe('leaf-0')
      expect(typeof entry.timestamp).toBe('string')
      // timestamp 可被 Date 解析（scanner ④ toLocalDate 依赖此性质）
      expect(Number.isNaN(new Date(entry.timestamp as string).getTime())).toBe(false)
    })
  },
)
