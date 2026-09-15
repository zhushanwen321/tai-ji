/**
 * u2-curl 验收测试：downloadViaCurl（spawn 系统 curl 整文件下载器）。
 *
 * 覆盖 impl-plan u2-curl 验收条款：
 *   ① spawn ENOENT 上抛形态不被 UpdateError 包装 / exit 33 删 temp 从头重下一次
 *      （fake child 两次调用）/ exit 7/28/35/56/22 各映射断言 / 进度 watch fake timers
 *   ② curl 参数数组断言（默认调用含 -f -L --connect-timeout 10 --speed-limit 1
 *      --speed-time 30 -C - -o <tempPath>；有代理时含 -x <proxyUrl>）
 *   ③ 子进程生命周期：非 detached 登记 + killActiveCurlDownloads 清杀 + 完成注销
 *
 * Mock 策略（不真实联网）：vi.mock node:child_process，spawn 返回 EventEmitter
 * 假 child（stdout/stderr/kill 可控，emit 'close'/'error' 驱动状态机）；temp 文件
 * 用真实 tmpdir（statSync 进度轮询与 exit 33 删 temp 均真实落盘可断言）。
 *
 * 运行：cd apps/electron/main && npx vitest run update/__tests__/curl-download.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ReleaseAsset } from '@taiji/shared'
import { UpdateError } from '../types.js'
import { downloadViaCurl, killActiveCurlDownloads, CurlConnectionError } from '../curl-download.js'

// ─── node:child_process mock（spawn 必须注入，不得真实联网） ─────────────────

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

// ─── 测试基建 ─────────────────────────────────────────────────────────────────

/** 假 ChildProcess：EventEmitter 形态，kill 模拟真实行为（SIGTERM → close(null, signal)）。 */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn(() => {
    child.emit('close', null, 'SIGTERM')
  })
  return child
}

/** 下载目标 fixture（不真实访问，URL 仅作参数断言对象）。 */
const ASSET: ReleaseAsset = {
  name: 'TaiJi-0.9.13-mac-arm64.dmg',
  downloadUrl: 'https://github.com/zhushanwen321/tai-ji/releases/download/v0.9.13/TaiJi-0.9.13-mac-arm64.dmg',
  size: 1000,
}

/** 验收条款 ② 的「args 含 <序列>」判定：连续子序列匹配（镜像验收文字语义）。 */
function containsSequence(args: unknown[], seq: string[]): boolean {
  outer: for (let i = 0; i + seq.length <= args.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (args[i + j] !== seq[j]) continue outer
    }
    return true
  }
  return false
}

/** 捕获 promise 的 rejection 值（避免 expect().rejects 无法保留实例做后续断言）。 */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  let caught: unknown
  await promise.then(
    () => { throw new Error('expected downloadViaCurl to reject, but it resolved') },
    (err: unknown) => { caught = err },
  )
  return caught
}

describe('u2-curl-download', () => {
  let tmpDir: string
  let tempPath: string
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    spawnMock.mockReset()
    tmpDir = mkdtempSync(join(tmpdir(), 'u2-curl-'))
    tempPath = join(tmpDir, `${ASSET.name}.downloading`)
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    vi.useRealTimers()
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function stubPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }

  // ── 验收 ②：curl 参数数组断言 ─────────────────────────────────────────────

  it('u2-args-default-call: darwin 默认调用构造的 args 含规定的连续 flag 序列（-f -L / connect-timeout 10 / speed-limit 1 / speed-time 30 / -C - / -o tempPath），spawn /usr/bin/curl 且 URL 在末位', async () => {
    stubPlatform('darwin')
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const promise = downloadViaCurl(ASSET, { tempPath })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, args, options] = spawnMock.mock.calls[0] as [string, string[], { detached?: boolean }]
    expect(cmd).toBe('/usr/bin/curl')
    expect(containsSequence(args, [
      '-f', '-L',
      '--connect-timeout', '10',
      '--speed-limit', '1',
      '--speed-time', '30',
      '-C', '-',
      '-o', tempPath,
    ])).toBe(true)
    // -w 捕获 http_code（exit 22 错误 message 依据，D6）
    expect(containsSequence(args, ['-w', '%{http_code}'])).toBe(true)
    // URL 必须是最后一个参数
    expect(args[args.length - 1]).toBe(ASSET.downloadUrl)
    // 非 detached（D6：生命周期归 main 进程管理）
    expect(options.detached).not.toBe(true)

    child.emit('close', 0, null)
    await promise
  })

  it('u2-args-proxy: 有代理时 args 含 -x <proxyUrl>，直连调用不含 -x', async () => {
    stubPlatform('darwin')
    const withProxy = makeFakeChild()
    const direct = makeFakeChild()
    spawnMock.mockReturnValueOnce(withProxy).mockReturnValueOnce(direct)
    const proxyUrl = 'http://user:pass@192.168.1.202:7890'

    const p1 = downloadViaCurl(ASSET, { tempPath, proxyUrl })
    expect(containsSequence(spawnMock.mock.calls[0][1] as string[], ['-x', proxyUrl])).toBe(true)
    withProxy.emit('close', 0, null)
    await p1

    const p2 = downloadViaCurl(ASSET, { tempPath, proxyUrl: undefined })
    expect((spawnMock.mock.calls[1][1] as string[]).includes('-x')).toBe(false)
    direct.emit('close', 0, null)
    await p2
  })

  it('u2-cmd-linux: 非 darwin 平台 spawn PATH 解析的 curl（缺失时由 D10 第三步兜底）', async () => {
    stubPlatform('linux')
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const promise = downloadViaCurl(ASSET, { tempPath })
    expect(spawnMock.mock.calls[0][0]).toBe('curl')

    child.emit('close', 0, null)
    await promise
  })

  // ── 验收 ①：exit code 映射 ────────────────────────────────────────────────

  it('u2-success: exit 0 返回 { tempPath }（不校验不 rename，归 downloadAsset）', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const promise = downloadViaCurl(ASSET, { tempPath })
    child.emit('close', 0, null)

    await expect(promise).resolves.toEqual({ tempPath })
  })

  it('u2-spawn-enoent: spawn ENOENT 原样上抛同一错误对象，不被 UpdateError 包装（D10 第三步引擎回退依据）', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)
    const enoent = Object.assign(new Error('spawn /usr/bin/curl ENOENT'), { code: 'ENOENT' })

    const promise = downloadViaCurl(ASSET, { tempPath })
    child.emit('error', enoent)

    const caught = await captureRejection(promise)
    expect(caught).toBe(enoent)
    expect(caught).not.toBeInstanceOf(UpdateError)
    expect((caught as NodeJS.ErrnoException).code).toBe('ENOENT')
    // ENOENT 后无重试（curl 可用性判定归编排方）
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('u2-exit33-retry: exit 33 删 temp 后从头重下一次（fake child 两次调用，重试成功）', async () => {
    const child1 = makeFakeChild()
    const child2 = makeFakeChild()
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2)
    // 预置残文件：exit 33 的删除动作有真实对象可删
    writeFileSync(tempPath, 'stale-partial')

    const promise = downloadViaCurl(ASSET, { tempPath, resumeBytes: 13 })

    child1.emit('close', 33, null)
    // 微任务冲刷：close → reject → catch（unlink + 二次 runCurlOnce → spawn#2）
    await new Promise((resolve) => setImmediate(resolve))

    expect(spawnMock).toHaveBeenCalledTimes(2)
    // 重下前 temp 已删（此刻第二次下载仍在进行，fake child 不写盘）
    expect(existsSync(tempPath)).toBe(false)
    // 从头重下：temp 已删后 `-C -` 自动从 0 起步，参数与首次一致
    expect(spawnMock.mock.calls[1][1]).toEqual(spawnMock.mock.calls[0][1])

    child2.emit('close', 0, null)
    await expect(promise).resolves.toEqual({ tempPath })
  })

  it('u2-exit33-retry-fails: 重试仍失败则按映射抛出（不再二次重试）', async () => {
    const child1 = makeFakeChild()
    const child2 = makeFakeChild()
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2)
    // exit 33 场景 temp 必然存在（续传起点即它），预置避免 best-effort 清理噪音
    writeFileSync(tempPath, 'stale-partial')

    const promise = downloadViaCurl(ASSET, { tempPath })
    child1.emit('close', 33, null)
    await new Promise((resolve) => setImmediate(resolve))
    child2.emit('close', 7, null)

    const caught = await captureRejection(promise)
    expect(caught).toBeInstanceOf(CurlConnectionError)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('u2-exit7: 连接失败抛 CurlConnectionError（UpdateError 子类 + curlExitCode=7），stderr 落 rawCause（供 D10 判定代理不可用）', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const promise = downloadViaCurl(ASSET, { tempPath, proxyUrl: 'http://192.168.1.202:7890' })
    child.stderr.emit('data', 'curl: (7) Failed to connect to 192.168.1.202 port 7890')
    child.emit('close', 7, null)

    const caught = await captureRejection(promise)
    expect(caught).toBeInstanceOf(CurlConnectionError)
    expect(caught).toBeInstanceOf(UpdateError)
    const connErr = caught as CurlConnectionError
    expect(connErr.curlExitCode).toBe(7)
    expect(connErr.errorCode).toBe('UPDATE_NETWORK_FAILED')
    expect(connErr.stage).toBe('downloading')
    expect(connErr.rawCause).toContain('Failed to connect')
  })

  it('u2-exit28-stalled: 传输停滞（speed-time 触发，stderr 无 connect 信号）映射 UPDATE_NETWORK_TIMEOUT，文案为停滞语义', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const promise = downloadViaCurl(ASSET, { tempPath })
    // curl --speed-time 触发时的典型 stderr 形态
    child.stderr.emit('data', 'curl: (28) Operation too slow. Less than 1 bytes/sec transferred the last 30 seconds')
    child.emit('close', 28, null)

    const caught = await captureRejection(promise)
    expect(caught).toBeInstanceOf(UpdateError)
    const err = caught as UpdateError
    expect(err.errorCode).toBe('UPDATE_NETWORK_TIMEOUT')
    expect(err.message).toContain('stalled')
    expect(err.message).toContain('30s')
    expect(err.message).not.toContain('connection timeout')
  })

  it('u2-exit28-connect-timeout: 连接超时（connect-timeout 触发，stderr 含 connect 信号）文案区别于停滞，不误标「30 秒无数据」', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const promise = downloadViaCurl(ASSET, { tempPath })
    // curl --connect-timeout 触发时的典型 stderr 形态
    child.stderr.emit('data', 'curl: (28) Connection timed out after 10001 milliseconds')
    child.emit('close', 28, null)

    const caught = await captureRejection(promise)
    const err = caught as UpdateError
    expect(err.errorCode).toBe('UPDATE_NETWORK_TIMEOUT')
    expect(err.message).toContain('connection timeout')
    expect(err.message).toContain('10s')
    expect(err.message).not.toContain('stalled')
  })

  it('u2-exit28-no-stderr: stderr 无判别信号（为空/未知形态）时按停滞文案（设计口径：判别 connect 信号，否则停滞）', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const promise = downloadViaCurl(ASSET, { tempPath })
    child.emit('close', 28, null)

    const caught = await captureRejection(promise)
    const err = caught as UpdateError
    expect(err.errorCode).toBe('UPDATE_NETWORK_TIMEOUT')
    expect(err.message).toContain('stalled')
  })

  it('u2-exit35: SSL 连接错误映射 UPDATE_NETWORK_FAILED', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const promise = downloadViaCurl(ASSET, { tempPath })
    child.emit('close', 35, null)

    const caught = await captureRejection(promise)
    expect(caught).toBeInstanceOf(UpdateError)
    expect((caught as UpdateError).errorCode).toBe('UPDATE_NETWORK_FAILED')
  })

  it('u2-exit56: 接收错误映射 UPDATE_NETWORK_FAILED', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const promise = downloadViaCurl(ASSET, { tempPath })
    child.emit('close', 56, null)

    const caught = await captureRejection(promise)
    expect(caught).toBeInstanceOf(UpdateError)
    expect((caught as UpdateError).errorCode).toBe('UPDATE_NETWORK_FAILED')
  })

  it('u2-exit22: HTTP 错误映射 UPDATE_NETWORK_FAILED 且 message 含 -w 捕获的 http_code', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const promise = downloadViaCurl(ASSET, { tempPath })
    // -f 语义下 body 不落盘，但 -w 的 %{http_code} 仍输出到 stdout（D6）
    child.stdout.emit('data', '403')
    child.emit('close', 22, null)

    const caught = await captureRejection(promise)
    expect(caught).toBeInstanceOf(UpdateError)
    const updateErr = caught as UpdateError
    expect(updateErr.errorCode).toBe('UPDATE_NETWORK_FAILED')
    expect(updateErr.message).toContain('403')
  })

  it('u2-exit-unknown: 未映射退出码兜底 UPDATE_NETWORK_FAILED（不裸抛内部信号）', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const promise = downloadViaCurl(ASSET, { tempPath })
    child.emit('close', 26, null)

    const caught = await captureRejection(promise)
    expect(caught).toBeInstanceOf(UpdateError)
    expect((caught as UpdateError).errorCode).toBe('UPDATE_NETWORK_FAILED')
  })

  // ── 验收 ①：进度 watch（fake timers） ─────────────────────────────────────

  it('u2-progress-watch: 500ms 轮询 statSync 字节数推 onProgress（fake timers）', async () => {
    vi.useFakeTimers()
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)
    const onProgress = vi.fn()

    const promise = downloadViaCurl(ASSET, { tempPath, onProgress })

    // 首轮：temp 已写入 100 字节
    writeFileSync(tempPath, 'a'.repeat(100))
    vi.advanceTimersByTime(500)
    expect(onProgress).toHaveBeenCalledWith(100)

    // 次轮：文件增长到 300 字节（只推原始字节，节流归调用方）
    writeFileSync(tempPath, 'a'.repeat(300))
    vi.advanceTimersByTime(500)
    expect(onProgress).toHaveBeenCalledWith(300)

    child.emit('close', 0, null)
    await promise
    // 完成后停表：close 已注销 interval，不再有新进度推流
    const callCountAtClose = onProgress.mock.calls.length
    vi.advanceTimersByTime(2000)
    expect(onProgress.mock.calls.length).toBe(callCountAtClose)
  })

  it('u2-progress-watch-skip: temp 未创建时轮询跳过该轮不推 0、不抛错', async () => {
    vi.useFakeTimers()
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)
    const onProgress = vi.fn()

    const promise = downloadViaCurl(ASSET, { tempPath, onProgress })
    vi.advanceTimersByTime(1500)
    expect(onProgress).not.toHaveBeenCalled()

    child.emit('close', 0, null)
    await promise
  })

  // ── 验收 ①：总墙钟已删（timeout-slow-flow-wallclock D1），慢速存活（fake timers） ──

  it('u2-no-total-timeout: 慢速但持续传输跨旧总钟边界（>2×3600s）不被外层 kill、不 reject——停滞检测归 curl 内部 --speed-time', async () => {
    vi.useFakeTimers()
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const promise = downloadViaCurl(ASSET, { tempPath })
    // 推进到旧总钟（3600s）的 2 倍：外层已无任何时间墙钟，不应 kill 子进程
    await vi.advanceTimersByTimeAsync(2 * 3_600_000)

    expect(child.kill).not.toHaveBeenCalled()
    // curl 内部 --speed-time 未触发（持续有字节）→ exit 0 正常完成
    child.emit('close', 0, null)
    await expect(promise).resolves.toEqual({ tempPath })
  })

  // ── 验收 ③：子进程生命周期（before-quit 清杀 + 完成注销） ──────────────────

  it('u2-kill-active: killActiveCurlDownloads 清杀进行中的 curl 子进程；完成后的下载已注销不被误杀', async () => {
    // 进行中：kill 被调用，被杀子进程以 UPDATE_NETWORK_FAILED 形态收尾
    const active = makeFakeChild()
    spawnMock.mockReturnValueOnce(active)
    const activePromise = downloadViaCurl(ASSET, { tempPath })

    killActiveCurlDownloads()
    expect(active.kill).toHaveBeenCalledTimes(1)
    const caught = await captureRejection(activePromise)
    expect(caught).toBeInstanceOf(UpdateError)
    expect((caught as UpdateError).errorCode).toBe('UPDATE_NETWORK_FAILED')

    // 已完成：settled 后从登记表注销，再次清杀不误杀历史子进程
    const finished = makeFakeChild()
    spawnMock.mockReturnValueOnce(finished)
    const donePromise = downloadViaCurl(ASSET, { tempPath })
    finished.emit('close', 0, null)
    await donePromise

    killActiveCurlDownloads()
    expect(finished.kill).not.toHaveBeenCalled()
  })
})
