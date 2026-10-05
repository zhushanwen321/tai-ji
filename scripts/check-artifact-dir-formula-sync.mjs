#!/usr/bin/env node
/**
 * check-artifact-dir-formula-sync.mjs —— 会话产物目录公式双实现对拍守卫。
 * （设计：.tmp/tech-design/chat-html-support.md §6.7 D7 / §11 检查点 8 / §10 u-artifacts）
 *
 * 背景：产物目录公式 `<dataDir>/artifacts/<sessionId>` 有两份实现，跨包不可 import
 * （extensions 包不依赖 @taiji/shared，且 shared getDataDir 对打包态 pi 进程直接 throw）：
 *   ① 权威侧 shared：`packages/shared/src/paths.ts` 的 `getSessionArtifactsDir`
 *      （runtime / main 消费）；
 *   ② 镜像侧 system-prompt 扩展：`extensions/taiji/system-prompt/src/index.ts` 的
 *      `SESSION_ARTIFACTS_DIR_SEGMENT` + `resolveSessionArtifactsDir`（每 turn 注入产物
 *      目录绝对路径）。
 * 两侧任一漂移（段名改了 / 校验正则松紧不一）= agent 收到的路径与实际目录不符（写偏或
 * 预览 404）。跨包不可 import 不是豁免机检的理由——本守卫与 u1 的
 * check-capability-allowlist-sync.mjs 同为**源文件字面量对拍**形态（强度对称）：
 * 读双侧源文本，提取段名字面量与 sessionId 校验正则字面量，断言逐字一致。
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
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fail, ok, isFailed, guardExit, extractFunctionBlock } from './lib/guard-report.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHARED_PATHS_SRC = join(ROOT, 'packages', 'shared', 'src', 'paths.ts')
const SYSTEM_PROMPT_SRC = join(ROOT, 'extensions', 'taiji', 'system-prompt', 'src', 'index.ts')

/** 权威侧函数名（shared）。 */
export const SHARED_FN = 'getSessionArtifactsDir'
/** 镜像侧函数名（system-prompt）。 */
export const MIRROR_FN = 'resolveSessionArtifactsDir'
/** 镜像侧段名常量名。 */
export const MIRROR_SEGMENT_CONST = 'SESSION_ARTIFACTS_DIR_SEGMENT'

/** 函数体截取锚点（含 `export function` 前缀，避免匹配到调用点）。 */
const SHARED_ANCHOR = `export function ${SHARED_FN}`
const MIRROR_ANCHOR = `export function ${MIRROR_FN}`

// 函数体截取原语与 POSIX resolve 镜像守卫同款收敛：scripts/lib/guard-report.mjs。
// re-export 保持单测（scripts/__tests__/check-artifact-dir-formula-sync.test.mjs）的既有 import 面。
export { extractFunctionBlock }

/** 从函数块提取 `join(<dataDir 表达式>, '<段名>', sessionId)` 的段名字面量。 */
export function extractJoinSegment(blockText) {
  const m = blockText.match(/join\([^,]+,\s*'([^']+)',\s*sessionId\)/)
  if (!m) return { error: `函数块内未找到 join(<dataDir>, '<段名>', sessionId) 形态（字面量段名缺失？）` }
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

/** 镜像侧函数块是否经常量（而非重写段名字面量）拼路径。 */
export function mirrorUsesSegmentConst(blockText) {
  return /join\([^,]+,\s*SESSION_ARTIFACTS_DIR_SEGMENT\s*,\s*sessionId\)/.test(blockText)
}

// ── --self-test：纯函数轻量自检（不触真实仓库文件）────────────────────

function selfTest() {
  const assert = (cond, name) => {
    if (!cond) {
      console.error(`  ✗ self-test: ${name}`)
      process.exitCode = 1
    } else {
      console.log(`  ✓ self-test: ${name}`)
    }
  }

  const sharedText = `/**
 * 会话产物目录（\`<dataDir>/artifacts/<sessionId>\`，含窄集注释 \`^[A-Za-z0-9_-]+$\`）。
 */
export function getSessionArtifactsDir(sessionId: string, dataDir?: string): string {
  // 校验与 isPiSessionId 同域：允许 [A-Za-z0-9._-]
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
    throw new Error(\`invalid sessionId: \${sessionId}\`)
  }
  return join(dataDir ?? getDataDir(), 'artifacts', sessionId)
}
export function nextOne() {}`

  const mirrorText = `export const SESSION_ARTIFACTS_DIR_SEGMENT = 'artifacts'

/**
 * 镜像推导。
 */
export function resolveSessionArtifactsDir(sessionId: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
    throw new Error(\`invalid sessionId: \${sessionId}\`)
  }
  return path.join(resolveDataDir(), SESSION_ARTIFACTS_DIR_SEGMENT, sessionId)
}
function other() {}`

  const sb = extractFunctionBlock(sharedText, SHARED_ANCHOR)
  assert(sb.text && sb.text.includes('getSessionArtifactsDir') && !sb.text.includes('nextOne'), '函数块截取到行首 } 为止')
  assert(extractJoinSegment(sb.text).value === 'artifacts', 'shared join 段名提取（注释里的窄集正则不干扰）')
  assert(
    extractSessionIdRegex(sb.text).value === '/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/',
    'shared sessionId 正则字面量提取（注释内反引号形态不误提取）',
  )

  const mb = extractFunctionBlock(mirrorText, MIRROR_ANCHOR)
  assert(extractSessionIdRegex(mb.text).value === extractSessionIdRegex(sb.text).value, '两侧正则一致（样例）')
  assert(extractConstLiteral(mirrorText, MIRROR_SEGMENT_CONST).value === 'artifacts', '常量段名字面量提取')
  assert(mirrorUsesSegmentConst(mb.text), '镜像侧 join 经常量拼段名')

  assert(extractFunctionBlock(sharedText, 'export function missing').error !== undefined, '函数缺失报 error')
  assert(extractJoinSegment('return join(x, y, sessionId)').error !== undefined, '无字面量段名报 error')
  assert(extractSessionIdRegex('const x = 1').error !== undefined, '无校验正则报 error')

  if (process.exitCode === 1) {
    console.error('artifact-dir-formula-sync self-test 未通过')
    process.exit(1)
  }
  console.log('✓ artifact-dir-formula-sync self-test 全部通过')
  process.exit(0)
}

if (process.argv.includes('--self-test')) selfTest()

// ── main()：CLI 直跑才执行 ──────────────────────────────────────────

// 呈报骨架（✓/✗ 行 + 失败旗标 + 汇总出口）与 scripts 家族共享：scripts/lib/guard-report.mjs

function readTextOrFail(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label} 缺失: ${filePath}——恢复动作：确认文件未被移动 / 删除（迁移时同步本守卫路径）`)
    return null
  }
  return readFileSync(filePath, 'utf-8')
}

function main() {
  const sharedText = readTextOrFail(SHARED_PATHS_SRC, 'shared paths 源文件')
  const mirrorText = readTextOrFail(SYSTEM_PROMPT_SRC, 'system-prompt 源文件')
  if (sharedText === null || mirrorText === null) process.exit(1)

  const sharedBlock = extractFunctionBlock(sharedText, SHARED_ANCHOR)
  const mirrorBlock = extractFunctionBlock(mirrorText, MIRROR_ANCHOR)
  if (sharedBlock.error) fail(`权威侧 ${SHARED_FN} 提取失败: ${sharedBlock.error}`)
  if (mirrorBlock.error) fail(`镜像侧 ${MIRROR_FN} 提取失败: ${mirrorBlock.error}`)
  if (isFailed()) {
    console.error('产物目录公式对拍：函数块提取失败，按上方 ✗ 修复后重跑')
    process.exit(1)
  }

  const sharedSegment = extractJoinSegment(sharedBlock.text)
  const sharedRegex = extractSessionIdRegex(sharedBlock.text)
  const mirrorSegment = extractConstLiteral(mirrorText, MIRROR_SEGMENT_CONST)
  const mirrorRegex = extractSessionIdRegex(mirrorBlock.text)
  for (const [label, r] of [
    ['shared join 段名', sharedSegment],
    ['shared sessionId 正则', sharedRegex],
    [`镜像常量 ${MIRROR_SEGMENT_CONST}`, mirrorSegment],
    ['镜像 sessionId 正则', mirrorRegex],
  ]) {
    if (r.error) fail(`${label} 提取失败: ${r.error}`)
  }
  if (isFailed()) {
    console.error('产物目录公式对拍：字面量提取失败，按上方 ✗ 修复后重跑')
    process.exit(1)
  }

  // ① 段名字面量一致
  if (sharedSegment.value === mirrorSegment.value) {
    ok(`段名字面量一致（'${sharedSegment.value}'，shared join ↔ 镜像常量）`)
  } else {
    fail(
      `段名字面量漂移: shared='${sharedSegment.value}' vs 镜像='${mirrorSegment.value}'` +
        `——恢复动作：人工核对 ${SHARED_PATHS_SRC} 的 ${SHARED_FN} 与 ${SYSTEM_PROMPT_SRC} 的 ${MIRROR_SEGMENT_CONST}`,
    )
  }

  // ② sessionId 校验正则字面量一致
  if (sharedRegex.value === mirrorRegex.value) {
    ok(`sessionId 校验正则字面量一致（${sharedRegex.value}）`)
  } else {
    fail(
      `sessionId 校验正则漂移: shared=${sharedRegex.value} vs 镜像=${mirrorRegex.value}` +
        `——恢复动作：人工核对两侧正则（规则须与 isPiSessionId 同域：允许 . 与 _，禁 :）`,
    )
  }

  // ③ 镜像侧须经常量拼段名（防常量保留而函数内重写死字面量）
  if (mirrorUsesSegmentConst(mirrorBlock.text)) {
    ok(`镜像 ${MIRROR_FN} 经 ${MIRROR_SEGMENT_CONST} 拼段名（无旁路字面量）`)
  } else {
    fail(
      `镜像 ${MIRROR_FN} 未经 ${MIRROR_SEGMENT_CONST} 拼段名` +
        `——恢复动作：改为 join(resolveDataDir(), ${MIRROR_SEGMENT_CONST}, sessionId)` +
        '（重写死字面量会被本守卫漏掉漂移）',
    )
  }

  guardExit(
    '✓ 产物目录公式双实现对拍通过（段名 + sessionId 校验正则逐字一致）',
    '产物目录公式对拍未通过，按上方 ✗ 明细修复后重跑（每条报错自带恢复动作）',
  )
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) main()
