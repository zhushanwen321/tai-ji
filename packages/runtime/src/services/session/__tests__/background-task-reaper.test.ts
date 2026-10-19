/**
 * background-task-reaper 换根行为测试（session-store-layout-inversion 域 5）。
 *
 * 锁定：
 *  - 布局契约：registry 落 `<dataDir>/ext-sessions/<sid>/background-tasks/registry.json`
 *    （getSessionRegistryPath 契约 SSOT，入参 pi agentDir 剥一层得树基址）；
 *  - 触发面 A：新树 registry 的孤儿条目被收殓（orphaned 终态写入）；
 *  - 触发面 B：扫 `<root>/` 一级 sid 目录 + D7 树内遍历规约（非合法 sessionId 形态
 *    目录一律跳过，不误读）。
 *
 * 进程原语全注入 mock（零真实进程）；fs 全部 mkdtemp 自建自删（测试红线：不触真实
 * 数据目录）。测试框架：vitest。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getSessionRegistryPath,
  reapSessionBackgroundTasks,
  reapAllSessionsBackgroundTasks,
} from '../background-task-reaper.js'

/** mkdtemp 自建自删目录集（afterEach 统一清理）。 */
const tmpDirs: string[] = []

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bte-reaper-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
  vi.restoreAllMocks()
})

/** 收殓 deps 全 mock：属主死 / 任务 pid 死（走分支③终态收尾，零真实进程探测）。 */
function deadOwnerDeps() {
  return {
    isPidAlive: vi.fn(() => false),
    killProcessTree: vi.fn(),
    getProcessStartTimeSec: vi.fn(() => undefined),
  }
}

/** 写一条孤儿 running 条目（属主 pid 999999 已死）。 */
function writeOrphanEntry(registryPath: string, taskId: string, sessionId = 'sid-a'): void {
  mkdirSync(join(registryPath, '..'), { recursive: true })
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          taskId,
          pid: 12345,
          command: 'sleep 3600',
          outputFile: join(registryPath, '..', `${taskId}.log`),
          startedAt: 1_700_000_000_000,
          state: 'running',
          ownerPiPid: 999_999,
          sessionId,
        },
      ],
    }),
    'utf8',
  )
}

const AGENT_DIRNAME = 'agent'

describe('getSessionRegistryPath（域 5 布局契约 SSOT）', () => {
  it('resolves <dataDir>/ext-sessions/<sid>/background-tasks/registry.json from pi agentDir', () => {
    const dataDir = freshDataDir()
    const agentDir = join(dataDir, AGENT_DIRNAME)
    expect(getSessionRegistryPath(agentDir, 'sid-a')).toBe(
      join(dataDir, 'ext-sessions', 'sid-a', 'background-tasks', 'registry.json'),
    )
  })
})

describe('reapSessionBackgroundTasks（触发面 A：新树收殓）', () => {
  it('collects an orphan entry from the new-tree registry (orphaned terminal written)', async () => {
    const dataDir = freshDataDir()
    const agentDir = join(dataDir, AGENT_DIRNAME)
    const registryPath = getSessionRegistryPath(agentDir, 'sid-a')
    writeOrphanEntry(registryPath, 'bt-1700000000-aaa001')

    const result = await reapSessionBackgroundTasks(agentDir, 'sid-a', deadOwnerDeps())

    expect(result.scannedDirs).toBe(1)
    expect(result.finalizedOrphans).toBe(1)
    // 终态写回同一路径（新树）
    const file = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      entries: Array<{ taskId: string; state: string }>
    }
    expect(file.entries[0]?.state).toBe('orphaned')
  })

  it('skips invalid sessionId shapes silently (no throw, no scan)', async () => {
    const dataDir = freshDataDir()
    const agentDir = join(dataDir, AGENT_DIRNAME)
    const result = await reapSessionBackgroundTasks(agentDir, 'btw:not-a-valid-id', deadOwnerDeps())
    expect(result.scannedDirs).toBe(0)
    expect(result.finalizedOrphans).toBe(0)
  })
})

describe('reapAllSessionsBackgroundTasks（触发面 B：扫树 + D7 跳过规约）', () => {
  it('scans ext-sessions root, collects orphans, and skips non-sessionId directories', async () => {
    const dataDir = freshDataDir()
    const agentDir = join(dataDir, AGENT_DIRNAME)
    // 合法 sid 树：孤儿条目应被收殓
    writeOrphanEntry(getSessionRegistryPath(agentDir, 'sid-b'), 'bt-1700000000-bbb001', 'sid-b')
    // 非法形态目录（D7 跳过，冒号必拒）：同名 background-tasks/registry.json 不得被读
    const junkDir = join(dataDir, 'ext-sessions', 'junk:dir')
    mkdirSync(join(junkDir, 'background-tasks'), { recursive: true })
    writeOrphanEntry(join(junkDir, 'background-tasks', 'registry.json'), 'bt-1700000000-jjj001')

    const result = await reapAllSessionsBackgroundTasks(agentDir, deadOwnerDeps())

    // junkDir 不计入扫描（isPiSessionId 滤网）；只有 sid-b 被 scan
    expect(result.scannedDirs).toBe(1)
    expect(result.finalizedOrphans).toBe(1)
  })

  it('is a silent no-op when the session store root does not exist', async () => {
    const dataDir = freshDataDir()
    const agentDir = join(dataDir, AGENT_DIRNAME)
    const result = await reapAllSessionsBackgroundTasks(agentDir, deadOwnerDeps())
    expect(result.scannedDirs).toBe(0)
    expect(result.finalizedOrphans).toBe(0)
  })
})
