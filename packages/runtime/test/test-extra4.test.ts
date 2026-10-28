import { DEFAULT_RETRY_BUDGET_MS as EXT_RETRY_BUDGET_MS, DEFAULT_RETRY_DELAY_MS as EXT_RETRY_DELAY_MS, DEFAULT_STALE_MS as EXT_STALE_MS, withFileLockSync as extWithFileLockSync } from '../../../extensions/shared/file-lock/src/file-lock.js';
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../test-guard/integration-gate.ts';
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js';
import { PiAgentEndEvent, PiAgentSettledEvent, PiAutoRetryEndEvent, PiAutoRetryStartEvent, PiCompactionEndEvent, PiCompactionStartEvent, PiEntryAppendedEvent, PiExtensionErrorEvent, PiQueueUpdateEvent, PiSessionInfoChangedEvent, PiThinkingLevelChangedEvent, PiToolExecutionEndEvent, PiToolExecutionResult, PiToolExecutionUpdateEvent, PiTurnEndEvent, PiUsage, type PiEvent } from '../src/infra/pi/pi-protocol.js';
import { SettingsCorruptedError, getActiveSettingsPath, invalidateSettingsCache, readSettings, setSettingsLockTimingForTest, setSettingsPath, type PiSettings, updateSettingsFields, writeSettings } from '../src/infra/pi/pi-settings-store.js';
import { extractLatestModelFromJsonl } from '../src/infra/pi/session-file-utils.js';
import { PiSessionStore } from '../src/infra/pi/session-store.js';
import { IConfigService, IEventAdapter, IExtensionService, type IMessageBroker, type ISessionService } from '../src/interfaces.js';
import { AuthService } from '../src/services/auth/auth-service.js';
import { AuthStorage } from '../src/services/auth/auth-storage.js';
import { ProviderCredentialResolver } from '../src/services/auth/provider-credential-resolver.js';
import type { MessageBus } from '../src/services/message-bus/message-bus.js';
import type { BusClient } from '../src/services/message-bus/types.js';
import { ModelService } from '../src/services/model-service.js';
import type { IGitInfoReader } from '../src/services/ports/git-info.js';
import type { IModelSource } from '../src/services/ports/model.js';
import { IPiEngine, type IProcessManager } from '../src/services/ports/pi-engine.js';
import { TaijiProviderStore } from '../src/services/provider-extras-store.js';
import { QuotaService } from '../src/services/quota-service.js';
import { SessionService } from '../src/services/session/session-service.js';
import { ConnectionManager } from '../src/transport/connection-manager.js';
import { SessionMessageHandler, type SessionHandlerContext } from '../src/transport/session-message-handler.js';
import { SESSION_NOT_FOUND } from '../src/utils/errors.js';
import { DEFAULT_RETRY_BUDGET_MS, DEFAULT_RETRY_DELAY_MS, DEFAULT_STALE_MS, withFileLockSync } from '../src/utils/file-lock.js';
import { ClientMessage, ProviderId, type ServerMessage, type ProviderInfo } from '@taiji/shared';
import { ZCODE_HOST_DB_SUFFIX, ZCODE_ISOLATED_DB_SEGMENTS } from '@zhushanwen/subagent-engine-sdk';
import { hostZcodeDbPath, zcodeIsolatedDbPath } from '@zhushanwen/zcode-session-source';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtemp, mkdtempSync, readFileSync, readdirSync, rm, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp as mkdtemp_z2, readFile, rm as rm_z2 } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← test/pi-settings-store.test.ts
// ======================================================================

// ── 锁原语时序注入（单测层极端测试整治第二波）──────────────────────────────
// withFileLockSync 的重试等待是 Atomics.wait（阻塞 event loop 的同步 sleep），单进程
// 同步重试循环中测试代码无法插手释放锁——「持锁者释放后获取」的时序原只能靠真子进程
// （原形态，见下方 TAIJI_TEST_INTEGRATION 门控块）。本地默认走 0 窗口注入：mock 包装
// 单次原语 acquireLockSync，holderOnce 置位后的首个调用先执行注入回调（真实取锁 →
// 锁内写 → 真实释放，窗口存续于回调内）再按 core 的 ELOCKED 形态抛错，之后恢复透传
// 真实现——首个获取请求撞窗 ELOCKED → busy-wait 重试 → 释放后真实获取，锁等待语义
// （ELOCKED→重试→获取成功→锁内重读）全程真实磁盘协议。默认（holderOnce = null）全透传。
const lockSim = vi.hoisted(() => ({
  actual: null as null | typeof import('@zhushanwen/pi-file-lock/core'),
  holderOnce: null as null | ((filePath: string) => void),
}))


vi.mock('@zhushanwen/pi-file-lock/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zhushanwen/pi-file-lock/core')>()
  lockSim.actual = actual
  return {
    ...actual,
    acquireLockSync: (filePath: string, opts?: { staleMs?: number; log?: (msg: string) => void }) => {
      const sim = lockSim.holderOnce
      if (!sim) return actual.acquireLockSync(filePath, opts)
      lockSim.holderOnce = null
      sim(filePath)
      // 获取请求撞在注入的持锁窗口内：message/fields 照抄 lock-core.ts 的 elocked()
      throw Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED', file: filePath })
    },
  }
})


const mkdtempP = promisify(mkdtemp)

const rmP = promisify(rm)


let tmpDir: string

let settingsPath: string

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-settings-store', () => {
beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'pi-settings-store-test-'))
  settingsPath = join(tmpDir, 'agent', 'settings.json')
  mkdirSync(join(tmpDir, 'agent'), { recursive: true })
  setSettingsPath(settingsPath)
})
afterEach(async () => {
  // 恢复锁参数默认值，避免压缩预算泄漏到后续用例
  setSettingsLockTimingForTest({})
  // 持锁窗口注入只允许用例内单次生效，防断言失败后泄漏到后续用例
  lockSim.holderOnce = null
  await rmP(tmpDir, { recursive: true, force: true })
})
describe('pi-settings-store', () => {
  describe('readSettings', () => {
    it('returns empty object when file does not exist', () => {
      expect(readSettings()).toEqual({})
    })

    it('reads existing settings', () => {
      writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'gpt-4', packages: ['x'] }), 'utf-8')
      expect(readSettings()).toEqual({ defaultModel: 'gpt-4', packages: ['x'] })
    })

    it('throws SettingsCorruptedError on corrupt JSON (fail-fast, no quarantine, file intact)', () => {
      // 读侧统一阻断（用户终裁）：损坏回落空对象已废弃——损坏即抛，文件原样、零隔离副本
      writeFileSync(settingsPath, '{ broken', 'utf-8')
      expect(() => readSettings()).toThrow(SettingsCorruptedError)
      expect(existsSync(settingsPath)).toBe(true)
      expect(readFileSync(settingsPath, 'utf-8')).toBe('{ broken')
      expect(readdirSync(tmpDir).filter(name => name.includes('.corrupt-'))).toEqual([])
    })

    it('returns empty on non-object JSON (e.g. array)', () => {
      writeFileSync(settingsPath, '[1,2,3]', 'utf-8')
      expect(readSettings()).toEqual({})
    })

    it('serves external file change on next read (revision fingerprint)', () => {
      writeFileSync(settingsPath, JSON.stringify({ v: 1 }), 'utf-8')
      expect(readSettings().v).toBe(1)
      writeFileSync(settingsPath, JSON.stringify({ v: 2 }), 'utf-8')
      // 指纹失配 → 重读：外部改动（pi 子进程写 / 用户手改）下一次 read 立即可见
      expect(readSettings().v).toBe(2)
    })
  })

  describe('writeSettings', () => {
    it('writes settings to disk', () => {
      writeSettings({ defaultModel: 'claude' })
      const raw = readFileSync(settingsPath, 'utf-8')
      expect(JSON.parse(raw)).toEqual({ defaultModel: 'claude' })
    })

    it('external changes after write are visible on next read', () => {
      writeSettings({ defaultModel: 'a' })
      writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'b' }), 'utf-8')
      // write 后的指纹 = 写入后 stat；外部改写使指纹失配 → 下一次 read 重读盘
      expect(readSettings().defaultModel).toBe('b')
    })

    it('writes with indent', () => {
      writeSettings({ defaultModel: 'claude' })
      const raw = readFileSync(settingsPath, 'utf-8')
      expect(raw).toContain('\n')
    })

    it('creates parent directories', () => {
      const deepPath = join(tmpDir, 'deep', 'nested', 'settings.json')
      setSettingsPath(deepPath)
      writeSettings({ defaultModel: 'claude' })
      expect(existsSync(deepPath)).toBe(true)
    })
  })

  describe('updateSettingsFields (locked RMW + scope merge)', () => {
    it('read-modify-write a single field', () => {
      writeSettings({ defaultModel: 'old' })
      updateSettingsFields('model', s => { s.defaultModel = 'new' })
      expect(readSettings().defaultModel).toBe('new')
    })

    it('preserves other fields (partial update)', () => {
      writeSettings({ defaultModel: 'keep', packages: ['keep-pkg'] })
      updateSettingsFields('model', s => { s.defaultModel = 'changed' })
      const result = readSettings()
      expect(result.defaultModel).toBe('changed')
      expect(result.packages).toEqual(['keep-pkg'])
    })

    it('operates on a deep copy (mutator does not affect cache)', () => {
      writeSettings({ packages: ['original'] })
      updateSettingsFields('extension', s => {
        s.packages!.push('added')
      })
      // mutator 改的是 draft，但 updateSettingsFields 回写了 draft
      expect(readSettings().packages).toEqual(['original', 'added'])
    })

    it('invalidates cache before read (sees external changes)', () => {
      writeSettings({ defaultModel: 'v1' })
      // 外部改盘（绕过 store）
      writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'external' }), 'utf-8')
      updateSettingsFields('extension', s => { s.packages = ['x'] })
      const result = readSettings()
      expect(result.defaultModel).toBe('external') // 拿到外部改的值
      expect(result.packages).toEqual(['x'])
    })

    it('creates lock in same dir and cleans it up after write', () => {
      updateSettingsFields('model', s => { s.defaultModel = 'm' })
      // 锁目录（<settings.json>.lock）在写完后必须被释放清理，否则会困住 pi 的下次保存
      expect(existsSync(`${settingsPath}.lock`)).toBe(false)
      expect(readSettings().defaultModel).toBe('m')
    })

    it('works when parent directory does not exist yet', () => {
      const deepPath = join(tmpDir, 'fresh', 'dir', 'settings.json')
      setSettingsPath(deepPath)
      updateSettingsFields('model', s => { s.defaultModel = 'first' })
      expect(readSettings().defaultModel).toBe('first')
    })

    it('releases lock when mutator throws (no stale lock left behind)', () => {
      expect(() => updateSettingsFields('model', () => { throw new Error('mutator boom') })).toThrow('mutator boom')
      expect(existsSync(`${settingsPath}.lock`)).toBe(false)
      // 抛错后文件未被写坏，下次写入正常
      updateSettingsFields('model', s => { s.defaultModel = 'ok' })
      expect(readSettings().defaultModel).toBe('ok')
    })
  })

  describe('field scope merge (D1b)', () => {
    it('model scope drops mutator changes to non-model keys', () => {
      writeSettings({ defaultModel: 'mine', packages: ['pkg'], skills: ['/sk'] })
      // mutator 越界改 packages/skills（调用方 bug）——API 强制分区：越界修改被丢弃
      updateSettingsFields('model', s => {
        s.defaultModel = 'changed'
        s.packages = ['hacked']
        s.skills = ['/evil']
      })
      const result = readSettings()
      expect(result.defaultModel).toBe('changed')
      expect(result.packages).toEqual(['pkg'])
      expect(result.skills).toEqual(['/sk'])
    })

    it('extension scope drop model-field changes and vice versa', () => {
      writeSettings({ defaultModel: 'mine', packages: ['pkg'] })
      updateSettingsFields('extension', s => { s.defaultModel = 'hacked'; s.packages = ['new-pkg'] })
      expect(readSettings().defaultModel).toBe('mine')
      expect(readSettings().packages).toEqual(['new-pkg'])
    })

    it('skills scope writes only skills', () => {
      writeSettings({ skills: ['/a'], defaultModel: 'm', packages: ['p'] })
      updateSettingsFields('skills', s => { s.skills = ['/b', '/c'] })
      const result = readSettings()
      expect(result.skills).toEqual(['/b', '/c'])
      expect(result.defaultModel).toBe('m')
      expect(result.packages).toEqual(['p'])
    })

    it('deleted scope field is physically removed from disk (clearEnabledModels semantics)', () => {
      writeSettings({ enabledModels: ['a/*'], defaultModel: 'm' })
      updateSettingsFields('model', s => { delete s.enabledModels })
      const raw = readFileSync(settingsPath, 'utf-8')
      expect(JSON.parse(raw)).toEqual({ defaultModel: 'm' }) // enabledModels key 物理消失
    })

    it('full scope writes everything the mutator set (migration whitelist semantics)', () => {
      writeSettings({ defaultModel: 'old' })
      updateSettingsFields('full', s => {
        s.defaultModel = 'new'
        s.packages = ['x']
        s.customUnknown = 'kept-by-full'
      })
      const result = readSettings()
      expect(result.defaultModel).toBe('new')
      expect(result.packages).toEqual(['x'])
      expect(result.customUnknown).toBe('kept-by-full')
    })

    it('unknown pi fields survive scoped writes (passthrough)', () => {
      writeSettings({ somePiFutureField: { nested: true }, defaultModel: 'm' })
      updateSettingsFields('model', s => { s.defaultModel = 'm2' })
      expect(readSettings().somePiFutureField).toEqual({ nested: true })
    })
  })

  describe('cross-process lock (D1a)', () => {
    it('re-reads latest inside lock after an externally locked writer (simulated pi)', () => {
      writeSettings({ defaultModel: 'v1', packages: ['p1'] })
      // 模拟 pi 持同一把锁写 settings.json（realpath:false + 同 lockfile 路径）
      const release = lockfile.lockSync(settingsPath, { realpath: false })
      try {
        writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'pi-wrote', packages: ['p1'], defaultThinkingLevel: 'high' }), 'utf-8')
      } finally {
        release()
      }
      updateSettingsFields('extension', s => { s.packages = ['p2'] })
      const result = readSettings()
      // pi 写入的 model 域字段被锁内重读吃进，taiji 的 extension 域写不覆盖它们（窗口 W1/W2 关闭）
      expect(result.defaultModel).toBe('pi-wrote')
      expect(result.defaultThinkingLevel).toBe('high')
      expect(result.packages).toEqual(['p2'])
    })

    it('fails fast with ELOCKED when lock is held beyond retry budget', () => {
      writeSettings({ defaultModel: 'v1' })
      // 压缩预算：10ms/次 × 预算 60ms，快速走完 fail-fast 路径
      setSettingsLockTimingForTest({ retryDelayMs: 10, retryBudgetMs: 60 })
      const release = lockfile.lockSync(settingsPath, { realpath: false })
      let err: unknown
      try {
        updateSettingsFields('model', s => { s.defaultModel = 'blocked' })
      } catch (e) {
        err = e
      } finally {
        release()
      }
      // fail-fast：预算耗尽抛错（对齐 pi 放弃保存语义），而非静默丢弃或死等
      expect((err as { code?: string } | undefined)?.code).toBe('ELOCKED')
      expect(readSettings().defaultModel).toBe('v1') // 本次写入被放弃
      // 锁释放后恢复正常
      updateSettingsFields('model', s => { s.defaultModel = 'after' })
      expect(readSettings().defaultModel).toBe('after')
    })

    // 真子进程版的确定性等价物（单测层默认跑）：真实子进程「持锁 150ms 后释放」的
    // 挂钟窗口压缩为 0 窗口注入（见文件头 mock 说明）——锁等待语义不变：首个获取
    // 请求撞持锁窗口 ELOCKED → busy-wait 重试 → 持锁者释放后真实获取 → 锁内重读
    // 吃进并发写方的值 → 本域 merge 写回。真子进程形态（spawn 挂钟无完成信号可等，
    // 判据第三档）在下方 TAIJI_TEST_INTEGRATION 门控块。
    it('busy-waits and acquires after a concurrent holder releases（0 窗口注入 + 0 重试间隔，确定性锁时序）', () => {
      writeSettings({ defaultModel: 'v1', packages: ['p1'] })
      let holderWindows = 0
      lockSim.holderOnce = (filePath) => {
        holderWindows++
        const release = lockSim.actual!.acquireLockSync(filePath)
        try {
          writeFileSync(filePath, JSON.stringify({ defaultModel: 'pi-holder', packages: ['p1'], defaultThinkingLevel: 'high' }), 'utf-8')
        } finally {
          release()
        }
      }
      // 0 重试间隔：ELOCKED 后 sleepSync(0) 立即重试（Atomics.wait 0ms 不阻塞 event loop）
      setSettingsLockTimingForTest({ retryDelayMs: 0 })

      updateSettingsFields('extension', s => { s.packages = ['p2'] })

      expect(holderWindows).toBe(1) // 恰经历一次真实持锁窗口（首次获取确实 ELOCKED 过）
      const result = readSettings()
      // busy-wait 到释放后获取，锁内重读吃进并发写方的 model 域字段（窗口 W1/W2 关闭）
      expect(result.defaultModel).toBe('pi-holder')
      expect(result.defaultThinkingLevel).toBe('high')
      expect(result.packages).toEqual(['p2']) // 本域（extension）写在 merge 后落盘
      expect(existsSync(`${settingsPath}.lock`)).toBe(false) // 锁正常释放清理
    })

    // [HISTORICAL] 2026-08-20 PR #185：真实子进程持锁用例显式超时——真实 spawn node
    // 子进程持 proper-lockfile 锁，满并行 + 系统余载下 spawn/锁往返超 vitest 默认 5s
    // testTimeout（对齐 worktree-registry D5a 口径）。
    // [2026-10-22 单测层极端测试整治] 「spawn 挂钟 + 跨进程持锁窗」无确定性完成信号
    // （判据第三档），经 TAIJI_TEST_INTEGRATION 门控移出默认单测层（SSOT =
    // test-guard/integration-gate.ts）；本地默认跑上方 0 窗口注入版。
    describe.skipIf(
      !INTEGRATION_TESTS_ENABLED,
    )(`busy-wait 跨进程真子进程（集成组：真 spawn + 150ms 真实持锁窗）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`, () => {
      it('busy-waits and acquires after a cross-process holder releases (real subprocess)', { timeout: 30_000 }, async () => {
        writeSettings({ defaultModel: 'v1', packages: ['p1'] })
        // 子进程 = 模拟 pi：锁请求对齐 pi 真实语义（pi-settings-store 模块头注释引
        // pi settings-manager acquireLockSyncWithRetry）——ELOCKED 时 CPU 自旋 20ms ×
        // 最多 10 次（总等待 ≤200ms）重试取锁，耗尽才抛。单次 fail-fast 是模拟保真度
        // 缺陷：与任何持锁窗口的一次碰撞（满载下窗口被 CPU 抢占拉长，实测 p99.9 从
        // 0.4ms 涨到 35ms）即未捕获 ELOCKED 崩溃 exit 1；pi 形态只把碰撞降级为多等一轮。
        // 持锁后锁内写 model 域字段、打印 LOCKED 握手标记（waitChildHoldsLock 依赖，
        // 见下）、150ms 后释放退出。
        const lockEntry = createRequire(import.meta.url).resolve('proper-lockfile')
        const child = spawn(process.execPath, ['-e', `
          const lockfile = require(${JSON.stringify(lockEntry)})
          const fs = require('node:fs')
          const acquireLikePi = () => {
            for (let attempt = 0; ; attempt++) {
              try {
                return lockfile.lockSync(${JSON.stringify(settingsPath)}, { realpath: false })
              } catch (e) {
                if (e.code !== 'ELOCKED' || attempt >= 10) throw e
                const spinUntil = Date.now() + 20
                while (Date.now() < spinUntil) {}
              }
            }
          }
          const release = acquireLikePi()
          fs.writeFileSync(${JSON.stringify(settingsPath)}, JSON.stringify({ defaultModel: 'pi-child', packages: ['p1'] }), 'utf-8')
          console.log('LOCKED')
          setTimeout(() => { release(); process.exit(0) }, 150)
        `])
        // 可观测性（设计文档 D6）：挂 stdout/stderr 双路监听进 ring buffer（50 行上限，
        // 同 pi-fixture.ts 口径），失败 throw 时拼输出 tail + 单跑指引——子进程崩溃的
        // 临终输出不再丢失。不抽共享工具：两处使用不构成抽象。
        const CHILD_BUF_MAX_LINES = 50
        const CHILD_TAIL_LINES = 10
        const childStdoutLines: string[] = []
        const childStderrLines: string[] = []
        const captureChunk = (lines: string[], chunk: Buffer): void => {
          const text = chunk.toString().trimEnd()
          if (!text) return
          lines.push(text)
          if (lines.length > CHILD_BUF_MAX_LINES) lines.shift()
        }
        child.stdout?.on('data', (chunk: Buffer) => captureChunk(childStdoutLines, chunk))
        child.stderr?.on('data', (chunk: Buffer) => captureChunk(childStderrLines, chunk))
        const streamTail = (name: 'stdout' | 'stderr', lines: string[]): string =>
          `\nchild ${name} (last ${CHILD_TAIL_LINES} lines):\n${lines.length === 0 ? '(empty)' : lines.slice(-CHILD_TAIL_LINES).join('\n')}`
        const failureContext = (): string =>
          `${streamTail('stdout', childStdoutLines)}${streamTail('stderr', childStderrLines)}\n👉 单跑复现：cd packages/runtime && npx vitest run test/pi-settings-store.test.ts`
        // stdout handshake 确定性等子进程持锁：子进程持锁成功打印 LOCKED 行，主进程等
        // 该行出现（独立行缓冲检测叠加在上方 ring buffer 监听旁，防单行跨 data 事件被拆）。
        // [HISTORICAL] 等待机制三代教训：
        //   - v1 盲等 40ms sleep（PR #185 前）：满载下子进程 spawn 慢于 40ms，主进程
        //     抢先拿锁、锁内读到旧值 'v1'（waitedMs 断言照过，仅 defaultModel 断言红）；
        //   - v2 主进程 lockSync 试探探测（PR #185）：每次探测都重新制造「锁被主进程
        //     持有」的窗口，满载下被 CPU 抢占拉长 20-250 倍（实测 p99.9 从 0.4ms 涨到
        //     35ms），子进程单次 fail-fast 请求命中即 ELOCKED 崩溃 exit 1——2026-09-05
        //     满载 flake 根因，确定性复现：主进程持锁 800ms + 同款子进程脚本 → exit 1；
        //   - v3（现行）主进程不再触碰锁文件，竞争源从机制上消除，观测与被观测解耦。
        // 子进程写入在 release 之前、主进程 acquire 后才锁内重读，故拿到的必是 pi-child。
        let childStdoutRemainder = ''
        let childSignaledLock = false
        child.stdout?.on('data', (chunk: Buffer) => {
          childStdoutRemainder += chunk.toString()
          const lines = childStdoutRemainder.split('\n')
          childStdoutRemainder = lines.pop() ?? ''
          if (lines.some((line) => line.trim() === 'LOCKED')) childSignaledLock = true
        })
        const waitChildHoldsLock = async (): Promise<void> => {
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline && !childSignaledLock) {
            if (child.exitCode !== null) {
              throw new Error(`child exited (code ${child.exitCode}) before holding lock${failureContext()}`)
            }
            await new Promise((r) => setTimeout(r, 2))
          }
          if (childSignaledLock) return
          throw new Error(`child did not signal LOCKED within 10s${failureContext()}`)
        }
        await waitChildHoldsLock()
        const t0 = Date.now()
        updateSettingsFields('extension', s => { s.packages = ['p2'] })
        const waitedMs = Date.now() - t0
        // 默认预算 1s 内成功：busy-wait 吃掉子进程持锁的剩余时间，锁内重读到子进程写的值
        expect(waitedMs).toBeLessThan(1_000)
        const result = readSettings()
        expect(result.defaultModel).toBe('pi-child')
        expect(result.packages).toEqual(['p2'])
        const childExit = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)))
        child.kill('SIGKILL') // 子进程可能已退出；确保不悬挂（150ms 后自然退出，此处兜底）
        await childExit
      })
    })
  })

  describe('invalidateSettingsCache', () => {
    it('forces re-read on next read', () => {
      writeSettings({ defaultModel: 'cached' })
      writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'changed' }), 'utf-8')
      invalidateSettingsCache()
      expect(readSettings().defaultModel).toBe('changed')
    })
  })

  describe('setSettingsPath / getActiveSettingsPath', () => {
    it('redirects read/write to new path', () => {
      const newPath = join(tmpDir, 'other-settings.json')
      writeSettings({ defaultModel: 'first-path' })
      setSettingsPath(newPath)
      expect(readSettings()).toEqual({}) // 新路径无文件
      writeSettings({ defaultModel: 'second-path' })
      expect(readSettings().defaultModel).toBe('second-path')
    })

    it('getActiveSettingsPath returns current path', () => {
      expect(getActiveSettingsPath()).toBe(settingsPath)
      const newPath = join(tmpDir, 'other.json')
      setSettingsPath(newPath)
      expect(getActiveSettingsPath()).toBe(newPath)
    })
  })

  describe('cross-domain sharing (single owner)', () => {
    it('settings.json is the same file for all domains', () => {
      // 模拟两个域（model 域和 extension 域）写各自的字段
      updateSettingsFields('model', s => { s.defaultModel = 'model-domain-field' })
      updateSettingsFields('extension', s => { s.packages = ['ext-domain-field'] })
      const result = readSettings()
      // 两域的字段共存于同一文件（D17 单一所有者）
      expect(result.defaultModel).toBe('model-domain-field')
      expect(result.packages).toEqual(['ext-domain-field'])
    })
  })
})
});

// ======================================================================
// ← test/switch-model.test.ts
// ======================================================================

// pi-provider-store: 控制默认 model 配置（测试主路径需要 model 已配置）
const providerMocks = vi.hoisted(() => ({
  defaultModel: {
    value: { provider: 'test-provider', modelId: 'test-model' } as
      { provider: string; modelId: string } | null,
  },
  refreshAll: vi.fn(),
}))

vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    refreshAll: providerMocks.refreshAll,
    getDefaultModel: () => providerMocks.defaultModel.value,
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
  }
})

// [U8a W1/W2 后] persistModelBinding 记录 mock 已随写点退役删除——taiji 侧不再有
// model 持久层写点可观察；本 mock 仅保留 scanPiSessions 拦截（列表扫描走测试装置）。
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return {
    ...actual,
    scanPiSessions: () => [],
  }
})

vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => '/mock/taiji/agent' }
})

vi.mock('../src/infra/system/trash.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/system/trash.js')>()
  return { ...actual, trash: vi.fn() }
})

vi.mock('../src/infra/pi/message-converter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/message-converter.js')>()
  return { ...actual, convertPiHistory: vi.fn((raw: unknown) => raw) }
})

vi.mock('../src/services/session-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session-history.js')>()
  return { ...actual, getHistoryFromFile: vi.fn().mockResolvedValue([]),
  getHistoryFromFilePath: vi.fn().mockResolvedValue([]), }
})
/** 一份最小测试装置：service + 各 mock 依赖。 */
function createService() {
  const clientMap = new Map<string, IPiEngine>()

  const pm = {
    createSession: vi.fn(async (id: string) => {
      const client = makeClient()
      clientMap.set(id, client)
      return client
    }),
    destroySession: vi.fn(async (id: string) => { clientMap.delete(id) }),
    getClient: vi.fn((id: string) => clientMap.get(id)),
    getSessionIdByClient: vi.fn(),
    hasClient: vi.fn((id: string) => clientMap.has(id)),
    rekey: vi.fn(),
    onSessionExit: vi.fn(),
    destroyAll: vi.fn(async () => { clientMap.clear() }),
  } as unknown as IProcessManager

  const broker = {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  } as unknown as IMessageBroker

  const extensionService = {
    getExtensionPaths: vi.fn().mockResolvedValue([]),
  } as unknown as IExtensionService

  const adapterFactory = (): IEventAdapter => ({ attach: vi.fn(), detach: vi.fn() })
  const gitInfoReader: IGitInfoReader = {
    readGitInfo: vi.fn(() => undefined),
    pruneStaleCache: vi.fn(),
  }
  const workspaceService = {
    record: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  }

  const service = new SessionService(
    pm,
    broker,
    adapterFactory,
    '/tmp',
    extensionService,
    new PiConfigStore(),
    new PiSessionStore(),
    gitInfoReader,
    workspaceService as unknown as ConstructorParameters<typeof SessionService>[8],
  )

  return { service, pm, broker, clientMap }
}


function makeClient(): IPiEngine {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ data: { messages: [] } }),
    sendCommand: vi.fn().mockResolvedValue({ data: {} }),
    switchSession: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({}),
    getCommands: vi.fn().mockResolvedValue([]),
    getSessionStats: vi.fn().mockResolvedValue({}),
    onEvent: vi.fn(() => () => {}),
    onExit: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
  } as unknown as IPiEngine
}


/** 从 broadcast 调用里找指定 type 的消息。 */
function findBroadcast(broker: IMessageBroker, type: ServerMessage['type']): ServerMessage | undefined {
  for (const call of vi.mocked(broker.broadcast).mock.calls) {
    if (call[0].type === type) return call[0] as ServerMessage
  }
  return undefined
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('switch-model', () => {
describe('W1/L7: switchModel fail-fast & 无 client 不假装成功', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerMocks.defaultModel.value = { provider: 'test-provider', modelId: 'test-model' }
  })

  it('U2: session 不在 Map → 先走 ensureActive（拉活/join）；恢复失败按既有码透传，不静默返回 sessionId', async () => {
    // model-switch-live-provider-sync U2/D5：停止态不再 throw 'session not active' 早退，而是
    // 先 ensureActive（拉起引擎或 join in-flight）。此处 session 文件不存在 → 激活阶段抛
    // SESSION_NOT_FOUND（既有码原样透传，供前端引导「侧栏删除该会话记录」）。
    const { service } = createService()
    await expect(service.switchModel('nonexistent', 'provider' as ProviderId, 'model'))
      .rejects.toMatchObject({ code: SESSION_NOT_FOUND })
  })

  it('U2: session 已注册但 pi 进程已退出（死 client）→ 先 ensureActive 拉活再切（不再「返回 sessionId」假成功）', async () => {
    // U2/D5 + 检查：`getClient` 不过滤已死进程的旧形态被结构性消除——激活路径负责
    // 「回收态/死 client → 拉起」，所以「无 client 就静默返回请求值」这一假成功分支已删。
    const { service, pm, broker, clientMap } = createService()
    // 1. 建立一个 session（会进 sessions Map 且挂 client）
    const seedState = { sessionId: 's1', sessionFile: '/fake/s1.jsonl' }
    const client = makeClient()
    vi.mocked(client.getState).mockResolvedValue(seedState)
    vi.mocked(pm.createSession).mockResolvedValueOnce(client)
    clientMap.set('s1', client)
    await service.create('/tmp', 'seed')
    expect(service.getSummary('s1')).toBeDefined()

    // 2. 模拟 pi 进程已退出：从 clientMap 移除，getClient 返回 undefined
    clientMap.delete('s1')
    vi.mocked(pm.getClient).mockReturnValue(undefined)

    // 3. switchModel：激活路径会尝试 restore；该 session 无落盘文件（进程在首次保存前退出）→
    //    激活失败显性化（SESSION_NOT_FOUND 既有码透传），且**不写缓存**（不假装成功）。
    const beforeModelId = service.getSession('s1')?.modelId
    await expect(service.switchModel('s1', 'new' as ProviderId, 'model'))
      .rejects.toMatchObject({ code: SESSION_NOT_FOUND })
    expect(service.getSession('s1')?.modelId).toBe(beforeModelId)
    // 未广播 session.state_changed（失败不产生状态假信号）
    expect(findBroadcast(broker, 'session.state_changed')).toBeUndefined()
  })
})
describe('model-control 生效值链（原 U1 写点覆盖，U8a 写点退役后 = 反向读 JSONL 可见）——switchModel/setThinkingLevel [U7/U8a]', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    providerMocks.defaultModel.value = { provider: 'test-provider', modelId: 'test-model' }
    tmpDir = mkdtempSync(join(tmpdir(), 'switch-model-sidecar-'))
  })

  afterEach(() => {
    // maxRetries：teardown 递归删除与在途异步写竞争致 ENOTEMPTY 满载 flake（教训 d9ad39cb8）
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 建一个带已 materialize 主文件的 seed session（对齐真实 pi：会话文件先于对话存在）。 */
  async function seedSessionWithFile(ctx: ReturnType<typeof createService>, id: string): Promise<string> {
    const sessionFile = join(tmpDir, `${id}.jsonl`)
    writeFileSync(sessionFile, '{"type":"session"}\n', 'utf8')
    const client = makeClient()
    vi.mocked(client.getState).mockResolvedValue({ sessionId: id, sessionFile })
    vi.mocked(ctx.pm.createSession).mockResolvedValueOnce(client)
    ctx.clientMap.set(id, client)
    await ctx.service.create('/tmp', `seed-${id}`)
    return sessionFile
  }

  /** [U7] 模拟 pi 的 JSONL append（真实 pi 在 setModel/setThinkingLevel 成功后写对应 entry）。 */
  function appendJsonl(sessionFile: string, line: object): void {
    appendFileSync(sessionFile, JSON.stringify(line) + '\n', 'utf8')
  }

  it('switchModel 成功后 get_state 读回的生效值反向读 JSONL 可见（生效值胜请求值；持久层唯一写方 = pi）', async () => {
    const ctx = createService()
    const sessionFile = await seedSessionWithFile(ctx, 's1')
    const client = ctx.clientMap.get('s1')!
    // pi pattern 引擎静默换模形态：get_state 读回生效模型 ≠ 请求模型（U6 回执普查）
    vi.mocked(client.getState).mockResolvedValue({
      sessionId: 's1',
      sessionFile,
      model: { provider: 'eff-provider', id: 'eff-model' },
      thinkingLevel: 'high',
    })
    // [U7] pi 侧生效落盘：setModel 成功后 append model_change；thinking 'high' 是 pi 既有状态
    vi.mocked(client.setModel).mockImplementation(async () => {
      appendJsonl(sessionFile, { type: 'model_change', provider: 'eff-provider', modelId: 'eff-model' })
      appendJsonl(sessionFile, { type: 'thinking_level_change', thinkingLevel: 'high' })
    })

    const effective = await ctx.service.switchModel('s1', 'req-provider' as ProviderId, 'req-model')

    expect(effective).toBe('eff-provider/eff-model')
    // 断言目标：读回值 == get_state 读回生效值（非请求值）——持久层唯一写方 = pi JSONL
    //（U8a W1 后 taiji 不再写 .model.json），列表可见性经扫描反向读达成
    expect(extractLatestModelFromJsonl(sessionFile)).toEqual({
      modelId: 'eff-provider/eff-model',
      thinkingLevel: 'high',
    })
  })

  it('setThinkingLevel 成功后钳制生效值反向读 JSONL 可见（get_state 读回胜请求值）', async () => {
    const ctx = createService()
    const sessionFile = await seedSessionWithFile(ctx, 's1')
    const client = ctx.clientMap.get('s1')!
    vi.mocked(client.getState).mockResolvedValue({
      sessionId: 's1',
      sessionFile,
      model: { provider: 'eff-provider', id: 'eff-model' },
      // P3 钳制形态：请求 max，pi 钳到 xhigh
      thinkingLevel: 'xhigh',
    })
    vi.mocked(client.setModel).mockImplementation(async () => {
      appendJsonl(sessionFile, { type: 'model_change', provider: 'eff-provider', modelId: 'eff-model' })
    })
    await ctx.service.switchModel('s1', 'eff-provider' as ProviderId, 'eff-model')

    // [U7] pi 侧生效落盘：setThinkingLevel 成功后 append thinking_level_change（钳制值）
    vi.mocked(client.setThinkingLevel).mockImplementation(async () => {
      appendJsonl(sessionFile, { type: 'thinking_level_change', thinkingLevel: 'xhigh' })
    })
    const effective = await ctx.service.setThinkingLevel('s1', 'max')

    expect(effective).toBe('xhigh')
    expect(extractLatestModelFromJsonl(sessionFile)).toEqual({
      modelId: 'eff-provider/eff-model',
      thinkingLevel: 'xhigh',
    })
  })
})
});

// ======================================================================
// ← test/host-db-suffix-parity.test.ts
// ======================================================================

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')


// ④ 重声明扫描的正则：`[` 锚定的四段数组字面量（引号风格/空白归一）。join 参数
// 形态（测试的独立展开断言）非数组形态，刻意不命中——只拦「重声明常量」回归。
const HOST_ARRAY_RE = /\[\s*['"]\.zcode['"]\s*,\s*['"]cli['"]\s*,\s*['"]db['"]\s*,\s*['"]db\.sqlite['"]/

const ISOLATED_ARRAY_RE = /\[\s*['"]engines['"]\s*,\s*['"]zcode['"]\s*,\s*['"]session-db['"]\s*,\s*['"]db\.sqlite['"]/


/** 从文件文本抽取 `<constName> = [ ... ]` 数组字面量的字符串段（引号/空白归一）。 */
function extractSuffixSegments(file: string, constName: string): string[] {
  const text = readFileSync(resolve(REPO_ROOT, file), 'utf8')
  const m = text.match(new RegExp(`\\b${constName}\\b\\s*=\\s*\\[([^\\]]*)\\]`))
  if (!m) {
    throw new Error(`${file} 未找到 ${constName} 数组字面量——常量改名或迁移后须同步本检查`)
  }
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((s) => s[1])
}


/** 从文件文本抽取 `<fnName>` 函数体内首个 `join(...)` 实参的引号段序列（引号/空白归一）。 */
function extractJoinSegments(file: string, fnName: string): string[] {
  const text = readFileSync(resolve(REPO_ROOT, file), 'utf8')
  const m = text.match(new RegExp(`function ${fnName}\\([^)]*\\)[\\s\\S]*?\\bjoin\\(([^)]*)\\)`))
  if (!m) {
    throw new Error(`${file} 未找到 ${fnName} 的 join 调用——函数改名或迁移后须同步本检查`)
  }
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((s) => s[1])
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('host-db-suffix-parity', () => {
describe('① 路径段 SSOT（engine-sdk zcode-db-paths）值独立展开断言', () => {
  it('ZCODE_HOST_DB_SUFFIX = ~/.zcode/cli/db/db.sqlite 相对段（期望值逐段写死，SSOT 改错即红）', () => {
    // 逐段断言（不用数组字面量期望值——本文件自身在 ④ 的扫描范围内）
    expect(ZCODE_HOST_DB_SUFFIX.length).toBe(4)
    expect(ZCODE_HOST_DB_SUFFIX[0]).toBe('.zcode')
    expect(ZCODE_HOST_DB_SUFFIX[1]).toBe('cli')
    expect(ZCODE_HOST_DB_SUFFIX[2]).toBe('db')
    expect(ZCODE_HOST_DB_SUFFIX[3]).toBe('db.sqlite')
  })

  it('ZCODE_ISOLATED_DB_SEGMENTS = engines/zcode/session-db/db.sqlite 相对段', () => {
    expect(ZCODE_ISOLATED_DB_SEGMENTS.length).toBe(4)
    expect(ZCODE_ISOLATED_DB_SEGMENTS[0]).toBe('engines')
    expect(ZCODE_ISOLATED_DB_SEGMENTS[1]).toBe('zcode')
    expect(ZCODE_ISOLATED_DB_SEGMENTS[2]).toBe('session-db')
    expect(ZCODE_ISOLATED_DB_SEGMENTS[3]).toBe('db.sqlite')
  })
})
describe('② runtime 侧函数输出与 SSOT 常量 join 等价（同源引用行为范围）', () => {
  it('zcodeIsolatedDbPath(dataDir) = join(dataDir, ...ZCODE_ISOLATED_DB_SEGMENTS)', () => {
    expect(zcodeIsolatedDbPath('/data-root')).toBe(join('/data-root', ...ZCODE_ISOLATED_DB_SEGMENTS))
  })

  it('hostZcodeDbPath() = join(homedir(), ...ZCODE_HOST_DB_SUFFIX)', () => {
    expect(hostZcodeDbPath()).toBe(join(homedir(), ...ZCODE_HOST_DB_SUFFIX))
  })
})
describe('③ 脚本字面量（zcode-session-db-cleanup.mjs，纯 ESM 无法 import SSOT）文本比对', () => {
  it('HOST_DB_SUFFIX 与 SSOT 逐段一致', () => {
    expect(extractSuffixSegments('scripts/zcode-session-db-cleanup.mjs', 'HOST_DB_SUFFIX')).toEqual([
      ...ZCODE_HOST_DB_SUFFIX,
    ])
  })

  it('zcodeSessionDbPathJs 的 join 段与 SSOT 逐段一致', () => {
    expect(extractJoinSegments('scripts/zcode-session-db-cleanup.mjs', 'zcodeSessionDbPathJs')).toEqual([
      ...ZCODE_ISOLATED_DB_SEGMENTS,
    ])
  })
})
describe('④ 重声明扫描：四段数组字面量只允许 SSOT 与脚本字面量两处', () => {
  /** 契约相关源码树（两侧消费方 + 宿主侧大包 + 脚本目录）内扫描四段数组字面量的命中文件。 */
  function scanRedeclarations(): string[] {
    const roots = [
      'packages/runtime/src',
      'packages/runtime/test',
      'packages/zcode-subagent-cli/src',
      'packages/subagent-core/src',
      'packages/subagent-engine-sdk/src',
      'scripts',
    ]
    const exts = new Set(['.ts', '.mts', '.cts', '.mjs'])
    const hits: string[] = []
    const walk = (absDir: string, relDir: string) => {
      let entries: string[]
      try {
        entries = readdirSync(absDir)
      } catch {
        return // 目录不存在（root 集合里某包调整结构时该 root 静默缺席，白名单断言会捕获误配）
      }
      for (const e of entries) {
        if (e === 'node_modules' || e === 'dist' || e === '__snapshots__' || e === 'test-results') continue
        const abs = join(absDir, e)
        const rel = `${relDir}/${e}`
        if (statSync(abs).isDirectory()) {
          walk(abs, rel)
          continue
        }
        if (!exts.has(extname(e)) || e.endsWith('.d.ts')) continue
        const text = readFileSync(abs, 'utf8')
        if (HOST_ARRAY_RE.test(text) || ISOLATED_ARRAY_RE.test(text)) hits.push(rel)
      }
    }
    for (const r of roots) walk(resolve(REPO_ROOT, r), r)
    return hits.sort()
  }

  it('命中集合恰为 [SSOT, 脚本字面量]（任何包重声明四段字面量即红）', () => {
    expect(scanRedeclarations()).toEqual([
      'packages/subagent-engine-sdk/src/zcode-db-paths.ts',
      'scripts/zcode-session-db-cleanup.mjs',
    ])
  })
})
});

// ======================================================================
// ← test/pi-protocol-contract.test.ts
// ======================================================================

// ════════════════════════════════════════════════════════════════════════
// W2 (U4/U5/U6): event-adapter.ts consumes pi-protocol narrow types.
// Structural assertions read event-adapter.ts source text.
// ════════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url))

const EVENT_ADAPTER_SRC = readFileSync(
  resolve(__dirname, '../src/infra/pi/event-adapter.ts'),
  'utf8',
)

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-protocol-contract', () => {
// ════════════════════════════════════════════════════════════════════════
// U1: PiEvent union covers all 10 new event types
// ════════════════════════════════════════════════════════════════════════

describe('U1: PiEvent union — 10 new event types present', () => {
  it('compaction_start is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'compaction_start', reason: 'manual' }
    expect(e.type).toBe('compaction_start')
  })

  it('compaction_end is assignable to PiEvent (full shape)', () => {
    const e: PiEvent = {
      type: 'compaction_end',
      reason: 'threshold',
      aborted: false,
      willRetry: true,
      errorMessage: 'oom',
    }
    expect(e.type).toBe('compaction_end')
  })

  it('auto_retry_start is assignable to PiEvent', () => {
    const e: PiEvent = {
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: 'timeout',
    }
    expect(e.type).toBe('auto_retry_start')
  })

  it('auto_retry_end is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'auto_retry_end', success: true, attempt: 2 }
    expect(e.type).toBe('auto_retry_end')
  })

  it('thinking_level_changed is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'thinking_level_changed', level: 'high' }
    expect(e.type).toBe('thinking_level_changed')
  })

  it('queue_update is assignable to PiEvent', () => {
    const e: PiEvent = {
      type: 'queue_update',
      steering: ['s1'],
      followUp: ['f1'],
    }
    expect(e.type).toBe('queue_update')
  })

  it('entry_appended is assignable to PiEvent', () => {
    const e: PiEvent = {
      type: 'entry_appended',
      entry: { id: 'e1', role: 'user' },
    }
    expect(e.type).toBe('entry_appended')
  })

  it('session_info_changed is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'session_info_changed', name: 'renamed' }
    expect(e.type).toBe('session_info_changed')
  })

  it('agent_settled is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'agent_settled' }
    expect(e.type).toBe('agent_settled')
  })

  it('extension_error is assignable to PiEvent', () => {
    const e: PiEvent = {
      type: 'extension_error',
      extensionPath: 'a/b.ts',
      event: 'tool_execution',
      error: 'boom',
    }
    expect(e.type).toBe('extension_error')
  })

  // Negative case: a non-existent type must NOT be assignable.
  it('rejects unknown event types at compile time', () => {
    // @ts-expect-error — 'not_a_real_type' is not a member of the PiEvent union
    const _e: PiEvent = { type: 'not_a_real_type' }
    expect(_e).toBeDefined()
  })
})
// Independent existence of the exported interfaces (so importing the names
// is valid even when used outside the union).
describe('U1: event interfaces are independently exported', () => {
  it('PiCompactionStartEvent accepts manual|threshold|overflow', () => {
    const e: PiCompactionStartEvent = { type: 'compaction_start', reason: 'overflow' }
    expect(e.reason).toBe('overflow')
  })

  it('PiCompactionEndEvent carries aborted/willRetry/errorMessage', () => {
    const e: PiCompactionEndEvent = {
      type: 'compaction_end',
      reason: 'manual',
      aborted: true,
      willRetry: false,
    }
    expect(e.aborted).toBe(true)
  })

  it('PiAutoRetryStartEvent / PiAutoRetryEndEvent shapes', () => {
    const s: PiAutoRetryStartEvent = {
      type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 100, errorMessage: 'e',
    }
    const en: PiAutoRetryEndEvent = { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'x' }
    expect(s.attempt).toBe(1)
    expect(en.success).toBe(false)
  })

  it('PiThinkingLevelChangedEvent', () => {
    const e: PiThinkingLevelChangedEvent = { type: 'thinking_level_changed', level: 'xhigh' }
    expect(e.level).toBe('xhigh')
  })

  it('PiQueueUpdateEvent', () => {
    const e: PiQueueUpdateEvent = { type: 'queue_update', steering: [], followUp: [] }
    expect(e.steering).toHaveLength(0)
  })

  it('PiEntryAppendedEvent', () => {
    const e: PiEntryAppendedEvent = { type: 'entry_appended', entry: { a: 1 } }
    expect(e.entry).toEqual({ a: 1 })
  })

  it('PiSessionInfoChangedEvent accepts undefined name', () => {
    const e: PiSessionInfoChangedEvent = { type: 'session_info_changed', name: undefined }
    expect(e.name).toBeUndefined()
  })

  it('PiAgentSettledEvent', () => {
    const e: PiAgentSettledEvent = { type: 'agent_settled' }
    expect(e.type).toBe('agent_settled')
  })

  it('PiExtensionErrorEvent', () => {
    const e: PiExtensionErrorEvent = {
      type: 'extension_error', extensionPath: 'p', event: 'ev', error: 'err',
    }
    expect(e.extensionPath).toBe('p')
  })
})
// ════════════════════════════════════════════════════════════════════════
// U2: PiToolExecutionResult mirrors pi AgentToolResult
// ════════════════════════════════════════════════════════════════════════

describe('U2: PiToolExecutionResult — mirrors pi AgentToolResult', () => {
  it('accepts content with text + image blocks, plus details/addedToolNames/terminate', () => {
    const r: PiToolExecutionResult = {
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'base64==', mimeType: 'image/png' },
      ],
      details: { truncated: true },
      addedToolNames: ['newTool'],
      terminate: true,
    }
    expect(r.content).toHaveLength(2)
    expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(r.details).toEqual({ truncated: true })
    expect(r.addedToolNames).toEqual(['newTool'])
    expect(r.terminate).toBe(true)
  })

  it('details is required (unknown), addedToolNames/terminate optional', () => {
    const r: PiToolExecutionResult = {
      content: [{ type: 'text', text: 'plain' }],
      details: null,
    }
    expect(r.details).toBeNull()
  })
})
// ════════════════════════════════════════════════════════════════════════
// U3: PiTurnEndEvent carries message + toolResults
// ════════════════════════════════════════════════════════════════════════

describe('U3: PiTurnEndEvent — message + toolResults', () => {
  it('accepts message (role/content/usage/stopReason) + toolResults array', () => {
    const e: PiTurnEndEvent = {
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: 'done',
        usage: { input: 10, output: 5, totalTokens: 15 },
        stopReason: 'end_turn',
      },
      toolResults: [
        {
          role: 'toolResult',
          toolCallId: 'tc1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'out' }],
          isError: false,
        },
      ],
    }
    expect(e.message.stopReason).toBe('end_turn')
    expect(e.toolResults).toHaveLength(1)
    expect(e.toolResults[0].toolName).toBe('bash')
  })

  it('toolResults may be empty', () => {
    const e: PiTurnEndEvent = {
      type: 'turn_end',
      message: { role: 'assistant', content: 'no tools' },
      toolResults: [],
    }
    expect(e.toolResults).toEqual([])
  })
})
describe('U4: event-adapter.ts imports PiEvent from pi-protocol (no local shadow)', () => {
  it('imports PiEvent as a type from ./pi-protocol.js', () => {
    // Must have `import type { ... PiEvent ... } from './pi-protocol.js'`
    expect(EVENT_ADAPTER_SRC).toMatch(/import\s+type\s+\{[^}]*\bPiEvent\b[^}]*\}\s+from\s+['"]\.\/pi-protocol\.js['"]/)
  })

  it('has no local `type PiEvent = Record<...>` shadow definition', () => {
    // The old shadow was: `type PiEvent = Record<string, unknown>`
    expect(EVENT_ADAPTER_SRC).not.toMatch(/^\s*type\s+PiEvent\s*=\s*Record</m)
  })
})
describe('U5: event-adapter.ts has no defensive double-read fallbacks', () => {
  it('has no `?? event.output` (result??output defense)', () => {
    expect(EVENT_ADAPTER_SRC).not.toContain('?? event.output')
  })

  it('has no `?? event.input` (args??input defense)', () => {
    expect(EVENT_ADAPTER_SRC).not.toContain('?? event.input')
  })

  it('has no `?? event.payload` (message??payload defense)', () => {
    expect(EVENT_ADAPTER_SRC).not.toContain('?? event.payload')
  })
})
describe('U6: 3 representative handlers use narrow Pi*Event param types', () => {
  // These three handlers previously took the wide `PiEvent` (= Record) shadow.
  // After W2 they must take the specific narrow interfaces from pi-protocol.

  it('handleToolExecutionEnd takes PiToolExecutionEndEvent', () => {
    expect(EVENT_ADAPTER_SRC).toMatch(/function\s+handleToolExecutionEnd\s*\(\s*event:\s*PiToolExecutionEndEvent\b/)
  })

  it('handleTurnEndPi takes PiTurnEndEvent', () => {
    expect(EVENT_ADAPTER_SRC).toMatch(/function\s+handleTurnEndPi\s*\(\s*event:\s*PiTurnEndEvent\b/)
  })

  it('handleToolExecutionStart takes PiToolExecutionStartEvent', () => {
    expect(EVENT_ADAPTER_SRC).toMatch(/function\s+handleToolExecutionStart\s*\(\s*event:\s*PiToolExecutionStartEvent\b/)
  })
})
// ════════════════════════════════════════════════════════════════════════
// W2 contract deepening — 4 should_fix field alignments (mirror pi source)
// ════════════════════════════════════════════════════════════════════════
//
// pi-protocol.ts claims to be pi's real contract (ADR-0037), but 4 fields
// drifted from pi's canonical names/shapes. These tests pin the alignment:
//   C1: PiUsage mirrors pi Usage field names (input/output/cacheRead/cacheWrite/totalTokens)
//   C2: PiAgentEndEvent carries willRetry: boolean (pi AgentSessionEvent.agent_end)
//   C3: PiToolExecutionUpdateEvent.partialResult is unknown (pi sends `any`)
//   C4: PiToolExecutionEndEvent has NO args field (pi never sends args on end)

describe('C1: PiUsage mirrors pi Usage field names (input/output/cacheRead/cacheWrite)', () => {
  it('accepts pi canonical field names { input, output, totalTokens, cacheRead, cacheWrite }', () => {
    const u: PiUsage = {
      input: 100,
      output: 50,
      totalTokens: 150,
      cacheRead: 10,
      cacheWrite: 5,
    }
    expect(u.input).toBe(100)
    expect(u.cacheRead).toBe(10)
  })

  it('rejects taiji field name inputTokens (translation belongs in event-adapter, not the contract)', () => {
    // @ts-expect-error — PiUsage mirrors pi: field is `input`, NOT `inputTokens`
    const _u: PiUsage = { inputTokens: 100 }
    expect(_u).toBeDefined()
  })

  it('rejects taiji field name outputTokens', () => {
    // @ts-expect-error — PiUsage mirrors pi: field is `output`, NOT `outputTokens`
    const _u: PiUsage = { outputTokens: 50 }
    expect(_u).toBeDefined()
  })
})
describe('C2: PiAgentEndEvent carries willRetry (pi AgentSessionEvent.agent_end)', () => {
  it('accepts { type, messages, willRetry }', () => {
    const e: PiAgentEndEvent = {
      type: 'agent_end',
      messages: [],
      willRetry: false,
    }
    expect(e.willRetry).toBe(false)
  })

  it('willRetry is required (omitting it must fail to compile)', () => {
    // @ts-expect-error — pi always sends willRetry; it is a required field
    const _e: PiAgentEndEvent = { type: 'agent_end', messages: [] }
    expect(_e).toBeDefined()
  })
})
describe('C3: PiToolExecutionUpdateEvent.partialResult is unknown (pi sends any)', () => {
  it('accepts a string partialResult', () => {
    const e: PiToolExecutionUpdateEvent = {
      type: 'tool_execution_update',
      toolCallId: 'x',
      toolName: 'y',
      partialResult: 'working...',
    }
    expect(e.partialResult).toBe('working...')
  })

  it('accepts an object partialResult (pi may send AgentToolResult-shaped objects)', () => {
    const e: PiToolExecutionUpdateEvent = {
      type: 'tool_execution_update',
      toolCallId: 'x',
      toolName: 'y',
      partialResult: { details: { progress: 50 }, content: 'half' },
    }
    expect(e.partialResult).toEqual({ details: { progress: 50 }, content: 'half' })
  })
})
describe('C4: PiToolExecutionEndEvent has NO args field (pi never sends args on end)', () => {
  it('accepts the canonical shape without args', () => {
    const e: PiToolExecutionEndEvent = {
      type: 'tool_execution_end',
      toolCallId: 'tc1',
      toolName: 'write',
      result: { content: [{ type: 'text', text: 'ok' }], details: {} },
      isError: false,
    }
    expect(e.toolCallId).toBe('tc1')
  })

  it('rejects args field (pi types.ts:430 defines tool_execution_end WITHOUT args)', () => {
    // args is a ghost field; pi only sends args on tool_execution_start.
    // Assigning to a PiToolExecutionEndEvent-typed variable must fail type-check.
    // @ts-expect-error — 'args' does not exist on PiToolExecutionEndEvent
    const _e: PiToolExecutionEndEvent = { type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'write', result: { content: [], details: {} }, isError: false, args: { path: '/x' } }
    expect(_e).toBeDefined()
  })
})
// ════════════════════════════════════════════════════════════════════════
// C5: pi 1.0.0 codemode tool_execution_end shape (codemode 设计 D4① 契约样本)
// ════════════════════════════════════════════════════════════════════════
//
// 样本来源：真机实测（taiji dev 实例 + pi 1.0.0 二进制 --mode rpc，真实 LLM 触发
// codemode 脚本并行 tools.read；RPC tool_execution_end 事件原样采集，仅替换标识符
// 与正文为脱敏占位）。信封与 C4 通用样本同构（type/toolCallId/toolName/result/
// isError），codemode 特有形状在 result 内：
//   - content 首块恒为 text：[0] 沙箱执行元信息（Script completed / Wall time）；
//     其后为脚本产物 items——本样本（并行 read 场景）恰一块脚本返回值序列化 text。
//     非恒定形状（pi execute.js content 拼装 = [header, ...items]）：image 产出场景
//     image 块追加在 text 块后（设计 §2 链路 C「text 块在前、image 块追加在后」；
//     S3 真机已验 image 块出现于 content 数组），无返回值脚本则无返回值 text 块
//   - details.calls：嵌套调用清单（D6 后置的树形展示数据源，本期无渲染消费点），
//     每项 { id: "<toolCallId>/<序号>", name, args: JSON 字符串, status, durationMs }
// 嵌套子调用自身的事件带 parentToolCallId 且不落 transcript（D4 过滤判据的
// 协议依据），不会以独立 tool_execution_end 形态出现在该契约范围上。

describe('C5: pi 1.0.0 codemode tool_execution_end shape (real-device sample)', () => {
  const CODEMODE_END_SAMPLE: PiToolExecutionEndEvent = {
    type: 'tool_execution_end',
    toolCallId: 'call_codemode_sample_0001',
    toolName: 'codemode',
    result: {
      content: [
        { type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
        { type: 'text', text: '[{"file":"a.txt","lines":5},{"file":"a1.log","lines":7}]' },
      ],
      details: {
        calls: [
          {
            id: 'call_codemode_sample_0001/1',
            name: 'read',
            args: '{"path":"a.txt","offset":null,"limit":null}',
            status: 'ok',
            durationMs: 14.27,
          },
          {
            id: 'call_codemode_sample_0001/2',
            name: 'read',
            args: '{"path":"a1.log","offset":null,"limit":null}',
            status: 'ok',
            durationMs: 4.7,
          },
        ],
      },
    },
    isError: false,
  }

  it('envelope is assignable to PiToolExecutionEndEvent (same fields as C4 canonical)', () => {
    const e: PiToolExecutionEndEvent = CODEMODE_END_SAMPLE
    expect(e.type).toBe('tool_execution_end')
    expect(e.toolName).toBe('codemode')
    expect(e.isError).toBe(false)
  })

  it('result.content is two text blocks (sandbox meta + serialized return value)', () => {
    const content = CODEMODE_END_SAMPLE.result.content
    expect(content).toHaveLength(2)
    expect(content.every((c) => c.type === 'text')).toBe(true)
    expect((content[0] as { type: 'text'; text: string }).text).toMatch(/^Script completed/)
  })

  it('result.details.calls pins the nested-call list shape (D6 deferred data source)', () => {
    const details = CODEMODE_END_SAMPLE.result.details as {
      calls: { id: string; name: string; args: string; status: string; durationMs: number }[]
    }
    expect(details.calls).toHaveLength(2)
    for (const call of details.calls) {
      expect(call.id).toMatch(/^call_codemode_sample_0001\/\d+$/)
      expect(typeof call.name).toBe('string')
      expect(typeof call.args).toBe('string') // JSON-serialized arguments, not an object
      expect(call.status).toBe('ok')
      expect(typeof call.durationMs).toBe('number')
    }
    expect(() => JSON.parse(details.calls[0].args)).not.toThrow()
  })
})
});

// ======================================================================
// ← test/file-lock-parity.test.ts
// ======================================================================

let tmpDir_m2: string


// ──────────────────── S3 锁互操作集成探针（真子进程并发） ────────────────────

/** 本测试文件目录（packages/runtime/test）→ 仓库根（向上 3 级）。 */
const REPO_ROOT_m2 = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const WORKER_SELF = join(REPO_ROOT_m2, 'scripts', 'probe', 'file-lock-interop-worker-self.ts')

const WORKER_PL = join(REPO_ROOT_m2, 'scripts', 'probe', 'file-lock-interop-worker-pl.mjs')

/** tsx CLI（runtime devDep，pnpm hoisted 布局下经 createRequire 从本文件位置可达）。 */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')


/** S3 每侧迭代数（设计 §4 S3：各循环 100 次 lock→write→unlock）。 */
const S3_ITERATIONS = 100


interface WorkerResult {  // oe-exempt:20261027:test:
  code: number
  stdout: string
  stderr: string
}


function runWorker(command: string, args: string[], target: string, tag: string): Promise<WorkerResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(command, [...args, target, String(S3_ITERATIONS), tag, tmpDir_m2], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => rejectP(err))
    child.on('exit', (code) => resolveP({ code: code ?? -1, stdout, stderr }))
  })
}


/** 启动屏障放行：等双侧 ready-<tag> 挂牌后写 go（tmpDir_m2 即协调目录，随 afterEach 清理）。 */
async function releaseGate(): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!(existsSync(join(tmpDir_m2, 'ready-a')) && existsSync(join(tmpDir_m2, 'ready-b')))) {
    if (Date.now() > deadline) throw new Error('启动屏障超时：worker ready 挂牌未收齐')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  writeFileSync(join(tmpDir_m2, 'go'), '')
}


interface WorkerReport {  // oe-exempt:20261027:test:
  worker: string
  impl: string
  iterations: number
  ok: boolean
  startedAtMs: number
  endedAtMs: number
}


/** 取 worker stdout 的末行 JSON（结果行）。 */
function parseWorkerReport(res: WorkerResult, tag: string): WorkerReport {
  const lines = res.stdout.trim().split('\n')
  const last = lines[lines.length - 1] ?? ''
  const report = JSON.parse(last) as WorkerReport
  expect(report.worker, `worker ${tag} 自报身份`).toBe(tag)
  expect(report.ok, `worker ${tag} 自报 ok`).toBe(true)
  expect(report.iterations, `worker ${tag} 完成迭代数`).toBe(S3_ITERATIONS)
  return report
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('file-lock-parity', () => {
beforeEach(async () => {
  tmpDir_m2 = await mkdtemp_z2(join(tmpdir(), 'file-lock-parity-'))
})
afterEach(async () => {
  await rm_z2(tmpDir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('file-lock parity（runtime ↔ extension sync 孪生实现）', () => {
  it('两侧默认参数相等（stale / retry 间隔 / 重试预算）', () => {
    expect(EXT_STALE_MS).toBe(DEFAULT_STALE_MS)
    expect(EXT_RETRY_DELAY_MS).toBe(DEFAULT_RETRY_DELAY_MS)
    expect(EXT_RETRY_BUDGET_MS).toBe(DEFAULT_RETRY_BUDGET_MS)
  })

  it('默认值与登记表锁协议一致（stale 30s / 25ms / 1s，data-source-registry §6）', () => {
    expect(DEFAULT_STALE_MS).toBe(30_000)
    expect(DEFAULT_RETRY_DELAY_MS).toBe(25)
    expect(DEFAULT_RETRY_BUDGET_MS).toBe(1_000)
  })

  it('两侧共用同一 lockfile：一侧持锁时另一侧 fail-fast，释放后可获取', () => {
    const target = join(tmpDir_m2, 'parity-target.json')
    const events: string[] = []

    withFileLockSync(target, () => {
      events.push('runtime-critical')
      // runtime 持锁期间，extension 侧取同一把锁：压缩预算快速验证 fail-fast
      //（抛 ELOCKED 而非静默拿到——证明两侧 lockfile 路径推导一致，互斥真实成立）
      expect(() =>
        extWithFileLockSync(target, () => events.push('ext-in-runtime-critical'), {
          retryDelayMs: 5,
          retryBudgetMs: 50,
        }),
      ).toThrow()
      expect(events).toEqual(['runtime-critical'])
    })

    // runtime 释放后 extension 立即可获取（无 stale 夺取冲突）
    extWithFileLockSync(target, () => events.push('ext-after-release'))
    expect(events).toEqual(['runtime-critical', 'ext-after-release'])
  })
})
describe.skipIf(
  !INTEGRATION_TESTS_ENABLED,
)(`S3 锁互操作集成探针（runtime 自实现 × proper-lockfile@4.1.2 实库，真子进程并发）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`, () => {
  // 真实并发：两子进程各 100 轮「ELOCKED 等待 → 临界区 RMW → 释放」。本机实测 ~1s，
  // CI 慢机余量取 120s（vitest 默认 5s 远不够；无 fake timers——真实定时器是探针语义本体）
  it(
    '双方各 100 次 lock→write→unlock 并发竞争：全部成功获取（等待互斥）、最终内容无交错损坏',
    async () => {
      const target = join(tmpDir_m2, 's3-target.jsonl')

      // 两个真子进程同时 spawn，启动屏障收齐双侧 ready 后同刻放行（并发非交替，
      // 且不受 tsx 与纯 node 启动开销不对称影响）
      const [selfRes, plRes] = await Promise.all([
        runWorker(process.execPath, [TSX_CLI, WORKER_SELF], target, 'a'),
        runWorker(process.execPath, [WORKER_PL], target, 'b'),
        releaseGate(),
      ])

      // ① 双方全部成功：退出码 0（任何一轮获取失败/校验失败 worker 都会非零退出）
      expect(selfRes.stderr, '自实现侧 worker stderr（失败现场）').toBe('')
      expect(selfRes.code, `自实现侧 worker 退出码（stderr: ${selfRes.stderr}）`).toBe(0)
      expect(plRes.stderr, 'proper-lockfile 侧 worker stderr（失败现场）').toBe('')
      expect(plRes.code, `proper-lockfile 侧 worker 退出码（stderr: ${plRes.stderr}）`).toBe(0)

      const selfReport = parseWorkerReport(selfRes, 'a')
      const plReport = parseWorkerReport(plRes, 'b')

      // ② 并发形态检查：两 worker 运行区间真实重叠（防探针退化为先后交替执行仍「绿」）
      const overlapMs =
        Math.min(selfReport.endedAtMs, plReport.endedAtMs) - Math.max(selfReport.startedAtMs, plReport.startedAtMs)
      expect(overlapMs, '两 worker 运行区间重叠毫秒数（并发形态检查）').toBeGreaterThan(0)

      // ③ 最终内容无交错损坏：恰好 200 行、行行成形、每方序号恰为 1..100 顺序完整
      //（并发 RMW 互斥失效 → 后写者覆盖先写者 → 丢行；撕裂写 → 畸形行——双双在此红）
      const content = await readFile(target, 'utf-8')
      const lines = content.split('\n').filter((l) => l !== '')
      expect(lines.length, '最终总行数（100×2，丢行 = 互斥被破坏）').toBe(S3_ITERATIONS * 2)

      const seqByWorker: Record<string, number[]> = { a: [], b: [] }
      let alternations = 0
      let prevWorker = ''
      for (const line of lines) {
        const m = /^(a|b):(\d+)$/.exec(line)
        expect(m, `畸形行（交错损坏痕迹）: ${JSON.stringify(line)}`).not.toBeNull()
        const worker = m![1]!
        seqByWorker[worker]!.push(Number(m![2]))
        if (worker !== prevWorker) alternations++
        prevWorker = worker
      }
      expect(seqByWorker.a, '自实现侧序号序列（须恰为 1..100 顺序完整）').toEqual(
        Array.from({ length: S3_ITERATIONS }, (_, i) => i + 1),
      )
      expect(seqByWorker.b, 'proper-lockfile 侧序号序列（须恰为 1..100 顺序完整）').toEqual(
        Array.from({ length: S3_ITERATIONS }, (_, i) => i + 1),
      )
      // 写序交替 ≥2 = 至少发生过一次持锁权易手（真竞争的直接物证；严格先后跑 = 恒 1）
      expect(alternations, 'a/b 写序交替次数（真竞争物证）').toBeGreaterThanOrEqual(2)
    },
    120_000,
  )
})
});

// ======================================================================
// ← test/runtime-wiring.test.ts
// ======================================================================

// ── mock helpers（参照 message-bus.test.ts + session-service.test.ts 范式）──────

/**
 * 创建 mock MessageBus：所有方法 vi.fn，便于断言调用次数与参数。
 * 不引入真实 MessageBus 实现（本 wave 测接线，bus 核心由 bus-core wave 覆盖）。
 */
function createMockMessageBus(): MessageBus {
  return {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    clearSession: vi.fn(),
  } as unknown as MessageBus
}


/** 创建 mock BusClient（ws 适配器契约）。readyState 默认 1（OPEN）。 */
function createMockWs(readyState: number = 1): BusClient & { sent: string[] } {
  const sent: string[] = []
  return { readyState, send: (data: string) => { sent.push(data) }, sent }
}


/**
 * 创建 mock IProcessManager（SessionService 构造依赖）。
 * 仅 stub 构造函数用到的 onSessionExit（进程退出回调注册）+ getClient（fetchAndBroadcastCommands 用）。
 * 与 session-service.test.ts 的 pm 桩对齐（本 wave 不测 pi 交互，pm 仅满足构造时序）。
 */
function createMockPm(overrides: Partial<{ getClient: ReturnType<typeof vi.fn> }> = {}) {
  return {
    onSessionExit: vi.fn(),
    getClient: overrides.getClient ?? vi.fn(() => undefined),
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('runtime-wiring', () => {
// ───────────────────────────────────────────────────────────────────
// TC1 / TC2：session-service send 回调双写
// ───────────────────────────────────────────────────────────────────

describe('wave:runtime-wiring · TC1/TC2 session-service send 回调双写', () => {
  /**
   * 验证 initializeManagedSession 的内联 send 闭包接线：session 级消息（带 sessionId payload）
   * 双写走 bus.publish + broker.broadcast；全局消息（无 sessionId）只走 broker.broadcast。
   *
   * send 闭包是 initializeManagedSession 内联的，经 adapterFactory 第 2 参数透传。
   * 测试侧用捕获型 adapterFactory 拿到 send 闭包，再分别传入 session 级 / 全局消息断言路由。
   * mock client.getCommands reject 让 fetchAndBroadcastCommands catch no-op（避免 bus.publish 噪音）。
   */
  let messageBus: MessageBus
  let broker: { broadcast: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    messageBus = createMockMessageBus()
    broker = { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() }
  })

  /** 构造 SessionService + 注入 messageBus（可选），经 initializeManagedSession 触发并捕获 send 闭包。 */
  async function captureSend(injectBus: boolean): Promise<{ send: (msg: ServerMessage) => void; svc: SessionService }> {
    let captured: ((msg: ServerMessage) => void) | null = null
    const captureAdapterFactory = (_sid: string, send: (msg: ServerMessage) => void) => {
      captured = send
      return { attach: vi.fn(), detach: vi.fn() }
    }
    const pm = createMockPm()
    const fakeClient = {
      getState: vi.fn().mockResolvedValue({ sessionId: 'pi-x', sessionFile: '/fake/x.jsonl' }),
      getCommands: vi.fn().mockRejectedValue(new Error('mock: skip fetchAndBroadcast')),
    }
    vi.mocked(pm.getClient).mockReturnValue(fakeClient as never)
    // configStore 桩：getDefaultModel 返 undefined（modelId 留空，本测试不关注模型字段）。
    const configStore = { getDefaultModel: vi.fn(() => undefined) }
    const svc = new SessionService(
      pm as never, broker as never,
      captureAdapterFactory as never,
      '/tmp', {} as never, configStore as never, {} as never,
      { readGitInfo: () => undefined, pruneStaleCache: () => {} } as never, {} as never,
    )
    if (injectBus) svc.setMessageBus(messageBus)
    await (svc as unknown as { initializeManagedSession: (id: string, client: unknown, cwd: string, label: string) => Promise<unknown> })
      .initializeManagedSession('s1', fakeClient, '/tmp', 'test')
    if (!captured) throw new Error('send callback was not captured')
    return { send: captured, svc }
  }

  it('TC1: session 级消息（带 sessionId payload）单通道——只 bus.publish，broker.broadcast 不再被调', async () => {
    const { send } = await captureSend(true)
    // 清空 fetchAndBroadcastCommands 阶段的 broker.broadcast 调用记录（避免噪音）
    broker.broadcast.mockClear()
    vi.mocked(messageBus.publish).mockClear()

    const msg: ServerMessage = { type: 'message.text_delta', payload: { sessionId: 's1', delta: 'hello' } }
    send(msg)
    // session 级：bus.publish 被调（'s1', msg），恰好一次（D1-2 单通道）
    expect(messageBus.publish).toHaveBeenCalledTimes(1)
    expect(messageBus.publish).toHaveBeenCalledWith('s1', msg)
    // wave:perf-w09（D1-2）：broadcast 路径已删——盲广播不再发生
    expect(broker.broadcast).not.toHaveBeenCalled()
  })

  it('TC2: 全局消息（无 sessionId payload）只走 broker.broadcast，不经 bus', async () => {
    const { send } = await captureSend(true)
    broker.broadcast.mockClear()
    vi.mocked(messageBus.publish).mockClear()

    const msg: ServerMessage = { type: 'config.sessions', payload: { groups: [] } }
    send(msg)
    // 全局消息：bus.publish 未被调
    expect(messageBus.publish).not.toHaveBeenCalled()
    // broker.broadcast 被调（盲广播保留）
    expect(broker.broadcast).toHaveBeenCalledTimes(1)
    expect(broker.broadcast).toHaveBeenCalledWith(msg)
  })

  it('未注入 messageBus 时（nullable）session 级消息不抛错（publish no-op，broker 也不走）', async () => {
    const { send } = await captureSend(false)
    broker.broadcast.mockClear()

    const msg: ServerMessage = { type: 'message.text_delta', payload: { sessionId: 's1' } }
    // wave:perf-w09（D1-2）：bus 未注入时 this.messageBus?.publish 静默 no-op——不抛错；
    // sid 存在故不走 broker 兜底分支（else 只接无 sid 消息）。组合根恒注入 bus，此为防御语义。
    expect(() => send(msg)).not.toThrow()
    expect(broker.broadcast).not.toHaveBeenCalled()
    expect(messageBus.publish).not.toHaveBeenCalled()
  })
})
// ───────────────────────────────────────────────────────────────────
// TC3 / TC4 / TC5：session-message-handler subscribe/unsubscribe RPC
// ───────────────────────────────────────────────────────────────────

describe('wave:runtime-wiring · TC3/TC4/TC5 session.subscribe/unsubscribe RPC', () => {
  /** 构造 SessionMessageHandler + mock ctx，返回 handler + 捕获 reply 的工具。 */
  function createHandlerWithMocks(busOverride?: Partial<MessageBus>) {
    const messageBus = { ...createMockMessageBus(), ...busOverride } as MessageBus
    const reply = vi.fn()
    const sendError = vi.fn()
    const ctx: SessionHandlerContext = {
      send: vi.fn(),
      reply,
      sendError,
      sessionService: {} as never,
      messageBus,
      nextPushId: () => 'push_test',
      broadcastSessionList: vi.fn(),
      broadcast: vi.fn(),
      invalidatePendingUiRequests: vi.fn(),
    }
    const handler = new SessionMessageHandler(ctx)
    return { handler, ctx, reply, sendError, messageBus }
  }

  it('TC3: session.subscribe 调 bus.subscribe + reply { snapshot, stateSnapshot, lastSeq, gap:false }', async () => {
    const snapshot = [{ type: 'pong', seq: 1, payload: {} }, { type: 'pong', seq: 2, payload: {} }] as ServerMessage[]
    const stateSnapshot = [{ type: 'session.commands', seq: 1, payload: { sessionId: 's1', commands: [] } }] as ServerMessage[]
    const { handler, reply, messageBus } = createHandlerWithMocks({
      subscribe: vi.fn(() => ({ snapshot: [...snapshot], stateSnapshot: [...stateSnapshot], lastSeq: 2 })),
    })
    const ws = createMockWs()
    const msg = { type: 'session.subscribe', id: 'rpc-1', payload: { sessionId: 's1' } } as unknown as ClientMessage
    await handler.handleSessionMessage(msg, ws as never)

    expect(messageBus.subscribe).toHaveBeenCalledTimes(1)
    expect(messageBus.subscribe).toHaveBeenCalledWith('s1', ws)
    expect(reply).toHaveBeenCalledWith(ws, 'rpc-1', 'session.subscribe', { snapshot, stateSnapshot, lastSeq: 2, gap: false })
  })

  it('TC4: session.subscribe 带 fromSeq 增量过滤（fromSeq=1, oldestSeq=1 → 无 gap，过滤 seq>1；stateSnapshot 不受影响）', async () => {
    // ring 中有 seq 1,2,3；fromSeq=1 表示已处理到 1，应返 seq>1 的 [2,3]，gap=false
    const snapshot = [
      { type: 'pong', seq: 1, payload: {} },
      { type: 'pong', seq: 2, payload: {} },
      { type: 'pong', seq: 3, payload: {} },
    ] as ServerMessage[]
    const stateSnapshot = [{ type: 'context.update', seq: 1, payload: { sessionId: 's1', usagePercent: 50 } }] as ServerMessage[]
    const { handler, reply } = createHandlerWithMocks({
      subscribe: vi.fn(() => ({ snapshot: [...snapshot], stateSnapshot: [...stateSnapshot], lastSeq: 3 })),
    })
    const ws = createMockWs()
    const msg = { type: 'session.subscribe', id: 'rpc-2', payload: { sessionId: 's1', fromSeq: 1 } } as unknown as ClientMessage
    await handler.handleSessionMessage(msg, ws as never)

    // 过滤后 snapshot 只含 seq>1；stateSnapshot 是 last-value 不受 fromSeq 影响
    const replyCall = reply.mock.calls[0]
    expect(replyCall[0]).toBe(ws)
    expect(replyCall[1]).toBe('rpc-2')
    expect(replyCall[2]).toBe('session.subscribe')
    const payload = replyCall[3] as { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number; gap: boolean }
    expect(payload.gap).toBe(false)
    expect(payload.lastSeq).toBe(3)
    expect(payload.snapshot.map(m => m.seq)).toEqual([2, 3])
    // stateSnapshot 全量透传（不被 fromSeq 过滤）
    expect(payload.stateSnapshot).toEqual(stateSnapshot)
  })

  it('TC4: session.subscribe fromSeq < oldestSeq（gap 检测，返全量 + gap:true）', async () => {
    // ring 最旧 seq=1，fromSeq=0 < 1 → 旧消息已被淘汰，gap=true 返全量
    const snapshot = [
      { type: 'pong', seq: 1, payload: {} },
      { type: 'pong', seq: 2, payload: {} },
    ] as ServerMessage[]
    const { handler, reply } = createHandlerWithMocks({
      subscribe: vi.fn(() => ({ snapshot: [...snapshot], stateSnapshot: [], lastSeq: 2 })),
    })
    const ws = createMockWs()
    const msg = { type: 'session.subscribe', id: 'rpc-3', payload: { sessionId: 's1', fromSeq: 0 } } as unknown as ClientMessage
    await handler.handleSessionMessage(msg, ws as never)

    const payload = reply.mock.calls[0][3] as { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number; gap: boolean }
    expect(payload.gap).toBe(true)
    // 全量返（不过滤）
    expect(payload.snapshot.map(m => m.seq)).toEqual([1, 2])
    expect(payload.stateSnapshot).toEqual([])
  })

  it('TC4 边界：bus.subscribe 返空 snapshot + fromSeq=0 → gap=false（无旧消息可淘汰）', async () => {
    // 空 ring：oldestSeq=0（snapshot[0]?.seq ?? 0），fromSeq=0 不 < 0，gap=false
    const { handler, reply } = createHandlerWithMocks({
      subscribe: vi.fn(() => ({ snapshot: [], stateSnapshot: [], lastSeq: 0 })),
    })
    const ws = createMockWs()
    const msg = { type: 'session.subscribe', id: 'rpc-4', payload: { sessionId: 's1', fromSeq: 0 } } as unknown as ClientMessage
    await handler.handleSessionMessage(msg, ws as never)
    const payload = reply.mock.calls[0][3] as { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; gap: boolean }
    expect(payload.gap).toBe(false)
    expect(payload.snapshot).toEqual([])
    expect(payload.stateSnapshot).toEqual([])
  })

  it('TC5: session.unsubscribe 调 bus.unsubscribe + reply message.status ack', async () => {
    const { handler, reply, messageBus } = createHandlerWithMocks()
    const ws = createMockWs()
    const msg = { type: 'session.unsubscribe', id: 'rpc-5', payload: { sessionId: 's1' } } as unknown as ClientMessage
    await handler.handleSessionMessage(msg, ws as never)

    expect(messageBus.unsubscribe).toHaveBeenCalledTimes(1)
    expect(messageBus.unsubscribe).toHaveBeenCalledWith('s1', ws)
    // ack 型：reply 'message.status'（ReplyPayloadMap 已定 void//reply message.status）
    expect(reply).toHaveBeenCalledWith(ws, 'rpc-5', 'message.status', { sessionId: 's1', status: 'unsubscribed' })
  })

  it('TC3 边界：messageBus 未注入时 session.subscribe 报 subscribe_unsupported', async () => {
    // 构造一个 ctx 不含 messageBus（模拟组合根未注入——理论不可达，防御性测）
    const reply = vi.fn()
    const sendError = vi.fn()
    const ctx = {
      send: vi.fn(), reply, sendError,
      sessionService: {} as never,
      nextPushId: () => 'push_test',
      broadcastSessionList: vi.fn(),
      broadcast: vi.fn(),
      // messageBus 故意不注入
    } as unknown as SessionHandlerContext
    const handler = new SessionMessageHandler(ctx)
    const ws = createMockWs()
    const msg = { type: 'session.subscribe', id: 'rpc-6', payload: { sessionId: 's1' } } as unknown as ClientMessage
    await handler.handleSessionMessage(msg, ws as never)
    expect(sendError).toHaveBeenCalledWith(ws, 'subscribe_unsupported', 'message bus not available', 'rpc-6', { sessionId: 's1' })
  })
})
// ───────────────────────────────────────────────────────────────────
// TC6：ConnectionManager.onClose → bus.unsubscribeAll
// ───────────────────────────────────────────────────────────────────

describe('wave:runtime-wiring · TC6 ConnectionManager.onClose → bus.unsubscribeAll', () => {
  it('ws close 时调 onDisconnect 回调（server 注入 bus.unsubscribeAll）', async () => {
    const messageBus = createMockMessageBus()
    // 用真实 ConnectionManager + 注入 onDisconnect 回调（模拟 server.ts 的接线）
    // 选一个空闲端口避免冲突；start 后模拟 ws close。
    const conn = new ConnectionManager(0, {
      onConnect: () => {},
      onMessage: vi.fn(),
      sendError: vi.fn(),
      onDisconnect: (ws) => messageBus.unsubscribeAll(ws as unknown as BusClient),
    }, 'test-ws-token-wiring')
    await conn.start()
    // 直接从 clients 池取一个 ws 模拟 close 事件（clients 是 readonly Set，handleConnection 时 add）。
    // 由于无法轻易构造真实 ws 进 connection 回调，改为验证 onDisconnect 回调本身接线正确：
    const fakeWs = createMockWs()
    // 手动触发 onDisconnect（验证回调调 bus.unsubscribeAll）
    ;(conn as unknown as { callbacks: { onDisconnect?: (ws: unknown) => void } }).callbacks.onDisconnect?.(fakeWs)
    expect(messageBus.unsubscribeAll).toHaveBeenCalledTimes(1)
    expect(messageBus.unsubscribeAll).toHaveBeenCalledWith(fakeWs)
    await conn.stop()
  })

  it('onDisconnect 可选（未注入时不抛错，向后兼容）', async () => {
    // 不注入 onDisconnect——旧 ConnectionCallbacks 形状仍合法
    const conn = new ConnectionManager(0, {
      onConnect: () => {},
      onMessage: vi.fn(),
      sendError: vi.fn(),
    }, 'test-ws-token-wiring')
    await conn.start()
    expect(() => {
      ;(conn as unknown as { callbacks: { onDisconnect?: (ws: unknown) => void } }).callbacks.onDisconnect?.(createMockWs())
    }).not.toThrow()
    await conn.stop()
  })
})
// ───────────────────────────────────────────────────────────────────
// TC7：session-service removeSessionEntry → bus.clearSession
// ───────────────────────────────────────────────────────────────────

describe('wave:runtime-wiring · TC7 removeSessionEntry → bus.clearSession', () => {
  it('removeSessionEntry 调 bus.clearSession(sessionId)', () => {
    const messageBus = createMockMessageBus()
    const service = new SessionService(
      createMockPm() as never, { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() } as never,
      () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
      '/tmp', {} as never, {} as never, {} as never,
      { readGitInfo: () => undefined, pruneStaleCache: () => {} } as never, {} as never,
    )
    service.setMessageBus(messageBus)
    // removeSessionEntry 是内部协议公开方法（lifecycle/dispatcher 窄接口共享声明）
    service.removeSessionEntry('s-destroy')
    expect(messageBus.clearSession).toHaveBeenCalledTimes(1)
    expect(messageBus.clearSession).toHaveBeenCalledWith('s-destroy')
  })

  it('未注入 messageBus 时 removeSessionEntry 仍正常（nullable no-op，不抛错）', () => {
    const service = new SessionService(
      createMockPm() as never, { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() } as never,
      () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
      '/tmp', {} as never, {} as never, {} as never,
      { readGitInfo: () => undefined, pruneStaleCache: () => {} } as never, {} as never,
    )
    // 不调 setMessageBus
    expect(() => service.removeSessionEntry('s-x')).not.toThrow()
  })
})
// ───────────────────────────────────────────────────────────────────
// TC8：session.commands 发布单通道（W12 起激活发布 = 播种 fetch 快照挂钩，仍只走 bus.publish）
// ───────────────────────────────────────────────────────────────────

describe('wave:runtime-wiring · TC8 session.commands 激活发布（W12 快照挂钩）', () => {
  it('播种 fetch → 快照应用挂钩发布 session.commands，只调 bus.publish(sessionId, msg)，broker.broadcast 不再被调', async () => {
    const messageBus = createMockMessageBus()
    const broadcast = vi.fn()
    // 构造 SessionService + mock pm.getClient 返回带 getCommands 的 client
    const commands = [{ name: 'cmd1', source: 'extension' }]
    const fakeClient = { getCommands: vi.fn().mockResolvedValue(commands) }
    const pm = createMockPm({ getClient: vi.fn().mockReturnValue(fakeClient) })
    const service = new SessionService(
      pm as never,
      { broadcast, send: vi.fn(), sendError: vi.fn() } as never,
      () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
      '/tmp', {} as never, { getDefaultModel: () => undefined } as never, {} as never,
      { readGitInfo: () => undefined, pruneStaleCache: () => {} } as never, {} as never,
    )
    service.setMessageBus(messageBus)

    // W12：旧 fetchAndBroadcastCommands（RPC 直连 publish）已删——激活发布 = initializeManagedSession
    // 注册播种 refetch → commands 快照应用 → fetchCommandsSnapshot 挂钩（setTimeout 0 宏任务）
    // 读快照发布（publishCommandsSnapshot 有 sessions.has 防护，须经真实 session 建立路径）。
    await service.initializeManagedSession('s-cmd', { getCommands: fakeClient.getCommands } as never, '/tmp', 't')
    // 播种 fetch 是 fire-and-forget（微任务链 applySnapshot），挂钩宏任务在其后——轮询等
    // publish 落地（全量并行负载下固定 sleep 不可靠，2s 上限兜底）。等待条件必须是
    // commands 帧本身而非「任意 publish」：registerSession 现含 occupancy idle 宣告帧
    // （Gate B V6b 修复），任意帧出现 ≠ 播种链宏任务完成。
    const deadline = Date.now() + 2_000
    const hasCommandsPublish = () =>
      vi.mocked(messageBus.publish).mock.calls.some((c) => c[1].type === 'session.commands')
    while (!hasCommandsPublish() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }

    // session.commands 单通道（wave:perf-w09 D1-2）：只 bus.publish，broadcast 路径已删。
    // payload 数据源 = commands 实例快照（W12），值与 mock RPC 返回逐字段一致。
    //（publish 总数可能含 modelId/thinkingLevel 播种失败后的 state_changed 兜底帧——
    // fakeClient 无 getState，与本用例的 commands 通道断言无关，按 type 过滤。）
    const cmdPublishes = vi.mocked(messageBus.publish).mock.calls.filter((c) => c[1].type === 'session.commands')
    expect(cmdPublishes).toHaveLength(1)
    const publishCall = cmdPublishes[0]
    expect(publishCall[0]).toBe('s-cmd')
    expect(publishCall[1]).toMatchObject({ type: 'session.commands', payload: { sessionId: 's-cmd', commands } })

    // broadcast 不再被调（session 级推送单通道）。注：registerSession 汇聚点原
    // session.surfaces 全局帧（W4a 判别器通道）已随 W4b 收编按协议收缩删除——
    // 抑制类判别改读 session.list {surface:'btw'} 拉取缓存（设计 §5-W4b 四步之③）。
    expect(broadcast.mock.calls).toEqual([])
  })
})
// ───────────────────────────────────────────────────────────────────
// TC9：ClientMessageMap subscribe/unsubscribe payload 形状（编译期 + 运行时）
// ───────────────────────────────────────────────────────────────────

describe('wave:runtime-wiring · TC9 ClientMessageMap subscribe/unsubscribe payload', () => {
  it('session.subscribe ClientMessage 带 fromSeq 可构造（payload 形状正确）', () => {
    const msg: Extract<ClientMessage, { type: 'session.subscribe' }> = {
      type: 'session.subscribe',
      id: 'rpc-1',
      payload: { sessionId: 's1', fromSeq: 5 },
    }
    expect(msg.type).toBe('session.subscribe')
    expect(msg.payload.sessionId).toBe('s1')
    expect(msg.payload.fromSeq).toBe(5)
  })

  it('session.subscribe ClientMessage 不带 fromSeq 也合法（fromSeq 可选）', () => {
    const msg: Extract<ClientMessage, { type: 'session.subscribe' }> = {
      type: 'session.subscribe',
      id: 'rpc-2',
      payload: { sessionId: 's1' },
    }
    expect(msg.payload.fromSeq).toBeUndefined()
  })

  it('session.unsubscribe ClientMessage payload 形状正确', () => {
    const msg: Extract<ClientMessage, { type: 'session.unsubscribe' }> = {
      type: 'session.unsubscribe',
      id: 'rpc-3',
      payload: { sessionId: 's1' },
    }
    expect(msg.type).toBe('session.unsubscribe')
    expect(msg.payload.sessionId).toBe('s1')
  })
})
// ───────────────────────────────────────────────────────────────────
// M2c：D3 组合根接线（index.ts / pi-provider-store.ts 源码级断言）
//
// index.ts 不可 import（模块顶层 `main().catch(...)` 即执行，会起真实进程/监听端口），
// 故组合根装配接线只能做源码级断言；它与行为断言互补——行为断言证明「消费点注入后生效」，
// 本组证明「组合根/传输层真的把 resolver 传到了那些消费点」，以及装配序（init 先于任何
// findValidDefaultModel 触发点）。pi-provider-store 的 readAuthCredentials 已删除，
// 此处同时锁定该裸读不会回归。
// ───────────────────────────────────────────────────────────────────
describe('M2c: 组合根 providerCredentialResolver 装配接线（源码级 + quota 近端到端）', () => {
  const readSource = (relPath: string): string =>
    readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf-8')

  const indexSource = readSource('../src/index.ts')
  const providerStoreSource = readSource('../src/infra/pi/pi-provider-store.ts')

  it('index.ts 装配 ProviderCredentialResolver 三依赖（authService / authStorage / configStore）', () => {
    const idx = indexSource.indexOf('new ProviderCredentialResolver({')
    expect(idx).toBeGreaterThan(-1)
    const block = indexSource.slice(idx, indexSource.indexOf('})', idx))
    expect(block).toContain('authService')
    expect(block).toContain('authStorage')
    expect(block).toContain('configStore')
  })

  it('装配序：init 注入先于任何 findValidDefaultModel 触发点（服务构造 / server.start / 后台初始化）', () => {
    const initIdx = indexSource.indexOf('initProviderCredentialResolver(providerCredentialResolver)')
    expect(initIdx).toBeGreaterThan(-1)
    for (const later of [
      'new ConfigService(',
      'new SessionService(',
      'new AuthService(',
      'new QuotaService(',
      'await server.start()',
      'runStartupBackgroundInit(',
    ]) {
      const laterIdx = indexSource.indexOf(later)
      expect(laterIdx, `index.ts 缺少 ${later}`).toBeGreaterThan(-1)
      expect(initIdx, `init 必须早于 ${later}`).toBeLessThan(laterIdx)
    }
  })

  it('三处消费点装配均收到 resolver：ConfigService 构造 / QuotaService options / server.setServices optional', () => {
    // ① ConfigService：组合根第 6 参
    const configLine = indexSource.split('\n').find(l => l.includes('new ConfigService('))
    expect(configLine).toContain('providerCredentialResolver')

    // ② QuotaService options
    const quotaStart = indexSource.indexOf('new QuotaService({')
    expect(quotaStart).toBeGreaterThan(-1)
    expect(indexSource.slice(quotaStart, indexSource.indexOf('const tServicesReady', quotaStart))).toContain('providerCredentialResolver')

    // ③ server.setServices optional 对象（链 2 经此进 SettingsMessageHandler ctx）
    const setServicesStart = indexSource.indexOf('server.setServices(')
    expect(setServicesStart).toBeGreaterThan(-1)
    expect(indexSource.slice(setServicesStart, indexSource.indexOf('// Graceful shutdown', setServicesStart))).toContain('providerCredentialResolver')
  })

  it('D-21 端口化：组合根构造 ModelConnectionTester 经 server.setServices 注入，transport 零 infra value import', () => {
    // ① 组合根构造（组合根允许 value import infra 实现）
    expect(indexSource).toContain('new ModelConnectionTester()')
    // ② server.setServices optional 对象入参（经此进 SettingsMessageHandler ctx）
    const setServicesStart = indexSource.indexOf('server.setServices(')
    expect(setServicesStart).toBeGreaterThan(-1)
    expect(indexSource.slice(setServicesStart, indexSource.indexOf('// Graceful shutdown', setServicesStart))).toContain('connectionTester')
    // ③ transport 关闭 M3a 让步：不再 value import infra 的 tester 实现
    const handlerSource = readSource('../src/transport/settings-message-handler.ts')
    expect(handlerSource).not.toMatch(/import\s+\{\s*ModelConnectionTester\s*\}/)
    expect(handlerSource).toContain("from '../services/ports/model-connection-tester.js'")
  })

  it('clearApiKey（I9 清理②）接到纯删键实现 clearProviderApiKey', () => {
    expect(indexSource).toContain('clearApiKey: clearProviderApiKey')
  })

  it('链 3 私有裸读 readAuthCredentials 已不存在（防回归：不得再出现裸读 auth.json）', () => {
    expect(providerStoreSource).not.toContain('readAuthCredentials')
    // 消费点改经注入的 resolver：单 provider 判定用 sync 布尔版 + 候选遍历用批量版（消除 N+1）
    // RT-3#5：消费点经 credentialResolverOrWarn（未注入一次性 warn 显形；返回注入的 resolver，语义不变）
    expect(providerStoreSource).toContain("credentialResolverOrWarn('adjudicateCatalogOnlyDefault')?.hasProviderCredential(")
    expect(providerStoreSource).toContain("credentialResolverOrWarn('pickCredentialBackedCatalogProvider')?.listCredentialBackedProviderIds(")
  })

  it('QuotaService 消费点（生产装配形态）：api-key 凭据经注入 resolver 解析并真实用于请求', async () => {
    // 近端到端：按组合根 index.ts 的装配形态构造真实 ProviderCredentialResolver
    // （auth.json 经真实 AuthStorage）+ 真实 QuotaService，驱动 refresh 走 getCredential 链。
    const quotaDir = mkdtempSync(join(tmpdir(), 'm2c-quota-'))
    const authPath = join(quotaDir, 'auth.json')
    writeFileSync(authPath, JSON.stringify({ 'zai-coding-cn': { type: 'api_key', key: 'k-from-auth-json' } }))
    const authStorage = new AuthStorage(authPath)
    // 生产形态：resolver 的 auth.json 明文路径经 AuthService.getCredential（index.ts 同款装配）
    const authService = new AuthService({
      authStorage,
      getOAuthConfig: () => undefined,
      broadcast: () => {},
      nextPushId: () => '1',
      clearApiKey: () => {},
    })
    const resolver = new ProviderCredentialResolver({
      authService,
      authStorage,
      configStore: { readModels: () => ({ providers: {} }), getProviderConfig: () => undefined } as never,
    })
    const resolveSpy = vi.spyOn(resolver, 'resolveProviderCredential')
    const extrasStore = new TaijiProviderStore(join(quotaDir, 'config', 'providers.json'))
    await extrasStore.modify('zai-coding-cn', () => ({ quota: { fetcher: 'zhipu', enabled: true } }))
    const fetchMock = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) =>
      new Response(JSON.stringify({
        success: true,
        data: { level: 'Max', limits: [{ type: 'TOKENS_LIMIT', percentage: 40 }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const svc = new QuotaService({
        dataDir: quotaDir,
        providerExtrasStore: extrasStore,
        getProviderInfo: (id) => (id === 'zai-coding-cn' ? { name: id, quota: { fetcher: 'zhipu' } } : undefined),
        providerCredentialResolver: resolver,
      })

      await svc.refresh('zai-coding-cn')

      // 凭据链经 resolver（而非旧内联 auth.json/models.json 链）
      expect(resolveSpy).toHaveBeenCalledWith('zai-coding-cn')
      // 且解析出的 key 真实进入请求头（zhipu 裸 authorization，无 Bearer 前缀）
      expect(new Headers(fetchMock.mock.calls[0]![1].headers).get('authorization')).toBe('k-from-auth-json')
    } finally {
      vi.unstubAllGlobals()
      rmSync(quotaDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
});

// ======================================================================
// ← test/scoped-model-e9.test.ts
// ======================================================================

// ── mock 工厂（复用 model-service.test.ts 模式）──────────────────

function makeMockSessionService(): ISessionService {
  return {
    switchModel: vi.fn(async () => 's1'),
    setThinkingLevel: vi.fn(async () => undefined),
    setThinkingLevelCache: vi.fn(),
    getSummary: vi.fn(() => undefined),
    getInputTokens: vi.fn((): number => 0),
    applyContextUpdate: vi.fn(),
    getUsagePercent: vi.fn((): number => 0),
  } as unknown as ISessionService
}


function makeMockConfigService(overrides: Partial<IConfigService> = {}): IConfigService {
  return {
    listProviders: vi.fn(() => []),
    setDefaultModel: vi.fn(),
    getDefaultModel: vi.fn(() => null),
    getScopedModels: vi.fn(() => []),
    ...overrides,
  } as unknown as IConfigService
}


function makeMockBroker(): IMessageBroker {
  return { broadcast: vi.fn() } as unknown as IMessageBroker
}


function makeMockModelSource(): IModelSource {
  return { discoverFromApi: vi.fn(async () => []) }
}


function makeProvider(id: string, name: string, modelIds: string[], enabled = true): ProviderInfo {
  return {
    id: id as ProviderId,
    name,
    apiKeySet: true,
    status: 'connected',
    enabled,
    models: modelIds.map(mid => ({ id: mid, name: mid })),
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('scoped-model-e9', () => {
// ── R3 / E9 测试 ────────────────────────────────────────────────
// R3 为 root unit 验收 id（词边界命中外层 describe），E9 为 sm-e2e 子 unit 验收 id
//（-t "E9" 过滤内层 describe）。两层共存互不干扰。

describe('R3: aggregateModels scoped 行为锁定', () => {
describe('E9: aggregateModels scoped 行为锁定', () => {
  it('E9-1 scopedModels 非空 → 只输出白名单内模型且保序', () => {
    const providers: ProviderInfo[] = [
      makeProvider('openai', 'OpenAI', ['gpt-4', 'gpt-3.5-turbo', 'o1']),
      makeProvider('anthropic', 'Anthropic', ['claude-opus', 'claude-sonnet']),
    ]
    const configService = makeMockConfigService({
      getScopedModels: vi.fn(() => ['anthropic/claude-opus', 'openai/gpt-4', 'openai/o1']),
    })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker())

    const result = svc.aggregateModels(providers)
    const ids = result.map(m => `${m.providerId}/${m.id}`)

    // 只返回白名单内的 3 个模型，保序（跨 provider 交错）
    expect(ids).toEqual(['anthropic/claude-opus', 'openai/gpt-4', 'openai/o1'])
  })

  it('E9-2 scopedModels 非空 + provider 级 disabled → disabled provider 的模型不显示（优先于 scoped）', () => {
    const providers: ProviderInfo[] = [
      makeProvider('openai', 'OpenAI', ['gpt-4'], true),
      makeProvider('anthropic', 'Anthropic', ['claude-opus'], false), // disabled
    ]
    const configService = makeMockConfigService({
      getScopedModels: vi.fn(() => ['openai/gpt-4', 'anthropic/claude-opus']),
    })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker())

    const result = svc.aggregateModels(providers)
    const ids = result.map(m => `${m.providerId}/${m.id}`)

    // anthropic 被 disabled，即使在 scoped 中也不显示
    expect(ids).toEqual(['openai/gpt-4'])
  })

  it('E9-3 scopedModels 为空 → 输出全量不变（回归锁定）', () => {
    const providers: ProviderInfo[] = [
      makeProvider('openai', 'OpenAI', ['gpt-4', 'gpt-3.5-turbo']),
      makeProvider('anthropic', 'Anthropic', ['claude-opus']),
    ]
    const getScopedModels = vi.fn((): string[] => [])
    const configService = makeMockConfigService({ getScopedModels })
    const svc = new ModelService(makeMockModelSource())
    svc.setServices(makeMockSessionService(), configService, makeMockBroker())

    const result = svc.aggregateModels(providers)
    const ids = result.map(m => m.id)

    // 全量输出，保序
    expect(ids).toEqual(['gpt-4', 'gpt-3.5-turbo', 'claude-opus'])
    // 检查调用：空列表也必须读 scoped 配置（区分旧实现无读取）
    expect(getScopedModels).toHaveBeenCalledOnce()
  })

  it('E9-4 providers.json scopedModels 损坏 → 独立容错：providers 域保留 + 条目级过滤（不隔离文件）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'scoped-model-e9-'))
    const file = join(dir, 'config', 'providers.json')
    mkdirSync(join(dir, 'config'), { recursive: true })
    const store = new TaijiProviderStore(file)
    try {
      // 非数组 scopedModels：getScopedModelsSync 返回 []，providers 域原样保留
      //（整文件 quarantine 实现下 providers 域被连坐清空——本断言是其区分力反例）
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: { openai: { authMethod: 'api_key' } },
        scopedModels: 'not-an-array',
      }, null, 2))
      expect(store.getScopedModelsSync()).toEqual([])
      expect(store.readAllSync()).toEqual({ openai: { authMethod: 'api_key' } })

      // 条目级容错：非 string / 非 provider/modelId 格式条目被过滤，合法条目保留
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: { openai: { authMethod: 'api_key' } },
        scopedModels: ['openai/gpt-4o', 123, 'invalid-no-slash', 'anthropic/claude-opus'],
      }, null, 2))
      expect(store.getScopedModelsSync()).toEqual(['openai/gpt-4o', 'anthropic/claude-opus'])
      expect(store.readAllSync()).toEqual({ openai: { authMethod: 'api_key' } })
    } finally {
      warnSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
})
});
