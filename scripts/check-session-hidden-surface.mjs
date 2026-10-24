#!/usr/bin/env node
/**
 * check-session-hidden-surface.mjs — 会话 `hidden` 字段退场 + `surface` 读取点白名单门禁。
 *
 * 背景（设计 §3.3.7 / §3.3.8 / §5-W5，约束登记 C-data-28 / C-data-29）：
 * W5 起会话 `hidden` 字段完整退场（五处类型 + 内部 CreateOptions 均已删），`surface`
 * 成为展示归属的唯一字段。本脚本是两条判据的机器执行：
 *
 * ① **hidden 检查**（C-data-29）：会话语义的 `hidden` 在 scope 内只允许出现在文件内
 *    ALLOWLIST 登记的同名列（插件 headerAction 的 hidden / `document.hidden` /
 *    canvas 布局 `opts.hidden` / locale 键等——与「会话隐藏」同形不同义）。双形态
 *    pattern：对象键 `\bhidden\s*:`（含可选声明 `hidden\s*\??\s*:`——防 `hidden?:`
 *    逃过对象键形态）+ 属性访问 `\.hidden\b`。清单外命中即红。
 *
 * ② **surface 读取点检查**（C-data-28）：`surface` 只允许三个用途——① 导航过滤与
 *    工作区历史判据（usage=nav-filter / workspace-history）② 抑制类只读判别
 *    （usage=suppression，W4b 收编后判别器 = session.list {surface:'btw'} 拉取缓存，
 *    入口 = renderer btw-line-membership 模块）③ 其余一律禁止（含任何状态写入判据）。
 *    四形态 pattern：属性访问 `\.surface\b` + 对象键 `\bsurface\s*:`（含可选声明形态
 *    `surface\s*\??\s*:`——与 hidden 侧同规格，设计 §3.3.8 末句「与 hidden 检查的双
 *    pattern + 同名排除规格对称」；防 `surface?:` 逃过对象键形态）+ 标识符
 *    `isKnownBtwLine|ensureBtwLineMembership|refreshBtwLineMembership|noteBtwLinesPulled`
 *    （抑制读取点经拉取缓存成员判别，naive `\.surface\b` 会漏掉；已退役的
 *    surfaceBySessionId/isBtwSession 标识符随派生表删除不再作为 pattern）。命中必须 ⊆
 *    登记清单（读取点带 usage 分类）+ runtime 注册表写入侧（registerSession 形参/记录
 *    字段/透传/deps 链/协议与 mock 载体）；
 *    `buildSessionSummary` 的 `surface: s.surface` 透传行按设计排除（同名列排除族）。
 *    非会话 `surface` 同名载体（modal-surface-registry / 浮层 surface id / canvas
 *    渐焦 surface / tailwind token）按文件级排除并逐条附理由。
 *
 * scope：`packages/<任意包>/src` 全部包；排除 `__tests__/` 目录、`*.test.*` / `*.spec.*`
 * 文件与注释行（块注释/行注释/Vue 模板注释逐行剥离，行号保持原文件行号）。
 *
 * 退出码：0=合规；3=清单外命中（输出 diff）；1=脚本自身异常（仓库根缺失 /
 * scope 缺失——packages/ 不可读或为空时拒绝出绿，fail-closed）。
 *
 * 用法：
 *   node scripts/check-session-hidden-surface.mjs            # 全仓扫描
 *   node scripts/check-session-hidden-surface.mjs --selftest # 样本树自测（预期红/绿）
 *
 * 登记纪律：新增/移动命中点先改本脚本 ALLOWLIST / READ_POINTS / WRITE_SIDE /
 * SAME_NAME_EXCLUDE（唯一登记处，逐条附理由）再合入；清单外命中即红，禁放宽 pattern。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

/**
 * 扫描根：packages 下各包的 src 目录（缺省 = 仓库根；自测传 fixture 根）。
 *
 * fail-closed（设计 §3.3.8「清单外命中即红」+ C-data-28/C-data-29 红线门禁语义）：
 * packages/ 读取失败时上抛而不返回 []——「什么都没扫」不得报成「扫过且全合规」。
 * 包内无 src 目录 = 该包无源码可扫（合法，跳过）；全部包皆无 src 由 runCheck 的
 * roots.length===0 检查拒绝出绿。
 */
function scanRoots(rootDir) {
  const pkgsDir = path.join(rootDir, 'packages')
  let entries
  try {
    entries = readdirSync(pkgsDir, { withFileTypes: true })
  } catch (e) {
    throw new Error(`scope 缺失：无法读取 ${pkgsDir}（${e.code ?? e.message}）——packages/ 不存在或不可读，拒绝出绿（fail-closed）`)
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(pkgsDir, e.name, 'src'))
    .filter((p) => existsSync(p) && statSync(p).isDirectory())
}

const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist', 'build', 'coverage', 'test-results'])
const SOURCE_FILE = /\.(ts|tsx|vue)$/
const TEST_FILE = /\.(spec|test)\.(ts|tsx|vue)$/

/**
 * 逐行剥注释（行号保持原文件行号——块注释跨行延续状态）：
 * `/* *\/` 块、`//` 行注释、Vue 模板 `<!-- -->` 注释。字符串字面量（`'` / `"` / `` ` ``，
 * 本行内生效）内的注释起始形态不作处理——`'https://x'` 的 `//` 若按行注释截断，
 * 该行后续的 hidden/surface 命中被静默丢弃；`'/*'` 若按块注释开会把后续行吞进
 * 注释态。两者都是「清单外命中即红」（设计 §3.3.8）的漏报通道。字符串内容原样
 * 保留（不剥离）——字符串内的 hidden/surface 形态与代码内同样计命中，与加状态机
 * 前的口径一致（修的是截断漏报，不放宽 pattern）。
 */
export function codeLines(text) {
  const out = []
  let inBlock = false
  let inHtml = false
  for (const raw of text.split('\n')) {
    let res = ''
    let i = 0
    let quote = null
    while (i < raw.length) {
      if (inBlock) {
        if (raw[i] === '*' && raw[i + 1] === '/') { inBlock = false; i += 2; continue }
        i += 1
        continue
      }
      if (inHtml) {
        if (raw[i] === '-' && raw[i + 1] === '-' && raw[i + 2] === '>') { inHtml = false; i += 3; continue }
        i += 1
        continue
      }
      if (quote !== null) {
        if (raw[i] === '\\') { res += raw[i] + (raw[i + 1] ?? ''); i += 2; continue }
        if (raw[i] === quote) quote = null
        res += raw[i]
        i += 1
        continue
      }
      if (raw[i] === '/' && raw[i + 1] === '*') { inBlock = true; i += 2; continue }
      if (raw[i] === '<' && raw[i + 1] === '!' && raw[i + 2] === '-' && raw[i + 3] === '-') { inHtml = true; i += 4; continue }
      if (raw[i] === '/' && raw[i + 1] === '/') break
      if (raw[i] === "'" || raw[i] === '"' || raw[i] === '`') { quote = raw[i]; res += raw[i]; i += 1; continue }
      res += raw[i]
      i += 1
    }
    out.push(res)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 检查①：会话 hidden 退场（双形态 pattern + ALLOWLIST）
// ─────────────────────────────────────────────────────────────────────────────

/** 双形态：对象键（含可选声明形态 `hidden\s*\??\s*:`）+ 属性访问。 */
export const HIDDEN_PATTERNS = [/\bhidden\s*\??\s*:/, /\.hidden\b/]

/**
 * 非会话 hidden 同名名列白名单（唯一登记处；键 = `file:line`，值 = 同名理由）。
 * 基线来源 = 本脚本实测（设计 §5-W5 判据 2 记载 R3 基线 12 处为「用法行」口径；
 * 可选声明形态纳入后实测含 7 处类型声明行——按「数量以脚本输出为准」全部登记）。
 *
 * 终态（2026-10-24 同步修复登记）：会话语义 hidden 的承载/写点已随 W5 字段退场与
 * u-w5b 协议收缩整体删除（五处类型 + 内部 CreateOptions.hidden + 协议
 * session.create.hidden + session-service 兼容委托形参 + session-message-handler
 * 透传三处均已删），当前 scope 内 hidden 命中全部为非会话同名列（插件 headerAction /
 * document.hidden / canvas 布局 opts.hidden / locale 键）。规则保留：会话语义 hidden
 * 承载点一律不得进本表（那些是退场对象，出现即新写入点、须先删除再合入）。
 */
export const HIDDEN_ALLOWLIST = new Map([
  // 插件 headerAction 的 hidden（入口整体不渲染语义；与「会话隐藏」同形不同义）
  ['packages/core/src/extension-host/header-action-store.ts:27', '插件 headerAction 运行时条目 hidden（HeaderActionEntry 声明，入口整体不渲染）'],
  ['packages/core/src/extension-host/header-action-store.ts:38', '插件 headerAction 声明侧静态形状 hidden（ContributionRegistry 侧）'],
  ['packages/core/src/extension-host/header-action-store.ts:78', '插件 headerAction 帧载荷 hidden 透传（set 写入）'],
  ['packages/core/src/extension-host/message-bus-bridge.ts:241', '插件 headerActionUpdate 帧 hidden 解析透传'],
  ['packages/plugin-sdk/src/types.ts:754', 'plugin-sdk HeaderActionOptions.hidden 声明（插件 API 面）'],
  ['packages/runtime/src/services/plugin-service/api/ui-api.ts:254', '插件 ui.updateHeaderAction 入参 hidden 校验'],
  ['packages/runtime/src/services/plugin-service/api/ui-api.ts:256', '插件 ui.updateHeaderAction hidden 校验错误文案'],
  ['packages/runtime/src/services/plugin-service/api/ui-api.ts:271', '插件 ui.updateHeaderAction hidden 透传'],
  ['packages/runtime/src/services/plugin-service/api/ui-api.ts:331', '插件 ui.updateHeaderAction 方法签名 hidden 形参（跨行断言的声明行）'],
  ['packages/runtime/src/services/plugin-service/api/ui-api.ts:346', '插件 ui.updateHeaderAction 实现签名 hidden 形参（跨行断言的声明行）'],
  ['packages/shared/src/protocol.ts:596', '协议 plugin headerAction 条目 hidden 字段声明'],
  // document.hidden（浏览器 API）
  ['packages/renderer/src/composables/features/settings/use-app-update-autocheck.ts:166', 'document.hidden（浏览器 API：页面可见性）'],
  ['packages/ui/src/features/chat/composables/useTurnElapsed.ts:125', 'document.hidden（浏览器 API：页面可见性，计时器暂停判据）'],
  // canvas 布局 opts.hidden（节点显隐回调）
  ['packages/renderer/src/components/canvas/CanvasGraph.vue:249', 'canvas 布局 opts.hidden（节点显隐回调注入）'],
  ['packages/renderer/src/components/canvas/canvas-display.ts:229', 'canvas 布局 opts.hidden 形参声明'],
  ['packages/renderer/src/components/canvas/canvas-display.ts:232', 'canvas 布局 opts.hidden 属性访问'],
  // renderer 扩展宿主桥的插件条目 hidden（帧面透传）
  ['packages/renderer/src/composables/shell/useExtensionHostBridge.ts:256', '插件 headerAction 运行时镜像 hidden（扩展宿主桥透传）'],
  // locale 键（设置页「注册但不可达」开关的字面键名）
  ['packages/ui/src/locale/en-US/settings.ts:1365', 'locale 键 hidden（设置项字面键名，非会话语义）'],
  ['packages/ui/src/locale/zh-CN/settings.ts:1364', 'locale 键 hidden（设置项字面键名，非会话语义）'],
])

// ─────────────────────────────────────────────────────────────────────────────
// 检查②：surface 读取点白名单（四形态 pattern + 清单 + 同名排除）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 四形态：属性访问 + 对象键（含可选声明形态 `surface\s*\??\s*:`——与 hidden 检查的双
 * pattern + 同名排除规格对称，设计 §3.3.8 末句；防 `surface?:` 逃过对象键形态）+ 标识符
 * （拉取缓存成员判别入口与抑制读取点经标识符命中）。
 * W4b 收编：原派生表标识符（surfaceBySessionId / isBtwSession）随该表删除，替换为
 * btw-line-membership 模块的四个出口（唯一成员判别入口——新读取点必须经它，禁另起口径）。
 */
export const SURFACE_PATTERNS = [
  /\.surface\b/,
  /\bsurface\s*\??\s*:/,
  /\bisKnownBtwLine\b/,
  /\bensureBtwLineMembership\b/,
  /\brefreshBtwLineMembership\b/,
  /\bnoteBtwLinesPulled\b/,
]

/**
 * 非会话 `surface` 同名载体（文件级排除，逐条附理由）：
 * modal-surface-registry 族的「界面 surface」（浮层/模态 id）与 canvas 渐焦 surface、
 * tailwind token、i18n 参数名——与「会话展示归属」同形不同义，不进登记清单。
 */
export const SURFACE_SAME_NAME_EXCLUDE = new Map([
  ['packages/renderer/src/App.vue', '界面 surface id（memory-pressure-bar，modal-surface-registry 族）'],
  ['packages/renderer/src/components/extension/form/FormOverlay.vue', '界面 surface id（form-overlay）'],
  ['packages/renderer/src/components/panel/ModeDeclarationRow.vue', 'i18n 参数名 surface（toolChip 文案插值）'],
  ['packages/renderer/src/components/settings/SettingsModal.vue', '界面 surface id（settings-modal）'],
  ['packages/renderer/src/components/sidebar/SessionList.vue', '界面 surface id（session-delete-confirm）'],
  ['packages/renderer/src/components/sidebar/session-item/SessionItemContextMenu.vue', '界面 surface id（session-item-context-menu）'],
  ['packages/renderer/src/components/ui/AsyncErrorFallback.vue', '界面 surface id（async-error-fallback-overlay）'],
  ['packages/renderer/src/components/ui/RollingRestartBanner.vue', '界面 surface id（rolling-restart）'],
  ['packages/renderer/src/components/ui/ToastContainer.vue', '界面 surface id（toast-container）'],
  ['packages/renderer/src/composables/features/app/modal-surface-registry/registry.ts', 'modal-surface-registry 本体（界面 surface 注册表）'],
  ['packages/shared/src/tailwind-preset.ts', 'tailwind token 名 surface（设计系统 token，非会话语义）'],
  ['packages/ui/src/extension-host/CompanionBand.vue', '界面 surface id（companion-band）'],
  ['packages/ui/src/features/chat/BlockScrollBox.vue', 'canvas 渐焦 surface（fade 形态键，非会话语义）'],
  ['packages/ui/src/modal-surface-registrar.ts', '界面 surface 类型声明（ui 侧 modal-surface 族）'],
  ['packages/ui/src/overlays/SearchModal.vue', '界面 surface id（search-modal）'],
  ['packages/ui/src/primitives/dialog/DialogContent.vue', '界面 surface id（dialog-confirm）'],
  ['packages/ui/src/primitives/popover/PopoverContent.vue', '界面 surface id（popover-content）'],
  ['packages/ui/src/primitives/select/SelectContent.vue', '界面 surface id（select-content）'],
])

/**
 * buildSessionSummary 的 `surface: s.surface` 透传行（设计 §3.3.8 点名的同名列排除族：
 * IManagedSessionView → SessionSummary 的透传，非读取点）。
 */
export const SURFACE_PASSTHROUGH_EXCLUDE = new Set([
  'packages/runtime/src/services/session/session-summary.ts:35',
])

/**
 * surface 读取点登记清单（C-data-28 合并全集：I2 用途① 三处 + 用途② 抑制类）。
 * 键 = `file:line`，值 = usage 分类（词表 = nav-filter / workspace-history / suppression）。
 * 新增读取点先登记再合入；清单外命中即红。
 */
export const SURFACE_READ_POINTS = new Map([
  // 用途①：导航过滤（两处过滤点，surface === 'sidebar' 正向谓词）
  ['packages/runtime/src/services/session/session-scanner.ts:59', 'nav-filter'],
  ['packages/renderer/src/components/panel/command-popover-symbols.ts:69', 'nav-filter'],
  // 用途①：工作区历史判据（读注册后记录 lifecycle.get(id).surface，不读 options）
  ['packages/runtime/src/services/session/session-lifecycle.ts:676', 'workspace-history'],
  // 用途②：抑制类只读判别（W4b 收编后判别器 = session.list {surface:'btw'} 拉取缓存，
  // 入口 = btw-line-membership 模块；原 session.surfaces 派生表已按协议收缩删除）
  ['packages/renderer/src/composables/effects/useCompletionNotify.ts:59', 'suppression'],
  ['packages/renderer/src/components/panel/tray/useTrayCounts.ts:229', 'suppression'],
  ['packages/renderer/src/composables/effects/useForkNoticeEffect.ts:93', 'suppression'],
  ['packages/renderer/src/composables/effects/useForkNoticeEffect.ts:227', 'suppression'],
  ['packages/renderer/src/composables/panel/useBtwTabData.ts:193', 'suppression'],
  ['packages/renderer/src/composables/panel/useBtwTabData.ts:194', 'suppression'],
])

/**
 * surface 合法载体文件（非读取点，不进 usage 词表；文件级登记）：
 * - renderer 拉取缓存本体（btw-line-membership：session.list {surface:'btw'} → 成员
 *   判别四出口，W4b 收编后抑制类判别的唯一供数载体）；
 * - runtime 注册表写入侧（registerSession 形参/记录字段/透传、CreateOptions.surface
 *   管道、btw 直注册链、scannedToSummary 缺省、session.surfaces 广播组装）；
 * - 协议/mock/广播/查询/冷读分支的 surface 载体（§3.3.4 四处载体与 W4a/W4b 接线）。
 *
 * 取文件级而非行级：载体行随重构/并行单元编辑漂移（行级登记会把正常漂移误报成红），
 * 而「新增 surface 用法」的拦截由读取点行级清单 + 未登记文件红线两道承担——代价 =
 * 载体文件内新增的读取点不被本检查行级捕获（由登记纪律 + CR 覆盖，已在约束登记注明）。
 */
export const SURFACE_WRITE_SIDE_FILES = new Set([
  'packages/renderer/src/composables/panel/btw-line-membership.ts',
  'packages/core/src/transport/mock/index.ts',
  'packages/renderer/src/components/panel/BtwPanel.vue',
  'packages/renderer/src/composables/features/search/useSearchModalDeps.ts',
  'packages/renderer/src/composables/panel/useBtwTabData.ts',
  'packages/runtime/src/services/session/btw-service.ts',
  'packages/runtime/src/services/session/session-lifecycle.ts',
  'packages/runtime/src/services/session/session-list-query.ts',
  'packages/runtime/src/services/session/session-scanner.ts',
  'packages/runtime/src/services/session/session-state-projection.ts',
  'packages/runtime/src/transport/message-broker.ts',
  'packages/runtime/src/transport/session-message-handler.ts',
  'packages/shared/src/protocol.ts',
  // 以下 4 个文件 = 对象键 pattern 补可选声明形态（`surface\s*\??\s*:`，与 hidden 侧对称，
  // 设计 §3.3.8 末句）后实测新暴露的载体行（2026-10-24 同步修复登记；补齐前这些行使
  // 「surface 载体已被机器看住」的声称范围缺角，新增 `surface?: X` 形态可绕过登记）：
  // §3.3.4 四处载体之一：SessionSummary.surface 声明（shared/session.ts:79）
  'packages/shared/src/session.ts',
  // §3.3.4 四处载体之二：IManagedSessionView.surface 声明（types.ts:139）
  'packages/runtime/src/services/session/types.ts',
  // session.list facade 形参（session-service.ts:1022）+ initializeManagedSession 的
  // surface 形参（:1533，btw 直注册链签名透传——§3.3.4 点名三处签名之一）
  'packages/runtime/src/services/session/session-service.ts',
  // renderer 侧 session.list 端口形参（domains/session.ts:68，查询侧过滤参数载体）
  'packages/core/src/transport/api/domains/session.ts',
])

// ─────────────────────────────────────────────────────────────────────────────
// 扫描与判定
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 收集 scope 内全部源码行的模式命中：`{ file, line, text, pattern }[]`
 * （file 为相对 rootDir 的 POSIX 风格路径；注释行已剥、不计命中）。
 * roots 可注入（runCheck 先做 scope 非空校验，避免同一棵树扫两遍 scanRoots）。
 */
export function collectHits(rootDir = REPO_ROOT, roots = scanRoots(rootDir)) {
  const hits = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      if (!SOURCE_FILE.test(entry.name)) continue
      if (TEST_FILE.test(entry.name)) continue
      const rel = path.relative(rootDir, abs).split(path.sep).join('/')
      let text
      try {
        text = readFileSync(abs, 'utf8')
      } catch {
        continue
      }
      let inImport = false
      codeLines(text).forEach((line, idx) => {
        // import / export...from 行是声明不是用法（标识符形态的 isKnownBtwLine 等会命中
        // import 行）——跳过；多行 import 以 from 子句结束为界
        if (inImport) {
          if (/\bfrom\s+['"]/.test(line)) inImport = false
          return
        }
        if (/^\s*import\b/.test(line)) {
          if (!/\bfrom\s+['"]/.test(line)) inImport = true
          return
        }
        if (/^\s*export\s+(\*|\{)[^]*\bfrom\s+['"]/.test(line)) return
        for (const [kind, patterns] of [['hidden', HIDDEN_PATTERNS], ['surface', SURFACE_PATTERNS]]) {
          if (patterns.some((p) => p.test(line))) {
            hits.push({ kind, file: rel, line: idx + 1, text: line.trim() })
          }
        }
      })
    }
  }
  for (const root of roots) walk(root)
  return hits
}

/**
 * 判定（纯函数）：返回违规清单 `{ kind, file, line, text, reason }[]`。
 * - hidden：命中 ⊆ HIDDEN_ALLOWLIST；
 * - surface：命中 ⊆ SAME_NAME_EXCLUDE（文件级）∪ PASSTHROUGH_EXCLUDE ∪
 *   READ_POINTS ∪ WRITE_SIDE。
 */
export function findViolations(hits) {
  const violations = []
  for (const hit of hits) {
    const key = `${hit.file}:${hit.line}`
    if (hit.kind === 'hidden') {
      if (!HIDDEN_ALLOWLIST.has(key)) {
        violations.push({ ...hit, reason: '会话 hidden 同名名列未登记（ALLOWLIST 之外即红；非会话同名命中须附理由登记）' })
      }
      continue
    }
    if (SURFACE_SAME_NAME_EXCLUDE.has(hit.file)) continue
    if (SURFACE_PASSTHROUGH_EXCLUDE.has(key)) continue
    if (SURFACE_READ_POINTS.has(key) || SURFACE_WRITE_SIDE_FILES.has(hit.file)) continue
    violations.push({ ...hit, reason: 'surface 命中未登记（读取点须带 usage 登记进 READ_POINTS，写入侧载体登记进 WRITE_SIDE，同名载体登记进 SAME_NAME_EXCLUDE）' })
  }
  return violations
}

/** 全仓扫描 + 判定（CLI 主流程）。 */
export function runCheck(rootDir = REPO_ROOT) {
  const roots = scanRoots(rootDir)
  if (roots.length === 0) {
    throw new Error(`scope 为空：${path.join(rootDir, 'packages')} 下没有可扫的 src 目录——拒绝出绿（fail-closed，设计 §3.3.8）`)
  }
  const hits = collectHits(rootDir, roots)
  const violations = findViolations(hits)
  const hiddenHits = hits.filter((h) => h.kind === 'hidden').length
  const surfaceHits = hits.filter((h) => h.kind === 'surface').length
  return { hits, violations, hiddenHits, surfaceHits, roots }
}

function report(rootDir) {
  const { violations, hiddenHits, surfaceHits } = runCheck(rootDir)
  console.log(`[hidden-surface] scope=packages/<任意包>/src：hidden 命中 ${hiddenHits} 处（ALLOWLIST ${HIDDEN_ALLOWLIST.size} 条）/ surface 命中 ${surfaceHits} 处（读取点 ${SURFACE_READ_POINTS.size} 条 + 载体文件 ${SURFACE_WRITE_SIDE_FILES.size} 个）`)
  if (violations.length === 0) {
    console.log('[hidden-surface] OK：全部命中均在登记清单内')
    return 0
  }
  console.error(`[FAIL] hidden/surface 清单外命中 ${violations.length} 处（先审阅语义，非会话同名附理由登记进 ALLOWLIST/SAME_NAME_EXCLUDE，会话读取点带 usage 登记进 READ_POINTS）：`)
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.kind}]  ${v.text}`)
    console.error(`      → ${v.reason}`)
  }
  return 3
}

// ─────────────────────────────────────────────────────────────────────────────
// 自测：样本树上跑出预期红/绿（fixture 树 = tmpdir 内最小 packages/<pkg>/src 形态）
// ─────────────────────────────────────────────────────────────────────────────

function makeSampleTree(root) {
  const write = (rel, content) => {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  write('packages/demo/src/clean.ts', [
    '// 绿样本：与 hidden / surface 各形态均不沾边的普通代码',
    'export const keep = (n: number) => n + 1',
    "export const label = 'sidebar'",
  ].join('\n'))
  write('packages/demo/src/commented.ts', [
    '/**',
    ' * hidden: true  （注释内，不计命中）',
    ' */',
    '// surface: btw  （行注释，不计命中）',
    '<!-- surface: btw （Vue 模板注释，不计命中）-->',
    'export const ok = 1',
  ].join('\n'))
  write('packages/demo/src/__tests__/ignored.ts', 'export const hidden: boolean = true\n')
  write('packages/demo/src/ignored.test.ts', 'export const hidden: boolean = true\n')
  // 红样本①：会话 hidden 未登记（对象键 + 属性访问 + 可选声明三形态各一）
  write('packages/demo/src/red-hidden.ts', [
    'export const a = { hidden: true }',
    'export const b = (s: { hidden?: boolean }) => s.hidden === true',
    'export const c = (o: { hidden?: boolean }) => o.hidden',
  ].join('\n'))
  // 红样本②：surface 未登记读取点（四形态各一：属性访问 / 对象键 / 对象键可选声明 / 标识符）
  write('packages/demo/src/red-surface.ts', [
    'export const d = (s: { surface?: string }) => s.surface === 1',
    "export const e = { surface: 'btw' }",
    'export const f = isKnownBtwLine',
    'export const g = (s: { surface?: string }) => 1',
  ].join('\n'))
  // 红样本③：ALLOWLIST 同行号漂移（登记行写错 → 命中落清单外）
  write('packages/demo/src/red-drift.ts', 'export const g = { hidden: true }\n')
  // 红样本④：字符串字面量内的注释起始形态不得截断该行（'https://' 的 // 与 '/*' 的块注释态）
  write('packages/demo/src/red-string.ts', [
    "export const u = link('https://x', { surface: 'btw' })",
    'export const v = f("/*", { hidden: true })',
  ].join('\n'))
  return root
}

function selftest() {
  const root = mkdtempSync(path.join(tmpdir(), 'hidden-surface-selftest-'))
  try {
    makeSampleTree(root)
    const { violations } = runCheck(root)
    const at = (file) => violations.filter((v) => v.file === file).map((v) => `${v.file}:${v.line}`)
    const expectRed = (file, lines, label) => {
      const got = at(file).sort()
      const want = lines.map((l) => `${file}:${l}`).sort()
      const ok = got.length === want.length && got.every((g, i) => g === want[i])
      console.log(`${ok ? '[selftest OK]' : '[selftest FAIL]'} ${label}：期望红 ${want.join(', ')}；实际红 ${got.join(', ') || '（无）'}`)
      return ok
    }
    const expectGreen = (file, label) => {
      const got = at(file)
      const ok = got.length === 0
      console.log(`${ok ? '[selftest OK]' : '[selftest FAIL]'} ${label}：期望绿；实际红 ${got.join(', ') || '（无）'}`)
      return ok
    }
    const results = [
      expectRed('packages/demo/src/red-hidden.ts', [1, 2, 3], 'hidden 三形态未登记命中即红'),
      expectRed('packages/demo/src/red-surface.ts', [1, 2, 3, 4], 'surface 四形态未登记命中即红'),
      expectRed('packages/demo/src/red-drift.ts', [1], 'ALLOWLIST 行号漂移命中即红'),
      expectRed('packages/demo/src/red-string.ts', [1, 2], '字符串字面量内注释形态（https:// 的 // 与 /* 块注释态）不截断该行、后续命中即红'),
      expectGreen('packages/demo/src/clean.ts', '合法用法不红'),
      expectGreen('packages/demo/src/commented.ts', '注释行（块/行/Vue 模板）不计命中'),
      expectGreen('packages/demo/src/__tests__/ignored.ts', '__tests__ 目录排除'),
      expectGreen('packages/demo/src/ignored.test.ts', '*.test.* 文件排除'),
    ]
    // 登记后转绿：把样本行登记进 ALLOWLIST 语义（改 fixture 行号到登记处不可行——
    // 以「清单命中即绿」验证判定函数本身）
    // 取真实清单的既有键（ALLOWLIST / READ_POINTS / WRITE_SIDE / SAME_NAME_EXCLUDE /
    // PASSTHROUGH_EXCLUDE 各一）验证「登记即绿」
    const hiddenKey = [...HIDDEN_ALLOWLIST.keys()][0]
    const readPointKey = [...SURFACE_READ_POINTS.keys()][0]
    const writeSideFile = [...SURFACE_WRITE_SIDE_FILES][0]
    const sameNameFile = [...SURFACE_SAME_NAME_EXCLUDE.keys()][0]
    const passthroughKey = [...SURFACE_PASSTHROUGH_EXCLUDE][0]
    const fakeHits = [
      { kind: 'hidden', file: hiddenKey.split(':').slice(0, -1).join(':'), line: Number(hiddenKey.split(':').at(-1)), text: 'hidden: true' },
      { kind: 'surface', file: readPointKey.split(':').slice(0, -1).join(':'), line: Number(readPointKey.split(':').at(-1)), text: '.surface === 1' },
      { kind: 'surface', file: writeSideFile, line: 1, text: "surface: 'btw'" },
      { kind: 'surface', file: sameNameFile, line: 1, text: "surface: 'x'" },
      { kind: 'surface', file: passthroughKey.split(':').slice(0, -1).join(':'), line: Number(passthroughKey.split(':').at(-1)), text: 'surface: s.surface' },
    ]
    const afterRegister = findViolations(fakeHits)
    const registerOk = afterRegister.length === 0
    console.log(`${registerOk ? '[selftest OK]' : '[selftest FAIL]'} 清单内命中（ALLOWLIST / SAME_NAME_EXCLUDE / PASSTHROUGH_EXCLUDE）不红：${registerOk ? '符合预期' : JSON.stringify(afterRegister)}`)
    results.push(registerOk)
    const pass = results.every(Boolean)
    console.log(pass ? '[selftest] 全部通过（样本树红/绿符合预期）' : '[selftest] 存在失败项')
    return pass ? 0 : 3
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function main() {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest())
  }
  if (!statSync(REPO_ROOT).isDirectory()) {
    console.error(`[hidden-surface] 仓库根不存在: ${REPO_ROOT}`)
    process.exit(1)
  }
  try {
    process.exit(report(REPO_ROOT))
  } catch (e) {
    // scope 缺失 / scope 为空等 fail-closed 路径（scanRoots 上抛的结构化错误）：
    // 不得以「零命中零违规」形态出绿，转退出码 1 并打印原因
    console.error(`[hidden-surface] 脚本自身异常：${e.message}`)
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  main()
}
