/**
 * W1 基础层红灯测试 —— fork 字段透传（U1-U6）。
 *
 * 本文件为 TDD 红灯阶段：测试断言 W1 即将引入的 fork 相关字段/函数已存在且行为正确。
 * 当前实现尚未引入这些字段（parentSession / forkEntryId / handedOffTo / lastMergedAt）
 * 与函数（persistHandedOff / extractHandedOff）。
 *
 * 红灯分类：
 * - U2/U3/U4/U5：运行时红灯 —— 直接断言行为，vitest run 即 fail。
 * - U1/U6：类型契约红灯 —— 断言类型接受新字段。vitest 用 esbuild 不做类型检查，这两条
 *   在 vitest run 下会通过；W1 实现后这些字段成为类型的一部分，契约自然满足。真正的类型
 *   回归防护由 `pnpm --filter @xyz-agent/runtime typecheck`（tsc --noEmit）承担：若 W1
 *   实现移除字段，字面量赋值会在 tsc 下报错。
 *
 * W1 实现完成后，本文件应全绿。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-fork-fields.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

// shared 类型（U1）
import type { SessionSummary } from '@xyz-agent/shared'

// infra 工具（U2/U3/U6 第一处）
import {
  parseSessionHeader,
  // W11：persistHandedOff 迁 sidecar 改名 persistHandoffSidecar（旧名已删）
  persistHandoffSidecar as persistHandoffInfra,
  extractHandedOff as extractHandedOffInfra,
} from '../infra/pi/session-file-utils.js'

// session-fork（U4）
import { createForkedSessionFile } from '../services/session/session-fork.js'

// pi-paths（U15：encodeCwd 子目录形态断言）
import { encodeCwd } from '../infra/pi/pi-paths.js'

// ports 第二处 ScannedSessionMeta（U6）
import type { ScannedSessionMeta as ScannedSessionMetaPort } from '../services/ports/session.js'
import type { ScannedSessionMeta as ScannedSessionMetaInfra } from '../infra/pi/session-file-utils.js'

describe('W1 fork 字段透传', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'w1-fork-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })

  // ── U1：SessionSummary 含 4 个新可选字段 ─────────────────────────

  // [2026-09 测试舰队审查 r2-20] U1 运行时空绿占位断言已裁（类型契约由 tsc 承担）。

  // ── U2：parseSessionHeader 解析 parentSession + forkEntryId ──────────

  it('U2: parseSessionHeader 返回 header 中的 parentSession + forkEntryId', () => {
    const filePath = join(dir, 'forked.jsonl')
    writeFileSync(
      filePath,
      JSON.stringify({
        type: 'session',
        id: 'forked-1',
        cwd: '/test',
        timestamp: '2026-07-07T01:00:00.000Z',
        parentSession: '/path/to/parent.jsonl',
        forkEntryId: 'entry-123',
      }) + '\n',
    )
    const header = parseSessionHeader(filePath)
    expect(header).not.toBeNull()
    expect(header?.parentSession).toBe('/path/to/parent.jsonl')
    expect(header?.forkEntryId).toBe('entry-123')
  })

  // ── U3：persistHandoffSidecar 写 sidecar + extractHandedOff 读取（W11 迁移）──

  it('U3: persistHandoffSidecar 写 .handoff.json sidecar（JSONL 零写），extractHandedOff 读回目标 sessionId', () => {
    const filePath = join(dir, 'session.jsonl')
    const original = JSON.stringify({ type: 'session', id: 'src-1', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }) + '\n'
    writeFileSync(filePath, original)

    persistHandoffInfra(filePath, 'new-session-id')

    // sidecar 出现且内容正确（xyz 自有文件，不触碰 pi 的 JSONL）
    const sidecarPath = filePath + '.handoff.json'
    expect(existsSync(sidecarPath)).toBe(true)
    const marker = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
    expect(marker.handedOffTo).toBe('new-session-id')
    expect(marker.type).toBe('handoff_marker')

    // JSONL 本体字节不变（绝对写规则：session JSONL 唯一写方是 pi）
    expect(readFileSync(filePath, 'utf-8')).toBe(original)

    // extractHandedOff 优先读 sidecar，返回被交接的目标 sessionId
    expect(extractHandedOffInfra(filePath)).toBe('new-session-id')
  })

  it('U3b: JSONL 不存在时跳过（规则 #6——绝不创建 sidecar，pi openSync("wx") 竞态防护）', () => {
    const filePath = join(dir, 'never-flushed.jsonl')
    expect(() => persistHandoffInfra(filePath, 'target-id')).not.toThrow()
    expect(existsSync(filePath + '.handoff.json')).toBe(false)
  })

  it('U3c: 存量旧 session 兼容——无 sidecar、JSONL 尾部含旧 handoff_marker entry 时 fallback 尾读', () => {
    const filePath = join(dir, 'legacy.jsonl')
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', id: 'src-2', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }),
        JSON.stringify({ type: 'handoff_marker', handedOffTo: 'legacy-target', timestamp: '2026-08-01T00:00:00.000Z' }),
      ].join('\n') + '\n',
    )
    // 无 sidecar → fallback 尾读旧 marker（W11 前写入的存量形态）
    expect(extractHandedOffInfra(filePath)).toBe('legacy-target')
  })

  it('U3d: sidecar 优先于旧 JSONL marker（两者并存时新值胜出）', () => {
    const filePath = join(dir, 'both.jsonl')
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', id: 'src-3', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }),
        JSON.stringify({ type: 'handoff_marker', handedOffTo: 'old-target', timestamp: '2026-08-01T00:00:00.000Z' }),
      ].join('\n') + '\n',
    )
    persistHandoffInfra(filePath, 'new-target')
    expect(extractHandedOffInfra(filePath)).toBe('new-target')
  })

  it('U3e: 无 sidecar 且无 marker → undefined（未交接）', () => {
    const filePath = join(dir, 'clean.jsonl')
    writeFileSync(
      filePath,
      JSON.stringify({ type: 'session', id: 'src-4', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }) + '\n',
    )
    expect(extractHandedOffInfra(filePath)).toBeUndefined()
  })

  it('U3f: 损坏 sidecar（handedOffTo 非字符串）→ fallthrough 尾读 JSONL 兜底', () => {
    const filePath = join(dir, 'corrupt.jsonl')
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: 'session', id: 'src-5', cwd: '/test', timestamp: '2026-07-07T01:00:00.000Z' }),
        JSON.stringify({ type: 'handoff_marker', handedOffTo: 'jsonl-target', timestamp: '2026-08-01T00:00:00.000Z' }),
      ].join('\n') + '\n',
    )
    writeFileSync(filePath + '.handoff.json', JSON.stringify({ handedOffTo: 123 }))
    expect(extractHandedOffInfra(filePath)).toBe('jsonl-target')
  })

  // ── U4：createForkedSessionFile 写入 forkEntryId 到 newHeader ───────

  it('U4: createForkedSessionFile 写入 forkEntryId 到新 session 的 header', async () => {
    const sourceFile = join(dir, 'source.jsonl')
    writeFileSync(
      sourceFile,
      [
        { type: 'session', version: 3, id: 'src-session-id', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    )

    // 传入 forkEntryId（fork 点的 pi entryId），期望新文件 header 记录该字段
    const { filePath } = await createForkedSessionFile(
      sourceFile,
      'a1',          // forkEntryId（截断点）
      true,          // includeFrom
      dir,           // targetDir
      'a1',          // forkEntryId 字段（写入新 header，供后续 merge 定位 fork 点）
    )

    const firstLine = readFileSync(filePath, 'utf-8').split('\n')[0]
    const header = JSON.parse(firstLine)
    expect(header.forkEntryId).toBe('a1')
  })

  // ── U15：fork 产物写入 encodeCwd 子目录（方案 B 布局对齐 pi）───────

  it('U15: createForkedSessionFile 产物写入 <targetDir>/<encodeCwd(header.cwd)>/ 子目录（与 import-service 写入形态对齐）', async () => {
    const sourceFile = join(dir, 'source-subdir.jsonl')
    writeFileSync(
      sourceFile,
      [
        { type: 'session', version: 3, id: 'src-subdir', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    )

    const { filePath } = await createForkedSessionFile(sourceFile, 'a1', true, dir)

    // 产物落在 encodeCwd 子目录内——写平铺根会被 pi 原生 listAll（只枚举子目录）漏掉
    expect(dirname(filePath)).toBe(join(dir, encodeCwd('/test')))
    // 子目录由 mkdir(recursive) 自动创建（首个该 cwd 的 fork 产物不 ENOENT）
    expect(existsSync(filePath)).toBe(true)
    // 产物 header 完整可读（用户可见后果：fork session 合法落盘）
    const header = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0])
    expect(header.type).toBe('session')
    expect(header.id).not.toBe('src-subdir')
  })

  // ── U5：parentSession fallback（源 session 未落盘时用源 sessionId）──

  it('U5: 源 session sessionFilePath 缺失时，parentSession fallback 到源 sessionId', async () => {
    // createForkedSessionFile 在源 header 已有 parentSession 时透传；
    // 若源 sessionFile 尚未落盘（sessionFilePath=undefined），forkSession/
    // initializeManagedSession 应把 parentSession 写成源 sessionId 而非 undefined。
    //
    // 本用例通过 createForkedSessionFile 的 parentSession fallback 参数覆盖：
    // 传入 fallbackParentId，期望新 header.parentSession 在源 header 无 parentSession 时
    // 取 fallbackParentId（源 sessionId），形成可追溯的父子链。
    const sourceFile = join(dir, 'source-noparent.jsonl')
    writeFileSync(
      sourceFile,
      [
        // 源 session header 无 parentSession（顶层 session，非 fork 产物）
        { type: 'session', version: 3, id: 'top-level-session', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    )

    const { filePath } = await createForkedSessionFile(
      sourceFile,
      'u1',
      true,
      dir,
      undefined,        // forkEntryId 字段（本用例不关心）
      'top-level-session', // fallbackParentId：源 session 尚未落盘时用源 sessionId
    )

    const firstLine = readFileSync(filePath, 'utf-8').split('\n')[0]
    const header = JSON.parse(firstLine)
    // fallback 生效：parentSession 不是源文件路径（源未落盘），而是源 sessionId
    expect(header.parentSession).toBe('top-level-session')
  })

  // ── U6：ScannedSessionMeta 两处定义字段对齐 ────────────────────────

  // [2026-09 测试舰队审查 r2-20] U6 运行时空绿占位断言已裁（类型契约由 tsc 承担）。
})
