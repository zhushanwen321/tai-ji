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
 *     AGENTS.md / AGENTS.MD / CLAUDE.md / CLAUDE.MD) every turn and appends it
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
import type { ExtensionAPI, BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent'
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
 * but deliberately not a strict mirror: pi 0.84.4 probes
 * ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]
 * against project dirs, while these candidates apply only to the global agents
 * directory and intentionally exclude AGENTS.override.md.
 */
const GLOBAL_AGENTS_CANDIDATES = ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']

/**
 * taiji capability 固定注入段（设计 D6）：告知 AI 本渲染器的能力面，让新会话无需
 * 用户手动教。常量放扩展源码内（版本化随 feature 走，非用户配置——用户只持有
 * on/off 开关，不持有文案本身）。文案英文，与 pi system prompt 语言一致；四点 =
 * 内联 HTML 白名单面 / 相对图片 cwd 解析 / 相对链接 cwd 解析（与反引号白名单路径
 * 自动链接化同基准、校验面差异如实）/ 远程图片不渲染 + 反引号规约。
 */
const TAIJI_CAPABILITY_SECTION = `# TaiJi capabilities

How TaiJi renders your markdown responses:

- Inline HTML is rendered with a GitHub-grade tag allowlist. Script/style elements and style/class attributes are stripped.
- Relative image paths (e.g. ![](docs/assets/img.png)) are resolved against the session working directory and displayed.
- Relative links (e.g. [plan](docs/plan.md)) use the same session working directory; clicking one opens the target file inside the app. Backtick file paths that TaiJi auto-links share the same cwd base. Difference in guarantees: auto-linked backtick paths are checked to exist, relative links may be dead — when citing a file you know exists, backticks are the safer form.
- Remote http(s) images are not rendered; reference a local file path instead. Always use backticks for inline code and type names in prose (bare angle-bracket names like Promise<void> are stripped).`

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
 */
function readConfig(dataDir: string): {
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
  capability: { enabled: boolean }
} {
  const parsed = readJsonIfValid(path.join(dataDir, CONFIG_FILE))
  if (!parsed) {
    return {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: '' },
      // capability 默认值与解析语义同向：缺 config → 开（见 readCapabilityEnabled）
      capability: { enabled: true },
    }
  }
  // Merge defensively — every field has its own default.
  // replace 字段仅防御性解析保持 config 结构完整，不参与本 hook 逻辑——
  // replace 走 --system-prompt CLI（ADR-0044），hook 只处理 append。
  return {
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    replace: readSection(parsed.replace),
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

/** Defensive field parsing for a `replace`/`append` config section. */
function readSection(raw: unknown): { enabled: boolean; prompt: string } {
  const section = isJsonObject(raw) ? raw : {}
  return {
    enabled: section.enabled === true,
    prompt: typeof section.prompt === 'string' ? section.prompt : '',
  }
}

/**
 * pi 是否以 --no-context-files / -nc 启动。用户显式退出 AGENTS.md / CLAUDE.md
 * 发现时，全局文件不得从这条通路溜回来。pi CLI 把 -nc 视为 --no-context-files
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
 */
function withCapabilitySection(prompt: string): string {
  const cfg = readConfig(resolveDataDir())
  if (!cfg.capability.enabled) return prompt
  return prompt + '\n\n' + TAIJI_CAPABILITY_SECTION
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
function buildSystemPrompt(event: BeforeAgentStartEvent): { systemPrompt: string } | undefined {
  const basePrompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : ''
  const newPrompt = withAppendPrompt(withCapabilitySection(withGlobalInstructions(basePrompt)))
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
  pi.on('before_agent_start', (event: BeforeAgentStartEvent) => {
    try {
      return buildSystemPrompt(event)
    } catch (err) {
      // Never block the agent loop.
      logHookFailure(err)
      return undefined
    }
  })
}