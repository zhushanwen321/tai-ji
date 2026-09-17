/**
 * composer-shortcut-actions.ts —— Composer 命令动作表（设计 docs/design/composer-pi-shortcuts.md
 * U1：pi TUI 四键位 shift+tab / ctrl+p / ctrl+shift+p / ctrl+x 的 GUI 通路）。
 *
 * 定位：与 pi 的「编辑器动作表」同构——composer 输入框聚焦时命令类键位先经本表匹配，命中
 * （含 no-op 行）即 stopPropagation + preventDefault（决策 7：阻断 window 层 open-preset-select
 * 因 mod=meta||ctrl 造成的 ctrl+shift+p 全平台双触发；本表要求 !metaKey，⌘ 系组合不受影响），
 * 未命中原样放行。动作下半身零新机制：模型/档位切换经 core useComposerModelThinking 的
 * onModelSelect / onThinkingSelect 三分支路由（staging 快照 / landing pending / 已建 RPC——与
 * popover 点击同一入口，G2 不产生第二真相源）；复制走 chatStore 最后一条 assistant +
 * normalizeContent + clipboard。
 *
 * 决策 8 意图目标（模块内瞬态变量，绑定聚焦中的 composer 实例生命周期，split 多实例各持各的；
 * ADR-0049 同判：非 per-session 数据，无需分区存储——sessionId 变化即清，无跨 session 残留窗）：
 * 已建态切换是回执写 store（无乐观写），计算起点滞后于 RPC 往返；本地持有意图目标后，
 * 计算起点 = 意图目标 ?? store 真值，RTT 内连按逐次递进不重步。清除时机：回执真值等于目标
 * （等值清 watch）/ 动作 reject / sessionId 变化 / 进入 staging（watch [sessionId, isStaging]）。
 * 仅已建态设立与续步——staging/landing 分支是同步写（无 RTT 窗口），不设意图。
 *
 * 守卫矩阵（§3.4 全行）：浮层 open 整体跳过（强模态上下文）→ IME 组合不触发（分发链 IME 段
 * 先行放行，本表不复判——over-engineering-audit 20260916 裁决：处理器只经分发链调用）→
 * auto-repeat：三个切换键忽略（按住只走一步，防 RPC 风暴）、ctrl+x 不忽略（幂等无 RPC，决策 8 例外）→
 * composer 内有选区时 ctrl+x 放行原生剪切 → 档位可用集仅 off / 模型列表 ≤1 时 no-op
 * （键吞掉，无报错无 toast 噪音）。
 */
import { watch, type Ref } from 'vue'
import { normalizeContent, type Message, type ModelInfo, type ProviderId } from '@taiji/shared'
import { normalizeSupportedLevels } from '@taiji/core/domain/composer'
import { findLastAssistantMessage } from '@taiji/core'

/**
 * toast 窄接口：入参 = i18n key，翻译在壳层组装适配时完成（翻译时刻 = 触发时刻，
 * locale 切换后反馈文案跟随；本模块零 i18n 依赖，与分发链纯分派器同风格）。
 */
export interface ComposerShortcutToast {
  info: (i18nKey: string) => void
  error: (i18nKey: string) => void
}

/** useComposerShortcutActions 依赖（全部只读注入，设计 §5 U1 deps 11 项；不新增持久状态） */
export interface ComposerShortcutActionDeps {
  /** 命令浮层 open 态：open 时动作表整体跳过（§3.4 首行守卫——分支入口先判，不逐键放行） */
  cmdOpen: Readonly<Ref<boolean>>
  /** 当前 session id（null = landing 态）：意图目标清除源之一 + 复制消息流定位 */
  sessionId: Readonly<Ref<string | null>>
  /** staging 活跃（fork/handoff）：意图目标仅已建态设立，进入 staging 即清 */
  isStaging: Readonly<Ref<boolean>>
  /** 当前模型 id（"provider/modelId" 复合串，core 三分支感知 computed；循环取值起点之一） */
  currentModelId: Readonly<Ref<string>>
  /** 当前 thinking 档位（undefined = 占位；循环取值起点之一） */
  currentThinkingLevel: Readonly<Ref<string | undefined>>
  /** 当前模型档位可用集（runtime 下发 supportedLevels，模块内经 normalizeSupportedLevels 归一） */
  currentSupportedLevels: Readonly<Ref<string[] | undefined>>
  /** 模型循环序源：settingsStore.models 经 enabled 过滤（与 ModelSelectPopover 双保险同款；序 = scopedModels 显示序） */
  enabledModels: Readonly<Ref<ModelInfo[]>>
  /** 模型切换入口（core 三分支路由，与 popover 点击同一入口） */
  onModelSelect: (payload: { modelId: string; provider: ProviderId }) => Promise<void>
  /** 档位切换入口（同上） */
  onThinkingSelect: (level: string) => Promise<void>
  /** session 消息流读取（复制动作取最后一条 assistant） */
  getMessages: (sessionId: string) => Message[]
  /** toast 窄接口（复制反馈：info 成功 / error 失败，决策 4） */
  toast: ComposerShortcutToast
}

/**
 * 键位→动作 id 映射：动作 id 沿用 pi 0.84.4 keybindings 的 namespaced id（设计 §3.3 键位表），
 * 与 pi keybindings.json 同构——P1 注册表化（统一 KeybindingRegistry）时的迁移锚点，
 * 本版不做用户配置。ShortcutAction 与键位判定/动作编排均由本表取值，单一来源防漂移。
 */
const COMPOSER_ACTION_KEYS = {
  'shift+tab': 'app.thinking.cycle',
  'ctrl+p': 'app.model.cycleForward',
  'ctrl+shift+p': 'app.model.cycleBackward',
  'ctrl+x': 'app.message.copy',
} as const

/** 动作 id（= COMPOSER_ACTION_KEYS 值联合，成员即 pi namespaced id） */
type ShortcutAction = (typeof COMPOSER_ACTION_KEYS)[keyof typeof COMPOSER_ACTION_KEYS]

/** 复制反馈 i18n key（文案落在 i18n/locales/*.panel.ts composer 段，设计 §3.3 决策 4 / §3.5） */
const COPY_SUCCESS_KEY = 'panel.composer.copyLastReply'
const COPY_FAILED_KEY = 'panel.composer.copyLastReplyFailed'

/**
 * 单条键位规则：主键 + 四修饰键期望态（true = 须按下 / false = 须松开，精确匹配）。
 * 期望态取值即 §3.3 键位表修饰键约束的数据化：shift+tab 仅 shift；ctrl+p 无 shift/alt/meta；
 * ctrl+shift+p 无 alt/meta（ctrl+p 按下 shift 分流而来）；ctrl+x 无 shift/alt/meta。
 * alt+p 不绑定（决策 6：GUI 不跟进 pi win/WSL 的 alt+p）；meta 系全部不命中（⌘P/⌘⇧P
 * 冒泡给全局快捷键表，决策 7）——两者都不在表内即自然不命中。
 */
interface ShortcutRule {
  key: string
  shift: boolean
  ctrl: boolean
  alt: boolean
  meta: boolean
  action: ShortcutAction
}

/** 键位规则表（§3.3 键位表）：数组序 = 匹配优先序（与键位表同序；成员主键互斥，序仅保读法一致） */
const SHORTCUT_RULES: readonly ShortcutRule[] = [
  { key: 'tab', shift: true, ctrl: false, alt: false, meta: false, action: COMPOSER_ACTION_KEYS['shift+tab'] },
  { key: 'p', shift: false, ctrl: true, alt: false, meta: false, action: COMPOSER_ACTION_KEYS['ctrl+p'] },
  { key: 'p', shift: true, ctrl: true, alt: false, meta: false, action: COMPOSER_ACTION_KEYS['ctrl+shift+p'] },
  { key: 'x', shift: false, ctrl: true, alt: false, meta: false, action: COMPOSER_ACTION_KEYS['ctrl+x'] },
]

/** 单规则精确匹配：主键与四修饰键全部与期望态一致才命中 */
function matchesShortcutRule(e: KeyboardEvent, key: string, rule: ShortcutRule): boolean {
  return (
    rule.key === key && rule.shift === e.shiftKey && rule.ctrl === e.ctrlKey && rule.alt === e.altKey && rule.meta === e.metaKey
  )
}

/** 键位匹配：key 统一小写比较（ctrl+shift 组合下部分平台上报大写 'P'），取首条命中规则的动作 */
function matchShortcutAction(e: KeyboardEvent): ShortcutAction | null {
  const key = e.key.toLowerCase()
  const rule = SHORTCUT_RULES.find((r) => matchesShortcutRule(e, key, r))
  return rule !== undefined ? rule.action : null
}

/**
 * composer 内有非折叠选区（§3.4 选区行）：选区锚点落在当前焦点元素内才成立——本表只挂在
 * composer 输入框的 keydown 链上，按键时焦点元素即输入框；锚点在外（程序化选区等边缘形态）
 * 不算「composer 内选区」，ctrl+x 照常触发复制动作。
 */
function hasSelectionInFocusedEditor(): boolean {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false
  const anchor = sel.anchorNode
  const active = document.activeElement
  return anchor !== null && active !== null && active.contains(anchor)
}

/**
 * 构建命令动作表处理器（composer-keydown 分发链「动作表」分支消费；返回签名与
 * commandPopoverRef.handleKeydown 同构：true = 事件已消费/拦截，false = 未消费放行）。
 */
export function useComposerShortcutActions(
  deps: ComposerShortcutActionDeps,
): (e: KeyboardEvent) => boolean {
  // 决策 8 本地意图目标（模型复合串 / thinking 档各一）：计算起点 = 意图目标 ?? store 真值
  let modelIntent: string | null = null
  let thinkingIntent: string | null = null

  // 清除防线①：sessionId 变化（防跨 session 意图残留错一步起点）或进入 staging（防跨态残留，
  // 影响面审 S-1：已建 in-flight → fork staging 续步错起点）即全清。watch 默认 pre flush：
  // 用户下一次 keydown 是宏任务，微任务 flush 先行完成，生产链路无「残留意图吃到下一次按键」的时序窗
  watch([deps.sessionId, deps.isStaging], () => {
    modelIntent = null
    thinkingIntent = null
  })
  // 清除防线②：store 真值（回执/同步写）到达且等于意图目标 → 清（决策 8 等值清）。
  // 回执钳制/乱序（回执值 ≠ 目标）不清——由既有 state_changed 防抖快照收敛后等值清除或失败清除
  watch(deps.currentModelId, (v) => {
    if (modelIntent !== null && v === modelIntent) modelIntent = null
  })
  watch(deps.currentThinkingLevel, (v) => {
    if (thinkingIntent !== null && v === thinkingIntent) thinkingIntent = null
  })

  /** 已建态（sessionId 非 null 且非 staging）：意图目标仅此态设立与续步（决策 8） */
  const isBuiltSession = (): boolean => deps.sessionId.value !== null && !deps.isStaging.value

  /**
   * 档位循环（shift+tab，仅 forward）。§3.3 起点规则：undefined（占位）→ 归一序列第一档
   * （off）；脏值不在归一集（钳制残值等）→ 对称取第一档。落点走 onThinkingSelect
   * （authored 记忆记录点——cycle 是用户显式选择，语义正确）。
   */
  function cycleThinkingLevel(): void {
    const levels = normalizeSupportedLevels(deps.currentSupportedLevels.value)
    if (levels.length <= 1) return // 档位可用集仅 off（non-reasoning）→ no-op（键已吞，无噪音）
    const start = thinkingIntent ?? deps.currentThinkingLevel.value
    const startIdx = start !== undefined ? levels.findIndex((l) => l === start) : -1
    const next = startIdx < 0 ? levels[0] : levels[(startIdx + 1) % levels.length]
    if (isBuiltSession()) thinkingIntent = next
    void deps.onThinkingSelect(next).catch((err: unknown) => {
      // 决策 8 reject 清：连按步进从真值重新起算。
      // 设计 §3.3 RPC 失败规格：console.warn + 无 toast（chip 由回执真值保持旧值，UI 不说谎）；
      // 拒绝处理器吞掉 rejection 防止 unhandled rejection
      thinkingIntent = null
      console.warn('[composer-shortcut] thinking level cycle RPC failed:', err)
    })
  }

  /** 模型双向循环（ctrl+p forward / ctrl+shift+p backward）。起点不在列表（landing 占位空串 /
   *  当前模型被禁用）→ forward 取第一个 / backward 取最后一个（§3.3 模型循环起点规则） */
  function cycleModel(direction: 'forward' | 'backward'): void {
    const models = deps.enabledModels.value
    if (models.length <= 1) return // 模型列表 ≤1（或空）→ no-op（键已吞，无报错无 toast）
    const current = modelIntent ?? deps.currentModelId.value
    const idx = models.findIndex((m) => `${m.providerId}/${m.id}` === current)
    const next =
      idx < 0
        ? direction === 'forward'
          ? models[0]
          : models[models.length - 1]
        : models[direction === 'forward' ? (idx + 1) % models.length : (idx - 1 + models.length) % models.length]
    const target = `${next.providerId}/${next.id}`
    if (isBuiltSession()) modelIntent = target
    void deps
      .onModelSelect({ provider: next.providerId, modelId: next.id })
      .catch((err: unknown) => {
        // 同上：RPC 失败规格 console.warn + 无 toast，防 unhandled rejection
        modelIntent = null
        console.warn('[composer-shortcut] model cycle RPC failed:', err)
      })
  }

  /**
   * 复制最后一条 assistant 正文（§3.5）：错误消息照常复制（错误以 assistant 消息入流，
   * 内容判定复杂度无收益）；空流/landing 无 assistant → no-op 不弹 toast（避免空态噪音）；
   * 写剪贴板失败 → toast error（键盘显式动作需闭环反馈，与 useCopy 图标态场景差异是刻意的）；
   * 复制内容为空串 → toast info 照常提示（写剪贴板空串无害）。
   */
  function copyLastAssistantReply(): void {
    const sid = deps.sessionId.value
    if (!sid) return // landing 态无消息流 → no-op
    const last = findLastAssistantMessage(deps.getMessages(sid))
    if (!last) return
    const text = normalizeContent(last.content)
    void navigator.clipboard.writeText(text).then(
      () => deps.toast.info(COPY_SUCCESS_KEY),
      () => deps.toast.error(COPY_FAILED_KEY),
    )
  }

  return (e: KeyboardEvent): boolean => {
    // §3.4 首行守卫：浮层 open → 动作表整体跳过（返回 false 不吞键，浮层段语义不受影响）
    if (deps.cmdOpen.value) return false
    const action = matchShortcutAction(e)
    if (!action) return false // 未命中 → 原样放行（不拦截、不阻断冒泡，既有段行为不变）
    if (action === COMPOSER_ACTION_KEYS['ctrl+x']) {
      // §3.4 选区行：composer 内有选区 → 放行原生剪切（不拦截），不触发复制动作
      if (hasSelectionInFocusedEditor()) return false
      copyLastAssistantReply()
      e.preventDefault()
      e.stopPropagation()
      return true
    }
    // 决策 8：三个切换键 auto-repeat 忽略（按住只走一步）；键位已命中 → 吞键不动作
    //（preventDefault 同时维持决策 9 的 shift+tab 反向焦点接管：长按期间焦点不出输入框）
    if (e.repeat) {
      e.preventDefault()
      e.stopPropagation()
      return true
    }
    if (action === COMPOSER_ACTION_KEYS['shift+tab']) cycleThinkingLevel()
    else cycleModel(action === COMPOSER_ACTION_KEYS['ctrl+p'] ? 'forward' : 'backward')
    // §3.4 拦截语义：命中任一键位（含 no-op 行）→ stopPropagation + preventDefault（决策 7）
    e.preventDefault()
    e.stopPropagation()
    return true
  }
}
