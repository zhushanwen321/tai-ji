/**
 * System prompt injection extension for Pi.
 *
 * Registers a `before_agent_start` hook that:
 *  1. Reads <dataDir>/system-prompt.json every turn (mtime-cached, see
 *     `cachedReadFileSync`).
 *  2. Appends the fixed taiji capability section unless explicitly disabled
 *     (`capability.enabled === false` — anything else, including a missing
 *     field, keeps it ON; deliberate inversion of the readSection fail-safe
 *     direction, see `readCapabilityEnabled`).
 *  3. When `append.enabled === true` and `append.prompt` is non-blank,
 *     appends the user's text to the event's systemPrompt.
 *  4. Reads the global instructions file `~/.agents/AGENTS.md` (candidates
 *     AGENTS.md / AGENTS.MD, exact case match) every turn and appends it
 *     under a labeled header. Modeled on pi's native `loadContextFileFromDir`
 *     but deliberately narrower: pi 0.84.4 also probes `AGENTS.override.md`
 *     and applies its candidate list to project dirs, whereas this list only
 *     targets the global agents directory and never picks up override files.
 *     Opt-in by file existence: no file → no injection. Skipped when
 *     pi was spawned with `--no-context-files` (consistent with pi's native
 *     context-file opt-out). `TAIJI_GLOBAL_AGENTS_DIR` overrides the global
 *     directory (test hook / escape hatch).
 *
 * Injection order per turn: base prompt → global instructions → taiji
 * capability section → append config (the explicitly configured text wins
 * last).
 *
 * Fail-safe: any error in the handler is swallowed and `undefined` is returned
 * so the agent loop is never blocked.
 */

import path from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import type { ExtensionAPI, BeforeAgentStartEvent, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getLogger } from '@zhushanwen/pi-extension-logger'

const logger = getLogger('taiji-system-prompt-extension')

const CONFIG_FILE = 'system-prompt.json'

/**
 * mtime 级文件内容缓存（KV-cache 稳定性改造）：每 turn 仍 stat 判变（文件被编辑后
 * 下一轮即读到新内容，语义与逐 turn 重读一致），但 mtime 未变时跳过 readFileSync——
 * 注入文本进每 turn system prompt，读盘路径上不引入额外开销。进程级缓存，per-process
 * = per-session，生命周期对齐。stat/read 失败 → 驱逐条目返回 null。
 *
 * @data-owner 文件本身（mtime+size 判变读缓存，非派生权威，无第二写入者）
 */
const fileContentCache = new Map<string, { mtimeMs: number; size: number; content: string }>()

function cachedReadFileSync(filePath: string): string | null {
  try {
    const stat = statSync(filePath)
    const entry = fileContentCache.get(filePath)
    // 双键判变：mtimeMs 相同粒度内被外部编辑器/脚本覆写且长度变化时 size 仍能命中
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) return entry.content
    const content = readFileSync(filePath, 'utf-8')
    fileContentCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content })
    return content
  } catch {
    fileContentCache.delete(filePath)
    return null
  }
}

/**
 * Global instruction candidates. Modeled on pi's native loadContextFileFromDir
 * but deliberately not a strict mirror: pi 0.84.4 probes its own candidate
 * list (including AGENTS.override.md) against project dirs, while these
 * candidates apply only to the global agents directory, intentionally exclude
 * AGENTS.override.md, and recognize only AGENTS.md case variants.
 */
const GLOBAL_AGENTS_CANDIDATES = ['AGENTS.md', 'AGENTS.MD']

/**
 * 对话流渲染管线的 HTML 能力边界（chat-html-support 设计 D1 ①②）：机器可读的结构化
 * 常量，能力段文案由这些常量渲染——禁止把清单写成散文旁路（成员集合可被
 * `scripts/check-capability-allowlist-sync.mjs` 与渲染管线白名单对拍，零散文解析）。
 *
 * 成员来源 = `packages/renderer/src/composables/logic/markdown-sanitize.ts` 的
 * `ALLOWED_TAGS` 实际字面量（52 项，GitHub 风格白名单翻译，按族归类，每项恰一次）。
 * 与渲染白名单的任一方向漂移（清单多出未放行成员 / 白名单新增未入清单）由对拍机检
 * 红灯拦住，pre-commit 按路径触发。
 */
export const CAPABILITY_INLINE_TAG_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  headings: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  text: ['p', 'br', 'span', 'div', 'section', 'blockquote', 'pre', 'hr'],
  inline: [
    'a', 'b', 'i', 'em', 'strong', 's', 'strike', 'del', 'ins',
    'code', 'kbd', 'samp', 'tt', 'var', 'sub', 'sup', 'q',
  ],
  lists: ['ul', 'ol', 'li', 'dl', 'dt', 'dd'],
  table: ['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'],
  media: ['img', 'picture', 'source'],
  annotation: ['ruby', 'rt', 'rp'],
  details: ['details', 'summary'],
}

/**
 * 可用呈现属性（设计 D1 ①）：成员 = `markdown-sanitize.ts` 的 `ALLOWED_ATTR` 实际
 * 字面量（defaultSchema 全局 '*' 表 + 按标签项；class 与任意 data-* 不翻译）。
 */
export const CAPABILITY_PRESENTATION_ATTRS: readonly string[] = [
  // defaultSchema 全局 '*' 表
  'abbr', 'accept', 'accept-charset', 'accesskey', 'action', 'align', 'alt', 'axis',
  'border', 'cellpadding', 'cellspacing', 'char', 'charoff', 'charset', 'checked',
  'clear', 'colspan', 'color', 'cols', 'compact', 'coords', 'datetime', 'dir',
  'disabled', 'enctype', 'frame', 'hspace', 'headers', 'height', 'hreflang', 'for',
  'id', 'ismap', 'itemprop', 'label', 'lang', 'maxlength', 'media', 'method',
  'multiple', 'name', 'nohref', 'noshade', 'nowrap', 'open', 'prompt', 'readonly',
  'rel', 'rev', 'rowspan', 'rows', 'rules', 'scope', 'selected', 'shape', 'size',
  'span', 'start', 'summary', 'tabindex', 'target', 'title', 'usemap', 'valign',
  'value', 'width',
  // defaultSchema 按标签项
  'cite', 'itemscope', 'itemtype', 'longdesc', 'src', 'srcset', 'href',
  'aria-describedby', 'aria-label', 'aria-labelledby',
]

/**
 * 禁用清单（设计 D1 ②）：净化层构造性剥除的标签与属性。
 * - 标签 = 不在 `ALLOWED_TAGS` 的 script / style / link / iframe / form / input /
 *   button / svg；
 * - 属性 = class / style 与通配 data-* / on*（净化层 `ALLOW_DATA_ATTR: false` 构造性
 *   全剥 data-*，on* 事件处理器同理不存活）。
 * 通配项以 `*` 结尾，对拍机检按前缀比对剥除语义。
 */
export const CAPABILITY_FORBIDDEN: {
  readonly tags: readonly string[]
  readonly attributes: readonly string[]
} = {
  tags: ['button', 'form', 'iframe', 'input', 'link', 'script', 'style', 'svg'],
  attributes: ['class', 'style', 'data-*', 'on*'],
}

/**
 * 能力段 ①② 的清单渲染（文案由常量渲染，禁手写散文旁路）。渲染顺序 = 常量声明顺序，
 * 包内单测按「解析出的清单集合 === 常量集合」逐项锁定（含常量集合全部成员、无旁路成员
 * ——防对拍机检空转）。
 */
function renderCapabilityLists(): {
  tags: string
  attrs: string
  forbiddenTags: string
  forbiddenAttrs: string
} {
  return {
    tags: Object.values(CAPABILITY_INLINE_TAG_FAMILIES).flat().join(', '),
    attrs: CAPABILITY_PRESENTATION_ATTRS.join(', '),
    forbiddenTags: CAPABILITY_FORBIDDEN.tags.join(', '),
    forbiddenAttrs: CAPABILITY_FORBIDDEN.attributes.join(', '),
  }
}

const CAPABILITY_LISTS = renderCapabilityLists()

/**
 * taiji capability 固定注入段（chat-html-support 设计 D1）：告知 AI 本渲染器的能力面，让新会话
 * 无需用户手动教。常量放扩展源码内（版本化随 feature 走，非用户配置——用户只持有 on/off 开关，
 * 不持有文案本身）。文案英文，与 pi system prompt 语言一致。
 *
 * M0 = ①②（inline HTML 正面清单 + 负面清单，文案由 CAPABILITY_* 常量渲染）；
 * M1 = ③④（HTML 产物交付约定 + 预览约束告知，本函数追加）。其余三点 = 相对图片 cwd 解析 /
 * 相对链接 cwd 解析（与反引号白名单路径自动链接化同基准、校验面差异如实）/ 远程图片不渲染
 * + 反引号规约。
 *
 * @param artifactsDir 会话产物目录绝对路径（handler 每 turn 经 ctx 推导后拼入 ③ 段）；
 *   null = 会话 id 缺失 / 不可解析 → 该处退化为 SESSION_ARTIFACTS_DIR_UNAVAILABLE，
 *   其余文案完整（设计 D1「该行退化」）。
 */
function renderCapabilitySection(artifactsDir: string | null): string {
  const artifactsRef = artifactsDir ?? SESSION_ARTIFACTS_DIR_UNAVAILABLE
  return `# TaiJi capabilities

How TaiJi renders your markdown responses:

- Inline HTML is rendered with a GitHub-grade allowlist; anything outside it is stripped before rendering. You may use these tags: ${CAPABILITY_LISTS.tags}. Presentational attributes allowed: ${CAPABILITY_LISTS.attrs}.
- Do not use these tags (they are stripped before rendering): ${CAPABILITY_LISTS.forbiddenTags}. Do not use these attributes (they are stripped and have no effect): ${CAPABILITY_LISTS.forbiddenAttrs}.
- For anything larger than a small fragment (reports, charts, interactive pages): write the HTML file into the session artifacts directory ${artifactsRef}${artifactsDir ? ' (given above each turn)' : ''}, then reference it with a fenced block whose info string is html-preview and whose content is that file's absolute path. Never paste the full HTML into your reply after writing the file — update the file in place on later changes. Artifacts are recycled automatically once stale (retention policy) — regenerate on reference failure instead of assuming persistence.
- Previewed HTML runs sandboxed with no network access: scripts/styles/fonts/images must be inline or reference local files by relative path next to the HTML file (CDN links will not load).
- Relative image paths (e.g. ![](docs/assets/img.png)) are resolved against the session working directory and displayed.
- Relative links (e.g. [plan](docs/plan.md)) use the same session working directory; clicking one opens the target file inside the app. Backtick file paths that TaiJi auto-links share the same cwd base. Difference in guarantees: auto-linked backtick paths are checked to exist, relative links may be dead — when citing a file you know exists, backticks are the safer form.
- Remote http(s) images are not rendered; reference a local file path instead. Always use backticks for inline code and type names in prose (bare angle-bracket names like Promise<void> are stripped).`
}

/**
 * Resolve the data directory from the environment.
 *
 * Priority:
 *  1. `process.env.TAIJI_AGENT_DATA_DIR` (explicit)
 *  2. `path.resolve(process.env.PI_CODING_AGENT_DIR ?? '', '..')`
 *     (PI_CODING_AGENT_DIR == <dataDir>/agent, one level up == dataDir)
 *
 * Layout trade-off (session-root-discovery plan B, 2026-09): only the NEW
 * layout shape is handled — one level up. An OLD-layout value
 * (`<dataDir>/pi/agent`, pre-migration) would resolve to `<dataDir>/pi`,
 * accepted here on purpose: in every shipped scenario the runtime injects
 * TAIJI_AGENT_DATA_DIR (priority 1 covers it), so priority 2 only serves
 * standalone hosts already on the new layout. session-reader's
 * discovery/env.ts strips both shapes for its diagnostics; this resolver
 * deliberately stays single-shape (registered divergence, not a bug).
 *
 * Re-read on every handler invocation so env changes between turns/sessions
 * take effect without reloading the extension.
 */
function resolveDataDir(): string {
  if (process.env.TAIJI_AGENT_DATA_DIR) {
    return process.env.TAIJI_AGENT_DATA_DIR
  }
  return path.resolve(process.env.PI_CODING_AGENT_DIR ?? '', '..')
}

/**
 * 会话产物目录镜像常量（设计 D1/D7）：`<dataDir>/artifacts/<sessionId>/`。
 *
 * shared 侧单点声明 = `packages/shared/src/paths.ts` 的 `getSessionArtifactsDir`；本包
 * 不 import `@taiji/shared`（① 包边界——extensions 包全体不依赖 @taiji/shared；② 运行时
 * 门禁——shared `getDataDir()` 对「非打包进程持有 ~/.taiji 树值」直接 throw（C-proc-26），
 * 而打包态 pi 进程恰构成该组合（C-proc-09 剥了 TAIJI_AGENT_PACKAGED），误用会让打包态
 * capability 段整段静默消失）。故以同公式镜像推导，两侧字面量一致性由 u-artifacts 的
 * 源文件对拍机检守护（§11 检查点 8）。
 */
export const SESSION_ARTIFACTS_DIR_SEGMENT = 'artifacts'

/**
 * 会话产物目录绝对路径（镜像 shared `getSessionArtifactsDir` 公式）。
 *
 * sessionId 校验与 pi `assertValidSessionId` / runtime `isPiSessionId` 同域：首尾字母
 * 数字，中间允许 `[A-Za-z0-9._-]`（允许 `.` / `_`，禁 `:`）——不用 `getImageCacheDir`
 * 的窄集 `/^[A-Za-z0-9_-]+$/`（合法含 `.` 的 pi sid 会被窄集误拒）。非法 sessionId
 * 直接 throw（防路径穿越）。
 *
 * @param sessionId 会话 id（子目录分区，须与 `isPiSessionId` 同域）
 * @throws Error 当 sessionId 含路径分隔符、冒号、空串或首尾非字母数字
 */
export function resolveSessionArtifactsDir(sessionId: string): string {
  // 校验与 pi-paths.ts 的 isPiSessionId 同域（字面量与 shared getSessionArtifactsDir 一致）
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
    throw new Error(`invalid sessionId (path traversal blocked): ${sessionId}`)
  }
  return path.join(resolveDataDir(), SESSION_ARTIFACTS_DIR_SEGMENT, sessionId)
}

/**
 * 产物目录不可用时的占位文案（会话 id 缺失 / 不可解析，设计 D1）：拼入能力段 ③ 段，
 * 退化只发生在该处，其余文案完整。
 */
const SESSION_ARTIFACTS_DIR_UNAVAILABLE = '(unavailable this turn)'

/**
 * 从 handler 第二参 ctx 推导会话产物目录绝对路径（设计 D1 路径注入）：
 * `ctx.sessionManager.getSessionId()` + 包内镜像推导（resolveDataDir + 段名常量，
 * 不经 @taiji/shared——包边界与 C-proc-26/C-proc-09 门禁组合，见 D1）。
 *
 * 会话 id 缺失（无 ctx / getSessionId 返回空）/ 非法（resolveSessionArtifactsDir throw，
 * 如 btw 虚拟 id 含冒号）/ getSessionId 抛错 → null，调用方按退化形态渲染。
 */
function resolveArtifactsDirFromCtx(ctx?: ExtensionContext): string | null {
  try {
    const manager = ctx?.sessionManager
    const sid = manager ? manager.getSessionId() : ''
    if (!sid) return null
    return resolveSessionArtifactsDir(sid)
  } catch (err) {
    // best-effort：本 turn 路径缺失 → 退化形态（绝不把异常漏给 agent loop）
    logger.debug('session artifacts dir unavailable this turn', { detail: String(err) })
    return null
  }
}

/**
 * Resolve the global agents directory.
 *
 * Priority:
 *  1. `process.env.TAIJI_GLOBAL_AGENTS_DIR` (explicit override; tests / escape
 *     hatch)
 *  2. `~/.agents` (the user-global agents dir that also hosts skills/templates)
 *
 * Re-read on every handler invocation so env changes take effect.
 */
function resolveGlobalAgentsDir(): string {
  if (process.env.TAIJI_GLOBAL_AGENTS_DIR) {
    return process.env.TAIJI_GLOBAL_AGENTS_DIR
  }
  return path.join(homedir(), '.agents')
}

/**
 * Read the global instructions file. First candidate that exists and is a
 * regular file with non-blank content wins (selection semantics consistent
 * with pi's native loader; the candidate list itself is narrower, see
 * GLOBAL_AGENTS_CANDIDATES). Returns { path, content } or null; never throws.
 */
function readGlobalAgentsFile(): { path: string; content: string } | null {
  const dir = resolveGlobalAgentsDir()
  // Match candidates against real directory entries (exact case) instead of
  // existsSync-per-candidate: on case-insensitive filesystems (macOS APFS
  // default) existsSync('AGENTS.md') would hit a file actually named
  // AGENTS.MD, reporting an injected path that differs from the on-disk
  // filename and shadowing the later exact-case candidate.
  let entries: Set<string>
  try {
    entries = new Set(readdirSync(dir))
  } catch {
    return null
  }
  for (const name of GLOBAL_AGENTS_CANDIDATES) {
    if (!entries.has(name)) continue
    const filePath = path.join(dir, name)
    try {
      if (statSync(filePath).isFile()) {
        const content = cachedReadFileSync(filePath)
        if (content !== null && content.trim()) {
          return { path: filePath, content }
        }
      }
    } catch (err) {
      // best-effort：候选文件 stat/read 失败（如权限）→ 试下一个候选，never throw into the agent loop。
      logger.debug('candidate file read failed, trying next', { detail: String(err) })
    }
  }
  return null
}

/**
 * Read & parse the config file. Missing / malformed / partial → all-default.
 * Returns the effective config object; never throws.
 *
 * Only parses the sections this extension consumes (append / capability).
 * The config file's `version` / `replace` fields belong to the runtime-side
 * `--system-prompt` consumer (ADR-0044) and are intentionally not parsed here.
 */
function readConfig(dataDir: string): {
  append: { enabled: boolean; prompt: string }
  capability: { enabled: boolean }
} {
  const parsed = readJsonIfValid(path.join(dataDir, CONFIG_FILE))
  if (!parsed) {
    return {
      append: { enabled: false, prompt: '' },
      // capability 默认值与解析语义同向：缺 config → 开（见 readCapabilityEnabled）
      capability: { enabled: true },
    }
  }
  // Merge defensively — every field has its own default.
  return {
    append: readSection(parsed.append),
    capability: { enabled: readCapabilityEnabled(parsed.capability) },
  }
}

/**
 * capability 段开关解析——方向与 readSection 刻意相反（设计 D6 防照抄锚点）：
 * 仅显式布尔 `false` 关闭；缺字段（v1 存量 json）/字段形态不对（如字符串
 * "false"）/capability 非对象/文件损坏（readConfig 前置收敛）→ true。
 * 原因：replace/append 是用户显式配置（缺省关闭才安全），capability 是 taiji
 * 内置告知（默认开是交付语义）——fail-safe 方向各自服务于所属字段的语义。
 */
function readCapabilityEnabled(raw: unknown): boolean {
  if (!isJsonObject(raw)) return true
  return raw.enabled !== false
}

/** Read a JSON file and return it as an object; missing / malformed / non-object → null. */
function readJsonIfValid(filePath: string): Record<string, unknown> | null {
  try {
    const raw = cachedReadFileSync(filePath)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/** Defensive field parsing for the `append` config section. */
function readSection(raw: unknown): { enabled: boolean; prompt: string } {
  const section = isJsonObject(raw) ? raw : {}
  return {
    enabled: section.enabled === true,
    prompt: typeof section.prompt === 'string' ? section.prompt : '',
  }
}

/**
 * pi 是否以 --no-context-files / -nc 启动。用户显式退出 AGENTS.md
 * 自动发现时，全局文件不得从这条通路溜回来。pi CLI 把 -nc 视为 --no-context-files
 * 的等价短形式（cli/args.ts），两种形式都必须命中守卫——与镜像侧
 * （argv-mirror.ts 同样解析两种形式）保持一致。
 */
function contextFilesDisabled(): boolean {
  return process.argv.includes('--no-context-files') || process.argv.includes('-nc')
}

/** Append the global instructions (~/.agents/AGENTS.md ...) under a labeled header. */
function withGlobalInstructions(prompt: string): string {
  if (contextFilesDisabled()) return prompt
  const global = readGlobalAgentsFile()
  if (!global) return prompt
  return prompt + '\n\n# Global instructions (' + global.path + ')\n\n' + global.content
}

/**
 * Append the fixed taiji capability section（labeled header 与 global 注入段同构）。
 * 生效粒度 = 下一 turn：本 hook 每 turn 读 config（mtime 缓存判变），改开关 → 写
 * system-prompt.json → 下一 turn 读到新值——当前 turn 不受影响（机制既有，非新增）。
 * 会话产物目录路径每 turn 经 ctx 重新推导（会话切换/新建即生效）。
 */
function withCapabilitySection(prompt: string, ctx?: ExtensionContext): string {
  const cfg = readConfig(resolveDataDir())
  if (!cfg.capability.enabled) return prompt
  return prompt + '\n\n' + renderCapabilitySection(resolveArtifactsDirFromCtx(ctx))
}

/** Read the append config and apply it to the prompt (empty append → unchanged). */
function withAppendPrompt(prompt: string): string {
  const cfg = readConfig(resolveDataDir())
  if (!cfg.append.enabled || !cfg.append.prompt.trim()) return prompt
  return prompt + '\n\n' + cfg.append.prompt
}

/**
 * Build the injected system prompt. Injection order per turn:
 * base prompt → global instructions → taiji capability section → append
 * config (the explicitly configured text wins last). Returns the new
 * systemPrompt, or undefined when nothing changed.
 */
function buildSystemPrompt(event: BeforeAgentStartEvent, ctx?: ExtensionContext): { systemPrompt: string } | undefined {
  const basePrompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : ''
  const newPrompt = withAppendPrompt(withCapabilitySection(withGlobalInstructions(basePrompt), ctx))
  return newPrompt === event.systemPrompt ? undefined : { systemPrompt: newPrompt }
}

/**
 * 落盘诊断，不泄露配置内容。
 *
 * 通道：extension-logger 的 error → appendEntry 写入 session JSONL（需 setPiHandle
 * 注入 pi handle 后生效）；TAIJI_AGENT_DEBUG=1 时另落文件日志。仅当 logger 自身抛错
 * 时才兜底 process.stderr.write（下方 catch），不外泄到 agent loop。
 */
function logHookFailure(err: unknown): void {
  try {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    logger.error(`before_agent_start hook failed: ${msg}`)
  } catch (nestedErr) {
    // best-effort：logger 抛错时的终极兜底 process.stderr.write——其内部吞错不会抛，仍不外泄到 agent loop。
    try {
      process.stderr.write(`[taiji-system-prompt-extension] logHookFailure also failed: ${String(nestedErr)}\n`)
    } catch (finalErr) {
      /* 完全静默：两层兜底都失败时无处可写 */
      void finalErr
    }
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    try {
      return buildSystemPrompt(event, ctx)
    } catch (err) {
      // Never block the agent loop.
      logHookFailure(err)
      return undefined
    }
  })
}