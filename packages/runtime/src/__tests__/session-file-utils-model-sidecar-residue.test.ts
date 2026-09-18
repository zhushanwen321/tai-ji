/**
 * [缓存治理 U9] 退役 model sidecar（`<session>.jsonl.model.json`）残留启动清理测试。
 *
 * 锁定 cleanupTmpMigrateResidue 的 U9 家族扩展契约（cache-governance §3.3.5 方案 A）：
 * - 残留删除（根目录 + cwd 分组子目录两层），JSONL 主文件不受影响
 * - 年龄无关全删（对比：新鲜 tmp 标记残留仍按龄保留——两家族策略并排锁定）
 * - 目录无残留时零操作不抛
 * - 形态精确性：只删 `*.jsonl.model.json`，不误删现存 sidecar（.meta.json / .handoff.json）
 *   与其他命名形态
 * - 幂等：二次清扫返回 0 不抛（重复删除走既有 warn 容错路径的可达性由删除后目录态保证）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-file-utils-model-sidecar-residue.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanupTmpMigrateResidue } from '../infra/pi/session-file-utils.js'

/** 写一个最小文件（内容非本测试关注面），返回绝对路径。 */
function writeFile(dir: string, name: string, content = '{}\n'): string {
  const filePath = join(dir, name)
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

describe('cleanupTmpMigrateResidue U9 家族（退役 .model.json sidecar 残留清扫）', () => {
  let dataDir: string
  let sessionsDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'u9-sidecar-residue-'))
    sessionsDir = join(dataDir, 'agent', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('残留 .model.json 删除（根目录 + cwd 子目录两层），JSONL 主文件不受影响', () => {
    const subDir = join(sessionsDir, '--Users-x-proj--')
    const rootJsonl = writeFile(sessionsDir, 'sess-root.jsonl', '{"type":"session","id":"sess-root"}\n')
    const rootSidecar = writeFile(sessionsDir, 'sess-root.jsonl.model.json', '{"modelId":"a/b"}')
    mkdirSync(subDir, { recursive: true })
    const subJsonl = writeFile(subDir, 'sess-sub.jsonl', '{"type":"session","id":"sess-sub"}\n')
    const subSidecar = writeFile(subDir, 'sess-sub.jsonl.model.json', '{"modelId":"c/d"}')

    // 启动挂点的调用形态：默认 maxAgeMs（U9 家族不受该参数约束）
    const removed = cleanupTmpMigrateResidue(sessionsDir)

    expect(removed).toBe(2)
    expect(existsSync(rootSidecar)).toBe(false)
    expect(existsSync(subSidecar)).toBe(false)
    expect(existsSync(rootJsonl)).toBe(true)
    expect(existsSync(subJsonl)).toBe(true)
  })

  it('年龄无关全删：刚写入的 sidecar 残留也删（对比：新鲜 tmp 标记残留仍按龄保留）', () => {
    const freshSidecar = writeFile(sessionsDir, 'sess-1.jsonl.model.json', '{"modelId":"a/b"}')
    const freshTmp = writeFile(sessionsDir, 'sess-1.jsonl.tmp-import-999.jsonl')

    const removed = cleanupTmpMigrateResidue(sessionsDir)

    expect(removed).toBe(1)
    expect(existsSync(freshSidecar)).toBe(false)
    expect(existsSync(freshTmp)).toBe(true)
  })

  it('目录无残留时零操作不抛（无 sidecar / 目录不存在均返回 0）', () => {
    writeFile(sessionsDir, 'sess-1.jsonl', '{"type":"session","id":"sess-1"}\n')

    expect(cleanupTmpMigrateResidue(sessionsDir)).toBe(0)
    expect(cleanupTmpMigrateResidue(join(dataDir, 'no-such-dir'))).toBe(0)
    expect(existsSync(sessionsDir)).toBe(true)
  })

  it('只删 *.jsonl.model.json 形态：现存 sidecar 与其他命名不误删', () => {
    const metaSidecar = writeFile(sessionsDir, 'sess-1.jsonl.meta.json')
    const handoffSidecar = writeFile(sessionsDir, 'sess-1.jsonl.handoff.json')
    const bareModel = writeFile(sessionsDir, 'notes.model.json')
    const bakSuffix = writeFile(sessionsDir, 'sess-1.jsonl.model.json.bak')
    const residue = writeFile(sessionsDir, 'sess-2.jsonl.model.json', '{"modelId":"x/y"}')

    const removed = cleanupTmpMigrateResidue(sessionsDir)

    expect(removed).toBe(1)
    expect(existsSync(residue)).toBe(false)
    expect(existsSync(metaSidecar)).toBe(true)
    expect(existsSync(handoffSidecar)).toBe(true)
    expect(existsSync(bareModel)).toBe(true)
    expect(existsSync(bakSuffix)).toBe(true)
  })

  it('幂等：清扫后二次执行返回 0 不抛', () => {
    writeFile(sessionsDir, 'sess-1.jsonl.model.json', '{"modelId":"a/b"}')
    expect(cleanupTmpMigrateResidue(sessionsDir)).toBe(1)

    expect(cleanupTmpMigrateResidue(sessionsDir)).toBe(0)
  })
})
