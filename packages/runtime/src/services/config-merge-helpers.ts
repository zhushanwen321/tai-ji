/**
 * Config 防御性合并 helpers（从 config-service.ts 抽出，控 max-lines 500）。
 *
 * 职责边界：把磁盘读到的 raw（可能字段缺失/类型错）合并到默认值上的纯函数，与
 * ConfigService 的有状态文件 I/O 解耦。这些函数不依赖 this，可独立单测，也便于
 * 未来对齐 pi models.json schema 后收窄。
 *
 * 抽出原因：config-service.ts 因 worktree-config 委托化后仍略超 max-lines(500)，
 * system-prompt / terminal 的 default + merge 是 ConfigService 内唯一无 this 依赖、
 * 纯函数化的内聚块（行为 / 签名不变，对外零感知）。
 */
import type { SystemPromptConfig, TerminalConfig } from '@taiji/shared'

export function defaultSystemPromptConfig(): SystemPromptConfig {
  return {
    version: 1,
    replace: { enabled: false, prompt: '' },
    append: { enabled: false, prompt: '' },
    // capability 默认开（设计 D6）：缺文件/损坏回退形态与解析语义同向——仅显式布尔 false 关闭
    capability: { enabled: true },
  }
}

/** raw 值是普通对象则透传，否则空对象兜底（replace/append/capability 共用形状守卫）。 */
function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return (typeof value === 'object' && value !== null && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {}
}

/** replace/append 段字段级防御合并：enabled 非 boolean → false，prompt 非 string → ''。 */
function mergePromptSegment(raw: Record<string, unknown>): SystemPromptConfig['replace'] {
  return {
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : false,
    prompt: typeof raw['prompt'] === 'string' ? raw['prompt'] : '',
  }
}

/**
 * 防御性合并：把磁盘读到的 raw（可能字段缺失/类型错）合并到默认值上。
 * corrupted=false（字段级容错，不视为损坏）；只有 JSON.parse 失败才 corrupted=true。
 */
export function mergeSystemPromptConfig(raw: unknown): SystemPromptConfig {
  const base = defaultSystemPromptConfig()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base
  const r = raw as Record<string, unknown>
  return {
    version: typeof r['version'] === 'number' ? r['version'] : base.version,
    replace: mergePromptSegment(asRecordOrEmpty(r['replace'])),
    append: mergePromptSegment(asRecordOrEmpty(r['append'])),
    // capability 解析方向与 replace/append 刻意相反（设计 D6 防照抄锚点）：replace/append
    // 是用户显式配置（缺省关闭才安全），capability 是 taiji 内置告知（默认开）——仅显式
    // 布尔 false 关闭（enabled !== false），缺字段（v1 存量 json）/形态不对（如字符串
    // "false"）/非对象 → true。必须透传：设置页经此 merge 读回开关态，剥字段会导致
    // 「关闭后重开设置页误显开 + 后续保存以 UI 态误开写回」（与扩展侧
    // readCapabilityEnabled 语义对齐）。
    capability: { enabled: asRecordOrEmpty(r['capability'])['enabled'] !== false },
  }
}

export function defaultTerminalConfig(): TerminalConfig {
  return {
    version: 1,
    shell: '',
    shellArgs: [],
    fontSize: 14,
    fontFamily: '',
    scrollback: 5000,
    cursorStyle: 'block',
    bell: true,
  }
}

/**
 * 防御性合并：把磁盘读到的 raw（可能字段缺失/类型错）合并到默认值上。
 * corrupted=false（字段级容错，不视为损坏）；只有 JSON.parse 失败才 corrupted=true。
 */
export function mergeTerminalConfig(raw: unknown): TerminalConfig {
  const base = defaultTerminalConfig()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base
  const r = raw as Record<string, unknown>
  const validCursorStyles: TerminalConfig['cursorStyle'][] = ['block', 'underline', 'bar']
  const cursorRaw = r['cursorStyle']
  return {
    version: typeof r['version'] === 'number' ? r['version'] : base.version,
    shell: typeof r['shell'] === 'string' ? r['shell'] : base.shell,
    shellArgs: Array.isArray(r['shellArgs']) ? r['shellArgs'].filter((a): a is string => typeof a === 'string') : base.shellArgs,
    fontSize: typeof r['fontSize'] === 'number' && Number.isFinite(r['fontSize']) ? r['fontSize'] : base.fontSize,
    fontFamily: typeof r['fontFamily'] === 'string' ? r['fontFamily'] : base.fontFamily,
    scrollback: typeof r['scrollback'] === 'number' && Number.isFinite(r['scrollback']) ? r['scrollback'] : base.scrollback,
    cursorStyle: typeof cursorRaw === 'string' && (validCursorStyles as string[]).includes(cursorRaw) ? cursorRaw as TerminalConfig['cursorStyle'] : base.cursorStyle,
    bell: typeof r['bell'] === 'boolean' ? r['bell'] : base.bell,
  }
}
