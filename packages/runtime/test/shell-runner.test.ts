/**
 * ShellRunner G3 峰值治理定向测试：CappedStreamAccumulator 字节帽（10MB 对齐
 * git-executor GIT_MAX_BUFFER_BYTES，超限截断保留头尾）。
 *
 * ShellRunner 构造函数注入 spawn（vi.fn 返回 fake child——EventEmitter + stdout/stderr
 * EventEmitters，形状契约见 shell-runner.ts 头注释），单测无需真 spawn。
 *
 * 覆盖（memory-leak-remediation §3.4-G3）：
 * 1. 帽内小输出原样透传（无截断标记）
 * 2. stdout 超帽 → 头尾保留 + 截断标记（dropped 字节数可观测）+ 结果串字节量有界
 * 3. stderr 独立同帽（标记 stream 标识正确）
 * 4. onOutput 流式逐行通道不在帽内（截断时仍全量送达——消费即释散的增量通道）
 *
 * chunk 粒度用管道真实量级（64KB，Node stream highWaterMark）——实现的头段切换有
 * 「单次 append 超调一个 chunk」的有界松弛（不做 UTF-8 字节精确回切，见被测实现
 * 注释），断言界 = cap + 一个 chunk。
 *
 * 运行：cd packages/runtime && npx vitest run test/shell-runner.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ShellRunner } from '../src/infra/shell-runner.js'
import type { SpawnFn } from '../src/services/ports/shell-runner.js'

/** 10MB = 10 * 1024 * 1024（与被测实现同值；用字面量保持「实现若漂移本用例红」的守卫性） */
// eslint-disable-next-line no-magic-numbers -- 10MB 帽，对齐 git-executor
const CAP_BYTES = 10 * 1024 * 1024
/** 管道典型 chunk（Node stream highWaterMark 量级） */
// eslint-disable-next-line no-magic-numbers -- 64KB 管道 chunk 量级
const CHUNK_BYTES = 64 * 1024

/** 可编程 fake child（与 node:child_process.ChildProcess 一致的最小形状契约）。 */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  killed: boolean
  kill(signal?: string): void
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  return child
}

/** 造注入 mock spawn 的 runner；child 数据由调用方发射。 */
function setup() {
  const child = makeFakeChild()
  const spawn = vi.fn(() => child) as unknown as SpawnFn
  const runner = new ShellRunner({ spawn })
  return { child, runner, spawn }
}

/** 发射 chunkCount 个 64KB 单行 chunk（首块 HEADMARK 前缀 / 末块 TAILMARK 后缀）到指定流。 */
function emitChunkedLines(child: FakeChild, stream: 'stdout' | 'stderr', chunkCount: number): void {
  for (let i = 0; i < chunkCount; i++) {
    let line: string
    if (i === 0) line = `HEADMARK${'a'.repeat(CHUNK_BYTES - 'HEADMARK'.length - 1)}\n`
    else if (i === chunkCount - 1) line = `${'b'.repeat(CHUNK_BYTES - 'TAILMARK'.length - 1)}TAILMARK\n`
    else line = 'x'.repeat(CHUNK_BYTES - 1) + '\n'
    child[stream].emit('data', Buffer.from(line))
  }
}

describe('ShellRunner G3 累积字节帽（CappedStreamAccumulator）', () => {
  it('帽内小输出原样透传：无截断标记，stdout/stderr 保留原始字符', async () => {
    const { child, runner, spawn } = setup()
    const p = runner.execute({ scriptPath: '/tmp/setup.sh', cwd: '/tmp', timeout: 60_000 })
    child.stdout.emit('data', Buffer.from('installing package done\n'))
    child.stderr.emit('data', Buffer.from('warn: something\n'))
    child.emit('close', 0)

    const r = await p
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('installing package done\n')
    expect(r.stderr).toBe('warn: something\n')
    expect(r.stdout).not.toContain('truncated')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('stdout 超 10MB：截断保留头尾 + 标记 dropped 字节 + 结果串有界', async () => {
    const { child, runner } = setup()
    const p = runner.execute({ scriptPath: '/tmp/setup.sh', cwd: '/tmp', timeout: 60_000 })
    // 192 × 64KB = 12MB > 10MB 帽
    const chunkCount = 192
    emitChunkedLines(child, 'stdout', chunkCount)
    child.emit('close', 0)

    const r = await p
    // 头保留（起点上下文）+ 尾保留（末尾结论）
    expect(r.stdout.startsWith('HEADMARK')).toBe(true)
    expect(r.stdout.endsWith('TAILMARK\n')).toBe(true)
    // 截断标记在中段：dropped 字节数可观测
    const markerIdx = r.stdout.indexOf('...[shell-runner] stdout truncated: dropped ')
    expect(markerIdx).toBeGreaterThan(0)
    const droppedMatch = r.stdout.match(/dropped (\d+) bytes/)
    expect(droppedMatch).not.toBeNull()
    expect(Number(droppedMatch![1])).toBeGreaterThan(0)
    // 结果串有界：头 8MB + 尾 2MB + 单 chunk 超调松弛 + 标记 ≈ 10MB 量级，远低于未帽 12MB
    expect(Buffer.byteLength(r.stdout)).toBeLessThan(CAP_BYTES + CHUNK_BYTES + 512)
    expect(Buffer.byteLength(r.stdout)).toBeGreaterThan(8 * 1024 * 1024)
    // stderr 独立未超帽 → 无标记
    expect(r.stderr).toBe('')
  })

  it('stderr 独立同帽：截断标记 stream 标识为 stderr', async () => {
    const { child, runner } = setup()
    const p = runner.execute({ scriptPath: '/tmp/setup.sh', cwd: '/tmp', timeout: 60_000 })
    emitChunkedLines(child, 'stderr', 192)
    child.emit('close', 0)

    const r = await p
    expect(r.stderr).toContain('...[shell-runner] stderr truncated: dropped ')
    expect(Buffer.byteLength(r.stderr)).toBeLessThan(CAP_BYTES + CHUNK_BYTES + 512)
    // stdout 未超帽 → 原样（空）
    expect(r.stdout).toBe('')
  })

  it('onOutput 流式通道不在帽内：截断时逐行回调仍全量送达', async () => {
    const { child, runner } = setup()
    const lines: Array<{ line: string; stream: 'stdout' | 'stderr' }> = []
    const p = runner.execute({
      scriptPath: '/tmp/setup.sh',
      cwd: '/tmp',
      timeout: 60_000,
      onOutput: (line, stream) => lines.push({ line, stream }),
    })
    const chunkCount = 192
    emitChunkedLines(child, 'stdout', chunkCount)
    child.emit('close', 0)

    const r = await p
    // 结果串已截断（有标记）……
    expect(r.stdout).toContain('[shell-runner] stdout truncated')
    // ……但流式通道收到全部行（消费即释散，不受帽影响）
    expect(lines).toHaveLength(chunkCount)
    expect(lines.every((l) => l.stream === 'stdout' && l.line.length === CHUNK_BYTES - 1)).toBe(true)
  })
})
