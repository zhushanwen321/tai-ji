/**
 * W3 surface 落地——btw 直注册链三条写路径的注册表回读（验收项 10③）。
 *
 * surface 定义（设计 §5-W3）：线的展示归属恒为 `'btw'`；三条写路径必须齐——
 * createLine / ensureProcess（reattach）/ rebuildFromDisk（重启重建）。漏
 * rebuildFromDisk = 重启后的线 surface 缺失（W5 切判据后 undefined !== 'sidebar'
 * 落向安全一侧，但属偶然，不能依赖）。
 *
 * W5 变更：`hidden` 字段完整退场（BtwLineRecord.hidden / registerSession hidden
 * 形参 / BtwServiceDeps.registerSession hidden 形参均已删），双写断言收敛为
 * surface 单字段断言；registerSession 收 6 参（尾部 surface）。
 *
 * 回读口径（验收项 10③）：runtime 层直取注册表记录，不经协议——
 * - `btwService.getLine(sessionId)`：BtwLineRecord 的 surface 字段；
 * - deps.registerSession 第 6 参（surface）：btw 直注册链显式传 'btw' 的断言
 *   （只改 registerSession 尾部传不到 btw 线——线不经 create 链路）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/btw-surface-dual-write.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BtwService } from '../btw-service.js'
import { getSessionBtwDir } from '@taiji/shared/paths'
import {
  cleanupDir, makeHarness, makeTmpDir, useTmpDataDir, writeSessionFile,
  type BtwHarness,
} from './helpers/btw-harness.js'

const MAIN_SID = 'main-sid-w3'
const CWD = '/Users/x/proj-w3'

let restoreDataDir: () => void
let fx: string
let h: BtwHarness
let svc: BtwService

beforeEach(() => {
  restoreDataDir = useTmpDataDir()
  fx = makeTmpDir()
  h = makeHarness()
  svc = new BtwService(h.deps)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  svc.dispose()
  cleanupDir(fx)
  restoreDataDir()
  vi.restoreAllMocks()
})

/** 分支② 形态建线（无 fork；state 给定 sid + 真实存在的线文件路径）。
 *  W4a 键统一：返回线 session id（= pi 真实 id）。 */
async function createNoForkLine(fileSid: string): Promise<{ sessionId: string; file: string }> {
  h.deps.resolveMainSessionFile = vi.fn(() => undefined)
  const file = writeSessionFile(join(fx, 'thread'), `${fileSid}.jsonl`, {
    type: 'session', version: 3, id: fileSid, timestamp: 't', cwd: CWD,
  }, [])
  h.state = { sessionId: fileSid, sessionFile: file }
  const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
  return { sessionId: res.sessionId, file: res.sessionFilePath }
}

/** surface 断言（三条路径共用）：注册表记录 surface==='btw'。 */
function expectBtwSurface(rec: { surface?: string } | undefined): void {
  expect(rec).toBeDefined()
  expect(rec!.surface).toBe('btw')
}

describe('W3 surface 落地：btw 线注册表记录 surface（验收项 10③，W5 hidden 退场后收敛为单字段）', () => {
  it('写路径①createLine：注册表记录 surface=btw + registerSession 第 6 参显式传 btw', async () => {
    const { sessionId } = await createNoForkLine('sid-create')

    // 注册表记录回读（btwService.getLine，runtime 层直取不经协议）
    expectBtwSurface(svc.getLine(sessionId))
    // btw 直注册链：deps.registerSession 调用带 surface='btw'（6 参形态）
    expect(h.registered).toHaveLength(1)
    expect(h.registered[0]).toMatchObject({ id: sessionId, surface: 'btw' })
    expect(h.registered[0].argc).toBe(6)
  })

  it('写路径②ensureProcess（reattach）：重附着后 surface 仍成立', async () => {
    const { sessionId } = await createNoForkLine('sid-reattach')
    svc.getLine(sessionId)!.client = undefined // 摘进程引用造重附着入口

    await svc.ensureProcess(sessionId)

    // 记录对象幂等重写 + registerSession 第 6 参再次显式传 btw
    expectBtwSurface(svc.getLine(sessionId))
    expect(h.registered).toHaveLength(2)
    expect(h.registered[1]).toMatchObject({ id: sessionId, surface: 'btw' })
  })

  it('写路径③rebuildFromDisk（重启重建）：重建条目 surface=btw', async () => {
    // 直接往磁盘树 <root>/<mainSid>/btw/*.jsonl 落一条线文件（root = tmp 数据目录下的
    // ext-sessions 存储树）——rebuildFromDisk 的扫描源；新 BtwService 实例 = 重启后的
    // 空注册表，rebuild 从磁盘树重建。
    const lineSid = 'sid-rebuild'
    const dir = getSessionBtwDir(MAIN_SID)
    writeSessionFile(dir, `2026-09-22T00-00-00-000Z_${lineSid}.jsonl`, {
      type: 'session', version: 3, id: lineSid, timestamp: 't', cwd: CWD,
    }, [])
    const svc2 = new BtwService(h.deps)

    const rebuilt = svc2.rebuildFromDisk()

    // W4a 键统一：注册键 = 线 session id（= header id 原样）
    expect(rebuilt.map(r => r.piSessionId)).toContain(lineSid)
    expectBtwSurface(svc2.getLine(lineSid))
    expect(svc2.getLine(lineSid)!.piSessionId).toBe(lineSid)
    svc2.dispose()
  })

  it('三路径合流：create → reattach → rebuild 后同一线的 surface 恒为 btw（终身不可变）', async () => {
    const { sessionId } = await createNoForkLine('sid-immutable')
    expectBtwSurface(svc.getLine(sessionId))

    svc.getLine(sessionId)!.client = undefined
    await svc.ensureProcess(sessionId)
    expectBtwSurface(svc.getLine(sessionId))

    // 重启形态：把该线的磁盘条目落进 btw 目录后以新实例重建（createNoForkLine 的线文件
    // 在 fx 下、不在扫描范围，重建前显式播种）
    const lineSid = sessionId // W4a：线 id 即 pi 真实 id（旧 vid 去前缀翻译层已删）
    writeSessionFile(getSessionBtwDir(MAIN_SID), `2026-09-22T00-00-00-000Z_${lineSid}.jsonl`, {
      type: 'session', version: 3, id: lineSid, timestamp: 't', cwd: CWD,
    }, [])
    const svc2 = new BtwService(h.deps)
    svc2.rebuildFromDisk()
    expectBtwSurface(svc2.getLine(sessionId))
    svc2.dispose()
  })
})
