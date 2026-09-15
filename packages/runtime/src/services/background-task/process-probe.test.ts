/**
 * probeProcessStartTimeMs 单测（D6 身份验证两档「按需现测」档的输入侧——kill 安全属性
 * 「宁不杀勿误杀」的第一道守卫，background-task-service.test.ts 全走 deps 注入 mock，
 * 真实实现仅由本文件加载）。
 *
 * 覆盖四个安全分支（review round1 test-coverage MUST_FIX）：
 * ① 非法 pid 守卫（0/负数/非整数）→ undefined = 分支④拒绝 kill 的输入侧
 * ② parseEpochMs 解析失败（垃圾 stdout / 空 stdout）→ undefined（核心安全分支：
 *    若返回 NaN 而非 undefined 会绕过「宁不杀勿误杀」拒绝 → 误杀无辜新进程）
 * ③ posix `ps -o lstart=` 与 win32 ISO 8601 两平台分支的合法输出 → epoch ms，
 *    附命令/超时/windowsHide 形态断言
 * ④ execFile reject（超时/进程不存在/权限拒绝）→ undefined
 *
 * Mock 边界：仅 mock node:child_process 的 execFile（保真复刻 promisify.custom 形态，
 * resolve { stdout, stderr }——与生产 promisify(execFile) 契约一致）；平台分支经
 * process.platform 定义切换（afterEach 恢复）。纯内存无 fs 写删、无真实 timer
 * （超时以 options 形态传入 mock，断言值即可，不需要 fake timers）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/background-task/process-probe.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { promisify } from 'node:util'

import { probeProcessStartTimeMs, PROBE_TIMEOUT_MS } from './process-probe.js'

// ── execFile mock：保真复刻 callback + promisify.custom 双形态 ──────

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  // callback 形态（promisify 默认路径不消费，仅为形态完整性）
  const mocked = ((file: string, args: readonly string[], options: object, callback: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    execFileMock(file, args, options, callback)
  }) as unknown as typeof actual.execFile
  // promisify.custom 形态：真实 execFile 经 promisify 后 resolve { stdout, stderr }——
  // process-probe.ts 模块加载期即 promisify(execFile)，必须走同一路径才反映生产契约
  Object.defineProperty(mocked, promisify.custom, {
    value: (file: string, args: readonly string[], options: object) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFileMock(file, args, options, (err: Error | null, out: { stdout: string; stderr: string }) =>
          err ? reject(err) : resolve(out),
        )
      }),
  })
  return { ...actual, execFile: mocked }
})

type ExecCallback = (err: Error | null, out: { stdout: string; stderr: string }) => void

function resolveWith(stdout: string): void {
  execFileMock.mockImplementation((_file: string, _args: readonly string[], _options: object, cb: ExecCallback) => {
    cb(null, { stdout, stderr: '' })
  })
}

function rejectWith(err: Error): void {
  execFileMock.mockImplementation((_file: string, _args: readonly string[], _options: object, cb: ExecCallback) => {
    cb(err, { stdout: '', stderr: '' }) // reject 路径 out 不被消费，空形态占位
  })
}

// ── platform 切换（process.platform 是 getter-only 自有属性，须 defineProperty） ──

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  execFileMock.mockReset()
  vi.restoreAllMocks()
})

const PID = 4242

// ── 四个安全分支 ──────────────────────────────────────────────────

describe('probeProcessStartTimeMs：kill 安全判定输入侧（undefined = 分支④拒绝 kill）', () => {
  it('① 非法 pid（0/负数/非整数/非有限数）→ undefined，不发起探测', async () => {
    setPlatform('darwin')
    resolveWith('Mon Sep  7 10:00:00 2026') // 若守卫失效，此输出会返回合法 ms——用「未被调用」双保险
    for (const pid of [0, -1, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(probeProcessStartTimeMs(pid)).resolves.toBeUndefined()
    }
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('② posix stdout 垃圾文本 → undefined（解析失败不得为 NaN，否则绕过拒绝分支误杀）', async () => {
    setPlatform('darwin')
    resolveWith('process not found\n') // ps 对不存在 pid 的部分形态输出非日期文本
    await expect(probeProcessStartTimeMs(PID)).resolves.toBeUndefined()
  })

  it('②b posix 空 stdout → undefined（ps 输出空白的退化形态）', async () => {
    setPlatform('darwin')
    resolveWith('   \n')
    await expect(probeProcessStartTimeMs(PID)).resolves.toBeUndefined()
  })

  it('③ posix 合法 `ps -o lstart=` 输出 → epoch ms；命令/超时形态正确', async () => {
    setPlatform('darwin')
    const lstart = 'Mon Sep  7 10:00:00 2026' // Date.parse 按本地时区解释（与登记侧同源）
    resolveWith(`${lstart}\n`)
    await expect(probeProcessStartTimeMs(PID)).resolves.toBe(Date.parse(lstart))
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [file, args, opts] = execFileMock.mock.calls[0] as [string, string[], { timeout: number }]
    expect(file).toBe('ps')
    expect(args).toEqual(['-o', 'lstart=', '-p', String(PID)])
    expect(opts.timeout).toBe(PROBE_TIMEOUT_MS)
  })

  it('③b win32 合法 ISO 8601 输出 → epoch ms；powershell 命令/超时/windowsHide 形态正确', async () => {
    setPlatform('win32')
    const iso = '2026-09-07T02:00:00.000Z' // Get-Process StartTime → 'o' round-trip 格式
    resolveWith(`${iso}\n`)
    await expect(probeProcessStartTimeMs(PID)).resolves.toBe(Date.parse(iso))
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [file, args, opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { timeout: number; windowsHide: boolean },
    ]
    expect(file).toBe('powershell.exe')
    expect(args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${PID} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
    ])
    expect(opts.timeout).toBe(PROBE_TIMEOUT_MS)
    expect(opts.windowsHide).toBe(true)
  })

  it('③c win32 stdout 垃圾文本 → undefined（第二平台分支的解析失败同守卫）', async () => {
    setPlatform('win32')
    resolveWith('Access is denied.')
    await expect(probeProcessStartTimeMs(PID)).resolves.toBeUndefined()
  })

  it('④ 探测命令 reject（超时/进程不存在/权限拒绝）→ undefined', async () => {
    setPlatform('darwin')
    rejectWith(Object.assign(new Error('Command failed: ps -o lstart= -p 4242'), { killed: true, code: null }))
    await expect(probeProcessStartTimeMs(PID)).resolves.toBeUndefined()
  })

  it('探测超时契约：PROBE_TIMEOUT_MS = 1000（D6 在役 RPC 路径短超时 ≤1s）', () => {
    expect(PROBE_TIMEOUT_MS).toBe(1_000)
  })
})
