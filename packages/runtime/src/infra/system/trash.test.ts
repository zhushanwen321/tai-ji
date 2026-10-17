/**
 * trash 语义测试（timeout-audit-hygiene-batch u-h4 / 设计 §3.4；目录级用例 =
 * session-store-layout-inversion u-trash / 设计 §3.3 D5）。
 *
 * 核心：mac 路径 trash 命令失败/超时后【永不降级 unlinkSync 永久删除】——
 * 文件保留原地 + 抛结构化错误（含路径与恢复指引）+ logger 落盘留痕；
 * 非 mac 分支保持现状直接 unlinkSync（D4-3 不改，回归锁）。
 * 目录级（trashDirectory）：mac 整树走同一通道（与文件级同构）；非 mac 降级
 * rmSync recursive 硬删（设计 D5 定档）——失败原生报错不吞。
 *
 * 观察手段：vi.mock node:child_process / node:fs / node:os / spawn-env / logger，
 * 不触真实系统命令与文件系统。目录级真实 fs 落盘（大目录递归删 + 性能核对）在
 * src/infra/__tests__/trash-directory.test.ts（本文件 fs 全 mock，两文件分工）。
 * 运行：cd packages/runtime && npx vitest run src/infra/system/trash.test.ts
 *
 * RT-8#2 后实现为数组参数形态（execFileSync，trash CLI 优先、osascript 回落），
 * 本文件锁语义与出站契约；注入面（argv 原样、路径不进 AppleScript 源码）由
 * test/trash-command-injection.test.ts 锁定。
 */
import { execFileSync } from 'node:child_process'
import { rmSync, unlinkSync } from 'node:fs'
import { platform } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildOutboundChildEnv } from '../spawn-env.js'
import { logger } from '../logger.js'
import { trash, trashDirectory } from './trash.js'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('node:fs', () => ({ unlinkSync: vi.fn(), rmSync: vi.fn() }))
vi.mock('node:os', () => ({ platform: vi.fn(() => 'darwin') }))
vi.mock('../spawn-env.js', () => ({ buildOutboundChildEnv: vi.fn(() => ({ PATH: '/usr/bin:/bin' })) }))
vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const execFileSyncMock = vi.mocked(execFileSync)
const unlinkSyncMock = vi.mocked(unlinkSync)
const rmSyncMock = vi.mocked(rmSync)
const platformMock = vi.mocked(platform)
const buildOutboundChildEnvMock = vi.mocked(buildOutboundChildEnv)
const loggerErrorMock = vi.mocked(logger.error)

const SESSION_FILE = '/tmp/taiji-test/sessions/abc-123.jsonl'
const SESSION_TREE = '/tmp/taiji-test/ext-sessions/abc-123'

describe('trash（mac 路径：失败保留文件 + 报错，永不永久删除）', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('')
    unlinkSyncMock.mockReset()
    buildOutboundChildEnvMock.mockReset().mockReturnValue({ PATH: '/usr/bin:/bin' })
    loggerErrorMock.mockReset()
    platformMock.mockReset().mockReturnValue('darwin')
  })

  it('① 正常路径：trash 命令成功 → resolve 进废纸篓，不抛错、不 unlink、env 走出站契约构建器', async () => {
    await expect(trash(SESSION_FILE)).resolves.toBeUndefined()
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    // RT-8#2：数组参数形态，路径作为单一 argv 元素（不经 shell 解释）
    expect(execFileSyncMock.mock.calls[0]?.[0]).toBe('trash')
    expect(execFileSyncMock.mock.calls[0]?.[1]).toEqual([SESSION_FILE])
    // C-proc-09：出站契约保持（env 必须经 buildOutboundChildEnv 组装）
    expect(buildOutboundChildEnvMock).toHaveBeenCalledTimes(1)
    // 5s 超时量级保持现状（D4-3）；stdio 缺省 pipe：失败时 stderr 进 error.stderr
    expect(execFileSyncMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000, env: { PATH: '/usr/bin:/bin' } })
    expect(unlinkSyncMock).not.toHaveBeenCalled()
  })

  it('② trash 超时/失败 → 抛结构化错误，文件不被 unlinkSync（降级永久删除路径已删除）', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('Command timed out') // 子进程超时形态
    })
    await expect(trash(SESSION_FILE)).rejects.toThrow('移入废纸篓失败')
    // trash CLI 与 osascript 回落均失败（两次尝试）后才报错
    expect(execFileSyncMock).toHaveBeenCalledTimes(2)
    // G4 核心：任何系统状态下文件要么进废纸篓要么留在原地——绝不 unlinkSync
    expect(unlinkSyncMock).not.toHaveBeenCalled()
  })

  it('③ 错误消息含文件路径与两类恢复指引（稍后重试 / 访达手动拖入废纸篓）', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('Command timed out')
    })
    await expect(trash(SESSION_FILE)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/移入废纸篓失败.*\/tmp\/taiji-test\/sessions\/abc-123\.jsonl.*稍后重试.*访达.*废纸篓/s),
      }),
    )
  })

  it('③a 失败经 logger.error 落盘留痕（D4-2：console 在打包环境不可观测）', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('osascript: Finder is busy')
    })
    await expect(trash(SESSION_FILE)).rejects.toThrow('移入废纸篓失败')
    expect(loggerErrorMock).toHaveBeenCalledTimes(1)
    expect(loggerErrorMock.mock.calls[0]?.[1]).toMatchObject({ filePath: SESSION_FILE })
  })

  it('⑤ 快失败（trash CLI 与 osascript 均非超时失败）与超时同语义：保留文件 + 报错', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawn /usr/bin/trash ENOENT'), { code: 127 })
    })
    await expect(trash(SESSION_FILE)).rejects.toThrow('移入废纸篓失败')
    expect(unlinkSyncMock).not.toHaveBeenCalled()
  })
})

describe('trash（非 mac 分支：保持现状直接永久删除，D4-3 回归锁）', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('')
    unlinkSyncMock.mockReset()
    platformMock.mockReset().mockReturnValue('linux')
  })

  it('linux：不走 trash 命令，直接 unlinkSync（现状语义不变）', async () => {
    await expect(trash(SESSION_FILE)).resolves.toBeUndefined()
    expect(unlinkSyncMock).toHaveBeenCalledTimes(1)
    expect(unlinkSyncMock).toHaveBeenCalledWith(SESSION_FILE)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })
})

describe('trashDirectory（mac 路径：整树走 trash 通道，与文件级同构——D5 前置契约）', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('')
    unlinkSyncMock.mockReset()
    rmSyncMock.mockReset()
    buildOutboundChildEnvMock.mockReset().mockReturnValue({ PATH: '/usr/bin:/bin' })
    loggerErrorMock.mockReset()
    platformMock.mockReset().mockReturnValue('darwin')
  })

  it('① 正常路径：trash 命令收到整树目录单一 argv 元素，env 走出站契约构建器，不触任何硬删', async () => {
    await expect(trashDirectory(SESSION_TREE)).resolves.toBeUndefined()
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    expect(execFileSyncMock.mock.calls[0]?.[0]).toBe('trash')
    // 数组参数形态，目录路径作为单一元素（不经 shell 解释）；timeout 量级与文件级一致
    expect(execFileSyncMock.mock.calls[0]?.[1]).toEqual([SESSION_TREE])
    expect(buildOutboundChildEnvMock).toHaveBeenCalledTimes(1)
    expect(execFileSyncMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000, env: { PATH: '/usr/bin:/bin' } })
    // 软删语义：成功路径不触 unlinkSync / rmSync
    expect(unlinkSyncMock).not.toHaveBeenCalled()
    expect(rmSyncMock).not.toHaveBeenCalled()
  })

  it('② trash CLI 失败 → 回落 osascript（目录路径经 argv 注入、不进 AppleScript 源码）', async () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn /usr/bin/trash ENOENT'), { code: 127 })
    })
    await expect(trashDirectory(SESSION_TREE)).resolves.toBeUndefined()
    expect(execFileSyncMock).toHaveBeenCalledTimes(2)
    expect(execFileSyncMock.mock.calls[1]?.[0]).toBe('osascript')
    const [eFlag, script, ...argv] = execFileSyncMock.mock.calls[1]?.[1] as string[]
    expect(eFlag).toBe('-e')
    expect(script).toContain('on run argv')
    expect(script).not.toContain(SESSION_TREE)
    expect(argv).toEqual([SESSION_TREE])
    expect(rmSyncMock).not.toHaveBeenCalled()
  })

  it('③ 双失败 = 整树保留原地 + 结构化报错（含路径与恢复指引）+ logger 留痕（G4：目录同样永不降级硬删）', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('Command timed out')
    })
    await expect(trashDirectory(SESSION_TREE)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/移入废纸篓失败.*ext-sessions\/abc-123.*稍后重试.*访达.*废纸篓/s),
      }),
    )
    expect(execFileSyncMock).toHaveBeenCalledTimes(2)
    expect(loggerErrorMock).toHaveBeenCalledTimes(1)
    expect(loggerErrorMock.mock.calls[0]?.[1]).toMatchObject({ filePath: SESSION_TREE })
    expect(unlinkSyncMock).not.toHaveBeenCalled()
    expect(rmSyncMock).not.toHaveBeenCalled()
  })
})

describe('trashDirectory（非 mac：设计 D5 定档降级 rmSync recursive 硬删）', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset().mockReturnValue('')
    rmSyncMock.mockReset()
    platformMock.mockReset().mockReturnValue('linux')
    // logger mock 实例为文件级共享，重置防上游 describe 的调用计数泄漏进本组断言
    loggerErrorMock.mockReset()
  })

  it('④ linux：不走 trash 命令，rmSync recursive 一次删除整树，不触 unlinkSync', async () => {
    await expect(trashDirectory(SESSION_TREE)).resolves.toBeUndefined()
    expect(rmSyncMock).toHaveBeenCalledTimes(1)
    expect(rmSyncMock).toHaveBeenCalledWith(SESSION_TREE, { recursive: true })
    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(unlinkSyncMock).not.toHaveBeenCalled()
  })

  it('⑤ 递归删失败（如权限）原生错误上抛不吞，与既有单文件通道失败语义一致', async () => {
    rmSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })
    await expect(trashDirectory(SESSION_TREE)).rejects.toThrow('EACCES')
    expect(loggerErrorMock).not.toHaveBeenCalled()
  })
})
