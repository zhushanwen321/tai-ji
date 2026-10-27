import { EventAdapter } from '../../infra/pi/event-adapter.js';
import { OUTPUT_TAIL_DEFAULT_MAX_BYTES, OUTPUT_TAIL_MAX_LINES, readOutputTail } from './output-tail.js';
import { PROBE_TIMEOUT_MS, probeProcessStartTimeMs } from './process-probe.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/background-task/event-adapter-background-task-hooks.test.ts
// ======================================================================

function attachAdapter(onBackgroundTaskActivity?: (sessionId: string) => void) {
  const interpret = vi.fn()
  const adapter = new EventAdapter('sid-1', interpret, onBackgroundTaskActivity)
  let listener: (event: unknown) => void = () => {}
  const unsub = vi.fn()
  adapter.attach({ onEvent: (l) => { listener = l as typeof listener; return unsub } })
  return { adapter, interpret, listener, unsub }
}


const BASH_EXIT_NOTICE = {
  type: 'message_start',
  message: { role: 'custom', content: '[background-bash] bt-x finished (exit 0)', customType: 'background-bash' },
}

const BASH_TOOL_END = {
  type: 'tool_execution_end',
  toolCallId: 'tc-1',
  toolName: 'bash',
  result: { content: [{ type: 'text', text: 'ok' }] },
  isError: false,
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('event-adapter-background-task-hooks', () => {
describe('EventAdapter 后台任务旁路钩子（D2 触发点②）', () => {
  it('customType background-bash 消息触发旁路，翻译输出不受影响（message.customStart 照常产出）', () => {
    const activity = vi.fn()
    const { interpret, listener } = attachAdapter(activity)
    listener(BASH_EXIT_NOTICE)
    expect(activity).toHaveBeenCalledTimes(1)
    expect(activity).toHaveBeenCalledWith('sid-1')
    // 纯旁路：既有翻译（customStart 帧）原样产出
    const kinds = interpret.mock.calls[0][0].map((e: { kind: string }) => e.kind)
    expect(kinds).toContain('message')
  })

  it('bash 工具调用结束触发旁路；非 bash 工具不触发', () => {
    const activity = vi.fn()
    const { listener } = attachAdapter(activity)
    listener(BASH_TOOL_END)
    expect(activity).toHaveBeenCalledTimes(1)
    listener({ ...BASH_TOOL_END, toolName: 'read' })
    listener({ type: 'message_start', message: { role: 'custom', content: '', customType: 'other-type' } })
    listener({ type: 'agent_start' })
    expect(activity).toHaveBeenCalledTimes(1)
  })

  it('未注入回调：零影响不炸（既有两参构造兼容）', () => {
    const { interpret, listener } = attachAdapter(undefined)
    expect(() => listener(BASH_EXIT_NOTICE)).not.toThrow()
    expect(() => listener(BASH_TOOL_END)).not.toThrow()
    expect(interpret).toHaveBeenCalledTimes(2)
  })

  it('畸形事件形态：旁路静默跳过，不干扰翻译/事件流', () => {
    const activity = vi.fn()
    const { interpret, listener } = attachAdapter(activity)
    // 畸形但非 null（PiEventListener 契约事件流无 null；null 违约不在此测）
    expect(() => listener({ type: 'message_start', message: null })).not.toThrow()
    expect(() => listener({ type: 42 })).not.toThrow()
    expect(activity).not.toHaveBeenCalled()
    // 正常翻译仍工作：message:null 走 assistant-turn 兜底分支产出 2 事件，type:42 未知类型 0 事件（不进 interpret）
    listener(BASH_EXIT_NOTICE)
    expect(activity).toHaveBeenCalledTimes(1)
    expect(interpret).toHaveBeenCalledTimes(2)
  })
})
});

// ======================================================================
// ← src/services/background-task/output-tail.test.ts
// ======================================================================

let dir: string

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('output-tail', () => {
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bg-task-tail-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('runtime 侧 tail 口径（调用方实参契约）', () => {
  it('默认口径常量：32KB（D3 output RPC 默认上界）/ 2000 行', () => {
    expect(OUTPUT_TAIL_DEFAULT_MAX_BYTES).toBe(32 * 1024)
    expect(OUTPUT_TAIL_MAX_LINES).toBe(2000)
  })

  it('re-export 链可读尾部：小文件全文返回（protocol 实现，text/truncated 形态）', () => {
    const p = join(dir, 'task.log')
    writeFileSync(p, 'line1\nline2\nline3\n', 'utf8')
    expect(readOutputTail(p, { maxBytes: OUTPUT_TAIL_DEFAULT_MAX_BYTES, maxLines: OUTPUT_TAIL_MAX_LINES })).toEqual({
      text: 'line1\nline2\nline3\n',
      truncated: false,
    })
  })

  it('行上限口径生效：超 2000 行截尾且 truncated=true（2000 行实参透传 protocol）', () => {
    const p = join(dir, 'many.log')
    writeFileSync(p, Array.from({ length: 2500 }, (_, i) => `n${i}`).join('\n'), 'utf8')
    const result = readOutputTail(p, { maxBytes: 1024 * 1024, maxLines: OUTPUT_TAIL_MAX_LINES })
    expect(result!.truncated).toBe(true)
    expect(result!.text.split('\n')).toHaveLength(2000)
    expect(result!.text.endsWith('n2499')).toBe(true)
  })

  it('文件不存在 → undefined（调用方映射 lost 语义）', () => {
    expect(readOutputTail(join(dir, 'never.log'), { maxBytes: OUTPUT_TAIL_DEFAULT_MAX_BYTES, maxLines: OUTPUT_TAIL_MAX_LINES })).toBeUndefined()
  })
})
});

// ======================================================================
// ← src/services/background-task/process-probe.test.ts
// ======================================================================

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


const PID = 4242

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('process-probe', () => {
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  execFileMock.mockReset()
  vi.restoreAllMocks()
})
// ── 四个安全分支 ──────────────────────────────────────────────────

describe('probeProcessStartTimeMs：kill 安全判定输入侧（undefined = 分支④拒绝 kill）', () => {
  it('① 非法 pid（0/负数/非整数/非有限数）→ undefined，不发起探测', async () => {
    setPlatform('darwin')
    resolveWith('Mon Sep  7 10:00:00 2026') // 若检查失效，此输出会返回合法 ms——用「未被调用」双保险
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

  it('③c win32 stdout 垃圾文本 → undefined（第二平台分支的解析失败同检查）', async () => {
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
});
