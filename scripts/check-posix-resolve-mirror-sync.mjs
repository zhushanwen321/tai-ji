#!/usr/bin/env node
/**
 * check-posix-resolve-mirror-sync.mjs —— POSIX resolve 折叠实现三份镜像的字面量对拍检查。
 * （chat-html-support v16 内联容器 / markdown-html-sanitize-render D4 镜像纪律的机检补强）
 *
 * 背景：`base + rel` 后逐段折叠 `.` / `..` 的 POSIX resolve 纯函数（Node path.resolve 语义
 * 的纯函数实现——renderer 运行时无 node:path）有三份逐字同款实现，跨包不可 import
 * （ui→renderer 依赖禁令）：
 *   ① ui html-preview-path.ts 的 resolvePosixPath（html-preview 内联容器 src/href 解析）；
 *   ② ui markdown-sanitize.ts 的 resolveResourcePath（相对资源 img src 重写，D4；D10 渲染链下沉后三方同域 ui 包内——镜像形态与对拍纪律不变）
 *   ③ ui markdown-links.ts 的 resolveHrefPath（④路相对链接 href resolve）。
 * 任一份漂移 = 两侧对同一相对路径解析出不同绝对路径（iframe src 与 markdown 链接点击
 * 落点不一致，越界收尾行为分叉）。三份仅注释纪律同步无机检同族先例（产物目录公式、
 * capability 清单均已配对拍检查），本检查补齐。
 *
 * renderer 的 lib/path-utils.resolvePreviewPath 不属于本族——它对相对路径仅前缀拼接
 * 不折叠 `..`（gitOverlay / git diff 查询用途，语义不同），不参与对拍。
 *
 * 对拍内容（源文件文本字面量，非运行时等价测试）：
 *   ① 三份函数体（剥签名行后）逐字一致：基准 = ui resolvePosixPath，renderer
 *      resolveResourcePath 与 MarkdownRenderer resolveHrefPath 各与基准比对
 *      （renderer ↔ MarkdownRenderer 由等价传递覆盖）；
 *   ② 折叠语义锚点在场：`rel.startsWith('/')` / `if (seg === '..')` / `parts.pop()`——
 *      防「三份一致地删空 / 退化」的对拍盲区（全同但全错照旧拦截）。
 *
 * 形态照搬 scripts/check-artifact-dir-formula-sync.mjs（读源文件文本、零散文解析、
 * 提取失败一律 fail、--self-test 纯函数自检）。
 *
 * 用法：
 *   node scripts/check-posix-resolve-mirror-sync.mjs               # 常规校验（pre-commit 按路径触发）
 *   node scripts/check-posix-resolve-mirror-sync.mjs --self-test   # 纯函数轻量自检
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
const UI_HTML_PREVIEW_PATH_SRC = join(ROOT, 'packages', 'ui', 'src', 'features', 'chat', 'html-preview-path.ts')
const SANITIZE_SRC = join(ROOT, 'packages', 'ui', 'src', 'features', 'chat', 'markdown-sanitize.ts')
const UI_MARKDOWN_LINKS_SRC = join(ROOT, 'packages', 'ui', 'src', 'features', 'chat', 'markdown-links.ts')

/** 函数体截取锚点（含声明前缀，避免匹配到调用点 / 注释提及）。 */
export const UI_ANCHOR = 'export function resolvePosixPath'
export const RENDERER_ANCHOR = 'export function resolveResourcePath'
export const UI_LINKS_ANCHOR = 'function resolveHrefPath'

/** 折叠语义锚点（三份缺一不可——防「一致删空 / 一致退化」的对拍盲区）。 */
export const FOLD_SEMANTIC_ANCHORS = ["rel.startsWith('/')", "if (seg === '..')", 'parts.pop()']

// 函数体截取原语与产物目录公式检查同款收敛：scripts/lib/guard-report.mjs（本文件 main /
// self-test 的本地引用经上方 import 绑定；export 保持既有公共部分）。
export { extractFunctionBlock }

/** 剥签名行（三份签名仅函数名 / export 修饰不同，对拍对象是签名行之后的函数体）。 */
export function stripSignatureHead(blockText) {
  const nl = blockText.indexOf('\n')
  return nl < 0 ? '' : blockText.slice(nl + 1)
}

/** 提取函数体：截取块 + 剥签名行；空体报 error。 */
export function extractFunctionBody(text, anchor) {
  const block = extractFunctionBlock(text, anchor)
  if (block.error) return block
  const body = stripSignatureHead(block.text)
  if (!body.trim()) return { error: `${anchor} 函数体为空（形态变化？）` }
  return { text: body }
}

/** 返回函数体缺失的折叠语义锚点（空数组 = 全在场）。 */
export function missingFoldAnchors(bodyText) {
  return FOLD_SEMANTIC_ANCHORS.filter((a) => !bodyText.includes(a))
}

// ── --self-test：纯函数轻量自检（不触真实仓库文件）────────────────────
// assert 骨架与尾部出口收敛在 scripts/lib/guard-report.mjs 的 runSelfTest；断言体按
// 检查组拆三函数（函数体提取 / 漂移与退化检出 / 提取失败形态）。

function selfTestSampleTexts() {
  const bodyOf = (anchor) => `${anchor}(base: string, rel: string): string {
  const joined = rel.startsWith('/') ? rel : \`\${base}/\${rel}\`
  const parts: string[] = []
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return \`/\${parts.join('/')}\`
}
function nextOne() {}`
  return {
    uiText: bodyOf(UI_ANCHOR),
    rendererText: bodyOf(RENDERER_ANCHOR),
    uiLinksText: bodyOf(UI_LINKS_ANCHOR),
  }
}

function selfTestExtraction(assert) {
  const { uiText } = selfTestSampleTexts()
  const uiBody = extractFunctionBody(uiText, UI_ANCHOR)
  assert(!uiBody.error && uiBody.text.includes("rel.startsWith('/')"), '函数体提取（含折叠拼接）')
  assert(!uiBody.text.includes(UI_ANCHOR), '签名行已剥（对拍对象不含声明行）')
  assert(!uiBody.text.includes('nextOne'), '截取到行首 } 为止（不吞后续函数）')
}

function selfTestDriftDetection(assert) {
  const { uiText, rendererText, uiLinksText } = selfTestSampleTexts()
  const uiBody = extractFunctionBody(uiText, UI_ANCHOR)
  const rendererBody = extractFunctionBody(rendererText, RENDERER_ANCHOR)
  const uiLinksBody = extractFunctionBody(uiLinksText, UI_LINKS_ANCHOR)

  // 三份同款 → 逐字一致 + 锚点全在场
  assert(
    uiBody.text === rendererBody.text && uiBody.text === uiLinksBody.text,
    '三份同款样例逐字一致',
  )
  assert(missingFoldAnchors(uiBody.text).length === 0, '同款样例折叠语义锚点全在场')

  // 漂移样例：一份改动折叠语义 → 与基准不等
  const driftedText = rendererText.replace("if (seg === '..') {\n      parts.pop()\n      continue\n    }", "if (seg === '..') continue")
  const driftedBody = extractFunctionBody(driftedText, RENDERER_ANCHOR)
  assert(driftedBody.text !== uiBody.text, '漂移样例被比对检出（≠ 基准）')

  // 一致退化样例：三份同款但删掉 `..` 折叠 → 语义锚点断言拦截
  const degenerateBody = uiBody.text.replace("if (seg === '..') {\n      parts.pop()\n      continue\n    }", "if (seg === '..') continue")
  assert(missingFoldAnchors(degenerateBody).length > 0, '一致退化样例被语义锚点断言拦截')
}

function selfTestErrors(assert) {
  assert(extractFunctionBody('const x = 1', UI_ANCHOR).error !== undefined, 'anchor 缺失报 error')
  assert(extractFunctionBody(`${UI_ANCHOR}(base: string, rel: string): string {\n  return rel\n`, UI_ANCHOR).error !== undefined, '无行首收尾报 error')
  assert(stripSignatureHead('nosignature') === '', '无换行块剥签名得空串')
}

function selfTestCases(assert) {
  selfTestExtraction(assert)
  selfTestDriftDetection(assert)
  selfTestErrors(assert)
}

if (process.argv.includes('--self-test')) runSelfTest('posix-resolve-mirror-sync', selfTestCases)

// ── main()：CLI 直跑才执行 ──────────────────────────────────────────

// 呈报骨架（✓/✗ 行 + 失败旗标 + 汇总出口 + 源文件读取 + self-test 骨架）与 scripts 家族
// 共享：scripts/lib/guard-report.mjs

/** 基准 ↔ 镜像逐字对拍（一致 ok / 漂移 fail 带恢复动作）。 */
function compareWithBaseline(baselineBody, mirrorBody, mirrorLabel, baselineLabel, mirrorSrc) {
  if (mirrorBody.text === baselineBody.text) {
    ok(`${mirrorLabel} 函数体与基准逐字一致`)
  } else {
    fail(
      `折叠实现漂移: ${mirrorLabel} ≠ 基准 ${baselineLabel}` +
        `——恢复动作：以任一份为准，把三份（${UI_ANCHOR} / ${RENDERER_ANCHOR} / ${UI_LINKS_ANCHOR}）` +
        `函数体改为逐字同款（本侧源文件 ${mirrorSrc}；本检查只对拍不裁决权威侧，语义变化须人工确认后三处同批同步）`,
    )
  }
}

function main() {
  const [uiText, rendererText, uiLinksText] = readSourcesOrFail([
    [UI_HTML_PREVIEW_PATH_SRC, 'ui html-preview-path 源文件'],
    [SANITIZE_SRC, 'renderer markdown-sanitize 源文件'],
    [UI_MARKDOWN_LINKS_SRC, 'ui markdown-links 源文件'],
  ])

  const uiBody = extractFunctionBody(uiText, UI_ANCHOR)
  const rendererBody = extractFunctionBody(rendererText, RENDERER_ANCHOR)
  const uiLinksBody = extractFunctionBody(uiLinksText, UI_LINKS_ANCHOR)
  const extracted = [
    [`ui ${UI_ANCHOR}`, uiBody, UI_HTML_PREVIEW_PATH_SRC],
    [`renderer ${RENDERER_ANCHOR}`, rendererBody, SANITIZE_SRC],
    [`ui ${UI_LINKS_ANCHOR}`, uiLinksBody, UI_MARKDOWN_LINKS_SRC],
  ]
  for (const [label, body, src] of extracted) {
    if (body.error) fail(`${label} 提取失败: ${body.error}——恢复动作：核对 ${src} 函数形态（收尾 '}' 须在行首）`)
  }
  exitIfFailed('POSIX resolve 镜像对拍：函数体提取失败，按上方 ✗ 修复后重跑')

  // ① 折叠语义锚点在场（防三份一致删空 / 退化的对拍盲区）
  const baselineLabel = `ui ${UI_ANCHOR}`
  const missing = missingFoldAnchors(uiBody.text)
  if (missing.length === 0) {
    ok(`折叠语义锚点全在场（${FOLD_SEMANTIC_ANCHORS.join(' / ')}）`)
  } else {
    fail(
      `${baselineLabel} 缺折叠语义锚点: ${missing.join('、')}` +
        '——恢复动作：核对折叠语义是否被改动（`..` 折叠 / base+rel 拼接是三份镜像的公共语义），语义变化须三处同批同步',
    )
  }

  // ② 三份函数体逐字对拍（renderer ↔ markdown-links 由等价传递覆盖）
  compareWithBaseline(uiBody, rendererBody, `renderer ${RENDERER_ANCHOR}`, baselineLabel, SANITIZE_SRC)
  compareWithBaseline(uiBody, uiLinksBody, `ui ${UI_LINKS_ANCHOR}`, baselineLabel, UI_MARKDOWN_LINKS_SRC)

  guardExit(
    '✓ POSIX resolve 三份折叠实现对拍通过（函数体逐字一致 + 折叠语义锚点在场）',
    'POSIX resolve 镜像对拍未通过，按上方 ✗ 明细修复后重跑（每条报错自带恢复动作）',
  )
}

if (isDirectRun(import.meta.url)) main()
