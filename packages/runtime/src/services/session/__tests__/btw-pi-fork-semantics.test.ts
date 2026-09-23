/**
 * P-fork-equivalence / P-fork-source 的 durable 探针（M1-b）：
 * 直接驱动 node_modules 实装 pi 0.84.4 的 `SessionManager.forkFrom`
 * （= CLI `--fork` 的同一函数，main.js forkSessionOrExit 调用点），断言：
 *  - 全树复制（含分支）逐字节等价（分支场景 fixture）+ parentSession = 源绝对路径 + 新 id；
 *  - 源缺失 / 空文件 → pi 显式 throw（不产空文件）；
 *  - header-only 源：pi 侧会产出零 entry 快照（边界），宿主 inspectSourceState
 *    **更严一档**判 unavailable——构造性杜绝空上下文线（G2 防线，设计前提 10 补强）。
 * 版本锚：npm ls @earendil-works/pi-coding-agent = 0.84.4（断言前已核对）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { inspectSourceState } from '../btw-service.js'
import { cleanEntries, cleanupDir, danglingEntries, makeTmpDir, writeSessionFile } from './helpers/btw-harness.js'

const dirs: string[] = []
function tmp(): string { const d = makeTmpDir('taiji-btw-pifork-'); dirs.push(d); return d }
afterEach(() => { while (dirs.length) cleanupDir(dirs.pop()!) })

function readJsonl(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
}

describe('pi 原生 forkFrom（实装 0.84.4）—— P-fork-equivalence / P-fork-source', () => {
  it('全树复制：含分支 fixture 逐字节等价 + parentSession=源 + 新 id（P-fork-equivalence）', () => {
    const root = tmp()
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const srcEntries = danglingEntries() // 含分支 e1→[e2|e3] + 悬空 tool-call
    const src = writeSessionFile(root, 'src.jsonl', {
      type: 'session', version: 3, id: 'main-src-001', timestamp: '2026-09-22T00:00:00.000Z', cwd: proj,
    }, srcEntries)
    const threadDir = join(root, 'threadA')

    const mgr = SessionManager.forkFrom(src, proj, threadDir)
    const forkedFile = mgr.getSessionFile()!
    expect(forkedFile.startsWith(threadDir)).toBe(true)
    expect(existsSync(forkedFile)).toBe(true)

    const lines = readJsonl(forkedFile)
    const header = lines[0] as { type: string; id: string; parentSession: string }
    expect(header.type).toBe('session')
    expect(header.id).not.toBe('main-src-001')
    expect(header.parentSession).toBe(src)
    // 逐字节等价：非 header entry 集 = 源全集（含分支 e3、悬空 tool-call e2）
    expect(lines.slice(1)).toEqual(srcEntries)
    expect(lines.some(l => l.id === 'e3')).toBe(true)
  })

  it('源缺失 / 空文件 → pi 显式 throw，不产目标文件（P-fork-source 分支② 依据）', () => {
    const root = tmp()
    const missing = join(root, 'missing.jsonl')
    expect(() => SessionManager.forkFrom(missing, root, join(root, 't1'))).toThrow(/empty or invalid/)

    const empty = join(root, 'empty.jsonl')
    writeFileSync(empty, '')
    expect(() => SessionManager.forkFrom(empty, root, join(root, 't2'))).toThrow(/empty or invalid/)

    expect(existsSync(join(root, 't1'))).toBe(false)
    expect(existsSync(join(root, 't2'))).toBe(false)
  })

  it('header-only 源：pi 产出零 entry 快照（边界），宿主前置判 unavailable 更严（G2 防线）', () => {
    const root = tmp()
    const headerOnly = writeSessionFile(root, 'header-only.jsonl', {
      type: 'session', version: 3, id: 'main-hdr-001', timestamp: 't', cwd: root,
    }, [])
    // pi 边界行为（实证）：零非 header entry 不 throw → 产出仅 header 的 fork 文件
    const mgr = SessionManager.forkFrom(headerOnly, root, join(root, 't3'))
    const lines = readJsonl(mgr.getSessionFile()!)
    expect(lines.length).toBe(1)
    // 宿主侧 inspectSourceState 判 empty → createLine 回落无 fork 分支（不产空上下文线）
    expect(inspectSourceState(headerOnly)).toEqual({ state: 'unavailable', reason: 'empty' })
  })

  it('inspectSourceState：ok 态含分支 + 悬空判定；缺失/未解析/尾部半行容忍', () => {
    const root = tmp()
    const src = writeSessionFile(root, 'src.jsonl', {
      type: 'session', version: 3, id: 'm-1', timestamp: 't', cwd: root,
    }, danglingEntries())
    expect(inspectSourceState(src)).toEqual({ state: 'ok', hasDanglingToolCall: true })

    const clean = writeSessionFile(root, 'clean.jsonl', {
      type: 'session', version: 3, id: 'm-2', timestamp: 't', cwd: root,
    }, cleanEntries())
    expect(inspectSourceState(clean)).toEqual({ state: 'ok', hasDanglingToolCall: false })

    expect(inspectSourceState(undefined)).toEqual({ state: 'unavailable', reason: 'unresolved' })
    expect(inspectSourceState(join(root, 'nope.jsonl'))).toEqual({ state: 'unavailable', reason: 'missing' })

    appendFileSync(clean, '{"type":"message","id":"partial')
    expect(inspectSourceState(clean)).toEqual({ state: 'ok', hasDanglingToolCall: false })
  })
})
