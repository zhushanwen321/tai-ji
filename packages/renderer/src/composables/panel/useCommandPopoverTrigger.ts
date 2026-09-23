/**
 * Composer 命令浮层触发态机（架构审查 F7，从 Composer.vue 拆出）。
 *
 * 职责（单一变化轴「slash/file/session/subagent/skill 浮层触发 + CommandPopover 联动」）：
 * - 五路触发态标记（slash/file/session/subagent/skill TriggerActive）：区分「输入区符号触发」
 *   与「+菜单触发」两条打开浮层路径——仅输入区路径设 true，使后续 trigger:null 能正确关闭浮层。
 * - onSlashTrigger / onFileTrigger / onSessionTrigger / onSubagentTrigger / onSkillTrigger：
 *   输入区触发事件路由（开/关浮层 + 记 query 透传过滤）。五符号语义（composer-symbol-system
 *   + 多 skill 注入 D1）：$ 文件（file-trigger emit）/ # session（session-trigger）/
 *   @ subagent（subagent-trigger）/ 行首 / 命令（slash-trigger）/ 行中空白后 / skill（skill-trigger，
 *   两 / 触发域正则互斥）。
 * - onAddSelect：+ 菜单打开 slash 浮层（不设触发态，防普通键误关）。
 * - onCmdSelect：选中后插 chip（slash/file/session/subagent），清过滤文本 + 复位触发态。
 * - onSelectAndSend：命令名精确匹配直发（onCmdSelect 复用 + 同步直调 dispatchEnter 链，
 *   command-enter-exact-send D2 钉死直调、禁合成事件）。
 * - pendingSlash watch：消费 SearchModal 经 commandStore 注入的 slash 请求（D2b：注入前
 *   清活跃域 token 残留——session 冻结守卫 + 文本定位删除助手，再插 chip）。
 * - SM 互斥 watch（search-modal-popover-mutual-exclusion D1）：SearchModal open 时单向
 *   关闭命令浮层（flush:'sync'，close 不恢复；open 时冻结 sessionId 供 D2b 守卫）。
 * - commandPopoverRef + cmdOpen：键盘路由（⏎/Esc）与 v-model:open 绑定。
 *
 * 不含：发送/steer/abort 编排、模型/思考等级、草稿维护（均留在 Composer.vue / 其他 composable）。
 */
import { ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSearchModal } from '@taiji/core'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { pickFile } from '@/lib/ipc'
// D2b 注入前清理：非光标锚定的活跃域 token 文本定位删除（带域约束正则 + 非唯一命中 no-op）
import {
  removeActiveTokenText,
  ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES,
} from '@taiji/dom-core/composer/input'
// 裸 skill 名归一化单点（剥 `skill:` / `/` 前缀）——与 CommandPopover skill-only 候选 /
// slash 候选 selected 比对 / onCmdSelect skill 项分流同源，避免第三份前缀剥离实现漂移。
import { bareSkillCommandName } from '@/components/panel/command-popover-skill-candidates'
// [tsc 前置修复] 输入区实例类型从 InstanceType<typeof ComposerInput>（ui 包 .vue，plain
// tsc 经 shim 解析不出 expose 面）改为 renderer 结构契约 ShellInputInstance（composer-shell）
import type { ShellInputInstance } from './composer-shell'
import type CommandPopover from '@/components/panel/CommandPopover.vue'

/** + 菜单「附件」项的图片类型过滤扩展名（「图片」入口 pickFile filters 用） */
const IMAGE_FILTER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']

/** 命令浮层五路类型（四符号体系 + skill：$/file、#//session、@/subagent、//slash、空格后 //skill） */
export type CommandPopoverType = 'file' | 'slash' | 'session' | 'subagent' | 'skill'

/** 浮层选中 payload（五路归一；name 保留兼容 slash/file，session/subagent 走专属字段） */
export interface CommandSelectPayload {
  type: CommandPopoverType
  name: string
  icon?: string
  description?: string
  /** slash 路 skill 项标记（设计 D3）：行首命令浮层的 skill 项（name 形如 '/skill:xxx'）
   *  按项类型分流到 skill 通路，与 type==='skill' 行为合流（光标处插入 + 多 chip 共存 +
   *  带 location + 已选禁选，后者即 S-2：slash 路候选同样消费 selectedSkillNames）——
   *  不再走 insertSlashChip（强制最前 + 误删全部 slash-chip + 丢 location） */
  isSkill?: boolean
  /** skill 路：SKILL.md 绝对路径（可得时带上，chip dataset 携带供反解析）；缺省时 runtime 经 get_commands 权威映射解析 */
  location?: string
  /** session 路：选中 session 的 id（TUI session_read 协议消费） */
  sessionId?: string
  /** session 路：显示 label（人可读标题，chip 展示用） */
  label?: string
  /** subagent 路：选中 record id；「新建」项为空串（语义由上层定） */
  subagentId?: string
  /** subagent 路：短标签；「新建」项为空串 */
  slug?: string
}

/** exactMatch 直发通道 payload（通道缺口④，编译器强制）：select 字段面 + 原始 Enter 事件 */
export interface CommandSelectAndSendPayload extends CommandSelectPayload {
  /** 原始 Enter KeyboardEvent（window capture 已 preventDefault + stopPropagation 截断） */
  originalEvent: KeyboardEvent
}

export function useCommandPopoverTrigger(
  inputRef: Readonly<Ref<ShellInputInstance | null>>,
  sessionId: Ref<string | null>,
  /** [command-enter-exact-send D2 直调通道] composer Enter 分发链（useComposerKeydown 返回的
   *  onKeydown——dispatchEnter 所在链体，composer-keydown.ts:140-151）。onSelectAndSend 同步
   *  直调、传原事件：严禁合成/再派发 KeyboardEvent（合成事件经 window capture 时浮层已关会
   *  早退放行 → 落到 ComposerInput 冒泡 → 二次 dispatchEnter → 双发）。缺省 undefined =
   *  只插 chip 不直发（fail-closed，与 activeElement 门同向）。调用方须传晚绑定闭包
   *  （本函数先于 useComposerKeydown 构建）。 */
  onComposerKeydown?: (e: KeyboardEvent) => void,
): {
  cmdOpen: Ref<boolean>
  cmdType: Ref<CommandPopoverType>
  slashQuery: Ref<string>
  fileQuery: Ref<string>
  sessionQuery: Ref<string>
  subagentQuery: Ref<string>
  skillQuery: Ref<string>
  commandPopoverRef: Ref<InstanceType<typeof CommandPopover> | null>
  onSlashTrigger: (payload: { query: string } | null) => void
  onFileTrigger: (payload: { query: string } | null) => void
  onSessionTrigger: (payload: { query: string } | null) => void
  onSubagentTrigger: (payload: { query: string } | null) => void
  onSkillTrigger: (payload: { query: string } | null) => void
  onAddSelect: (type: 'attach' | 'image' | 'slash') => Promise<void>
  onCmdSelect: (payload: CommandSelectPayload) => void
  onSelectAndSend: (payload: CommandSelectAndSendPayload) => void
} {
  const { t } = useI18n()
  const commandStore = useCommandStore()
  /** 命令浮层状态（§2d #/$/@//） */
  const cmdOpen = ref(false)
  const cmdType = ref<CommandPopoverType>('file')
  /**
   * slash 触发态标记：区分「输入区 / 触发」与「+菜单触发」两条打开浮层路径。
   * 仅输入区 / 触发打开时为 true，使后续 slash-trigger:null 能正确关闭；
   * +菜单路径（onAddSelect）不设 true，避免用户敲普通键误关 +菜单浮层。
   */
  const slashTriggerActive = ref(false)
  /** slash 命令过滤 query（输入区 / 后内容），透传给 CommandPopover 过滤 */
  const slashQuery = ref('')
  /** $ 文件触发态标记：同 slashTriggerActive 语义，区分输入区 $ 触发与 +菜单触发两条路径 */
  const fileTriggerActive = ref(false)
  /** $ 文件过滤 query（输入区 $ 后内容），透传给 CommandPopover 过滤 */
  const fileQuery = ref('')
  /** # session 触发态标记（四符号体系新增，同上语义） */
  const sessionTriggerActive = ref(false)
  /** # session 过滤 query（输入区 # 后内容），透传给 CommandPopover 过滤 */
  const sessionQuery = ref('')
  /** @ subagent 触发态标记（四符号体系新增，同上语义） */
  const subagentTriggerActive = ref(false)
  /** @ subagent 过滤 query（输入区 @ 后内容），透传给 CommandPopover 过滤 */
  const subagentQuery = ref('')
  /** skill 触发态标记（多 skill 注入 D1：行中空白后 / 的新分路，同上语义） */
  const skillTriggerActive = ref(false)
  /** skill 过滤 query（输入区空格后 / 的内容），透传给 CommandPopover 过滤 */
  const skillQuery = ref('')
  const commandPopoverRef = ref<InstanceType<typeof CommandPopover> | null>(null)

  /** SearchModal 单例（core 域，⌘K 全局搜索弹窗）——D1 互斥 watch 消费其 isOpen */
  const searchModal = useSearchModal()
  /**
   * SM open 时刻冻结的 sessionId（D2b session 冻结守卫锚点）：消费 pendingSlash 清理时
   * 冻结值 ≠ 当前 session 则跳过清理（⌘N 在 SM open 期间可切 session，切换时 draft watch
   * setText 整框替换且不派发 trigger——冻结的 active/query 与新文本静默脱钩，不守卫则可能
   * 误删他 session 草稿的同形 token）。注入本身不受此守卫影响（由 req.sessionId 过滤）。
   */
  const frozenSearchModalSessionId = ref<string | null>(null)

  /**
   * D1 单向状态互斥（search-modal-popover-mutual-exclusion 设计 D1）：SM open 时关命令浮层。
   *
   * 单向语义：仅 open 边沿动 cmdOpen（置 false），close 不动（SM 关闭后浮层不自动恢复——
   * 恢复 = 替用户决定她仍在命令语境；slash query 文本保留，删改任一字符即重新触发，D2）。
   * SM open 期间 cmdOpen 无再开向量（再开向量封闭三事实，设计前提 1）：①SM open watch →
   * nextTick autofocus 搜索输入框——键盘输入进 SM 不进 composer；②fixed inset-0 z-[1000]
   * 遮罩 + click.self——pointer 无法触达 composer；③slash-trigger level 重估只在 composer
   * input emit 时发生（dom-core contenteditable onInput），composer 收不到 input ⇒ cmdOpen
   * 无重置为 true 的输入源。flush:'sync'：⌘K keydown → isOpen=true → watch 同步执行
   * cmdOpen=false，同一事件循环内完成——用户下一次物理按键时 capture 监听开门条件已失效
   * （前提 3；仓内既定习语，command-popover-keyboard activeIndex 收敛 watch 同款）。
   * 不动 triggerActive/query 标记（保留即冻结守卫与 D2b 活跃域判定的锚，D2b 责任面）。
   */
  watch(
    () => searchModal.isOpen.value,
    (open) => {
      if (open) {
        cmdOpen.value = false
        frozenSearchModalSessionId.value = sessionId.value
      }
    },
    { flush: 'sync' },
  )

  /**
   * 活跃触发域判定（D2b 责任面判据）：五路 triggerActive 找 true 的那路，取其 query ref。
   * 活跃域至多一个（触发符检测按光标位置单激活）；判据是 active 标记**非 query ref 非空**
   * （失活域的 query ref 保留旧值不清，makeTriggerHandler null 分支只关浮层不清 query）；
   * +菜单路径（onAddSelect）不设 active——无活跃域返回 null（无清理对象，no-op-safe）。
   */
  function resolveActiveTriggerDomain(): { type: CommandPopoverType; query: Ref<string> } | null {
    if (slashTriggerActive.value) return { type: 'slash', query: slashQuery }
    if (fileTriggerActive.value) return { type: 'file', query: fileQuery }
    if (sessionTriggerActive.value) return { type: 'session', query: sessionQuery }
    if (subagentTriggerActive.value) return { type: 'subagent', query: subagentQuery }
    if (skillTriggerActive.value) return { type: 'skill', query: skillQuery }
    return null
  }

  /**
   * D2b 注入前清理：SM confirm 注入 chip 前清除活跃触发域 token 残留（文本定位式，非光标锚定）。
   *
   * 不清理则用户输入 `/compact`（浮层 open、域活跃）→ ⌘K → SM confirm `/commit` → chip 注入
   * 但残留明文仍在 → 序列化归首产出 `/commit /compact` → pi 把残留当 args 执行（垃圾参数）。
   * 链路：session 冻结守卫（SM open 时冻结 ≠ 当前 session 跳过——防误删他 session 草稿）→
   * 活跃域判定（无活跃域跳过）→ removeActiveTokenText（带域约束正则全文定位；非唯一/0 命中
   * 自行 no-op；删除范围 = 符号 + query，边界空白保留；光标落删除点，后续 chip 落 token 原位）。
   * onChanged 传空实现：draft ref 同步由紧随其后的 insertSlashChip/insertSkillChip 尾部
   * onChanged（= onInput → emitInput(getText())）承担——两者在同一 watch 回调内无条件顺序
   * 执行，删除后的最终态文本经 insert 的 emitInput 一次性同步给 Composer.vue 的 draft ref；
   * 独立 emitInput 通道（contenteditable composable 闭包）未暴露在 ShellInputInstance 契约面。
   */
  function clearActiveTokenBeforeInject(): void {
    if (frozenSearchModalSessionId.value !== sessionId.value) return
    const domain = resolveActiveTriggerDomain()
    if (!domain) return
    removeActiveTokenText({
      el: inputRef.value?.getInputElement?.() ?? null,
      domainPatternSource: ACTIVE_TOKEN_DOMAIN_PATTERN_SOURCES[domain.type],
      query: domain.query.value,
      onChanged: () => {},
    })
  }

  /**
   * 消费搜索浮层的 slash 注入请求（store 驱动模式，替代断链的 injectSlash 回调）。
   * SearchModal → useSearchJump.confirmCommand → commandStore.requestSlashInjection 写入 pendingSlash，
   * 本 watch 按 sessionId 过滤消费，命中则注入 chip 并 clearPendingSlash。
   *
   * D2b 注入顺序：先 clearActiveTokenBeforeInject 清活跃域 token，再插 chip（insert 不清
   * 明文——insertSlashChip/insertSkillChip 的替换语义只移除既有 chip 节点，文本节点不在
   * 其删除范围，清理职责唯一归删除助手）。
   *
   * 分流（与 onCmdSelect 的 D3 项类型分流同款落点）：pi 的 skill 命令名是**裸** `skill:<name>`
   * （无前导 /），命令通路进入 insertSlashChip 后仅「以 /skill: 开头」的判据为假 ⇒ 落成命令
   * chip（无 chipLocation + 受单命令替换语义管辖），既丢 SKILL.md 路径也丢多 skill 共存。
   * 故 isSkill 为真时直接走 skill 通路：裸名（bareSkillCommandName 剥 `skill:` / `/`）
   * + location + icon，落点与 onCmdSelect 的 skill 项/type==='skill' 两分支一致；否则维持命令通路（回归锁）。
   *
   * 非 immediate：防 Composer 后挂载时读到旧 pendingSlash 残留值误注入（挂载时 store 可能已有
   * 给前一个 Composer 的请求，immediate 会立即误触发）。仅响应挂载后的新写入。
   * sessionId 匹配：含双方 null（landing 态）。不匹配分支不 clear（防误清留给其他 Composer 的请求）。
   * 注入顺序：先插 chip 后 clearPendingSlash（防先清后注入读到 null）。
   */
  watch(
    () => commandStore.pendingSlash.value,
    (req) => {
      if (!req) return
      if (req.sessionId !== sessionId.value) return // 仅消费目标 session 的请求
      clearActiveTokenBeforeInject()
      if (req.isSkill) {
        inputRef.value?.insertSkillChip(bareSkillCommandName(req.command), req.location, req.icon)
      } else {
        inputRef.value?.insertSlashChip(req.command, req.icon)
      }
      commandStore.clearPendingSlash()
    },
  )

  /** 四路输入区触发事件路由的共用态机（$/#/@// 四符号行为一致，只差触发态、query、cmdType 三轴）：
   *  - payload 非 null（光标前有「空格/行首 + 符号 + 非空白」）→ 打开对应浮层，记录 query 透传过滤，标记触发态
   *  - payload 为 null 且该路触发态为 true → 关闭浮层（符号后遇空格等终止场景；仅输入区触发
   *    路径受影响——+菜单路径不设触发态，普通键不会误关） */
  function makeTriggerHandler(
    active: Ref<boolean>,
    query: Ref<string>,
    type: CommandPopoverType,
  ): (payload: { query: string } | null) => void {
    return (payload) => {
      if (payload) {
        active.value = true
        query.value = payload.query
        cmdType.value = type
        cmdOpen.value = true
      } else if (active.value) {
        cmdOpen.value = false
        active.value = false
      }
    }
  }

  /** 输入区 / 触发 → slash 浮层（payload 非 null 条件：/ 在最左且无 chip） */
  const onSlashTrigger = makeTriggerHandler(slashTriggerActive, slashQuery, 'slash')
  /** 输入区 $ 触发 → file 浮层 */
  const onFileTrigger = makeTriggerHandler(fileTriggerActive, fileQuery, 'file')
  /** 输入区 # 触发 → session 浮层（四符号体系） */
  const onSessionTrigger = makeTriggerHandler(sessionTriggerActive, sessionQuery, 'session')
  /** 输入区 @ 触发 → subagent 浮层（四符号体系） */
  const onSubagentTrigger = makeTriggerHandler(subagentTriggerActive, subagentQuery, 'subagent')
  /** 输入区空格后 / 触发 → skill 浮层（多 skill 注入 D1；与 onSlashTrigger 行首命令域正则互斥） */
  const onSkillTrigger = makeTriggerHandler(skillTriggerActive, skillQuery, 'skill')

  /** + 菜单选择：
   *  - attach（任意文件）：调 pickFile IPC（无 filters），选中后插文本路径到输入区。canceled 静默 return。
   *  - image（图片）：调 pickFile IPC（带 image filters），选中后以磁盘 path 插 image chip。
   *  - slash：打开命令浮层（slashTriggerActive 不设 true——+菜单路径的浮层不受后续 slash-trigger:null 影响）。
   *
   *  pickFile 降级（web/mock 无 preload）→ {canceled:true, path:null}，onAddSelect 视同取消 return（不 throw）。
   *  pickFile 异常（reject）→ try/catch 降级：记 warn 后 return（取消已是预期路径，不 toast / 不重抛）。
   *  file 入口已移除（$ 文件走输入区 inline 触发，四符号体系 D 项确认 +菜单无 #/$ 提示入口）。 */
  async function onAddSelect(type: 'attach' | 'image' | 'slash'): Promise<void> {
    if (type === 'attach' || type === 'image') {
      inputRef.value?.focus()
      try {
        const result =
          type === 'image'
            ? await pickFile({ filters: [{ name: 'Images', extensions: IMAGE_FILTER_EXTENSIONS }] })
            : await pickFile()
        if (result.canceled || !result.path) return
        if (type === 'image') {
          // image：文件已在磁盘，直接以原 path 建 image chip（不走 writeSessionImage，避免复制 + path 漂移）
          // 磁盘已存在文件的 fileName 与 displayName 相同（basename，无 uuid 前缀）：
          // 与粘贴/拖拽通路（writeSessionImage 产出 uuid 前缀 fileName + 用户可读 displayName）不同，
          // 此处两字段同值（磁盘 basename）。
          const name = result.path.split(/[\\/]/).pop() || result.path
          // +菜单选的是用户磁盘已存在文件，不需要迁移（不是 landing 态 writeSessionImage 落 tmpdir 的临时文件）。
          // needsMigrate 显式传 false——若误传 true，renameSync 会把用户原文件移走（数据丢失）。
          inputRef.value?.insertImageBadge(result.path, name, name, false)
        } else {
          // attach：任意文件，走 file chip（与 # 文件引用 / drawer 注入一致产出绿色 badge）。
          // file segment 全链路（DOM 解析 / segmentsToText / Turn 渲染）已支持，pi 收到裸 path 自己 read。
          inputRef.value?.insertFileChip(result.path)
        }
      } catch (e) {
        // pickFile reject（IPC 异常 / 主进程崩溃）→ best-effort 降级：取消已是预期路径，
        // 不 toast、不重抛（用户点 + 菜单选文件失败不应阻断 composer 其他操作）。仅记 warn 便于排查。
        console.warn('[onAddSelect] pickFile IPC failed', e)
      }
      return
    }
    // slash
    inputRef.value?.saveSelection()
    inputRef.value?.focus()
    cmdType.value = 'slash'
    cmdOpen.value = true
  }

  /** 命令浮层选中：五路各先清「符号+query」过滤文本再插对应 chip。
   *  - slash：clearSlashQueryText → 命令项 insertSlashChip；skill 项（isSkill）按项类型分流
   *    insertSkillChip（设计 D3，与 skill 入口行为合流：光标处、多共存、带 location）
   *  - skill（行中空白后 / 触发）：clearSkillQueryText → insertSkillChip（光标处标记 chip，
   *    多个共存——与 slash 的「唯一/替换语义」命令 chip 通道区分，多 skill 注入 D2）
   *  - file（$ 触发）：clearDollarFileQueryText → insertFileChip（绿色 file chip，
   *    与原 insertMentionChip('#') 等价——dom-core 内 # 委托 insertFileChip，直接走本名）
   *  - session（# 触发）：clearSessionQueryText → insertSessionChip（显示 label 非 uuid）
   *  - subagent（@ 触发）：clearSubagentQueryText → insertSubagentChip；「新建」项
   *    （subagentId/slug 空串）插占位 slug chip（@新任务），发送分流在 U2b 收口。
   *  icon 按 source 透传给 chip（extension→terminal / skill→star / 默认 wrench），与选择框图标一致。 */
  function onCmdSelect(payload: CommandSelectPayload): void {
    cmdOpen.value = false
    slashTriggerActive.value = false // 复位触发态标记
    fileTriggerActive.value = false // 复位 $ 触发态标记
    sessionTriggerActive.value = false // 复位 # 触发态标记
    subagentTriggerActive.value = false // 复位 @ 触发态标记
    skillTriggerActive.value = false // 复位 skill 触发态标记
    inputRef.value?.focus()
    if (payload.type === 'slash') {
      inputRef.value?.clearSlashQueryText()
      if (payload.isSkill) {
        // 设计 D3：行首浮层的 skill 项按「项类型」分流——与 type==='skill' 分支合流
        //（光标处 + 多个共存 + 带 location），不再走 insertSlashChip 老通路
        const parsedName = payload.name.startsWith('/skill:')
          ? payload.name.slice('/skill:'.length)
          : payload.name
        inputRef.value?.insertSkillChip(parsedName, payload.location, payload.icon)
      } else {
        inputRef.value?.insertSlashChip(payload.name, payload.icon)
      }
    } else if (payload.type === 'skill') {
      inputRef.value?.clearSkillQueryText()
      inputRef.value?.insertSkillChip(payload.name, payload.location, payload.icon)
    } else if (payload.type === 'session') {
      inputRef.value?.clearSessionQueryText()
      inputRef.value?.insertSessionChip(payload.sessionId ?? '', payload.label ?? payload.name)
    } else if (payload.type === 'subagent') {
      inputRef.value?.clearSubagentQueryText()
      const slug = payload.slug || ''
      const subagentId = payload.subagentId || ''
      // 「新建 subagent」项（两字段空串）：插占位 slug chip（设计 3.1.3 场景 2）
      inputRef.value?.insertSubagentChip(subagentId, slug || t('panel.command.newSubagentPlaceholder'))
    } else {
      inputRef.value?.clearDollarFileQueryText()
      inputRef.value?.insertFileChip(payload.name)
    }
  }

  /** exactMatch 直发接线（U2，command-enter-exact-send D2）：onCmdSelect 复用（关浮层 + 清
   *  五路触发态 + 清 query + 插 chip——先插后发，与用户手按二次 Enter 的前置态完全同链、发送链
   *  零改动零分叉）→ 同步直调 dispatchEnter 链（原事件直接函数调用，零合成零 DOM 派发）。 */
  function onSelectAndSend(payload: CommandSelectAndSendPayload): void {
    onCmdSelect(payload)
    onComposerKeydown?.(payload.originalEvent)
  }

  return {
    cmdOpen,
    cmdType,
    slashQuery,
    fileQuery,
    sessionQuery,
    subagentQuery,
    skillQuery,
    commandPopoverRef,
    onSlashTrigger,
    onFileTrigger,
    onSessionTrigger,
    onSubagentTrigger,
    onSkillTrigger,
    onAddSelect,
    onCmdSelect,
    onSelectAndSend,
  }
}
