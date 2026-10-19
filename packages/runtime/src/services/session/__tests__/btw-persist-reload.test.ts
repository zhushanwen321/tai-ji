/**
 * P-persist：checkpoint 豁免（registerSession 订阅者豁免——不为 btw 建档，重启不误
 * reattach）。
 *
 * 覆盖边界（防重复写已有断言）：
 * - 注册表重建基础面（vid/header cwd/mainSid/hidden 复原/幂等/坏文件跳过）已由
 *   btw-registry.test.ts 覆盖。
 * - [session-store-layout-inversion] 启动孤儿补账已随布局反转退役（线 jsonl 挂主树
 *   内域随主树回收，btw 侧无启动期扫描删除面）——原「孤儿补账先于重建」测试组随
 *   机制一并移除；外部删除/删除失败残留按设计 D3 附注与域 9 同口径接受。
 * - 回放等价半边由 M2-c 落地：renderer `src/__tests__/stores/btw-replay.test.ts` +
 *   core `chat-lru-btw.test.ts`（live≡reload / 同驱派生键），本文件不重复。
 * - 线进程/目录级联在 btw-cascade.test.ts（P-cascade）。
 *
 * 防线：TAIJI_AGENT_DATA_DIR 钉 tmp（fs-guard 白名单）；checkpoint store 显式 init 到
 * 独立 tmp 目录（singleton ??=——beforeAll 一次，用例用唯一 sid 防串扰）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/btw-persist-reload.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initRuntimeCheckpointStore, getRuntimeCheckpointStore } from '../runtime-checkpoint.js'
import { BtwService } from '../btw-service.js'
import {
  cleanupDir,
  makeHarness,
  makeTmpDir,
  useTmpDataDir,
  type BtwHarness,
} from './helpers/btw-harness.js'
import { createSetup } from './helpers/session-service-setup.js'
import type { IPiEngine } from '../../ports/pi-engine.js'

const CWD = '/Users/x/proj'

let checkpointDir: string
let restoreDataDir: () => void
let fx: string
let h: BtwHarness
let svc: BtwService

beforeAll(() => {
  checkpointDir = mkdtempSync(join(tmpdir(), 'btw-persist-checkpoint-'))
  initRuntimeCheckpointStore({ dir: checkpointDir })
})
afterAll(() => {
  rmSync(checkpointDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
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

describe('checkpoint 豁免（P-persist 重启半边：不为 btw 建档 → 重启不误 reattach）', () => {
  it('registerSession(vid) 后 checkpoint 无该条目；普通 session 照常入档（订阅者其余保留）', async () => {
    const { service } = createSetup()
    const vid = `btw:linepi-ckpt-${Date.now()}`
    const mainSid = `main-ckpt-${Date.now()}`

    await service.initializeManagedSession(vid, {} as IPiEngine, CWD, 'line', undefined, true)
    await service.initializeManagedSession(mainSid, {} as IPiEngine, CWD, 'main')

    const ids = getRuntimeCheckpointStore().read()?.sessions.map(s => s.piSessionId) ?? []
    expect(ids).not.toContain(vid) // 豁免生效：reattach 编排结构上看不见 btw 线
    expect(ids).toContain(mainSid) // 对照：主会话建档不受影响（D3 语义保持）

    // 卸载清理（避免条目跨用例累积噪音）
    getRuntimeCheckpointStore().removeSession(mainSid)
  })
})
