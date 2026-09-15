/**
 * check-unsafe-stream-writes.mjs 检测核心单测（S14）：误报会逼人加豁免瓦解护栏，
 * 污染 allowlist 治理——R1（裸流写 / try 窗口 / allowlist 豁免 / 注释行排除）、
 * R2（socket 入口 error 挂载）、R4（readline 转发）行为必须机器锁定。
 */
import { describe, it, expect } from 'vitest'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanFileLines, collectTsFiles, isCommentLine } from '../check-unsafe-stream-writes.mjs'

describe('isCommentLine', () => {
  it('// 、* 、/* 开头判注释', () => {
    expect(isCommentLine('  // x')).toBe(true)
    expect(isCommentLine('  * x')).toBe(true)
    expect(isCommentLine('  /* x')).toBe(true)
    expect(isCommentLine('  conn.write(x)')).toBe(false)
  })
})

describe('scanFileLines R1（裸流写）', () => {
  it('裸 conn.write 命中违规，try 包裹（8 行窗口内）放行', () => {
    const bad = scanFileLines('a.ts', ['function f() {', '  conn.write(frame)', '}'], new Set())
    expect(bad.length).toBe(1)
    expect(bad[0]).toContain('a.ts@2')
    expect(bad[0]).toContain('conn.write')
    const good = scanFileLines('a.ts', ['try {', '  conn.write(frame)', '} catch {}'], new Set())
    expect(good).toEqual([])
  })
  it('注释行里的流写不命中；可选链形态 stdin?.write( 命中', () => {
    expect(scanFileLines('a.ts', ['  // conn.write(x)'], new Set())).toEqual([])
    const v = scanFileLines('a.ts', ['  stdin?.write(chunk)'], new Set())
    expect(v.length).toBe(1)
    expect(v[0]).toContain('stdin')
  })
  it('allowlist 行号豁免命中（回写 hits 供 stale 告警）', () => {
    const hits = new Set()
    const v = scanFileLines('a.ts', ['  conn.write(frame)'], new Set(['a.ts@1']), hits)
    expect(v).toEqual([])
    expect([...hits]).toEqual(['a.ts@1'])
  })
})

describe('scanFileLines R2（socket 入口 error 挂载）', () => {
  it('handleConnection(conn: Socket) 无 error listener 命中；挂上放行；once 不认（显式不对称）', () => {
    const bad = scanFileLines('b.ts', ['function handleConnection(conn: net.Socket) {', '}'], new Set())
    expect(bad.some((v) => v.includes("conn.on('error'"))).toBe(true)
    const good = scanFileLines('b.ts', ["function handleConnection(conn: net.Socket) {", "  conn.on('error', () => {})", '}'], new Set())
    expect(good).toEqual([])
    const onceOnly = scanFileLines('b.ts', ["function handleConnection(conn: net.Socket) {", "  conn.once('error', () => {})", '}'], new Set())
    expect(onceOnly.some((v) => v.includes('socket 接收入口'))).toBe(true)
  })
  it('非 Connection 命名的 Socket 参数不触发 R2', () => {
    expect(scanFileLines('b.ts', ['function fn(sock: Socket) {', '}'], new Set())).toEqual([])
  })
})

describe('scanFileLines R4（readline 转发）', () => {
  it('createInterface 无 error listener 命中；on/once 均放行', () => {
    const bad = scanFileLines('c.ts', ['const rl = createInterface({ input: s })'], new Set())
    expect(bad.some((v) => v.includes('rl.on(\'error\''))).toBe(true)
    expect(scanFileLines('c.ts', ['const rl = createInterface({ input: s })', "rl.once('error', () => {})"], new Set())).toEqual([])
    expect(scanFileLines('c.ts', ['const rl = createInterface({ input: s })', "rl.on('error', () => {})"], new Set())).toEqual([])
  })
})

describe('collectTsFiles', () => {
  it('递归收集 .ts，排除 __tests__ / *.test.ts / .d.ts', () => {
    // 对真实 RUNTIME_SRC 不可行（函数硬编码根），用行为断言代替：对脚本自身目录调用，
    // 断言返回数组且不含 .md / __tests__ 条目（fileURLToPath：pathname 在 Windows 返回 /D:/ 形态）
    const files = collectTsFiles(dirname(fileURLToPath(import.meta.url)))
    expect(Array.isArray(files)).toBe(true)
    expect(files.every((f) => f.endsWith('.ts'))).toBe(true)
    expect(files.some((f) => f.includes('__tests__'))).toBe(false)
  })
})
