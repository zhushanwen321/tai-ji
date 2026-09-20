/**
 * gen-stats-service 单元测试（composer-gen-stats u3-wiring，设计 §3.3 D2/D4/D7/D8 + §3.5）。
 *
 * 覆盖（u3 验收①）：
 * - recordSample：bogus guard 丢弃（output>50 && duration<100 → 速度样本不落盘、命中率照常）、
 *   durationMs=null（无配对 turn-start）速度跳过、promptTotal≤0 不采命中率、
 *   映射写 1 + per-session current 槽、扩展广播（同模型全部已知 session 逐 sid 发帧，
 *   聚合共享 / current 各自独立）；
 * - 映射三写一清：写 1（recordSample）/ 写 2（onModelSwitched 重登记+推帧）/ 写 3
 *   （getSnapshotForSession get_state 成功回填）/ 清（registerSessionCleanup + 销毁回调，
 *   映射与 per-session current 槽同清）；
 * - frameFor：current=本会话样本（会话隔离 + 无回落 + 模型切换来回 + 迟到旧模型样本）/
 *   聚合=模型全局（model 恒回填 MF8、无记录全 null、modelKey=null 缺省、day/d7/d30 滚动窗口）；
 * - getSnapshotForSession 降级链四分支：get_state 成功 → 内存映射 → replicated states
 *   缓存值 → 全 null；
 * - interpreter 接线（LLM 窗口口径 genstats-speed-llm-window D1/D3）：turn-start →
 *   message_end(assistant) → turn-usage → onGenStats 携带扩展字段 + durationMs=窗口差；
 *   无 turn-start / 缺闭合 → durationMs=null。
 *
 * 数据目录红线（TEST-STRATEGY / fs-guard）：全部写删目标 = mkdtempSync(
 * join(tmpdir(), 'taiji-gen-stats-')) + TAIJI_AGENT_DATA_DIR env 注入，零共享推导路径触碰。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/gen-stats-service.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenStatsFrame, ServerMessage } from '@taiji/shared'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionService, IMessageBroker } from '../../../interfaces.js'
import { EventInterpreter } from '../event-interpreter.js'
import { SessionService } from '../session-service.js'
import { MessageBus } from '../../message-bus/message-bus.js'
import { SessionMessageHandler } from '../../../transport/session-message-handler.js'
import { translate } from '../../../infra/pi/event-adapter.js'
import type { PiTurnEndEvent } from '../../../infra/pi/pi-protocol.js'
import type { PiTranslatedEvent } from '../types.js'
import { cacheRatioFilePath, localDayKey, speedFilePath, writeDayRecords } from '../gen-stats-store.js'
import { GenStatsService } from '../gen-stats-service.js'

// ── fixture：mkdtemp + TAIJI_AGENT_DATA_DIR 注入（store 测试同款模式，文件级 env 隔离）──────

let dataDir: string
let prevDataDirEnv: string | undefined

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'taiji-gen-stats-'))
  prevDataDirEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = dataDir
})

afterEach(() => {
  if (prevDataDirEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = prevDataDirEnv
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── 服务构造 fixture：窄依赖 mock（deps 面 = 消费面）────────────────────────────────────

interface Fixture {
  service: GenStatsService
  published: Array<{ sid: string; msg: ServerMessage }>
  getClient: ReturnType<typeof vi.fn>
  getState: ReturnType<typeof vi.fn>
  setOnSessionDestroyed: ReturnType<typeof vi.fn>
  getSummary: ReturnType<typeof vi.fn>
}

function makeService(getStateImpl?: () => Promise<unknown>): Fixture {
  const published: Array<{ sid: string; msg: ServerMessage }> = []
  const getState = vi.fn(getStateImpl ?? (async () => undefined))
  const getClient = vi.fn(() => (getStateImpl === null ? undefined : ({ getState } as unknown)))
  const setOnSessionDestroyed = vi.fn()
  const getSummary = vi.fn(() => undefined)
  const service = new GenStatsService({
    publish: (sid, msg) => published.push({ sid, msg }),
    pm: { getClient } as unknown as IProcessManager,
    sessionService: { setOnSessionDestroyed, getSummary } as unknown as ISessionService,
  })
  return { service, published, getClient, getState, setOnSessionDestroyed, getSummary }
}

/** 无活跃 pi 进程（降级链①不可用）形态 */
function makeOfflineService(): Fixture {
  const f = makeService(undefined)
  f.getClient.mockReturnValue(undefined)
  return f
}

/** 直读落盘文件内容（真实存储位置断言） */
function readJson(p: string): unknown {
  expect(existsSync(p)).toBe(true)
  return JSON.parse(readFileSync(p, 'utf-8'))
}

const NORMAL_SAMPLE = {
  outputTokens: 100,
  durationMs: 2000,
  model: 'mdl',
  provider: 'prov',
  input: 500,
  cacheRead: 300,
  cacheWrite: 100,
}

describe('GenStatsService.recordSample（写 1 + bogus guard + 落盘）', () => {
  it('正常样本：speed/cache-ratio 两文件各落一条 + 映射写 1 + 向采样 session 发帧', () => {
    const { service, published } = makeService()
    service.recordSample('s1', { ...NORMAL_SAMPLE })

    expect(readJson(speedFilePath('prov', 'mdl'))).toEqual({ [localDayKey()]: [[100, 2000]] })
    // promptTotal = input + cacheRead + cacheWrite = 900（不含 output，D6 口径）
    expect(readJson(cacheRatioFilePath('prov', 'mdl'))).toEqual({ [localDayKey()]: [[300, 900]] })
    expect(service.sessionsOfModel('prov/mdl')).toEqual(['s1'])
    // 扩展广播：采样 session 自身在映射 → 收到 1 帧
    expect(published).toHaveLength(1)
    expect(published[0]!.sid).toBe('s1')
  })

  it('bogus（output>50 && duration<100）：速度样本丢弃不落盘，命中率样本照常（D7①）', () => {
    const { service } = makeService()
    service.recordSample('s1', { ...NORMAL_SAMPLE, outputTokens: 1000, durationMs: 50 })

    expect(existsSync(speedFilePath('prov', 'mdl'))).toBe(false)
    expect(readJson(cacheRatioFilePath('prov', 'mdl'))).toEqual({ [localDayKey()]: [[300, 900]] })
  })

  it('bogus 阈值边界：output=50 或 duration=100 非 bogus（严格不等，store 谓词语义）', () => {
    const { service } = makeService()
    service.recordSample('s1', { ...NORMAL_SAMPLE, outputTokens: 50, durationMs: 50 })
    service.recordSample('s2', { ...NORMAL_SAMPLE, outputTokens: 1000, durationMs: 100 })
    const speed = readJson(speedFilePath('prov', 'mdl')) as Record<string, unknown[]>
    expect(speed[localDayKey()]).toHaveLength(2)
  })

  it('durationMs=null（无配对 turn-start，D2）：速度样本跳过，命中率样本照常（§3.5）', () => {
    const { service } = makeService()
    service.recordSample('s1', { ...NORMAL_SAMPLE, durationMs: null, outputTokens: 100 })

    expect(existsSync(speedFilePath('prov', 'mdl'))).toBe(false)
    expect(readJson(cacheRatioFilePath('prov', 'mdl'))).toEqual({ [localDayKey()]: [[300, 900]] })
  })

  it('双丢弃（bogus + promptTotal≤0）：无落盘无广播；映射写 1 仍登记（D7②③）', () => {
    const { service, published } = makeService()
    service.recordSample('s1', {
      outputTokens: 1000, durationMs: 50, model: 'mdl', provider: 'prov',
      input: 0, cacheRead: null, cacheWrite: null,
    })

    expect(existsSync(speedFilePath('prov', 'mdl'))).toBe(false)
    expect(existsSync(cacheRatioFilePath('prov', 'mdl'))).toBe(false)
    expect(published).toHaveLength(0)
    // 映射写 1 仍然登记（当前归属语义，与写 2/写 3 一致）
    expect(service.sessionsOfModel('prov/mdl')).toEqual(['s1'])
  })

  it('promptTotal≤0 但速度样本合法：仅速度落盘 + 广播（命中率字段保持旧值）', () => {
    const { service, published } = makeService()
    service.recordSample('s1', {
      outputTokens: 80, durationMs: 1500, model: 'mdl', provider: 'prov',
      input: 0, cacheRead: null, cacheWrite: null,
    })

    expect(readJson(speedFilePath('prov', 'mdl'))).toEqual({ [localDayKey()]: [[80, 1500]] })
    expect(existsSync(cacheRatioFilePath('prov', 'mdl'))).toBe(false)
    expect(published).toHaveLength(1)
  })

  it('model/provider 缺失：样本整体跳过（防御分支，不抛不落盘）', () => {
    const { service, published } = makeService()
    service.recordSample('s1', { ...NORMAL_SAMPLE, model: null, provider: null })
    expect(published).toHaveLength(0)
    expect(service.sessionsOfModel('prov/mdl')).toEqual([])
  })
})

describe('GenStatsService 映射三写一清 + 扩展广播（D4）', () => {
  it('扩展广播：同模型多 session，采样后逐 sid 各发一帧（聚合共享、current 各取本会话槽）', () => {
    const { service, published } = makeOfflineService()
    service.recordSample('sA', { ...NORMAL_SAMPLE })
    expect(published).toHaveLength(1)

    // sB 经写 3 形态登记（直接以写 2 代入：同模型重登记）后，sA 再采样 → 双 session 各一帧
    service.onModelSwitched('sB', 'prov/mdl')
    service.recordSample('sA', { ...NORMAL_SAMPLE })

    expect(published).toHaveLength(4) // sA 首采样 1 帧 + sB 切模型快照 1 帧 + sA 二次采样广播 2 帧
    const lastTwo = published.slice(-2)
    expect(lastTwo.map((p) => p.sid).sort()).toEqual(['sA', 'sB'])
    const bySid = new Map(lastTwo.map((p) => [p.sid, p.msg.payload as GenStatsFrame]))
    for (const p of lastTwo) {
      expect(p.msg.type).toBe('session.stats_update')
      const payload = p.msg.payload as GenStatsFrame
      expect(payload.sessionId).toBe(p.sid)
      expect(payload.model).toBe('prov/mdl')
      expect(payload.speed.day).toBe(50) // 聚合共享：(100+100)/(2000+2000)×1000
      expect(payload.cacheRatio.day).toBe(33)
    }
    // current 会话隔离：sA 取本会话样本；sB 无本会话样本 → null（无回落，读不到 sA 的值）
    expect(bySid.get('sA')!.speed.current).toBe(50)
    expect(bySid.get('sB')!.speed.current).toBeNull()
    expect(bySid.get('sB')!.cacheRatio.current).toBeNull()
  })

  it('会话隔离：他 session 采样不覆盖本会话 current，聚合仍共享更新', () => {
    const { service, published } = makeOfflineService()
    service.recordSample('sA', { ...NORMAL_SAMPLE })
    service.onModelSwitched('sB', 'prov/mdl')
    service.recordSample('sB', { ...NORMAL_SAMPLE, outputTokens: 400, durationMs: 4000 })

    const frames = published.map((p) => p.msg.payload as GenStatsFrame)
    const lastForA = [...frames].reverse().find((f) => f.sessionId === 'sA')!
    const lastForB = [...frames].reverse().find((f) => f.sessionId === 'sB')!
    expect(lastForA.speed.current).toBe(50) // sA 自己的样本未被 sB 覆盖
    expect(lastForB.speed.current).toBe(100) // sB 自己的样本
    // 聚合共享：sB 采样后两 session 的 day 同步更新（(100+400)/(2000+4000)×1000 = 83）
    expect(lastForA.speed.day).toBe(83)
    expect(lastForB.speed.day).toBe(83)
  })

  it('模型切换来回：切到无本会话样本模型 current=null；切回恢复本会话旧样本', () => {
    const { service, published } = makeOfflineService()
    service.recordSample('s1', { ...NORMAL_SAMPLE })
    service.onModelSwitched('s1', 'prov/mdl2')

    const switched = published[1]!.msg.payload as GenStatsFrame
    expect(switched.model).toBe('prov/mdl2')
    expect(switched.speed.current).toBeNull()

    service.onModelSwitched('s1', 'prov/mdl')
    const back = published[2]!.msg.payload as GenStatsFrame
    expect(back.speed.current).toBe(50)
    expect(back.cacheRatio.current).toBe(33)
  })

  it('迟到旧模型样本：只进该 sid 的旧模型槽，不污染新模型 current', () => {
    const { service } = makeOfflineService()
    service.recordSample('s1', { ...NORMAL_SAMPLE })
    service.onModelSwitched('s1', 'prov/mdl2')
    service.recordSample('s1', { ...NORMAL_SAMPLE }) // turn 中切模型后迟到的旧模型 usage

    expect(service.frameFor('s1', 'prov/mdl2').speed.current).toBeNull()
    expect(service.frameFor('s1', 'prov/mdl').speed.current).toBe(50)
  })

  it('写 2 onModelSwitched：重登记（旧模型清出）+ 推新模型快照帧（无记录 → 全 null + model 恒回填 MF8）', () => {
    const { service, published } = makeOfflineService()
    service.recordSample('s1', { ...NORMAL_SAMPLE })
    // 写 2 正式入口：切到无任何记录的模型 mdl2 → 仍必须推帧（MF8：无记录全 null 帧
    // + model 恒回填，否则场景 4⑥「切模型立即显新模型快照/—」分支不可达）
    service.onModelSwitched('s1', 'prov/mdl2')

    expect(service.sessionsOfModel('prov/mdl')).toEqual([])
    expect(service.sessionsOfModel('prov/mdl2')).toEqual(['s1'])

    const frame = published[1]!.msg.payload as GenStatsFrame
    expect(published[1]!.sid).toBe('s1')
    expect(frame.model).toBe('prov/mdl2')
    expect(frame.speed).toEqual({ current: null, day: null, d7: null, d30: null })
    expect(frame.cacheRatio).toEqual({ current: null, day: null })
  })

  it('写 3 onSnapshotResolved：恢复腿解析回填后 live 帧可达（sessionsOfModel 含该 sid）', () => {
    const { service } = makeOfflineService()
    service.onSnapshotResolved('s9', 'prov/mdl')
    expect(service.sessionsOfModel('prov/mdl')).toEqual(['s9'])
  })

  it('D4 条件回写：切模型后迟到的旧模型 usage 不回写映射（样本仍落盘自带 model 名下）', () => {
    const { service } = makeOfflineService()
    service.recordSample('s1', { ...NORMAL_SAMPLE }) // 旧模型 prov/mdl 采样登记
    service.onModelSwitched('s1', 'prov/mdl2') // turn 中切模型（写 2 重登记）

    // 切模型后迟到的 usage 事件自带旧模型名（prov/mdl）——只落盘，不回写映射
    service.recordSample('s1', { ...NORMAL_SAMPLE })

    // 映射保持新模型：s1 不回旧模型广播集合，新模型广播可达该 sid
    expect(service.sessionsOfModel('prov/mdl')).toEqual([])
    expect(service.sessionsOfModel('prov/mdl2')).toEqual(['s1'])
    // 样本归属仍正确：落盘到自带 model（旧模型）名下，速度/命中率各两条
    expect(readJson(speedFilePath('prov', 'mdl'))).toEqual({ [localDayKey()]: [[100, 2000], [100, 2000]] })
    expect(readJson(cacheRatioFilePath('prov', 'mdl'))).toEqual({ [localDayKey()]: [[300, 900], [300, 900]] })
    expect(existsSync(speedFilePath('prov', 'mdl2'))).toBe(false) // 新模型无落盘
  })

  it('D4 条件回写：未登记（新 sid）与同 key 重复样本均正常回写', () => {
    const { service } = makeOfflineService()
    // 新 sid：未登记 → 回写
    service.recordSample('s-new', { ...NORMAL_SAMPLE })
    expect(service.sessionsOfModel('prov/mdl')).toEqual(['s-new'])
    // 同 key 重复采样：回写幂等，映射不漂移
    service.recordSample('s-new', { ...NORMAL_SAMPLE })
    expect(service.sessionsOfModel('prov/mdl')).toEqual(['s-new'])
  })

  it('清：registerSessionCleanup 挂销毁回调，触发后该 sid 全部条目删除', () => {
    const { service, setOnSessionDestroyed } = makeOfflineService()
    service.registerSessionCleanup()
    expect(setOnSessionDestroyed).toHaveBeenCalledTimes(1)
    const handler = setOnSessionDestroyed.mock.calls[0]![0] as (s: { id: string }) => void

    service.recordSample('s1', { ...NORMAL_SAMPLE })
    expect(service.sessionsOfModel('prov/mdl')).toEqual(['s1'])
    expect(service.frameFor('s1', 'prov/mdl').speed.current).toBe(50)
    handler({ id: 's1' })
    expect(service.sessionsOfModel('prov/mdl')).toEqual([])
    // per-session current 槽同清（无界增长封口；残留会让已删 session 重进时显脏值）
    expect(service.frameFor('s1', 'prov/mdl').speed.current).toBeNull()
  })
})

describe('GenStatsService.frameFor（混合视角：current 会话槽 + 聚合模型全局 + MF8 model 恒回填）', () => {
  it('本会话样本驱动 current；day/d7/d30=窗口加权聚合；model 恒回填', () => {
    const { service } = makeOfflineService()
    service.recordSample('s1', { ...NORMAL_SAMPLE })
    service.recordSample('s1', { ...NORMAL_SAMPLE, outputTokens: 300, durationMs: 3000 })

    const snap = service.frameFor('s1', 'prov/mdl')
    expect(snap.model).toBe('prov/mdl')
    // current = 本会话末条 300/3s = 100 t/s；day = (100+300)/(2000+3000)×1000 = 80 t/s
    expect(snap.speed).toEqual({ current: 100, day: 80, d7: 80, d30: 80 })
    // 命中率：本会话末条 300/900 = 33%；day 加权同值（两样本相同）
    expect(snap.cacheRatio.current).toBe(33)
    expect(snap.cacheRatio.day).toBe(33)
    // 他会话视角：聚合同值、current 不共享（会话隔离）
    const other = service.frameFor('s-other', 'prov/mdl')
    expect(other.speed).toEqual({ current: null, day: 80, d7: 80, d30: 80 })
  })

  it('无回落钉：磁盘有该模型样本但本会话无槽（重启 / 他会话存量）→ current null，聚合照常', () => {
    const { service } = makeOfflineService()
    // 直写文件模拟「聚合存量」（重启后 runtime 内存槽清零，或样本来自其他会话）
    writeDayRecords(speedFilePath('prov', 'mdl'), { [localDayKey()]: [[100, 2000]] })
    writeDayRecords(cacheRatioFilePath('prov', 'mdl'), { [localDayKey()]: [[300, 900]] })

    const snap = service.frameFor('s-fresh', 'prov/mdl')
    expect(snap.speed.current).toBeNull()
    expect(snap.cacheRatio.current).toBeNull()
    expect(snap.speed.day).toBe(50)
    expect(snap.cacheRatio.day).toBe(33)
  })

  it('无记录模型：全 null 帧 + model 恒回填（MF8，场景 4⑥「无记录则—」分支可达）', () => {
    const { service } = makeOfflineService()
    const snap = service.frameFor('s1', 'other/model-x')
    expect(snap.model).toBe('other/model-x')
    expect(snap.speed).toEqual({ current: null, day: null, d7: null, d30: null })
    expect(snap.cacheRatio).toEqual({ current: null, day: null })
  })

  it('modelKey=null（降级链④走尽）：全 null 且 model 缺省', () => {
    const { service } = makeOfflineService()
    const snap = service.frameFor('s1', null)
    expect(snap.model).toBeUndefined()
    expect(snap.speed).toEqual({ current: null, day: null, d7: null, d30: null })
    expect(snap.cacheRatio).toEqual({ current: null, day: null })
  })

  it('d7/d30 滚动窗口：窗口外日键不参与聚合（day 键直接构造写入）', () => {
    const { service } = makeOfflineService()
    const now = new Date()
    const daysAgo = (n: number): string => localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n))
    // 今日 100/2s + 8 天前 300/3s：d7 不含 8 天前样本，d30 含
    writeDayRecords(speedFilePath('prov', 'mdl'), {
      [daysAgo(8)]: [[300, 3000]],
      [daysAgo(0)]: [[100, 2000]],
    })

    const snap = service.frameFor('s1', 'prov/mdl')
    expect(snap.speed.current).toBeNull() // 直写文件无本会话槽 → 无回落
    expect(snap.speed.day).toBe(50)
    expect(snap.speed.d7).toBe(50)
    expect(snap.speed.d30).toBe(80) // (100+300)/(2000+3000)×1000
  })
})

// ── 缓存命中率归因降噪（2026-09-19 D-A）────────────────────────────────────────────────
// 展示 0% 的样本在已知成因下附 currentMiss，UI 不再渲染裸 0%（shared GenStatsCacheMiss）。
// 时间控制用 Date.now spy（不用 fake timers：localDayKey 走 new Date()，日键保持真实值）；
// 测试状态文件级隔离，afterEach 统一 restoreAllMocks。

/** 展示 0%（read=0，promptTotal=1000） */
const ZERO_SAMPLE = { ...NORMAL_SAMPLE, input: 1000, cacheRead: 0, cacheWrite: 0 }
/** 展示 90%（read=900，promptTotal=1000） */
const HIT_SAMPLE_90 = { ...NORMAL_SAMPLE, input: 100, cacheRead: 900, cacheWrite: 0 }

describe('GenStatsService 归因降噪（cacheRatio.currentMiss）', () => {
  it('cold-start：本会话首条样本展示 0% → 归因（帧内下发，广播帧同源出口同带）', () => {
    const { service, published } = makeOfflineService()
    service.recordSample('s1', ZERO_SAMPLE)

    const frame = service.frameFor('s1', 'prov/mdl')
    expect(frame.cacheRatio.current).toBe(0)
    expect(frame.cacheRatio.currentMiss).toEqual({ reason: 'cold-start' })
    const broadcast = published.at(-1)!.msg.payload as GenStatsFrame
    expect(broadcast.cacheRatio.currentMiss).toEqual({ reason: 'cold-start' })
  })

  it('命中样本不带归因；随后的新 0% 样本会整槽替换旧注解', () => {
    const { service } = makeOfflineService()
    service.recordSample('s1', ZERO_SAMPLE) // 首条 0% → cold-start
    service.recordSample('s1', HIT_SAMPLE_90)
    // 命中样本：无归因（currentMiss 与「刺眼的 0」严格同域）
    expect(service.frameFor('s1', 'prov/mdl').cacheRatio.currentMiss).toBeUndefined()

    // 非空闲、无 compaction 的 0%：未知成因 → 保留裸 0%（不降噪，清掉旧 cold-start 注解）
    service.recordSample('s1', ZERO_SAMPLE)
    const frame = service.frameFor('s1', 'prov/mdl')
    expect(frame.cacheRatio.current).toBe(0)
    expect(frame.cacheRatio.currentMiss).toBeUndefined()
  })

  it('idle-expiry：距上一次请求空闲 > 5min 的首个 0% → 归因 + 实际 idleMs', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    const { service } = makeOfflineService()
    service.recordSample('s1', HIT_SAMPLE_90)

    now.mockReturnValue(1_000_000 + 6 * 60_000) // 6 分钟
    service.recordSample('s1', ZERO_SAMPLE)

    expect(service.frameFor('s1', 'prov/mdl').cacheRatio.currentMiss).toEqual({
      reason: 'idle-expiry',
      idleMs: 6 * 60_000,
    })
  })

  it('idle 边界：空闲恰好 5min → 不归因；超 TTL 1ms → 归因（严格大于，基准 = 上一次请求）', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    const { service } = makeOfflineService()
    service.recordSample('s1', HIT_SAMPLE_90)

    now.mockReturnValue(1_000_000 + 5 * 60_000) // 恰好 TTL：不归因（严格大于）
    service.recordSample('s1', ZERO_SAMPLE)
    expect(service.frameFor('s1', 'prov/mdl').cacheRatio.currentMiss).toBeUndefined()

    now.mockReturnValue(1_000_000 + 2 * 5 * 60_000 + 1) // 距上一次请求 TTL+1ms → 归因
    service.recordSample('s1', ZERO_SAMPLE)
    expect(service.frameFor('s1', 'prov/mdl').cacheRatio.currentMiss).toEqual({
      reason: 'idle-expiry',
      idleMs: 5 * 60_000 + 1,
    })
  })

  it('context-rewrite：markContextRewritten 后首个 0% → 归因；优先级高于空闲超时', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    const { service } = makeOfflineService()
    service.recordSample('s1', HIT_SAMPLE_90)
    service.markContextRewritten('s1')

    now.mockReturnValue(2_600_000) // 同时空闲超 TTL（1h）——前缀重写是结构性成因，优先
    service.recordSample('s1', ZERO_SAMPLE)

    expect(service.frameFor('s1', 'prov/mdl').cacheRatio.currentMiss).toEqual({ reason: 'context-rewrite' })
  })

  it('context-rewrite 一次性：标记被紧随其后的样本消费（命中即消费），下一条 0% 不再归因', () => {
    const { service } = makeOfflineService()
    service.recordSample('s1', HIT_SAMPLE_90)
    service.markContextRewritten('s1')
    service.recordSample('s1', HIT_SAMPLE_90) // 标记被本条消费（非 0%，无注解可附）
    service.recordSample('s1', ZERO_SAMPLE)

    expect(service.frameFor('s1', 'prov/mdl').cacheRatio.currentMiss).toBeUndefined()
  })

  it('provider 未上报 cache 字段（两字段全缺省）→ 不落盘不变槽（显示保留上一条，非 0%）', () => {
    const { service, published } = makeOfflineService()
    service.recordSample('s1', HIT_SAMPLE_90) // 首条：速度 + 命中率双落盘 + 广播
    service.recordSample('s1', { ...HIT_SAMPLE_90, input: 5000, cacheRead: null, cacheWrite: null })

    // 命中率文件不再写（无计量 ≠ 0% miss）；本条仍有合法速度样本 → 速度落盘 + 广播一帧
    expect(readJson(cacheRatioFilePath('prov', 'mdl'))).toEqual({ [localDayKey()]: [[900, 1000]] })
    const broadcast = published.at(-1)!.msg.payload as GenStatsFrame
    expect(broadcast.cacheRatio.current).toBe(90) // 槽未被 null-null 样本改写
    expect(broadcast.cacheRatio.currentMiss).toBeUndefined()
  })

  it('会话隔离：sA 的 idle 归因不污染 sB（sB 首条仍为 cold-start，idle 基准各自独立）', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    const { service } = makeOfflineService()
    service.recordSample('sA', HIT_SAMPLE_90)

    now.mockReturnValue(1_000_000 + 10 * 60_000) // 10 分钟后：sA 的 miss 返归因，sB 首条回 cold-start
    service.recordSample('sA', ZERO_SAMPLE)
    service.recordSample('sB', ZERO_SAMPLE)

    expect(service.frameFor('sA', 'prov/mdl').cacheRatio.currentMiss).toEqual({
      reason: 'idle-expiry',
      idleMs: 10 * 60_000,
    })
    expect(service.frameFor('sB', 'prov/mdl').cacheRatio.currentMiss).toEqual({ reason: 'cold-start' })
  })

  it('恢复腿保留归因：getSnapshotForSession（RPC 帧）与 live 帧同带 currentMiss', async () => {
    const { service } = makeOfflineService()
    service.recordSample('s1', ZERO_SAMPLE)

    const frame = await service.getSnapshotForSession('s1')
    expect(frame.model).toBe('prov/mdl')
    expect(frame.cacheRatio.currentMiss).toEqual({ reason: 'cold-start' })
  })

  it('销毁清理：session 销毁后归因状态同清（frameFor 全空，无残留注解）', () => {
    const { service, setOnSessionDestroyed } = makeOfflineService()
    service.registerSessionCleanup()
    const handler = setOnSessionDestroyed.mock.calls[0]![0] as (s: { id: string }) => void
    service.recordSample('s1', ZERO_SAMPLE)

    handler({ id: 's1' })
    const frame = service.frameFor('s1', 'prov/mdl')
    expect(frame.cacheRatio.current).toBeNull()
    expect(frame.cacheRatio.currentMiss).toBeUndefined()
  })
})

describe('GenStatsService.getSnapshotForSession（恢复腿降级链，D4）', () => {
  it('① get_state 成功：解析 provider/id 复合 key + 写 3 回填 + 帧 current=本会话样本', async () => {
    const { service, getClient } = makeService(async () => ({ model: { id: 'mdl', provider: 'prov' } }))
    service.recordSample('sOther', { ...NORMAL_SAMPLE }) // prov/mdl 已有样本（sOther 的）

    const frame = await service.getSnapshotForSession('sLive')
    expect(getClient).toHaveBeenCalledWith('sLive')
    expect(frame.sessionId).toBe('sLive')
    expect(frame.model).toBe('prov/mdl')
    expect(frame.speed.current).toBeNull() // sLive 无本会话样本 → 无回落（sOther 的值不共享）
    expect(frame.speed.day).toBe(50) // 聚合全局可见
    // 写 3：解析成功即登记，live 帧此后可达
    expect(service.sessionsOfModel('prov/mdl')).toContain('sLive')
  })

  it('② get_state 失败 → 内存映射命中（该 session 采样过）', async () => {
    const { service } = makeService(async () => { throw new Error('pi offline') })
    service.recordSample('s1', { ...NORMAL_SAMPLE })

    const frame = await service.getSnapshotForSession('s1')
    expect(frame.model).toBe('prov/mdl')
    expect(frame.speed.current).toBe(50)
  })

  it('③ get_state 失败 + 无映射 → replicated states 缓存值（getSummary 的 modelId 双写缓存）', async () => {
    const { service, getSummary } = makeService(async () => { throw new Error('pi offline') })
    getSummary.mockReturnValue({ id: 's1', modelId: 'prov/mdl-cached' })

    const frame = await service.getSnapshotForSession('s1')
    expect(getSummary).toHaveBeenCalledWith('s1')
    expect(frame.model).toBe('prov/mdl-cached')
    expect(frame.speed).toEqual({ current: null, day: null, d7: null, d30: null })
  })

  it('④ 全部未命中：全 null 帧 + model 缺省（不卡加载）', async () => {
    const { service } = makeOfflineService()
    const frame = await service.getSnapshotForSession('sUnknown')
    expect(frame).toEqual({
      sessionId: 'sUnknown',
      speed: { current: null, day: null, d7: null, d30: null },
      cacheRatio: { current: null, day: null },
    })
    expect(frame.model).toBeUndefined()
  })
})

// ── interpreter 接线（u3 验收①：turn-usage → onGenStats 回调）────────────────────────

function makeInterpreter(onGenStats: ReturnType<typeof vi.fn>): EventInterpreter {
  return new EventInterpreter('s1', { send: () => {}, onGenStats: onGenStats as never })
}

const TURN_USAGE_EVENT: PiTranslatedEvent = {
  kind: 'turn-usage',
  sessionId: 's1',
  inputTokens: 30,
  totalTokens: 30,
  outputTokens: 100,
  cacheRead: 300,
  cacheWrite: 100,
  input: 500,
  model: 'mdl',
  provider: 'prov',
}

/** assistant message_end 帧（照抄 event-adapter 翻译形态：{sessionId, entry: PiMessageEntry}；构造范式同 event-interpreter.test.ts D3 矩阵）。 */
function makeAssistantMessageEnd(): ServerMessage {
  return {
    type: 'message.message_end',
    payload: {
      sessionId: 's1',
      entry: { type: 'message', timestamp: new Date().toISOString(), message: { role: 'assistant' } },
    },
  }
}

describe('EventInterpreter gen-stats 接线（D1/D2）', () => {
  it('turn-start → message_end(assistant) → turn-usage：onGenStats 携带扩展字段 + durationMs=LLM 窗口差', () => {
    vi.useFakeTimers()
    const onGenStats = vi.fn()
    const interp = makeInterpreter(onGenStats)
    const T0 = 1_000_000
    vi.setSystemTime(T0)
    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    vi.setSystemTime(T0 + 5_000)
    interp.interpret([{ kind: 'message', message: makeAssistantMessageEnd() }]) // message_end 结算窗口 t1-t0=5000
    vi.setSystemTime(T0 + 35_000) // end → usage 之间的墙钟（工具执行等）不得计入窗口
    interp.interpret([TURN_USAGE_EVENT])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    expect(onGenStats).toHaveBeenCalledWith('s1', {
      outputTokens: 100,
      durationMs: 5_000,
      model: 'mdl',
      provider: 'prov',
      input: 500,
      cacheRead: 300,
      cacheWrite: 100,
    })
  })

  it('无配对 turn-start（runtime 中途启动/事件丢失）：durationMs=null（D2）', () => {
    const onGenStats = vi.fn()
    const interp = makeInterpreter(onGenStats)
    interp.interpret([TURN_USAGE_EVENT])
    expect(onGenStats).toHaveBeenCalledWith('s1', expect.objectContaining({ durationMs: null }))
  })

  it('消费后置空：缺闭合的下一个 turn-usage 不得复用上一窗口（§3.5 一致性）', () => {
    vi.useFakeTimers()
    const onGenStats = vi.fn()
    const interp = makeInterpreter(onGenStats)
    const T0 = 2_000_000
    vi.setSystemTime(T0)
    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    vi.setSystemTime(T0 + 5_000)
    interp.interpret([{ kind: 'message', message: makeAssistantMessageEnd() }])
    interp.interpret([TURN_USAGE_EVENT])
    // 第二个 turn-usage 缺配对闭合（真缺闭：pi 崩溃/断连）：窗口消费后置 null + 重锚
    // 清除不变量——若旧窗口未清会复用 5_000 产出「旧窗口 × 新 token」脏样本（系统性
    // 失真），必须为 null（§3.5：速度样本跳过而非脏样本）
    vi.setSystemTime(T0 + 10_000)
    interp.interpret([TURN_USAGE_EVENT])

    expect(onGenStats).toHaveBeenCalledTimes(2)
    expect(onGenStats).toHaveBeenNthCalledWith(1, 's1', expect.objectContaining({ durationMs: 5_000 }))
    expect(onGenStats).toHaveBeenNthCalledWith(2, 's1', expect.objectContaining({ durationMs: null }))
  })

  it('context.update 链路不受影响：onContextUpdate 照常触发（既有行为回归钉）', () => {
    const onGenStats = vi.fn()
    const onContextUpdate = vi.fn()
    const interp = new EventInterpreter('s1', {
      send: () => {},
      onGenStats: onGenStats as never,
      onContextUpdate,
    })
    interp.interpret([TURN_USAGE_EVENT])
    expect(onContextUpdate).toHaveBeenCalledWith('s1', { inputTokens: 30, totalTokens: 30 })
  })

  it('compaction 成功 → onCompactionContextRewritten（归因降噪接线：上下文重写标记）', () => {
    const onCompactionContextRewritten = vi.fn()
    const interp = new EventInterpreter('s1', { send: () => {}, onCompactionContextRewritten })
    interp.interpret([{ kind: 'compaction-end', reason: 'manual', aborted: false, result: { summary: 'S' } }])

    expect(onCompactionContextRewritten).toHaveBeenCalledTimes(1)
    expect(onCompactionContextRewritten).toHaveBeenCalledWith('s1')
  })

  it('compaction aborted（无 result）/ failed（errorMessage 真值）→ 不标记（上下文未变，不得误标）', () => {
    const onCompactionContextRewritten = vi.fn()
    const interp = new EventInterpreter('s1', { send: () => {}, onCompactionContextRewritten })
    interp.interpret([
      { kind: 'compaction-end', reason: 'threshold', aborted: true },
      { kind: 'compaction-end', reason: 'manual', aborted: false, errorMessage: 'summarize failed' },
    ])

    expect(onCompactionContextRewritten).not.toHaveBeenCalled()
  })
})

// ── Gate A ②：event-adapter handleTurnEndPi 扩展字段提取（D1，无人认领防线）────────────

describe('event-adapter handleTurnEndPi 扩展字段提取（D1）', () => {
  function turnEndEvent(message: Record<string, unknown>): PiTurnEndEvent {
    return { type: 'turn_end', turnIndex: 0, message, toolResults: [] } as unknown as PiTurnEndEvent
  }

  it('完整 usage + model/provider → turn-usage 携带全部扩展字段', () => {
    const events = translate(turnEndEvent({
      role: 'assistant',
      content: [],
      usage: { input: 100, output: 200, totalTokens: 500, cacheRead: 300, cacheWrite: 50 },
      model: 'mimo-v2.5-pro',
      provider: 'xiaomi-token-plan-cn',
    }), 's1')

    expect(events.find((e) => e.kind === 'turn-usage')).toEqual({
      kind: 'turn-usage',
      sessionId: 's1',
      inputTokens: 500,
      totalTokens: 500,
      outputTokens: 200,
      cacheRead: 300,
      cacheWrite: 50,
      input: 100,
      model: 'mimo-v2.5-pro',
      provider: 'xiaomi-token-plan-cn',
    })
  })

  it('字段缺省 → null 编码（禁 ?? 0）；无 totalTokens → 空（既有早退门控不变）', () => {
    const events = translate(turnEndEvent({ role: 'assistant', content: [], usage: { totalTokens: 10 } }), 's1')
    expect(events.find((e) => e.kind === 'turn-usage')).toEqual({
      kind: 'turn-usage',
      sessionId: 's1',
      inputTokens: 10,
      totalTokens: 10,
      outputTokens: null,
      cacheRead: null,
      cacheWrite: null,
      input: null,
      model: null,
      provider: null,
    })

    const none = translate(turnEndEvent({ role: 'assistant', content: [] }), 's1')
    expect(none.filter((e) => e.kind === 'turn-usage')).toHaveLength(0)
  })
})

// ── Gate A ③：session-service 写 2 tap 机制（state_changed 后置 tap / 帧序 / bus 替换 memoize）──

describe('SessionService 写 2 tap（setGenStatsModelSwitchTap / 投影 bus 视图）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  /** d1-usage-protocol-invariants 同款最小 fixture：真实 bus + fake pi client + 全 mock 依赖。 */
  function makeSvcFixture() {
    const state: Record<string, unknown> = {
      sessionName: 'tap', thinkingLevel: 'low', model: { id: 'model-a', provider: 'p' }, pendingMessageCount: 0,
    }
    const client = {
      getState: vi.fn(async () => state),
      getSessionStats: vi.fn(async () => ({ contextUsage: { tokens: 100, contextWindow: 128000, percent: 1 } })),
      getCommands: vi.fn(async () => []),
      setModel: vi.fn(async () => undefined),
    }
    const pm = {
      onSessionExit: vi.fn(),
      getClient: vi.fn(() => client as unknown as IPiEngine),
    } as unknown as IProcessManager
    const bus = new MessageBus()
    const publishSpy1 = vi.spyOn(bus, 'publish')
    const svc = new SessionService(
      pm,
      { broadcast: vi.fn() } as unknown as IMessageBroker,
      () => ({ attach: vi.fn(), detach: vi.fn() }),
      '/test/project-root',
      {} as never,
      { getDefaultModel: () => ({ provider: 'p', modelId: 'model-a' }) } as never,
      { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never,
      { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never,
      {} as never,
      bus,
    )
    svc.setMessageBus(bus)
    return { svc, bus, client, publishSpy1 }
  }

  it('state_changed 发布后 tap 被调且帧序构造性成立（ws 先收到 state_changed，tap 后执行，MF9）', async () => {
    const { svc, bus } = makeSvcFixture()
    const order: string[] = []
    const ws = { readyState: 1, send: (p: string) => { if (p.includes('"session.state_changed"')) order.push('ws:state_changed') } }
    bus.subscribe('s-tap', ws as never)
    const tapCalls: Array<[string, string]> = []
    svc.setGenStatsModelSwitchTap((sid, mk) => { tapCalls.push([sid, mk]); order.push('tap') })

    await svc.initializeManagedSession('s-tap', {} as unknown as IPiEngine, '/tmp', 'w1')
    await vi.advanceTimersByTimeAsync(500)

    expect(tapCalls.length).toBeGreaterThanOrEqual(1)
    expect(tapCalls[0]![0]).toBe('s-tap')
    expect(tapCalls[0]![1]).toBe('p/model-a')
    expect(order[0]).toBe('ws:state_changed')
    expect(order[1]).toBe('tap')
  })

  it('publish 非 state_changed 类型不触发 tap', () => {
    const { svc, bus } = makeSvcFixture()
    const tap = vi.fn()
    svc.setGenStatsModelSwitchTap(tap)
    bus.publish('s-x', { type: 'message.message_start', payload: { sessionId: 's-x' } } as never)
    bus.publish('s-x', { type: 'context.update', payload: { sessionId: 's-x' } } as never)
    expect(tap).not.toHaveBeenCalled()
  })

  it('bus 替换后 memoize 重建：state_changed 落新 bus、tap 继续被调、旧 bus 不再收新帧', async () => {
    const { svc, client, publishSpy1 } = makeSvcFixture()
    const tap = vi.fn()
    svc.setGenStatsModelSwitchTap(tap)
    await svc.initializeManagedSession('s-r', {} as unknown as IPiEngine, '/tmp', 'w1')
    await vi.advanceTimersByTimeAsync(500)
    const stateFramesOnBus1 = publishSpy1.mock.calls.filter(([, m]) => m.type === 'session.state_changed').length
    expect(stateFramesOnBus1).toBeGreaterThanOrEqual(1)

    const bus2 = new MessageBus()
    const publishSpy2 = vi.spyOn(bus2, 'publish')
    svc.setMessageBus(bus2)
    client.getState.mockResolvedValue({
      sessionName: 'tap', thinkingLevel: 'low', model: { id: 'model-b', provider: 'p' }, pendingMessageCount: 0,
    })
    await svc.switchModel('s-r', 'p' as never, 'model-b')
    await vi.advanceTimersByTimeAsync(1000)

    expect(publishSpy2.mock.calls.filter(([, m]) => m.type === 'session.state_changed').length).toBeGreaterThanOrEqual(1)
    expect(tap).toHaveBeenCalledWith('s-r', 'p/model-b')
    // 旧 bus 视图随 memoize 失效：替换后无新增 state_changed
    expect(publishSpy1.mock.calls.filter(([, m]) => m.type === 'session.state_changed').length).toBe(stateFramesOnBus1)
  })
})

// ── Gate A ④：session-message-handler getGenStats case（D4 恢复腿路由）────────────────

describe('SessionMessageHandler session.getGenStats case', () => {
  const MSG = { type: 'session.getGenStats', id: 'req-1', payload: { sessionId: 's9' } } as never
  const WS = {} as never

  function makeHandler(genStats?: { getSnapshotForSession: (sid: string) => Promise<GenStatsFrame> }) {
    const replies: Array<{ id: string | undefined; type: string; payload: unknown }> = []
    const errors: Array<{ code: string }> = []
    const ctx = {
      send: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
        replies.push({ id, type, payload })
      }),
      sendError: vi.fn((_ws: unknown, code: string) => { errors.push({ code }) }),
      sessionService: {},
      genStatsService: genStats,
    }
    const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    return { handler, replies, errors }
  }

  it('未注入 genStatsService → sendError gen_stats_unsupported（importService 同款防御）', async () => {
    const { handler, errors, replies } = makeHandler()
    await handler.handleSessionMessage(MSG, WS)
    expect(errors).toEqual([{ code: 'gen_stats_unsupported' }])
    expect(replies).toHaveLength(0)
  })

  it('注入 → reply session.stats_update，payload = 降级链快照帧（handler 只透传）', async () => {
    const frame: GenStatsFrame = {
      sessionId: 's9',
      speed: { current: 50, day: 50, d7: null, d30: null },
      cacheRatio: { current: null, day: null },
      model: 'prov/mdl',
    }
    const getSnapshotForSession = vi.fn(async () => frame)
    const { handler, replies, errors } = makeHandler({ getSnapshotForSession })

    await handler.handleSessionMessage(MSG, WS)

    expect(errors).toHaveLength(0)
    expect(getSnapshotForSession).toHaveBeenCalledWith('s9')
    expect(replies).toEqual([{ id: 'req-1', type: 'session.stats_update', payload: frame }])
  })
})
