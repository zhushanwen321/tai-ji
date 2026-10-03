/**
 * 崩溃台账接线测试共用装置（*.journal.test.ts 两处共享的克隆块提取位）：
 * mkdtemp 数据目录生命周期挂接（beforeEach 建 / afterAll 批量清）+ 活跃档台账读取。
 *
 * 在 describe 顶层（或模块顶层）调用一次即可——vitest 允许在收集期注册钩子；
 * dataDir 经 getDataDir() 在用例内取值（beforeEach 已重建）。
 *
 * 仅服务测试（src/__tests__/ 及各域 journal 直测），不入生产 bundle。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach } from 'vitest'

/** JSONL 文本 → 行对象数组（空行丢弃）。独立小函数：打散与各用例内联读档块的克隆面。 */
function parseJsonlLines(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter(l => l !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

export function setupCrashJournalHarness(tmpPrefix: string): {
  /** 当前用例的 mkdtemp 数据目录（beforeEach 重建，fs-guard 白名单内自建自删）。 */
  getDataDir(): string
  /** 读台账活跃档全部行（不存在 = 零事件）。 */
  readJournalRecords(): Array<Record<string, unknown>>
} {
  let dataDir = ''
  const createdDirs: string[] = []

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), tmpPrefix))
    createdDirs.push(dataDir)
  })

  afterAll(() => {
    // maxRetries+retryDelay（教训 d9ad39cb8）：teardown 递归删除与在途异步写竞争的
    // ENOTEMPTY 瞬态重试（pre-commit flake 卫生检查硬要求）。forEach 形态避免与各用例
    // 内联同型 teardown 块构成克隆（共享装置的存在正是为了消除重复）。
    createdDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  })

  return {
    getDataDir: () => dataDir,
    /** 读台账活跃档全部行（不存在 = 零事件）。 */
    readJournalRecords: (): Array<Record<string, unknown>> => {
      const p = join(dataDir, 'logs', 'crashes', 'runtime.jsonl')
      return existsSync(p) ? parseJsonlLines(readFileSync(p, 'utf8')) : []
    },
  }
}
