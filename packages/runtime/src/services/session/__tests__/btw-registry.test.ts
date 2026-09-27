/**
 * 线注册表启动重建（btw-question D5：内存缓存 + 目录扫描重建 + hidden 复原）。
 * 目录布局 = `btw/<encodeCwd>/<mainSid>/*.jsonl`（数据目录经 TAIJI_AGENT_DATA_DIR
 * 测试隔离指向 tmp，写删目标全部自建自删——测试红线）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BtwService } from '../btw-service.js'
import { encodeCwd, getBtwSessionsRoot, getBtwThreadDir } from '../../../infra/pi/pi-paths.js'
import {
  cleanEntries, cleanupDir, makeHarness, makeTmpDir, useTmpDataDir, writeSessionFile,
  type BtwHarness,
} from './helpers/btw-harness.js'

const PROJ_A = '/Users/x/proj-a'
const PROJ_B = '/Users/x/proj-b'

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

function seedThread(mainSid: string, lineSid: string, cwd: string, entries = cleanEntries()): string {
  const dir = join(getBtwSessionsRoot(), encodeCwd(cwd), mainSid)
  mkdirSync(dir, { recursive: true })
  return writeSessionFile(dir, `2026-09-22T00-00-00-000Z_${lineSid}.jsonl`, {
    type: 'session', version: 3, id: lineSid, timestamp: 't', cwd,
  }, entries)
}

describe('rebuildFromDisk：启动目录扫描重建', () => {
  it('按 btw/<enc>/<mainSid>/*.jsonl 重建：vid/header cwd/mainSid 目录 + hidden 复原', () => {
    seedThread('main-a', 'line-1', PROJ_A)
    seedThread('main-b', 'line-2', PROJ_B)

    const rebuilt = svc.rebuildFromDisk()

    expect(rebuilt).toHaveLength(2)
    const byVid = new Map(rebuilt.map(r => [r.vid, r]))
    expect(byVid.get('btw:line-1')).toMatchObject({
      piSessionId: 'line-1', mainSid: 'main-a', cwd: PROJ_A, hidden: true,
      snapshotKind: 'unknown', contractRounds: 0,
      threadDir: getBtwThreadDir(PROJ_A, 'main-a'),
    })
    expect(byVid.get('btw:line-1')!.client).toBeUndefined() // 重建不 spawn（惰性）
    expect(byVid.get('btw:line-2')).toMatchObject({ mainSid: 'main-b', cwd: PROJ_B, hidden: true })
    // sessionFilePath 指向真实文件
    expect(byVid.get('btw:line-1')!.sessionFilePath).toContain('main-a')
  })

  it('listLines(mainSid) 按归属过滤 + createdAt 升序', () => {
    seedThread('main-a', 'line-1', PROJ_A)
    seedThread('main-a', 'line-2', PROJ_A)
    seedThread('main-b', 'line-9', PROJ_B)
    svc.rebuildFromDisk()

    expect(svc.listLines('main-a').map(l => l.vid)).toEqual(['btw:line-1', 'btw:line-2'])
    expect(svc.listLines('main-b').map(l => l.vid)).toEqual(['btw:line-9'])
    expect(svc.listAllLines()).toHaveLength(3)
  })

  it('幂等：重复扫描不产重复条目（活跃条目优先不覆盖）', () => {
    seedThread('main-a', 'line-1', PROJ_A)
    expect(svc.rebuildFromDisk()).toHaveLength(1)
    expect(svc.rebuildFromDisk()).toHaveLength(0) // 已登记 → 不重复产出
    expect(svc.listAllLines()).toHaveLength(1)
  })

  it('坏文件 / 无 cwd header / 非法 sid / 非 sid 目录名 → warn 跳过（登记不静默）', () => {
    seedThread('main-a', 'line-1', PROJ_A)
    const enc = encodeCwd(PROJ_A)
    const root = getBtwSessionsRoot()
    // 无法解析的 jsonl
    writeFileSync(join(root, enc, 'main-a', 'broken.jsonl'), 'not-json\n')
    // header 无 cwd
    writeSessionFile(join(root, enc, 'main-a'), 'nocwd.jsonl', { type: 'session', version: 3, id: 'line-x' }, cleanEntries())
    // 非 sid 目录名
    mkdirSync(join(root, enc, 'not a sid!'), { recursive: true })
    // 非法 header id（含冒号 → btwVirtualId 拒）
    writeSessionFile(join(root, enc, 'main-a'), 'badid.jsonl', { type: 'session', version: 3, id: 'btw:evil', cwd: PROJ_A }, cleanEntries())

    const rebuilt = svc.rebuildFromDisk()

    expect(rebuilt.map(r => r.vid)).toEqual(['btw:line-1'])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('skip unparsable'))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('without cwd'))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('non-session dir name'))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('invalid session id'))
  })

  it('空根（首启无 btw 目录）→ []', () => {
    expect(svc.rebuildFromDisk()).toEqual([])
    expect(existsSync(getBtwSessionsRoot())).toBe(false)
  })

  it('重建条目 reattach 轮 hidden:true 注册（hidden 复原经既有 registerSession）', async () => {
    const file = seedThread('main-a', 'line-1', PROJ_A)
    svc.rebuildFromDisk()
    h.state = { sessionId: 'line-1', sessionFile: file }

    const client = await svc.ensureProcess('btw:line-1')

    expect(client).toBeDefined()
    expect(h.spawned[0].client.switchSession).toHaveBeenCalledWith(file)
    expect(h.registered[0]).toMatchObject({ id: 'btw:line-1', hidden: true, file, cwd: PROJ_A })
    expect(h.spawned[0].options.env?.PI_CODING_AGENT_SESSION_DIR).toBe(getBtwThreadDir(PROJ_A, 'main-a'))
    expect(svc.getLine('btw:line-1')!.contractRounds).toBe(1)
  })
})
