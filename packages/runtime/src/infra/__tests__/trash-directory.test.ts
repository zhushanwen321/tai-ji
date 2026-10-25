/**
 * trashDirectory 非 mac 降级递归删——真实 fs 落盘上的删净逻辑
 * （session-store-layout-inversion u-trash / 设计 §3.3 D5）。
 *
 * 与 src/infra/system/trash.test.ts 的分工：那边 fs 全 mock 锁通道语义（mac argv
 * 形态 / 回落 / 结构化报错 / rmSync 调用参数）；本文件 fs 真实，验证 rmSync recursive
 * 对多层嵌套树真实删净。树规模保持小（单测只测逻辑、高负载下极快）——「大目录也快」
 * 属性能关切，不归单测层（2026-10-22 测试整治裁决，登记 docs/TEST-STRATEGY.md「新写测试判据」节）。
 *
 * 观察手段：platform mock 成 linux（任何宿主机都走降级分支，mac 本机也不例外）；
 * node:child_process 整模块 mock——非 mac 分支零子进程由断言兜底锁定。写删目标全部
 * mkdtemp 自建自删（AGENTS.md 测试红线），不触真实数据目录。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/__tests__/trash-directory.test.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trashDirectory } from '../system/trash.js'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  // platform 钉死 linux：降级 rmSync recursive 分支在任何宿主机上真实执行；
  // tmpdir 等其余成员保持真实（fs-guard 白名单 = os.tmpdir()）
  return { ...actual, platform: () => 'linux' }
})

const execFileSyncMock = vi.mocked(execFileSync)

// 体量锚点：2 × 5 二级目录 × 2 文件 = 20 文件三层嵌套（递归删净逻辑的最小等价规模；
// 高负载下也恒快——大目录吞吐不属单测层关切）
const L1_DIRS = 2
const L2_DIRS_PER_L1 = 5
const FILES_PER_L2 = 2

let tempRoot = ''

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'taiji-trash-dir-test-'))
})

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 在 tempRoot 下建一颗 session 树形态的多层目录树，返回树根。 */
function buildSessionTree(): string {
  const root = join(tempRoot, 'ext-sessions', 'abc-123')
  let fileCount = 0
  for (let i = 0; i < L1_DIRS; i++) {
    const l1 = join(root, `domain-${i}`)
    for (let j = 0; j < L2_DIRS_PER_L1; j++) {
      const l2 = join(l1, `item-${j}`)
      mkdirSync(l2, { recursive: true })
      for (let k = 0; k < FILES_PER_L2; k++) {
        writeFileSync(join(l2, `f-${k}.bin`), `payload-${i}-${j}-${k}`)
        fileCount++
      }
    }
  }
  expect(fileCount).toBe(L1_DIRS * L2_DIRS_PER_L1 * FILES_PER_L2)
  return root
}

describe('trashDirectory 非 mac 降级递归删（真实 fs）', () => {
  it('多层嵌套树整树递归删：删净深处文件、零子进程', async () => {
    const treeRoot = buildSessionTree()
    const deepFile = join(treeRoot, 'domain-0', 'item-0', 'f-0.bin')
    // 前提自证：删前树与深处文件真实存在
    expect(existsSync(treeRoot)).toBe(true)
    expect(existsSync(deepFile)).toBe(true)

    await trashDirectory(treeRoot)

    // 整树删净：树根与深处文件均不存在
    expect(existsSync(treeRoot)).toBe(false)
    expect(existsSync(deepFile)).toBe(false)
    // 非 mac 降级分支零子进程（不触 mac 通道）
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('路径不存在：原生 ENOENT 上抛不吞（与既有单文件 unlinkSync 失败语义一致）', async () => {
    const missing = join(tempRoot, 'ext-sessions', 'not-exist-sid')
    await expect(trashDirectory(missing)).rejects.toThrow(/ENOENT/)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })
})
