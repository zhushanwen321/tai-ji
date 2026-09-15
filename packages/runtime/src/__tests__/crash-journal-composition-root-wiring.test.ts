/**
 * runtime 台账组合根接线测试（u-init 收口，crash-forensics-and-watchdog D1）。
 *
 * 缺口背景：initCrashJournal 此前只在 main 侧（apps/electron/main/main.ts）被调用，
 * runtime 组合根零调用——真实 app 中 `<dataDir>/logs/crashes/runtime.jsonl` 永不创建，
 * u1b/u1d1/u1d2/u1e 的全部 runtime 侧事件（pi-respawn 四态 / frame-truncated /
 * registry-miss / session 生命周期）经 getCrashJournal() 落到 no-op writer 被静默丢弃。
 * 单元测试各自显式 init（测试自建单例）掩盖了这条组合根接线缺失。
 *
 * 两层断言：
 * 1. 组合根接线（源码级）——index.ts 必须 import 并在 main() 内调用 initCrashJournal，
 *    位置对齐既有 initLogger（先于 service 构造，任何 append 之前）。index.ts import 即
 *    执行 main()，无法直测，源码级守卫沿用既有先例（crash-forensics-logger.test.ts
 *    「源码硬保证」段）。
 * 2. 行为断言——init 后 getCrashJournal() 从 no-op 切为真实 writer（crashes 目录创建 +
 *    append 落盘可读），未 init 时 no-op 不落任何文件。方向与生产一致：启动期 init →
 *    后续事件的 append 才真正可见。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/crash-journal-composition-root-wiring.test.ts
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeCrashJournal, getCrashJournal, initCrashJournal } from '../infra/crash-journal.js'

const createdDirs: string[] = []

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crash-journal-root-wiring-'))
  createdDirs.push(dir)
  return dir
}

afterEach(async () => {
  await closeCrashJournal() // 单例复位（??= 幂等语义；下个用例可指向新 tmpdir）
})

afterAll(() => {
  // maxRetries+retryDelay（crash-journal.test.ts 同款）：teardown 与在途异步写竞争吞瞬态
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('runtime 组合根初始化台账单例（u-init）', () => {
  it('index.ts import 并在 main() 内调用 initCrashJournal(getDataDir(), logger)（对齐 initLogger 时序 + 留痕出口注入）', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

    // 接线存在性：import 单例 init + 在组合根调用（唯一生产调用点；main 侧另有双胞胎）。
    // import 行随 #31 扩为多导出（closeCrashJournal 进 shutdown 序）——断言改为对 init
    // 符号的 import 存在性（防字面量与导出清单耦合），close 接线由 shutdown 序测试守卫。
    expect(source).toMatch(/import\s*\{[^}]*initCrashJournal[^}]*\}\s*from\s*'\.\/infra\/crash-journal\.js'/)
    expect(source).toContain('initCrashJournal(getDataDir(), logger)')

    // 时序：initLogger 之后（initLogger 已验证 getDataDir() 可用）、token 解析 / service
    // 构造之前（任何一个 service 都可能 append 台账，晚于其构造 = 早期事件静默丢）
    const initLoggerIdx = source.indexOf('initLogger(getDataDir())')
    const initJournalIdx = source.indexOf('initCrashJournal(getDataDir(), logger)')
    const tokenIdx = source.indexOf('const runtimeToken = resolveRuntimeToken()')
    const serviceIdx = source.indexOf('const pm = new ProcessManager(')
    expect(initLoggerIdx).toBeGreaterThan(-1)
    expect(tokenIdx).toBeGreaterThan(-1)
    expect(serviceIdx).toBeGreaterThan(-1)
    expect(initJournalIdx).toBeGreaterThan(initLoggerIdx)
    expect(initJournalIdx).toBeLessThan(tokenIdx)
    expect(initJournalIdx).toBeLessThan(serviceIdx)
  })

  it('init 前 getCrashJournal() 为 no-op：append 不落盘、crashes 目录不创建（未初始化契约）', () => {
    const dir = makeDataDir()
    expect(() =>
      getCrashJournal().append({ layer: 'runtime', event: 'crash', detailDigest: 'pre-init' }),
    ).not.toThrow()
    expect(existsSync(join(dir, 'logs', 'crashes'))).toBe(false)
  })

  it('init 后 getCrashJournal() 非 no-op：事件真实落 <dataDir>/logs/crashes/runtime.jsonl（生产链路接通）', async () => {
    const dir = makeDataDir()
    initCrashJournal(dir)

    // 组合根初始化后，runtime 侧事件经同一单例可见（pi-respawn / 守卫 / 生命周期共用）
    getCrashJournal().append({
      layer: 'pi',
      event: 'auto-respawn',
      reason: 'scheduled',
      sessionId: 's1',
      detailDigest: 'attempt=1 delayMs=5000',
    })
    await closeCrashJournal()

    const journal = join(dir, 'logs', 'crashes', 'runtime.jsonl')
    expect(existsSync(journal)).toBe(true)
    const rows = readFileSync(journal, 'utf8').split('\n').filter((l) => l !== '')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!)).toMatchObject({
      layer: 'pi',
      event: 'auto-respawn',
      reason: 'scheduled',
      sessionId: 's1',
    })
  })
})
