#!/usr/bin/env node
/**
 * check-posix-resolve-mirror-sync.mjs —— POSIX resolve 折叠实现三份镜像的字面量对拍守卫。
 * （chat-html-support v16 内联容器 / markdown-html-sanitize-render D4 镜像纪律的机检补强）
 *
 * 背景：`base + rel` 后逐段折叠 `.` / `..` 的 POSIX resolve 纯函数（Node path.resolve 语义
 * 的纯函数实现——renderer 运行时无 node:path）有三份逐字同款实现，跨包不可 import
 * （ui→renderer 依赖禁令）：
 *   ① ui html-preview-path.ts 的 resolvePosixPath（html-preview 内联容器 src/href 解析）；
 *   ② ui markdown-sanitize.ts 的 resolveResourcePath（相对资源 img src 重写，D4；D10 渲染链下沉后三方同域 ui 包内——镜像形态与对拍纪律不变）
 *   ③ ui markdown-links.ts 的 resolveHrefPath（④路相对链接 href resolve）。
 * 任一份漂移 = 两侧对同一相对路径解析出不同绝对路径（iframe src 与 markdown 链接点击
 * 落点不一致，越界收口行为分叉）。三份仅注释纪律同步无机检同族先例（产物目录公式、
 * capability 清单均已配对拍守卫），本守卫补齐。
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
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fail, ok, isFailed, guardExit, extractFunctionBlock } from './lib/guard-report.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UI_HTML_PREVIEW_PATH_SRC = join(ROOT, 'packages', 'ui', 'src', 'features', 'chat', 'html-preview-path.ts')
const SANITIZE_SRC = join(ROOT, 'packages', 'ui', 'src', 'features', 'chat', 'markdown-sanitize.ts')
const UI_MARKDOWN_LINKS_SRC = join(ROOT, 'packages', 'ui', 'src', 'features', 'chat', 'markdown-links.ts')

/** 函数体截取锚点（含声明前缀，避免匹配到调用点 / 注释提及）。 */
export const UI_ANCHOR = 'export function resolvePosixPath'
export const RENDERER_ANCHOR = 'export function resolveResourcePath'
export const UI_LINKS_ANCHOR = 'function resolveHrefPath'

/** 折叠语义锚点（三份缺一不可——防「一致删空 / 一致退化」的对拍盲区）。 */
export const FOLD_SEMANTIC_ANCHORS = ["rel.startsWith('/')", "if (seg === '..')", 'parts.pop()']

// 函数体截取原语与产物目录公式守卫同款收敛：scripts/lib/guard-report.mjs（本文件 main /
// self-test 的本地引用经上方 import 绑定；export 保持既有公共面）。
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

function selfTest() {
  const assert = (cond, name) => {
    if (!cond) {
      console.error(`  ✗ self-test: ${name}`)
      process.exitCode = 1
    } else {
      console.log(`  ✓ self-test: ${name}`)
    }
  }

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

  const uiText = bodyOf(UI_ANCHOR)
  const rendererText = bodyOf(RENDERER_ANCHOR)
  const uiLinksText = bodyOf(UI_LINKS_ANCHOR)

  const uiBody = extractFunctionBody(uiText, UI_ANCHOR)
  assert(!uiBody.error && uiBody.text.includes("rel.startsWith('/')"), '函数体提取（含折叠拼接）')
  assert(!uiBody.text.includes(UI_ANCHOR), '签名行已剥（对拍对象不含声明行）')
  assert(!uiBody.text.includes('nextOne'), '截取到行首 } 为止（不吞后续函数）')

  // 三份同款 → 逐字一致 + 锚点全在场
  const rendererBody = extractFunctionBody(rendererText, RENDERER_ANCHOR)
  const uiLinksBody = extractFunctionBody(uiLinksText, UI_LINKS_ANCHOR)
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

  // 提取失败形态
  assert(extractFunctionBody('const x = 1', UI_ANCHOR).error !== undefined, 'anchor 缺失报 error')
  assert(extractFunctionBody(`${UI_ANCHOR}(base: string, rel: string): string {\n  return rel\n`, UI_ANCHOR).error !== undefined, '无行首闭合报 error')
  assert(stripSignatureHead('nosignature') === '', '无换行块剥签名得空串')

  if (process.exitCode === 1) {
    console.error('posix-resolve-mirror-sync self-test 未通过')
    process.exit(1)
  }
  console.log('✓ posix-resolve-mirror-sync self-test 全部通过')
  process.exit(0)
}

if (process.argv.includes('--self-test')) selfTest()

// ── main()：CLI 直跑才执行 ──────────────────────────────────────────

// 呈报骨架（✓/✗ 行 + 失败旗标 + 汇总出口）与 scripts 家族共享：scripts/lib/guard-report.mjs

function readTextOrFail(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label} 缺失: ${filePath}——恢复动作：确认文件未被移动 / 删除（迁移时同步本守卫路径常量）`)
    return null
  }
  return readFileSync(filePath, 'utf-8')
}

/** 基准 ↔ 镜像逐字对拍（一致 ok / 漂移 fail 带恢复动作）。 */
function compareWithBaseline(baselineBody, mirrorBody, mirrorLabel, baselineLabel, mirrorSrc) {
  if (mirrorBody.text === baselineBody.text) {
    ok(`${mirrorLabel} 函数体与基准逐字一致`)
  } else {
    fail(
      `折叠实现漂移: ${mirrorLabel} ≠ 基准 ${baselineLabel}` +
        `——恢复动作：以任一份为准，把三份（${UI_ANCHOR} / ${RENDERER_ANCHOR} / ${UI_LINKS_ANCHOR}）` +
        `函数体改为逐字同款（本侧源文件 ${mirrorSrc}；本守卫只对拍不裁决权威侧，语义变化须人工确认后三处同批同步）`,
    )
  }
}

function main() {
  const uiText = readTextOrFail(UI_HTML_PREVIEW_PATH_SRC, 'ui html-preview-path 源文件')
  const rendererText = readTextOrFail(SANITIZE_SRC, 'renderer markdown-sanitize 源文件')
  const uiLinksText = readTextOrFail(UI_MARKDOWN_LINKS_SRC, 'ui markdown-links 源文件')
  if (uiText === null || rendererText === null || uiLinksText === null) process.exit(1)

  const uiBody = extractFunctionBody(uiText, UI_ANCHOR)
  const rendererBody = extractFunctionBody(rendererText, RENDERER_ANCHOR)
  const uiLinksBody = extractFunctionBody(uiLinksText, UI_LINKS_ANCHOR)
  const extracted = [
    [`ui ${UI_ANCHOR}`, uiBody, UI_HTML_PREVIEW_PATH_SRC],
    [`renderer ${RENDERER_ANCHOR}`, rendererBody, SANITIZE_SRC],
    [`ui ${UI_LINKS_ANCHOR}`, uiLinksBody, UI_MARKDOWN_LINKS_SRC],
  ]
  for (const [label, body, src] of extracted) {
    if (body.error) fail(`${label} 提取失败: ${body.error}——恢复动作：核对 ${src} 函数形态（闭合 '}' 须在行首）`)
  }
  if (isFailed()) {
    console.error('POSIX resolve 镜像对拍：函数体提取失败，按上方 ✗ 修复后重跑')
    process.exit(1)
  }

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

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) main()
