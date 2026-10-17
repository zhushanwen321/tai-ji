#!/usr/bin/env node
/**
 * check-artifact-dir-formula-sync.mjs —— 会话产物目录公式对拍守卫（公式双实现 +
 * sessionId 校验正则三方 + session 存储树段）。
 * （设计：.tmp/tech-design/chat-html-support.md §6.7 D7 / §11 检查点 8 / §10 u-artifacts；
 *   session 存储树扩展：.tmp/tech-design/session-store-layout-inversion.md §3.3 D1/D8）
 *
 * 背景：产物目录公式 `<dataDir>/ext-sessions/<sessionId>/artifacts` 有两份实现，跨包
 * 不可 import（extensions 包不依赖 @taiji/shared，且 shared getDataDir 对打包态 pi 进程
 * 直接 throw）：
 *   ① 权威侧 shared：`packages/shared/src/paths.ts` 的 `getSessionArtifactsDir`
 *      （runtime / main 消费）；
 *   ② 镜像侧 system-prompt 扩展：`extensions/taiji/system-prompt/src/index.ts` 的
 *      `SESSION_STORE_DIR_SEGMENT` + `SESSION_ARTIFACTS_DIR_SEGMENT` +
 *      `resolveSessionArtifactsDir`（每 turn 注入产物目录绝对路径）。
 * 两侧任一漂移（段名改了 / 校验正则松紧不一）= agent 收到的路径与实际目录不符（写偏或
 * 预览 404）。跨包不可 import 不是豁免机检的理由——本守卫与 u1 的
 * check-capability-allowlist-sync.mjs 同为**源文件字面量对拍**形态（强度对称）：
 * 读双侧源文本，提取段名字面量与 sessionId 校验正则字面量，断言逐字一致。
 *
 * sessionId 校验正则另对拍第三源（2026-10-11 branch-review minor 残余补登）：runtime
 * `packages/runtime/src/infra/pi/pi-paths.ts` 的 `PI_SESSION_ID_PATTERN`（`const <名> =
 * /正则/` 声明形态，isPiSessionId 消费）——该正则决定产物目录名合法性判据（isPiSessionId
 * 挡虚拟 id / 路径注入），漂移时公式两侧一致也会判错目录名。三方断言 = shared ↔ 镜像 +
 * shared ↔ runtime（镜像 ↔ runtime 由等价传递覆盖）。shared 侧校验收敛在模块私有
 * helper assertPiSessionId（同名 `PI_SESSION_ID_PATTERN` 常量声明，不再内联在各推导
 * 函数内）。
 *
 * 第四组对拍（2026-10-14 branch-review minor 残余收编）：pi 会话树段——shared
 * `PI_SESSION_TREE_SEGMENTS`（跨进程消费 SSOT：main 不能 import runtime，树内包含
 * 判定如会话导出路径安全校验经它推导）↔ runtime pi-paths.ts 布局权威三函数
 * （getSessionsDir / getSubagentSessionDir / getBtwSessionsRoot）join 首段字面量。
 * 此前两处仅注释互指，runtime 改树名时 shared 常量漂移无红灯。
 * session-store-layout-inversion 扩展：常量末位段 'ext-sessions' ↔ shared
 * `SESSION_STORE_DIR_SEGMENT` 常量 ↔ 镜像侧同名常量，三方对拍（存储树根段一致性）。
 *
 * 【第五组断言位（已登记未启用）】base-tool-enhance 登记目录公式（域 5）：
 * `extensions/universal/base-tool-enhance/src/background/registry.ts` 的
 * `getRegistryPath` 现为旧布局 `join(dataDir, 'base-tool-enhance', sessionId,
 * 'registry.json')`，与 shared `getSessionBackgroundTasksDir`（`<root>/<sid>/
 * background-tasks/`）暂不一致——换根归 u-ext-tasks-views 单元。该单元把 registry
 * 公式改为 `join(dataDir, 'ext-sessions', sessionId, 'background-tasks', 'registry.json')`
 * 时，须在本守卫同批启用对拍：提取 getRegistryPath 函数块内 join 各段字面量，断言
 * 与 shared `SESSION_STORE_DIR_SEGMENT` + 'background-tasks' 逐字一致（复用
 * extractConstLiteral / extractFunctionBlock 原语，形态照抄第一组）。提前启用会在其
 * 换根前恒红（现状公式即旧布局），故只登记不接线。
 *
 * 形态照搬 scripts/check-capability-allowlist-sync.mjs（读源文件文本、零散文解析、
 * 提取失败一律 fail、`--self-test` 纯函数自检）。
 *
 * 用法：
 *   node scripts/check-artifact-dir-formula-sync.mjs               # 常规校验（pre-commit 按路径触发）
 *   node scripts/check-artifact-dir-formula-sync.mjs --self-test   # 纯函数轻量自检
 *
 * 退出码：0 = 通过；1 = 存在 fail。
 */
import { join } from 'node:path'
import {
  fail,
  ok,
  guardExit,
  exitIfFailed,
  readSourcesOrFail,
  runSelfTest,
  repoRootFrom,
  isDirectRun,
  extractFunctionBlock,
} from './lib/guard-report.mjs'

const ROOT = repoRootFrom(import.meta.url)
const SHARED_PATHS_SRC = join(ROOT, 'packages', 'shared', 'src', 'paths.ts')
const SYSTEM_PROMPT_SRC = join(ROOT, 'extensions', 'taiji', 'system-prompt', 'src', 'index.ts')
const RUNTIME_PI_PATHS_SRC = join(ROOT, 'packages', 'runtime', 'src', 'infra', 'pi', 'pi-paths.ts')

/** 权威侧函数名（shared）。 */
export const SHARED_FN = 'getSessionArtifactsDir'
/** 镜像侧函数名（system-prompt）。 */
export const MIRROR_FN = 'resolveSessionArtifactsDir'
/** 镜像侧段名常量名。 */
export const MIRROR_SEGMENT_CONST = 'SESSION_ARTIFACTS_DIR_SEGMENT'
/** 第三源（runtime pi-paths）sessionId 正则常量名。 */
export const RUNTIME_PATTERN_CONST = 'PI_SESSION_ID_PATTERN'
/** 第四组对拍：shared pi 会话树段 SSOT 常量名。 */
export const SHARED_TREE_CONST = 'PI_SESSION_TREE_SEGMENTS'
/** runtime 侧三棵树布局权威函数（数组位 ↔ shared 常量元素位，pi 宿主段）。 */
export const RUNTIME_TREE_FNS = ['getSessionsDir', 'getSubagentSessionDir', 'getBtwSessionsRoot']
/** session 存储树根段常量名（shared 与镜像侧同名，三方对拍：shared ↔ 镜像 ↔ 树段常量末位）。 */
export const STORE_SEGMENT_CONST = 'SESSION_STORE_DIR_SEGMENT'
/** shared 侧 sessionId 校验正则常量名（assertPiSessionId 消费，与 runtime 同名）。 */
export const SHARED_PATTERN_CONST = 'PI_SESSION_ID_PATTERN'

/** 函数体截取锚点（含 `export function` 前缀，避免匹配到调用点）。 */
const SHARED_ANCHOR = `export function ${SHARED_FN}`
const MIRROR_ANCHOR = `export function ${MIRROR_FN}`

// 函数体截取原语与 POSIX resolve 镜像守卫同款收敛：scripts/lib/guard-report.mjs。
// re-export 保持单测（scripts/__tests__/check-artifact-dir-formula-sync.test.mjs）的既有 import 面。
export { extractFunctionBlock }

/** 从 shared 函数块提取 `join(getSessionStoreDir(…), sessionId, '<域段>')` 的域段字面量。 */
export function extractJoinSegment(blockText) {
  const m = blockText.match(/join\(getSessionStoreDir\([^)]*\),\s*sessionId,\s*'([^']+)'\)/)
  if (!m) return { error: `函数块内未找到 join(getSessionStoreDir(…), sessionId, '<域段>') 形态（字面量段名缺失 / 公式形态变化？）` }
  return { value: m[1] }
}

/** 从函数块提取 sessionId 校验正则字面量（`/..../.test(sessionId)` 形态，取正则字面量本体）。 */
export function extractSessionIdRegex(blockText) {
  const m = blockText.match(/(\/\^[^/\n]*\/)\.test\(sessionId\)/)
  if (!m) return { error: `函数块内未找到 /^.../.test(sessionId) 校验正则字面量` }
  return { value: m[1] }
}

/** 从源文本提取 `const <name> = '<字面量>'` 的段名字面量。 */
export function extractConstLiteral(text, constName) {
  const m = text.match(new RegExp(`const\\s+${constName}\\s*=\\s*'([^']+)'`))
  if (!m) return { error: `未找到 const ${constName} = '<字面量>'（改名 / 形态变化？）` }
  return { value: m[1] }
}

/**
 * 从源文本提取 `const <name> = /正则字面量/` 的正则字面量本体（第三源 runtime
 * `PI_SESSION_ID_PATTERN` 的声明形态；行尾分号可选）。按行匹配（multiline `$`），
 * 正则字面量内含未转义 `/` 时提取失败一律 fail（守卫原则：形态变化宁可误报不可漏报）。
 */
export function extractConstRegex(text, constName) {
  const m = text.match(new RegExp(`const\\s+${constName}\\s*=\\s*(/[^/\\n]+/)\\s*;?\\s*$`, 'm'))
  if (!m) return { error: `未找到 const ${constName} = /正则字面量/ 声明（改名 / 形态变化？）` }
  return { value: m[1] }
}

/**
 * 从源文本提取 `const <name> = ['a', 'b', …] as const` 的字符串元素组（第四组对拍：
 * shared `PI_SESSION_TREE_SEGMENTS` 的声明形态；元素缺失 / 形态变化一律 fail）。
 */
export function extractConstStringArray(text, constName) {
  const decl = text.match(new RegExp(`const\\s+${constName}\\s*=\\s*(\\[[^\\]]*\\])\\s*as\\s+const`))
  if (!decl) return { error: `未找到 const ${constName} = ['…'] as const 声明（改名 / 形态变化？）` }
  const items = decl[1].match(/'[^']+'/g)?.map((s) => s.slice(1, -1)) ?? []
  if (items.length === 0) return { error: `${constName} 数组内未提取到字符串字面量` }
  return { value: items }
}

/** 从 runtime 布局函数块提取 `join(getPiAgentDir(), '<树根段>', …)` 的首段字面量。 */
export function extractTreeRootSegment(blockText) {
  const m = blockText.match(/join\(getPiAgentDir\(\),\s*'([^']+)'/)
  if (!m) return { error: `函数块内未找到 join(getPiAgentDir(), '<树根段>', …) 形态（字面量缺失？）` }
  return { value: m[1] }
}

/** 镜像侧函数块是否经两个段常量（根段 + 域段，而非重写字面量）拼路径。 */
export function mirrorUsesSegmentConst(blockText) {
  return /join\([^,]+,\s*SESSION_STORE_DIR_SEGMENT\s*,\s*sessionId\s*,\s*SESSION_ARTIFACTS_DIR_SEGMENT\)/.test(blockText)
}

// ── --self-test：纯函数轻量自检（不触真实仓库文件）────────────────────
// assert 骨架与尾部出口收敛在 scripts/lib/guard-report.mjs 的 runSelfTest；断言体按
// 对拍组拆三函数（公式双侧 / 树段三方 / 提取失败形态），单函数圈复杂度守低。

function selfTestFormulaPairing(assert) {
  const sharedText = `/**
 * session 存储树根段。
 */
export const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'

/**
 * pi 会话 id 同域校验正则（注释里的窄集 \`^[A-Za-z0-9_-]+$\` 形态不干扰提取）。
 */
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

export function getSessionArtifactsDir(sessionId: string, dataDir?: string): string {
  // 校验注释：允许 [A-Za-z0-9._-]
  assertPiSessionId(sessionId)
  return join(getSessionStoreDir(dataDir), sessionId, 'artifacts')
}
export function nextOne() {}`

  const mirrorText = `export const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'

export const SESSION_ARTIFACTS_DIR_SEGMENT = 'artifacts'

/**
 * 镜像推导。
 */
export function resolveSessionArtifactsDir(sessionId: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
    throw new Error(\`invalid sessionId: \${sessionId}\`)
  }
  return path.join(resolveDataDir(), SESSION_STORE_DIR_SEGMENT, sessionId, SESSION_ARTIFACTS_DIR_SEGMENT)
}
function other() {}`

  const runtimeText = `/**
 * pi 会话 id 合法值域判定。
 */
export function isPiSessionId(id: string): boolean {
  return PI_SESSION_ID_PATTERN.test(id)
}

const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`

  const sb = extractFunctionBlock(sharedText, SHARED_ANCHOR)
  assert(sb.text && sb.text.includes('getSessionArtifactsDir') && !sb.text.includes('nextOne'), '函数块截取到行首 } 为止')
  assert(extractJoinSegment(sb.text).value === 'artifacts', 'shared join 域段提取（注释里的窄集正则不干扰）')
  assert(
    extractConstRegex(sharedText, SHARED_PATTERN_CONST).value === '/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/',
    'shared sessionId 正则常量提取（assertPiSessionId 收敛形态；注释内反引号形态不误提取）',
  )
  assert(extractConstLiteral(sharedText, STORE_SEGMENT_CONST).value === 'ext-sessions', 'shared 树根段常量提取')

  const mb = extractFunctionBlock(mirrorText, MIRROR_ANCHOR)
  assert(extractSessionIdRegex(mb.text).value === extractConstRegex(sharedText, SHARED_PATTERN_CONST).value, '两侧正则一致（样例）')
  assert(extractConstLiteral(mirrorText, MIRROR_SEGMENT_CONST).value === 'artifacts', '常量域段字面量提取')
  assert(extractConstLiteral(mirrorText, STORE_SEGMENT_CONST).value === 'ext-sessions', '镜像树根段常量提取')
  assert(mirrorUsesSegmentConst(mb.text), '镜像侧 join 经根段+域段两常量拼路径')

  assert(extractConstRegex(runtimeText, RUNTIME_PATTERN_CONST).value === extractSessionIdRegex(mb.text).value, '第三源 const 正则声明提取（.test 调用行不误匹配）')
  assert(extractConstRegex('const OTHER = /x/;', RUNTIME_PATTERN_CONST).error !== undefined, '常量名不符报 error')
}

function selfTestTreePairing(assert) {
  const treeSharedText = `export const PI_SESSION_TREE_SEGMENTS = ['sessions', 'subagents', 'btw', 'ext-sessions'] as const
export const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'`
  const treeRuntimeText = `export function getSessionsDir(): string {
  return join(getPiAgentDir(), 'sessions')
}

export function getSubagentSessionDir(mainCwd: string): string {
  return join(getPiAgentDir(), 'subagents', encodeCwd(mainCwd), 'sessions')
}

export function getBtwSessionsRoot(): string {
  return join(getPiAgentDir(), 'btw')
}`
  const treeSegs = extractConstStringArray(treeSharedText, SHARED_TREE_CONST)
  assert(treeSegs.value && treeSegs.value.join(',') === 'sessions,subagents,btw,ext-sessions', '树段常量数组元素提取（含存储树末位段）')
  assert(
    compareTreeSegmentsShape(treeSegs.value, RUNTIME_TREE_FNS.length, 'ext-sessions').error === undefined,
    '树段形态断言（宿主段数 + 存储树末位段）通过（样例）',
  )
  assert(
    compareTreeSegmentsShape(['sessions', 'subagents', 'btw'], RUNTIME_TREE_FNS.length, 'ext-sessions').error !== undefined,
    '缺存储树末位段报 error',
  )
  for (const [i, fn] of RUNTIME_TREE_FNS.entries()) {
    const b = extractFunctionBlock(treeRuntimeText, `export function ${fn}`)
    assert(!b.error && extractTreeRootSegment(b.text).value === treeSegs.value[i], `pi 宿主树根段对位提取（${fn}）`)
  }
  assert(extractConstStringArray('const OTHER = 1', SHARED_TREE_CONST).error !== undefined, '树段常量缺失报 error')
  assert(extractTreeRootSegment('return join(other(), x)').error !== undefined, '树根段字面量缺失报 error')
}

function selfTestExtractionErrors(assert) {
  const sharedText = `export function getSessionArtifactsDir(sessionId: string): string {
  return join(getDataDir(), 'artifacts', sessionId)
}`
  assert(extractFunctionBlock(sharedText, 'export function missing').error !== undefined, '函数缺失报 error')
  assert(extractJoinSegment('return join(x, y, sessionId)').error !== undefined, '无字面量段名报 error')
  assert(extractSessionIdRegex('const x = 1').error !== undefined, '无校验正则报 error')
}

function selfTestCases(assert) {
  selfTestFormulaPairing(assert)
  selfTestTreePairing(assert)
  selfTestExtractionErrors(assert)
}

if (process.argv.includes('--self-test')) runSelfTest('artifact-dir-formula-sync', selfTestCases)

// ── main()：CLI 直跑才执行 ──────────────────────────────────────────

// 呈报骨架（✓/✗ 行 + 失败旗标 + 汇总出口 + 源文件读取 + self-test 骨架）与 scripts 家族
// 共享：scripts/lib/guard-report.mjs

/** 提取阶段①：双侧公式函数块（shared / system-prompt 镜像）。失败 → ✗ + fail-fast。 */
function extractFormulaBlocksOrFail(sharedText, mirrorText) {
  const sharedBlock = extractFunctionBlock(sharedText, SHARED_ANCHOR)
  const mirrorBlock = extractFunctionBlock(mirrorText, MIRROR_ANCHOR)
  if (sharedBlock.error) fail(`权威侧 ${SHARED_FN} 提取失败: ${sharedBlock.error}`)
  if (mirrorBlock.error) fail(`镜像侧 ${MIRROR_FN} 提取失败: ${mirrorBlock.error}`)
  exitIfFailed('产物目录公式对拍：函数块提取失败，按上方 ✗ 修复后重跑')
  return { sharedBlock, mirrorBlock }
}

/** 提取阶段②：公式对拍全部字面量（域段 ×2 / 树根段 ×2 / sessionId 正则 ×3 源）。失败 → ✗ + fail-fast。 */
function extractFormulaLiteralsOrFail(sharedText, sharedBlock, mirrorBlock, mirrorText, runtimeText) {
  const extracted = {
    sharedSegment: extractJoinSegment(sharedBlock.text),
    sharedStoreSegment: extractConstLiteral(sharedText, STORE_SEGMENT_CONST),
    sharedRegex: extractConstRegex(sharedText, SHARED_PATTERN_CONST),
    mirrorStoreSegment: extractConstLiteral(mirrorText, STORE_SEGMENT_CONST),
    mirrorSegment: extractConstLiteral(mirrorText, MIRROR_SEGMENT_CONST),
    mirrorRegex: extractSessionIdRegex(mirrorBlock.text),
    runtimeRegex: extractConstRegex(runtimeText, RUNTIME_PATTERN_CONST),
  }
  for (const [label, r] of [
    ['shared join 域段', extracted.sharedSegment],
    [`shared 树根段常量 ${STORE_SEGMENT_CONST}`, extracted.sharedStoreSegment],
    [`shared sessionId 正则常量 ${SHARED_PATTERN_CONST}`, extracted.sharedRegex],
    [`镜像树根段常量 ${STORE_SEGMENT_CONST}`, extracted.mirrorStoreSegment],
    [`镜像常量 ${MIRROR_SEGMENT_CONST}`, extracted.mirrorSegment],
    ['镜像 sessionId 正则', extracted.mirrorRegex],
    [`runtime ${RUNTIME_PATTERN_CONST} 正则`, extracted.runtimeRegex],
  ]) {
    if (r.error) fail(`${label} 提取失败: ${r.error}`)
  }
  exitIfFailed('产物目录公式对拍：字面量提取失败，按上方 ✗ 修复后重跑')
  return extracted
}

/** ① 域段字面量一致（shared join ↔ 镜像常量）。 */
function compareSegmentLiteral(sharedSegment, mirrorSegment) {
  if (sharedSegment === mirrorSegment) {
    ok(`域段字面量一致（'${sharedSegment}'，shared join ↔ 镜像常量）`)
  } else {
    fail(
      `域段字面量漂移: shared='${sharedSegment}' vs 镜像='${mirrorSegment}'` +
        `——恢复动作：人工核对 ${SHARED_PATHS_SRC} 的 ${SHARED_FN} 与 ${SYSTEM_PROMPT_SRC} 的 ${MIRROR_SEGMENT_CONST}`,
    )
  }
}

/** ①b 存储树根段字面量一致（shared 常量 ↔ 镜像常量）。 */
function compareStoreSegmentLiteral(sharedStoreSegment, mirrorStoreSegment) {
  if (sharedStoreSegment === mirrorStoreSegment) {
    ok(`存储树根段字面量一致（'${sharedStoreSegment}'，shared ${STORE_SEGMENT_CONST} ↔ 镜像）`)
  } else {
    fail(
      `存储树根段字面量漂移: shared='${sharedStoreSegment}' vs 镜像='${mirrorStoreSegment}'` +
        `——恢复动作：人工核对 ${SHARED_PATHS_SRC} 与 ${SYSTEM_PROMPT_SRC} 的 ${STORE_SEGMENT_CONST}`,
    )
  }
}

/** ② + ②b：sessionId 校验正则字面量三方一致（shared ↔ 镜像；shared ↔ runtime）。 */
function compareSessionIdRegexes(sharedRegex, mirrorRegex, runtimeRegex) {
  if (sharedRegex === mirrorRegex) {
    ok(`sessionId 校验正则字面量一致（${sharedRegex}）`)
  } else {
    fail(
      `sessionId 校验正则漂移: shared=${sharedRegex} vs 镜像=${mirrorRegex}` +
        `——恢复动作：人工核对两侧正则（规则须与 isPiSessionId 同域：允许 . 与 _，禁 :）`,
    )
  }
  // 镜像 ↔ runtime 由等价传递覆盖；该正则同时是产物目录名合法性判据 isPiSessionId 的源头，
  // 漂移即判错目录名
  if (sharedRegex === runtimeRegex) {
    ok(`runtime ${RUNTIME_PATTERN_CONST} 与 shared sessionId 正则一致（${runtimeRegex}）`)
  } else {
    fail(
      `sessionId 校验正则漂移: shared=${sharedRegex} vs runtime ${RUNTIME_PATTERN_CONST}=${runtimeRegex}` +
        `——恢复动作：人工核对 ${SHARED_PATHS_SRC} 的 ${SHARED_PATTERN_CONST} 与 ${RUNTIME_PI_PATHS_SRC} 的 ${RUNTIME_PATTERN_CONST}` +
        `（同域规则：首尾字母数字，中间允许 [A-Za-z0-9._-]，禁 :）`,
    )
  }
}

/** ③ 镜像侧须经根段+域段两常量拼路径（防常量保留而函数内重写死字面量）。 */
function checkMirrorConstUsage(mirrorBlock) {
  if (mirrorUsesSegmentConst(mirrorBlock.text)) {
    ok(`镜像 ${MIRROR_FN} 经 ${STORE_SEGMENT_CONST} + ${MIRROR_SEGMENT_CONST} 拼路径（无旁路字面量）`)
  } else {
    fail(
      `镜像 ${MIRROR_FN} 未经段常量拼路径` +
        `——恢复动作：改为 path.join(resolveDataDir(), ${STORE_SEGMENT_CONST}, sessionId, ${MIRROR_SEGMENT_CONST})` +
        '（重写死字面量会被本守卫漏掉漂移）',
    )
  }
}

/**
 * ④ pi 会话树段对拍：shared PI_SESSION_TREE_SEGMENTS（跨进程消费 SSOT）↔ runtime
 * 布局权威三函数的树根段字面量——runtime 改树名而 shared 常量未跟 = 树内包含判定
 * （如会话导出路径安全校验）跨进程判据漂移。末位段为 taiji 存储树根段（基址
 * `<dataDir>`，非 piAgentDir），与 shared `SESSION_STORE_DIR_SEGMENT` 一致。
 */

/**
 * 树段数组形态断言（纯函数，self-test 直测）：前 `hostSegmentCount` 位为 pi 宿主段，
 * 末位须为存储树根段 `storeSegment`。
 */
export function compareTreeSegmentsShape(treeSegments, hostSegmentCount, storeSegment) {
  if (treeSegments.length < hostSegmentCount + 1 || treeSegments[treeSegments.length - 1] !== storeSegment) {
    return {
      error:
        `${SHARED_TREE_CONST} 须含 pi 宿主 ${hostSegmentCount} 段 + 末位存储树根段 '${storeSegment}'，` +
        `实际 [${treeSegments.join(', ')}]——恢复动作：树布局增删时同批更新 shared 常量与本守卫`,
    }
  }
  return { value: true }
}

/** ④ 逐步（循环体）：提取 runtime 布局函数树根段，与 shared 常量对位比对。 */
function compareTreeRootSegment(runtimeText, treeSegments, i, fn) {
  const block = extractFunctionBlock(runtimeText, `export function ${fn}`)
  if (block.error) {
    fail(`runtime ${fn} 提取失败: ${block.error}`)
    return
  }
  const seg = extractTreeRootSegment(block.text)
  if (seg.error) {
    fail(`runtime ${fn} 树根段提取失败: ${seg.error}`)
  } else if (seg.value !== treeSegments[i]) {
    fail(
      `pi 会话树段漂移: ${SHARED_TREE_CONST}[${i}]='${treeSegments[i]}' vs runtime ${fn}()='${seg.value}'` +
        `——恢复动作：树名变更时同批改 ${SHARED_PATHS_SRC} 常量与 ${RUNTIME_PI_PATHS_SRC} 布局函数`,
    )
  } else {
    ok(`pi 会话树段一致（runtime ${fn}() → '${seg.value}'，对应 ${SHARED_TREE_CONST}[${i}]）`)
  }
}

function compareTreeSegments(sharedText, runtimeText, sharedStoreSegment) {
  const treeSegments = extractConstStringArray(sharedText, SHARED_TREE_CONST)
  if (treeSegments.error) {
    fail(`shared ${SHARED_TREE_CONST} 提取失败: ${treeSegments.error}`)
    return
  }
  const shape = compareTreeSegmentsShape(treeSegments.value, RUNTIME_TREE_FNS.length, sharedStoreSegment)
  if (shape.error) {
    fail(shape.error)
    return
  }
  for (const [i, fn] of RUNTIME_TREE_FNS.entries()) {
    compareTreeRootSegment(runtimeText, treeSegments.value, i, fn)
  }
  ok(`存储树末位段一致（${SHARED_TREE_CONST} 末位 ↔ shared ${STORE_SEGMENT_CONST}='${sharedStoreSegment}'）`)
}

function main() {
  const [sharedText, mirrorText, runtimeText] = readSourcesOrFail([
    [SHARED_PATHS_SRC, 'shared paths 源文件'],
    [SYSTEM_PROMPT_SRC, 'system-prompt 源文件'],
    [RUNTIME_PI_PATHS_SRC, 'runtime pi-paths 源文件'],
  ])

  const { sharedBlock, mirrorBlock } = extractFormulaBlocksOrFail(sharedText, mirrorText)
  const lits = extractFormulaLiteralsOrFail(sharedText, sharedBlock, mirrorBlock, mirrorText, runtimeText)

  compareSegmentLiteral(lits.sharedSegment.value, lits.mirrorSegment.value)
  compareStoreSegmentLiteral(lits.sharedStoreSegment.value, lits.mirrorStoreSegment.value)
  compareSessionIdRegexes(lits.sharedRegex.value, lits.mirrorRegex.value, lits.runtimeRegex.value)
  checkMirrorConstUsage(mirrorBlock)
  compareTreeSegments(sharedText, runtimeText, lits.sharedStoreSegment.value)

  guardExit(
    '✓ 产物目录公式对拍通过（域段 + 存储树根段 + sessionId 校验正则三方 + pi 会话树段逐字一致）',
    '产物目录公式对拍未通过，按上方 ✗ 明细修复后重跑（每条报错自带恢复动作）',
  )
}

if (isDirectRun(import.meta.url)) main()
