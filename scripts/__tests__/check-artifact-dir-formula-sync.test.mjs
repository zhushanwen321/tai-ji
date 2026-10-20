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
  BTE_STORE_SEGMENT_CONST,
  BTE_DOMAIN_SEGMENT_CONST,
  SHARED_BG_TASKS_FN,
  SHARED_VIEW_FN,
  SR_VIEW_FN_ANCHOR,
  SHARED_ARCHIVE_STATUS_CONST,
  SHARED_TURN_INTERFACE,
  MIRROR_TURN_INTERFACE,
  D7_LITERAL_CONSTS,
  compareTreeSegmentsShape,
  extractFunctionBlock,
  extractJoinSegment,
  extractSessionIdRegex,
  extractConstLiteral,
  extractConstRegex,
  extractConstStringArray,
  extractTreeRootSegment,
  extractViewTreeRootSegment,
  extractViewFileSegment,
  extractViewSessionIdRegex,
  extractMirrorStatusLiterals,
  extractInterfaceMembers,
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
      ``,
      `export function ${RUNTIME_TREE_FNS[3]}(): string {`,
      `  return join(getPiAgentDir(), 'archive')`,
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

  it('域 6 提取器：doExport 裸字面量三段提取（树根段 / 文件段 / 内联正则；形态不符报 error）', () => {
    const block = extractFunctionBlock(sessionReaderViewSrc(), SR_VIEW_FN_ANCHOR)
    expect(block.error).toBeUndefined()
    expect(extractViewTreeRootSegment(block.text).value).toBe('ext-sessions')
    expect(extractViewFileSegment(block.text).value).toBe('session-view.md')
    expect(extractViewSessionIdRegex(block.text).value).toBe(DEFAULT_REGEX)
    // 调用形态锁定：基址 / 变量名 / .test 目标任一变化 → error（宁可误报不可漏报）
    expect(extractViewTreeRootSegment(`const outDir = join(dataRoot(), 'ext-sessions', resolved.sessionId)`).error).toBeDefined()
    expect(extractViewFileSegment(`const outPath = join(target, 'session-view.md')`).error).toBeDefined()
    expect(extractViewSessionIdRegex(`if (!${DEFAULT_REGEX}.test(sessionId)) {`).error).toBeDefined()
  })
})

// ── fixture 生成（源文件真实形态：函数块 + 常量）────────────────────────

// 树段真实形态：4 宿主段（sessions/subagents/btw/archive）+ 末位存储树根段（域 10
// getArchiveDir 加入 RUNTIME_TREE_FNS 后的真实五段）。
const DEFAULT_TREE_SEGMENTS = ['sessions', 'subagents', 'btw', 'archive', 'ext-sessions']

const sharedPathsSrc = ({
  segment = 'artifacts',
  regex = DEFAULT_REGEX,
  storeSegment = 'ext-sessions',
  treeSegments = DEFAULT_TREE_SEGMENTS,
  bgTasksSegment = 'background-tasks',
  viewFileSegment = 'session-view.md',
  subagentsSegment = 'subagents',
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
    // 第五组（域 5）对拍权威函数：bgTasksSegment = null 注入「函数缺席」形态
    ...(bgTasksSegment
      ? [
          `export function ${SHARED_BG_TASKS_FN}(sessionId: string, dataDir?: string): string {`,
          `  assertPiSessionId(sessionId)`,
          `  return join(getSessionStoreDir(dataDir), sessionId, '${bgTasksSegment}')`,
          `}`,
          ``,
        ]
      : []),
    // 第六组（域 6）对拍权威函数：viewFileSegment = null 注入「函数缺席」形态
    ...(viewFileSegment
      ? [
          `export function ${SHARED_VIEW_FN}(sessionId: string, dataDir?: string): string {`,
          `  assertPiSessionId(sessionId)`,
          `  return join(getSessionStoreDir(dataDir), sessionId, '${viewFileSegment}')`,
          `}`,
          ``,
        ]
      : []),
    // 第七组（域 9）对拍权威函数：subagentsSegment = null 注入「函数缺席」形态
    ...(subagentsSegment
      ? [
          `export function getSessionSubagentsDir(sessionId: string, dataDir?: string): string {`,
          `  assertPiSessionId(sessionId)`,
          `  return join(getSessionStoreDir(dataDir), sessionId, '${subagentsSegment}')`,
          `}`,
          ``,
        ]
      : []),
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
    // 域 10 归档根（RUNTIME_TREE_FNS 第 4 位，dmg-r1-9 补齐镜像形态）。
    `export function ${RUNTIME_TREE_FNS[3]}(): string {`,
    `  return join(getPiAgentDir(), '${treeSegments[3] ?? 'archive'}')`,
    `}`,
    '',
  ].join('\n')

// 第五组（域 5）fixture：base-tool-enhance registry 双引号形态（包内 prettier 风格）
const bteRegistrySrc = ({ storeSegment = 'ext-sessions', domainSegment = 'background-tasks', regex = DEFAULT_REGEX } = {}) =>
  [
    `export const ${BTE_STORE_SEGMENT_CONST} = "${storeSegment}"`,
    `export const ${BTE_DOMAIN_SEGMENT_CONST} = "${domainSegment}"`,
    ``,
    `function assertPiSessionId(sessionId: string): void {`,
    `  if (!${regex}.test(sessionId)) {`,
    `    throw new Error('invalid sessionId (path traversal blocked): ' + sessionId)`,
    `  }`,
    `}`,
    ``,
    `export function getRegistryPath(dataDir: string, sessionId: string): string {`,
    `  assertPiSessionId(sessionId);`,
    `  return join(dataDir, ${BTE_STORE_SEGMENT_CONST}, sessionId, ${BTE_DOMAIN_SEGMENT_CONST}, "registry.json");`,
    `}`,
    ``,
  ].join('\n')

// 第六组（域 6）fixture：session-reader tool-handler 裸字面量形态（doExport 落盘段缩样）
const sessionReaderViewSrc = ({ treeSegment = 'ext-sessions', fileSegment = 'session-view.md', regex = DEFAULT_REGEX } = {}) =>
  [
    `async function doExport(`,
    `  params: SessionReadParams,`,
    `  agentDir: string,`,
    `): Promise<ToolResult> {`,
    `  if (!${regex}.test(resolved.sessionId)) {`,
    `    throw err('导出拒绝')`,
    `  }`,
    `  const outDir = join(dirname(agentDir), '${treeSegment}', resolved.sessionId)`,
    `  const outPath = join(outDir, '${fileSegment}')`,
    `  await mkdir(outDir, { recursive: true })`,
    `}`,
    ``,
  ].join('\n')

// 第七组（域 9）fixture：session-reader discovery roots 常量镜像形态（树根段 / subagent
// 域段 / 分区名正则；drift 注入任一字面量观察守卫红）
const sessionReaderDiscoveryRootsSrc = ({
  storeSegment = 'ext-sessions',
  subagentsSegment = 'subagents',
  regex = DEFAULT_REGEX,
} = {}) =>
  [
    `const SESSIONS_DIRNAME = 'sessions'`,
    `const SUBAGENTS_DIRNAME = '${subagentsSegment}'`,
    ``,
    `const ${STORE_SEGMENT_CONST} = '${storeSegment}'`,
    ``,
    `const ${SHARED_PATTERN_CONST} = ${regex}`,
    ``,
  ].join('\n')

// 第八组（域 10）fixture：归档镜像四源（shared schema / extension 簿记解析 / runtime
// 簿记路径 / renderer 预检正文；drift 注入观察域 10 各轴红）。sessionIdRegex 为
// dmg-r2-1 轴（shared schema 内 PI_SESSION_ID_PATTERN 镜像 ↔ shared paths 权威）。
const sharedArchiveSchemaSrc = ({
  statuses = ['staging', 'archived'],
  turnMembers = ['user', 'agent'],
  sessionIdRegex = '/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/',
} = {}) =>
  [
    `export const ${SHARED_ARCHIVE_STATUS_CONST} = [`,
    ...statuses.map((s) => `  '${s}',`),
    `] as const satisfies readonly ArchiveLedgerStatus[]`,
    ``,
    `export interface ArchiveSummaryTurn {`,
    ...turnMembers.map((m) => `  ${m}: string | null`),
    `}`,
    ``,
    `function parseSummaryTurn(raw: unknown, index: number): ArchiveSummaryTurn | string {`,
    ...turnMembers.map((m) => `  const ${m} = (raw as Record<string, unknown>).${m}`),
    `  return { ${turnMembers.join(', ')} }`,
    `}`,
    ``,
    `const ${SHARED_PATTERN_CONST} = ${sessionIdRegex}`,
    ``,
  ].join('\n')

const srArchiveLedgerSrc = ({
  dirnameConst = 'archive',
  statuses = ['staging', 'archived'],
  turnMembers = ['user', 'agent'],
  headerLiteral = '状态: 已归档 (archived) — 完整内容已压缩离线，以下仅为摘要',
  restoreNote = '注: 如需完整历史，请让用户在归档列表中恢复该会话。',
} = {}) =>
  [
    `export const ARCHIVE_DIRNAME = '${dirnameConst}'`,
    ``,
    `export interface ArchiveLedgerTurn {`,
    ...turnMembers.map((m) => `  ${m}: string | null`),
    `}`,
    ``,
    `const ARCHIVED_HEADER = '${headerLiteral}'`,
    `const RESTORE_NOTE = '${restoreNote}'`,
    `const USER_ATTACHMENT_PLACEHOLDER = '[图片/附件消息]'`,
    `const AGENT_NO_TEXT_PLACEHOLDER = '（此 turn 以工具调用结束，无文本回复）'`,
    ``,
    `function collect(files: string[]) {`,
    `  const mine = files.filter((f) => f.endsWith('.archive.json'))`,
    `  return mine`,
    `}`,
    ``,
    `function parseArchiveLedgerText(text: string) {`,
    `  if (obj.status !== '${statuses[0]}' && obj.status !== '${statuses[1]}') return undefined`,
    `}`,
    ``,
    `function parseSummary(raw: unknown) {`,
    ...turnMembers.map((m) => `  if (typeof obj.${m} !== 'string') return undefined`),
    `}`,
    ``,
  ].join('\n')

const runtimeArchivePathsSrc = () =>
  [
    `export function archiveLedgerPath(unitDir: string, originalFile: string): string {`,
    `  return join(unitDir, \`\${originalFile}.archive.json\`)`,
    `}`,
    ``,
  ].join('\n')

const rendererArchiveReferenceSrc = ({
  headerLiteral = '状态: 已归档 (archived) — 完整内容已压缩离线，以下仅为摘要',
  restoreNote = '注: 如需完整历史，请让用户在归档列表中恢复该会话。',
} = {}) =>
  [
    `const ARCHIVED_HEADER = '${headerLiteral}'`,
    `const RESTORE_NOTE = '${restoreNote}'`,
    `const USER_ATTACHMENT_PLACEHOLDER = '[图片/附件消息]'`,
    `const AGENT_NO_TEXT_PLACEHOLDER = '（此 turn 以工具调用结束，无文本回复）'`,
    ``,
  ].join('\n')

/**
 * tmp mirror 工厂：目录布局对齐守卫 ROOT 相对路径（packages/shared/src、extensions/taiji/
 * system-prompt/src、packages/runtime/src/infra/pi、extensions/universal/base-tool-enhance/
 * src/background、extensions/universal/session-reader/src、packages/renderer/src）。
 * overrides 覆盖任一侧公式（漂移注入点），missing 指定不落盘的文件。root/落盘/清理/
 * 守卫副本装置见 guard-mirror.mjs。
 */
function makeMirror({ shared = {}, mirror = {}, runtime = {}, bte = {}, sr = {}, srRoots = {}, sharedArchive = {}, srLedger = {}, runtimeArchive = {}, rendererRef = {}, missing = [] } = {}) {
  return makeGuardMirror({
    prefix: 'artifact-formula-fx-',
    files: {
      'packages/shared/src/paths.ts': sharedPathsSrc(shared),
      'extensions/taiji/system-prompt/src/index.ts': mirrorSystemPromptSrc(mirror),
      'packages/runtime/src/infra/pi/pi-paths.ts': runtimePiPathsSrc(runtime),
      'extensions/universal/base-tool-enhance/src/background/registry.ts': bteRegistrySrc(bte),
      'extensions/universal/session-reader/src/tool-handler.ts': sessionReaderViewSrc(sr),
      'extensions/universal/session-reader/src/discovery/roots.ts': sessionReaderDiscoveryRootsSrc(srRoots),
      'packages/shared/src/archive.ts': sharedArchiveSchemaSrc(sharedArchive),
      'extensions/universal/session-reader/src/discovery/archive-ledger.ts': srArchiveLedgerSrc(srLedger),
      'packages/runtime/src/services/archive/archive-paths.ts': runtimeArchivePathsSrc(runtimeArchive),
      'packages/renderer/src/components/archive/agent-reference-format.ts': rendererArchiveReferenceSrc(rendererRef),
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
      // 第五组（域 5）：registry 镜像三字面量对拍
      expect(r.stdout).toContain(`域 5 存储树根段一致（'ext-sessions'，shared ↔ base-tool-enhance 镜像）`)
      expect(r.stdout).toContain(`域 5 后台任务域段一致（'background-tasks'，shared ${SHARED_BG_TASKS_FN} ↔ 镜像常量）`)
      expect(r.stdout).toContain(`域 5 sessionId 校验正则一致（${DEFAULT_REGEX}）`)
      // 第六组（域 6）：session-reader 镜像三字面量对拍
      expect(r.stdout).toContain(`域 6 存储树根段一致（'ext-sessions'，shared ↔ session-reader 镜像）`)
      expect(r.stdout).toContain(`域 6 导出文件段一致（'session-view.md'，shared ${SHARED_VIEW_FN} ↔ 镜像字面量）`)
      expect(r.stdout).toContain(`域 6 sessionId 校验正则一致（${DEFAULT_REGEX}）`)
      // 第七组（域 9）：session-reader discovery 镜像三字面量对拍
      expect(r.stdout).toContain(`域 9 存储树根段一致（'ext-sessions'，shared ↔ session-reader discovery 镜像）`)
      expect(r.stdout).toContain(`域 9 subagent 域段一致（'subagents'，shared getSessionSubagentsDir ↔ 镜像常量）`)
      expect(r.stdout).toContain(`域 9 sessionId 校验正则一致（${DEFAULT_REGEX}）`)
      // 第八组（域 10）：归档镜像——目录名/后缀 + schema 字段级 + D7 四字面
      expect(r.stdout).toContain(`域 10 归档目录名一致（'archive'，shared 树段 ↔ runtime getArchiveDir ↔ 镜像 ARCHIVE_DIRNAME）`)
      expect(r.stdout).toContain(`域 10 簿记后缀一致（'.archive.json'，runtime archiveLedgerPath ↔ 镜像扫描后缀）`)
      expect(r.stdout).toContain(`域 10 status 词表一致（[staging, archived]，shared ${SHARED_ARCHIVE_STATUS_CONST} ↔ 镜像守卫字面量）`)
      expect(r.stdout).toContain(`域 10 summary.turns 成员名一致（[user,agent]，shared ArchiveSummaryTurn ↔ 镜像 ArchiveLedgerTurn，两端 parse 块消费同名校验通过）`)
      for (const name of D7_LITERAL_CONSTS) {
        expect(r.stdout).toContain(`域 10 D7 字面一致（${name}，renderer 预检 ↔ extension 返回正文逐字相同）`)
      }
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（域 9 discovery 镜像 subagent 域段与 shared getSessionSubagentsDir 不一致）→ exit 1，报双侧值', () => {
    const fx = makeMirror({ srRoots: { subagentsSegment: 'sub-agent' } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`域 9 subagent 域段漂移: shared='subagents' vs 镜像='sub-agent'`)
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（域 9 discovery 镜像分区名正则与 shared 不一致）→ exit 1，报双侧值', () => {
    const fx = makeMirror({ srRoots: { regex: '/^[A-Za-z0-9_-]+$/' } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`域 9 sessionId 校验正则漂移: shared=${DEFAULT_REGEX} vs 镜像=/^[A-Za-z0-9_-]+$/`)
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（域 6 session-reader 镜像导出文件段与 shared getSessionViewPath 不一致）→ exit 1，报双侧值', () => {
    const fx = makeMirror({ sr: { fileSegment: 'session-view.txt' } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`域 6 导出文件段漂移: shared='session-view.md' vs 镜像='session-view.txt'`)
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（域 5 registry 镜像域段与 shared 后台任务域段不一致）→ exit 1，报双侧值', () => {
    const fx = makeMirror({ bte: { domainSegment: 'background-task' } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("域 5 域段漂移: shared='background-tasks' vs 镜像='background-task'")
      expect(r.stderr).toContain('恢复动作')
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

  it('漂移红（域 10 D7 字面 renderer 预检与 extension 返回正文不一致）→ exit 1，报双侧值', () => {
    const fx = makeMirror({ rendererRef: { headerLiteral: '状态: 已归档 — 漂移的头部' } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`域 10 D7 字面漂移（ARCHIVED_HEADER）`)
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（域 10 status 词表 extension 守卫与 shared 元组不一致）→ exit 1，报双侧值', () => {
    const fx = makeMirror({ srLedger: { statuses: ['staging', 'expired'] } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`域 10 status 词表漂移: shared=[staging, archived] vs 镜像=[staging, expired]`)
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（域 10 summary.turns 成员名两侧 interface 不一致）→ exit 1，报双侧值', () => {
    const fx = makeMirror({ sharedArchive: { turnMembers: ['user', 'agent', 'extra'] } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`域 10 summary.turns 成员名漂移: shared=[user,agent,extra] vs 镜像=[user,agent]`)
      expect(r.stderr).toContain('恢复动作')
    } finally {
      fx.cleanup()
    }
  })

  it('漂移红（域 10 簿记 sessionId 正则与 shared paths 权威不一致）→ exit 1，报双侧值（dmg-r2-1 轴非恒绿）', () => {
    const fx = makeMirror({ sharedArchive: { sessionIdRegex: '/^[A-Za-z0-9_-]+$/' } })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`域 10 簿记 sessionId 正则漂移: shared paths='/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/' vs shared archive='/^[A-Za-z0-9_-]+$/'`)
      expect(r.stderr).toContain('恢复动作')
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

  it('域 6 镜像源文件缺失 → exit 1，报 session-reader tool-handler 缺失路径', () => {
    const fx = makeMirror({ missing: ['extensions/universal/session-reader/src/tool-handler.ts'] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('session-reader tool-handler 源文件 缺失')
    } finally {
      fx.cleanup()
    }
  })

  it('域 9 镜像源文件缺失 → exit 1，报 session-reader discovery roots 缺失路径', () => {
    const fx = makeMirror({ missing: ['extensions/universal/session-reader/src/discovery/roots.ts'] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('session-reader discovery roots 源文件 缺失')
    } finally {
      fx.cleanup()
    }
  })

  it('域 10 新增源缺失 → exit 1，报 renderer 归档预检正文缺失路径（dmg-r1-9 对拍轴）', () => {
    const fx = makeMirror({ missing: ['packages/renderer/src/components/archive/agent-reference-format.ts'] })
    try {
      const r = fx.run()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('renderer 归档预检正文源文件 缺失')
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
