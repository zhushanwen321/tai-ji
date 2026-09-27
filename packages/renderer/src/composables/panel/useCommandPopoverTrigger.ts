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
 * - pendingSlash watch：消费 SearchModal 经 commandStore 注入的 slash 请求。
 * - commandPopoverRef + cmdOpen：键盘路由（⏎/Esc）与 v-model:open 绑定。
 *
 * 不含：发送/steer/abort 编排、模型/思考等级、草稿维护（均留在 Composer.vue / 其他 composable）。
 */
import { ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { pickFile } from '@/lib/ipc'
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

export function useCommandPopoverTrigger(
  inputRef: Readonly<Ref<ShellInputInstance | null>>,
  sessionId: Ref<string | null>,
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

  /**
   * 消费搜索浮层的 slash 注入请求（store 驱动模式，替代断链的 injectSlash 回调）。
   * SearchModal → useSearchJump.confirmCommand → commandStore.requestSlashInjection 写入 pendingSlash，
   * 本 watch 按 sessionId 过滤消费，命中则注入 chip 并 clearPendingSlash。
   *
   * 分流（与 onCmdSelect 的 D3 项类型分流同款落点）：pi 的 skill 命令名是**裸** `skill:<name>`
   * （无前导 /），命令通路进入 insertSlashChip 后仅「以 /skill: 开头」的判据为假 ⇒ 落成命令
   * chip（无 chipLocation + 受单命令替换语义管辖），既丢 SKILL.md 路径也丢多 skill 共存。
   * 故 isSkill 为真时直接走 skill 通路：裸名（bareSkillCommandName 剥 `skill:` / `/`）+ location
   * + icon，落点与 onCmdSelect 的 skill 项/type==='skill' 两分支一致；否则维持命令通路（回归锁）。
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
  }
}
