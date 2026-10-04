/**
 * check-artifact-dir-formula-sync.mjs 单测（R1 一致性审查：守卫本体 + pre-commit 触发段已交付，
 * 但守卫自身无回归测试、--self-test 无自动化挂载点——三条比较（段名相等 / 正则相等 / 镜像经常量
 * 拼段名）自身退化时无任何红灯。设计 §11 检查点 8 要求「与 u1 对拍同型」，u1 对拍照搬的先例
 * check-thinking-levels 含守卫回归测试，故本守卫的非恒绿证明随行补上。）
 *
 * 组织方式照 check-thinking-levels.test.mjs 惯例：纯函数直测 + tmpdir fixture，CLI 集成用例把
 * 守卫脚本复制到 tmp mirror 运行（守卫 ROOT 由 import.meta.url 推导，副本位置使 ROOT 落在 mirror
 * 内——篡改 fixture 才真正改到守卫读的文件，「篡改即红、还原即绿」的差分才成立）。
 *
 * 运行：cd <repo-root> && pnpm exec vitest run scripts/__tests__/check-artifact-dir-formula-sync.test.mjs
 * （ci.yml「Test - scripts guards」逐文件列举同款口径。）
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SHARED_FN,
  MIRROR_FN,
  MIRROR_SEGMENT_CONST,
  extractFunctionBlock,
  extractJoinSegment,
  extractSessionIdRegex,
  extractConstLiteral,
  mirrorUsesSegmentConst,
} from '../check-artifact-dir-formula-sync.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(TEST_DIR, '..', 'check-artifact-dir-formula-sync.mjs')
const REPO_ROOT = join(TEST_DIR, '..', '..')

const DEFAULT_REGEX = '/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/'

// ── 纯函数直测（提取器形态覆盖）──────────────────────────────────────

describe('提取器纯函数', () => {
  it('函数块截取到行首 } 为止（体内缩进 } 不误截）', () => {
    const src = [
      `export function ${SHARED_FN}(sessionId: string): string {`,
      `  if (!${DEFAULT_REGEX}.test(sessionId)) {`,
      `    throw new Error('bad')`,
      `  }`,
      `  return join(getDataDir(), 'artifacts', sessionId)`,
      `}`,
      `export function nextOne() {}`,
    ].join('\n')
    const block = extractFunctionBlock(src, `export function ${SHARED_FN}`)
    expect(block.error).toBeUndefined()
    expect(block.text).toContain(SHARED_FN)
    expect(block.text).not.toContain('nextOne')
    expect(extractJoinSegment(block.text).value).toBe('artifacts')
    expect(extractSessionIdRegex(block.text).value).toBe(DEFAULT_REGEX)
  })

  it('函数缺失 / 无字面量段名 / 无校验正则 → error（宁可误报不可漏报）', () => {
    expect(extractFunctionBlock('const x = 1', 'export function missing').error).toBeDefined()
    expect(extractJoinSegment('return join(x, y, sessionId)').error).toBeDefined()
    expect(extractSessionIdRegex('const x = 1').error).toBeDefined()
  })

  it('常量段名提取 + 镜像经常量拼段名判定', () => {
    const mirror = [
      `export const ${MIRROR_SEGMENT_CONST} = 'artifacts'`,
      `export function ${MIRROR_FN}(sessionId: string): string {`,
      `  return path.join(resolveDataDir(), ${MIRROR_SEGMENT_CONST}, sessionId)`,
      `}`,
    ].join('\n')
    expect(extractConstLiteral(mirror, MIRROR_SEGMENT_CONST).value).toBe('artifacts')
    const block = extractFunctionBlock(mirror, `export function ${MIRROR_FN}`)
    expect(mirrorUsesSegmentConst(block.text)).toBe(true)
    expect(mirrorUsesSegmentConst(`return path.join(resolveDataDir(), 'artifacts', sessionId)`)).toBe(false)
  })
})

// ── fixture 生成（源文件真实形态：函数块 + 常量）────────────────────────

const sharedPathsSrc = ({ segment = 'artifacts', regex = DEFAULT_REGEX } = {}) =>
  [
    `export function ${SHARED_FN}(sessionId: string, dataDir?: string): string {`,
    `  if (!${regex}.test(sessionId)) {`,
    `    throw new Error('invalid sessionId (path traversal blocked): ' + sessionId)`,
    `  }`,
    `  return join(dataDir ?? getDataDir(), '${segment}', sessionId)`,
    `}`,
    ``,
  ].join('\n')

const mirrorSystemPromptSrc = ({ segmentConst = 'artifacts', regex = DEFAULT_REGEX, useConst = true } = {}) =>
  [
    `export const ${MIRROR_SEGMENT_CONST} = '${segmentConst}'`,
    ``,
    `export function ${MIRROR_FN}(sessionId: string): string {`,
    `  if (!${regex}.test(sessionId)) {`,
    `    throw new Error('invalid sessionId (path traversal blocked): ' + sessionId)`,
    `  }`,
    useConst
      ? `  return path.join(resolveDataDir(), ${MIRROR_SEGMENT_CONST}, sessionId)`
      : `  return path.join(resolveDataDir(), 'artifacts', sessionId)`,
    `}`,
    ``,
  ].join('\n')

/**
 * tmp mirror 工厂：目录布局对齐守卫 ROOT 相对路径（packages/shared/src、extensions/taiji/
 * system-prompt/src）。overrides 覆盖任一侧公式（漂移注入点），missing 指定不落盘的文件。
 *
 * root 取 realpath：Node 对入口模块 import.meta.url 做 realpath，而 process.argv[1] 保留调用方
 * 路径——macOS os.tmpdir() 是 /var/folders → /private/var/folders 符号链接，两者不一致会让守卫
 * 的 isMain 判定为 false，脚本被 import 而不执行 main（恒 exit 0）。realpath 后两条路径同源。
 */
function makeMirror({ shared = {}, mirror = {}, missing = [] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-formula-fx-')))
  const files = {
    'packages/shared/src/paths.ts': sharedPathsSrc(shared),
    'extensions/taiji/system-prompt/src/index.ts': mirrorSystemPromptSrc(mirror),
  }
  for (const [rel, content] of Object.entries(files)) {
    if (missing.includes(rel)) continue
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const guardCopy = join(root, 'scripts', 'check-artifact-dir-formula-sync.mjs')
  mkdirSync(dirname(guardCopy), { recursive: true })
  copyFileSync(SCRIPT, guardCopy)
  const run = () => spawnSync(process.execPath, [guardCopy], { cwd: root, encoding: 'utf-8' })
  return { root, run, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) }
}

describe('CLI 集成（守卫脚本 × tmp mirror）', () => {
  it('两侧一致 → exit 0，三条比较逐一报一致', () => {
    const fx = makeMirror()
    try {
      const r = fx.run()
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('✓ 产物目录公式双实现对拍通过')
      expect(r.stdout).toContain("段名字面量一致（'artifacts'")
      expect(r.stdout).toContain(`sessionId 校验正则字面量一致（${DEFAULT_REGEX}）`)
      expect(r.stdout).toContain(`镜像 ${MIRROR_FN} 经 ${MIRROR_SEGMENT_CONST} 拼段名`)
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（镜像段名常量与 shared join 字面量不一致）→ exit 1，报双侧值', () => {
    const fx = makeMirror({ mirror: { segmentConst: 'artifact' } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("段名字面量漂移: shared='artifacts' vs 镜像='artifact'")
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（共享侧 sessionId 校验正则不一致）→ exit 1（证明第 ② 步非恒绿）', () => {
    const fx = makeMirror({ shared: { regex: '/^[A-Za-z0-9_-]+$/' } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('sessionId 校验正则漂移')
      expect(r.stderr).toContain('isPiSessionId 同域')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（镜像函数旁路常量重写死字面量）→ exit 1（证明第 ③ 步非恒绿）', () => {
    const fx = makeMirror({ mirror: { useConst: false } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`镜像 ${MIRROR_FN} 未经 ${MIRROR_SEGMENT_CONST} 拼段名`)
      expect(r.stderr).toContain('重写死字面量会被本守卫漏掉漂移')
    } finally {
      fx.cleanup()
    }
  })

  it('比对面文件缺失 → exit 1，报缺失路径与迁移同步指引（提取失败一律 fail）', () => {
    const fx = makeMirror({ missing: ['packages/shared/src/paths.ts'] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('shared paths 源文件 缺失')
    } finally {
      fx.cleanup()
    }
  })
})

describe('真实仓库源文件（守卫对实际交付面非恒绿的反面：当前两侧一致）', () => {
  it('直跑真实守卫 → exit 0', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf-8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('✓ 产物目录公式双实现对拍通过')
  })
})
