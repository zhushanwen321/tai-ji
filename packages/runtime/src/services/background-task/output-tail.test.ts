/**
 * output tail runtime 侧口径单测（u-runtime-svc，D7：默认 32KB / 2000 行）。
 * 算法自 ext-simplify-13 起下沉 protocol readOutputTail（跨端单一实现，语义矩阵在
 * protocol 包 output-tail.test.ts 覆盖），本文件锁定 runtime 侧调用方契约：
 * 32KB/2000 行口径常量、re-export 链（background-task-service 经 output-tail.ts
 * 消费 protocol 实现的单一路径）与 lost 语义透传。
 *
 * 运行：cd packages/runtime && env -u XYZ_AGENT_DATA_DIR npx vitest run src/services/background-task
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OUTPUT_TAIL_DEFAULT_MAX_BYTES, OUTPUT_TAIL_MAX_LINES, readOutputTail } from './output-tail.js'

let dir: string

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
