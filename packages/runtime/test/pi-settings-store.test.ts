import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

import lockfile from 'proper-lockfile'
import {
  readSettings,
  writeSettings,
  updateSettingsFields,
  setSettingsPath,
  setSettingsLockTimingForTest,
  getActiveSettingsPath,
  invalidateSettingsCache,
  type PiSettings,
} from '../src/infra/pi/pi-settings-store.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

let tmpDir: string
let settingsPath: string

beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'pi-settings-store-test-'))
  settingsPath = join(tmpDir, 'agent', 'settings.json')
  mkdirSync(join(tmpDir, 'agent'), { recursive: true })
  setSettingsPath(settingsPath)
})

afterEach(async () => {
  // 恢复锁参数默认值，避免压缩预算泄漏到后续用例
  setSettingsLockTimingForTest({})
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

    it('returns empty on corrupt JSON', () => {
      writeFileSync(settingsPath, '{ broken', 'utf-8')
      expect(readSettings()).toEqual({})
    })

    it('returns empty on non-object JSON (e.g. array)', () => {
      writeFileSync(settingsPath, '[1,2,3]', 'utf-8')
      expect(readSettings()).toEqual({})
    })

    it('serves cached value within TTL', () => {
      writeFileSync(settingsPath, JSON.stringify({ v: 1 }), 'utf-8')
      expect(readSettings().v).toBe(1)
      writeFileSync(settingsPath, JSON.stringify({ v: 2 }), 'utf-8')
      // TTL 缓存挡住外部改动
      expect(readSettings().v).toBe(1)
    })
  })

  describe('writeSettings', () => {
    it('writes settings to disk', () => {
      writeSettings({ defaultModel: 'claude' })
      const raw = readFileSync(settingsPath, 'utf-8')
      expect(JSON.parse(raw)).toEqual({ defaultModel: 'claude' })
    })

    it('refreshes cache after write', () => {
      writeSettings({ defaultModel: 'a' })
      writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'b' }), 'utf-8')
      // write 刷新了缓存，但缓存值是 write 的值，不是盘上被外部改的
      expect(readSettings().defaultModel).toBe('a')
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

    // [HISTORICAL] 2026-08-20 PR #185：真实子进程持锁用例显式超时——真实 spawn node
    // 子进程持 proper-lockfile 锁，满并行 + 系统余载下 spawn/锁往返超 vitest 默认 5s
    // testTimeout（对齐 worktree-registry D5a 口径）。
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
