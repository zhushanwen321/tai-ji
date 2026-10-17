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
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SHARED_FN,
  MIRROR_FN,
  MIRROR_SEGMENT_CONST,
  RUNTIME_PATTERN_CONST,
  SHARED_TREE_CONST,
  RUNTIME_TREE_FNS,
  STORE_SEGMENT_CONST,
  SHARED_PATTERN_CONST,
  compareTreeSegmentsShape,
  extractFunctionBlock,
  extractJoinSegment,
  extractSessionIdRegex,
  extractConstLiteral,
  extractConstRegex,
  extractConstStringArray,
  extractTreeRootSegment,
  mirrorUsesSegmentConst,
} from '../check-artifact-dir-formula-sync.mjs'
import { expectGuardDirectRunPasses, makeGuardMirror } from './helpers/guard-mirror.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(TEST_DIR, '..', 'check-artifact-dir-formula-sync.mjs')

const DEFAULT_REGEX = '/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/'

// ── 纯函数直测（提取器形态覆盖）──────────────────────────────────────

describe('提取器纯函数', () => {
  it('函数块截取到行首 } 为止（体内缩进 } 不误截）', () => {
    const src = [
      `export function ${SHARED_FN}(sessionId: string, dataDir?: string): string {`,
      `  assertPiSessionId(sessionId)`,
      `  return join(getSessionStoreDir(dataDir), sessionId, 'artifacts')`,
      `}`,
      `export function nextOne() {}`,
    ].join('\n')
    const block = extractFunctionBlock(src, `export function ${SHARED_FN}`)
    expect(block.error).toBeUndefined()
    expect(block.text).toContain(SHARED_FN)
    expect(block.text).not.toContain('nextOne')
    expect(extractJoinSegment(block.text).value).toBe('artifacts')
  })

  it('函数缺失 / 无字面量域段 / 无校验正则 → error（宁可误报不可漏报）', () => {
    expect(extractFunctionBlock('const x = 1', 'export function missing').error).toBeDefined()
    expect(extractJoinSegment(`return join(getSessionStoreDir(dataDir), sessionId)`).error).toBeDefined()
    expect(extractJoinSegment(`return join(getDataDir(), 'artifacts', sessionId)`).error).toBeDefined()
    expect(extractSessionIdRegex('const x = 1').error).toBeDefined()
  })

  it('常量段名提取（根段 + 域段）+ 镜像经两常量拼路径判定', () => {
    const mirror = [
      `export const ${STORE_SEGMENT_CONST} = 'ext-sessions'`,
      `export const ${MIRROR_SEGMENT_CONST} = 'artifacts'`,
      `export function ${MIRROR_FN}(sessionId: string): string {`,
      `  return path.join(resolveDataDir(), ${STORE_SEGMENT_CONST}, sessionId, ${MIRROR_SEGMENT_CONST})`,
      `}`,
    ].join('\n')
    expect(extractConstLiteral(mirror, STORE_SEGMENT_CONST).value).toBe('ext-sessions')
    expect(extractConstLiteral(mirror, MIRROR_SEGMENT_CONST).value).toBe('artifacts')
    const block = extractFunctionBlock(mirror, `export function ${MIRROR_FN}`)
    expect(mirrorUsesSegmentConst(block.text)).toBe(true)
    expect(
      mirrorUsesSegmentConst(`return path.join(resolveDataDir(), 'ext-sessions', sessionId, 'artifacts')`),
    ).toBe(false)
  })

  it('const 正则声明提取（shared / runtime 同形态；.test 调用行不误匹配；带分号兼容）', () => {
    const decl = `const ${RUNTIME_PATTERN_CONST} = ${DEFAULT_REGEX}`
    expect(extractConstRegex(decl, RUNTIME_PATTERN_CONST).value).toBe(DEFAULT_REGEX)
    expect(extractConstRegex(`${decl};`, RUNTIME_PATTERN_CONST).value).toBe(DEFAULT_REGEX)
    expect(extractConstRegex(`export function isPiSessionId(id: string): boolean {
  return ${RUNTIME_PATTERN_CONST}.test(id)
}

${decl}`, RUNTIME_PATTERN_CONST).value).toBe(DEFAULT_REGEX)
    expect(extractConstRegex('const OTHER = /x/;', RUNTIME_PATTERN_CONST).error).toBeDefined()
    expect(extractConstRegex('export const x = 1', RUNTIME_PATTERN_CONST).error).toBeDefined()
  })

  it('树段常量数组提取 + runtime 布局函数树根段对位提取（第四组对拍提取器）', () => {
    const shared = `export const ${SHARED_TREE_CONST} = ['sessions', 'subagents', 'btw', 'ext-sessions'] as const`
    expect(extractConstStringArray(shared, SHARED_TREE_CONST).value).toEqual([
      'sessions',
      'subagents',
      'btw',
      'ext-sessions',
    ])
    const runtime = [
      `export function ${RUNTIME_TREE_FNS[0]}(): string {`,
      `  return join(getPiAgentDir(), 'sessions')`,
      `}`,
      ``,
      `export function ${RUNTIME_TREE_FNS[1]}(mainCwd: string): string {`,
      `  return join(getPiAgentDir(), 'subagents', encodeCwd(mainCwd), 'sessions')`,
      `}`,
      ``,
      `export function ${RUNTIME_TREE_FNS[2]}(): string {`,
      `  return join(getPiAgentDir(), 'btw')`,
      `}`,
    ].join('\n')
    for (const fn of RUNTIME_TREE_FNS) {
      const block = extractFunctionBlock(runtime, `export function ${fn}`)
      expect(block.error).toBeUndefined()
      expect(extractTreeRootSegment(block.text).error).toBeUndefined()
    }
    expect(extractTreeRootSegment(`  return join(getPiAgentDir(), 'btw')`).value).toBe('btw')
    // 子代理函数取首段 'subagents'，不误取内层 'sessions'
    const subBlock = extractFunctionBlock(runtime, `export function ${RUNTIME_TREE_FNS[1]}`)
    expect(extractTreeRootSegment(subBlock.text).value).toBe('subagents')
    expect(extractConstStringArray('const OTHER = 1', SHARED_TREE_CONST).error).toBeDefined()
    expect(extractTreeRootSegment('return join(other(), x)').error).toBeDefined()
  })

  it('树段形态断言：宿主段 + 存储树末位段；缺末位段报 error（第四组形态校验纯函数）', () => {
    expect(compareTreeSegmentsShape(['sessions', 'subagents', 'btw', 'ext-sessions'], 3, 'ext-sessions').error).toBeUndefined()
    expect(compareTreeSegmentsShape(['sessions', 'subagents', 'btw'], 3, 'ext-sessions').error).toBeDefined()
    expect(compareTreeSegmentsShape(['sessions', 'subagents', 'btw', 'other-root'], 3, 'ext-sessions').error).toBeDefined()
  })
})

// ── fixture 生成（源文件真实形态：函数块 + 常量）────────────────────────

const DEFAULT_TREE_SEGMENTS = ['sessions', 'subagents', 'btw', 'ext-sessions']

const sharedPathsSrc = ({
  segment = 'artifacts',
  regex = DEFAULT_REGEX,
  storeSegment = 'ext-sessions',
  treeSegments = DEFAULT_TREE_SEGMENTS,
} = {}) =>
  [
    `export const ${STORE_SEGMENT_CONST} = '${storeSegment}'`,
    ``,
    `const ${SHARED_PATTERN_CONST} = ${regex}`,
    ``,
    `export function ${SHARED_FN}(sessionId: string, dataDir?: string): string {`,
    `  assertPiSessionId(sessionId)`,
    `  return join(getSessionStoreDir(dataDir), sessionId, '${segment}')`,
    `}`,
    ``,
    // treeSegments = null 注入「常量缺席」形态（守卫第四组提取失败一律 fail）
    ...(treeSegments
      ? [`export const ${SHARED_TREE_CONST} = [${treeSegments.map((s) => `'${s}'`).join(', ')}] as const`, '']
      : []),
  ].join('\n')

const mirrorSystemPromptSrc = ({
  segmentConst = 'artifacts',
  storeSegmentConst = 'ext-sessions',
  regex = DEFAULT_REGEX,
  useConst = true,
} = {}) =>
  [
    `export const ${STORE_SEGMENT_CONST} = '${storeSegmentConst}'`,
    `export const ${MIRROR_SEGMENT_CONST} = '${segmentConst}'`,
    ``,
    `export function ${MIRROR_FN}(sessionId: string): string {`,
    `  if (!${regex}.test(sessionId)) {`,
    `    throw new Error('invalid sessionId (path traversal blocked): ' + sessionId)`,
    `  }`,
    useConst
      ? `  return path.join(resolveDataDir(), ${STORE_SEGMENT_CONST}, sessionId, ${MIRROR_SEGMENT_CONST})`
      : `  return path.join(resolveDataDir(), 'ext-sessions', sessionId, 'artifacts')`,
    `}`,
    ``,
  ].join('\n')

const runtimePiPathsSrc = ({ regex = DEFAULT_REGEX, treeSegments = DEFAULT_TREE_SEGMENTS } = {}) =>
  [
    'export function isPiSessionId(id: string): boolean {',
    `  return ${RUNTIME_PATTERN_CONST}.test(id)`,
    '}',
    '',
    `const ${RUNTIME_PATTERN_CONST} = ${regex}`,
    '',
    `export function ${RUNTIME_TREE_FNS[0]}(): string {`,
    `  return join(getPiAgentDir(), '${treeSegments[0]}')`,
    `}`,
    '',
    `export function ${RUNTIME_TREE_FNS[1]}(mainCwd: string): string {`,
    `  return join(getPiAgentDir(), '${treeSegments[1]}', encodeCwd(mainCwd), 'sessions')`,
    `}`,
    '',
    `export function ${RUNTIME_TREE_FNS[2]}(): string {`,
    `  return join(getPiAgentDir(), '${treeSegments[2]}')`,
    `}`,
    '',
  ].join('\n')

/**
 * tmp mirror 工厂：目录布局对齐守卫 ROOT 相对路径（packages/shared/src、extensions/taiji/
 * system-prompt/src、packages/runtime/src/infra/pi）。overrides 覆盖任一侧公式（漂移
 * 注入点），missing 指定不落盘的文件。root/落盘/清理/守卫副本装置见 guard-mirror.mjs。
 */
function makeMirror({ shared = {}, mirror = {}, runtime = {}, missing = [] } = {}) {
  return makeGuardMirror({
    prefix: 'artifact-formula-fx-',
    files: {
      'packages/shared/src/paths.ts': sharedPathsSrc(shared),
      'extensions/taiji/system-prompt/src/index.ts': mirrorSystemPromptSrc(mirror),
      'packages/runtime/src/infra/pi/pi-paths.ts': runtimePiPathsSrc(runtime),
    },
    missing,
    script: SCRIPT,
  })
}

describe('CLI 集成（守卫脚本 × tmp mirror）', () => {
  it('三方一致 → exit 0，各条比较逐一报一致（含 runtime 第三源与存储树段）', () => {
    const fx = makeMirror()
    try {
      const r = fx.run()
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('✓ 产物目录公式对拍通过')
      expect(r.stdout).toContain("域段字面量一致（'artifacts'")
      expect(r.stdout).toContain(`存储树根段字面量一致（'ext-sessions'，shared ${STORE_SEGMENT_CONST} ↔ 镜像）`)
      expect(r.stdout).toContain(`sessionId 校验正则字面量一致（${DEFAULT_REGEX}）`)
      expect(r.stdout).toContain(`runtime ${RUNTIME_PATTERN_CONST} 与 shared sessionId 正则一致（${DEFAULT_REGEX}）`)
      expect(r.stdout).toContain(`镜像 ${MIRROR_FN} 经 ${STORE_SEGMENT_CONST} + ${MIRROR_SEGMENT_CONST} 拼路径`)
      expect(r.stdout).toContain(`存储树末位段一致（${SHARED_TREE_CONST} 末位 ↔ shared ${STORE_SEGMENT_CONST}='ext-sessions'）`)
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（镜像域段常量与 shared join 字面量不一致）→ exit 1，报双侧值', () => {
    const fx = makeMirror({ mirror: { segmentConst: 'artifact' } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("域段字面量漂移: shared='artifacts' vs 镜像='artifact'")
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（镜像树根段常量与 shared 常量不一致）→ exit 1（存储树根段对拍非恒绿）', () => {
    const fx = makeMirror({ mirror: { storeSegmentConst: 'ext-session' } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("存储树根段字面量漂移: shared='ext-sessions' vs 镜像='ext-session'")
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（shared 树段常量缺存储树末位段）→ exit 1（形态断言非恒绿）', () => {
    const fx = makeMirror({ shared: { treeSegments: ['sessions', 'subagents', 'btw'] } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`须含 pi 宿主 ${RUNTIME_TREE_FNS.length} 段 + 末位存储树根段 'ext-sessions'`)
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
      expect(r.stderr).toContain(`镜像 ${MIRROR_FN} 未经段常量拼路径`)
      expect(r.stderr).toContain('重写死字面量会被本守卫漏掉漂移')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（runtime 第三源 sessionId 正则不一致）→ exit 1（证明 ②b 非恒绿）', () => {
    const fx = makeMirror({ runtime: { regex: '/^[A-Za-z0-9_-]+$/' } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`vs runtime ${RUNTIME_PATTERN_CONST}=/^[A-Za-z0-9_-]+$/`)
      expect(r.stderr).toContain('pi-paths.ts')
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（runtime btw 树根段与 shared 常量第三位不一致）→ exit 1（证明 ④ 非恒绿）', () => {
    const fx = makeMirror({ runtime: { treeSegments: ['sessions', 'subagents', 'btw-lines', 'ext-sessions'] } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`pi 会话树段漂移: ${SHARED_TREE_CONST}[2]='btw' vs runtime ${RUNTIME_TREE_FNS[2]}()='btw-lines'`)
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（shared 树段常量缺席）→ exit 1（第四组提取失败一律 fail）', () => {
    const fx = makeMirror({ shared: { treeSegments: null } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`shared ${SHARED_TREE_CONST} 提取失败`)
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

  it('第三源文件缺失 → exit 1，报 runtime pi-paths 缺失路径（三方对拍含第三源）', () => {
    const fx = makeMirror({ missing: ['packages/runtime/src/infra/pi/pi-paths.ts'] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('runtime pi-paths 源文件 缺失')
    } finally {
      fx.cleanup()
    }
  })
})

describe('真实仓库源文件（守卫对实际交付面非恒绿的反面：当前三方一致）', () => {
  it('直跑真实守卫 → exit 0', () => {
    expectGuardDirectRunPasses(SCRIPT, '✓ 产物目录公式对拍通过')
  })
})
