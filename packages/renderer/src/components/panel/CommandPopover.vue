<template>
  <!--
    命令浮层（draft-composer-states §2d，四符号体系扩为四路共享容器：$ 文件 / # session /
    @ subagent / / 命令）。由 Composer 受控打开（v-model:open）。用 reka-ui Popover portal
    到 body，不受 composer-box 父容器 overflow/stacking context 限制（修复 D5 定位 bug）。
    **anchor 是 slot 传入的 composer-box**：composer-box 内任何 focus 都算 inside，
    不触发 onFocusOutside dismiss（修复 focus-outside 误关 bug）。
    键盘事件（↑↓ ⏎ Tab Esc）主入口 = 本组件经 command-popover-keyboard.ts 注册的 window
    capture 监听；Composer 在 ComposerInput keydown 时调 handleKeydown 为兜底路（见
    composer-keydown.ts），二者共用同一 handleKeydown——幂等守卫（e.defaultPrevented）在
    command-popover-keyboard.ts 内，同一事件只被先到的入口消费。
    **@open-auto-focus.prevent**：禁掉 reka-ui PopoverContent 的 FocusScope 自动聚焦——
    否则浮层打开会把焦点抢到首个命令按钮，contenteditable 不再收键，导致
    「敲 / 后无法继续输入做实时筛选」（query 实时过滤依赖焦点留在输入区）。
    键盘导航走 window capture 监听，与焦点位置无关，故禁自动聚焦不影响 ↑↓⏎Tab Esc。
    **宽度**：w 取 --reka-popper-anchor-width（= composer-box 宽），严格对齐 composer 宽度；
    max-w calc(100vw-16px) 兜底防极窄视口溢出。提示词列 truncate 在固定宽度内截断。
    右侧提示词列透传 slash 命令 description（skill 描述等），无则退显 kind 标签。
    无 header 行（去掉「命令 / · xx 项」），列表直接展示，提示列更宽（max-w-[520px]）。

    **v6 视觉范式（B3 问题 14，对齐 demo .cmd-row）**：
    - 行用纯 div（非 Button variant=ghost），避免 button 的 font-medium/ring-offset 噪音
    - 选中态 bg-surface（实色）——D8 特例，不复用 popover-styles.ts 的 SELECTED_ITEM_CLASS（bg-accent-soft）
    - skill 类命令未选中时图标 text-reasoning（紫，demo .cmd-ico.skill）；选中统一 text-accent
    - 命令名 font-semibold（非 mono）+ middot · 分隔符（命令名与描述间）
    - 容器投影走 PopoverContent 默认 shadow-2（demo .cmd-pop box-shadow）
  -->
  <Popover v-model:open="controlledOpen">
    <!-- anchor：composer-box 本身（由调用方通过 slot 传入），DOM contains 成立 →
         composer-box 内任何 focus 都算 inside，不触发 onFocusOutside dismiss -->
    <PopoverAnchor as-child>
      <slot />
    </PopoverAnchor>
    <!-- v-if 只看 open：每个 open 态都有可见行（候选列表 / 空态 / 加载中 / 加载失败）。
         这是「浮层 open 即消费键盘」的前提——不可见态吞键会导致消息发不出且无提示，
         故此前按「实际可见才消费」；反馈行补齐后该理由消失（决策因果见 command-popover-keyboard.ts）。 -->
    <PopoverContent
      v-if="open"
      side="top"
      align="start"
      :side-offset="6"
      :collision-padding="8"
      class="w-[var(--reka-popper-anchor-width)] max-w-[calc(100vw-16px)] overflow-hidden p-0"
      @open-auto-focus.prevent
    >
      <!-- D7：landing cwd 路错误态（加载失败 vs 无结果两因区分）——整行可点重试（重发起拉取） -->
      <div
        v-if="fileErrorVisible"
        class="flex cursor-pointer items-center gap-2 px-2.5 py-2 text-left text-[12px] text-neutral-mid transition-colors hover:bg-surface-hover hover:text-neutral-fg"
        role="button"
        data-testid="cmd-file-error"
        @click="retryCwdFileFetch"
      >
        <AlertCircle class="size-[15px] shrink-0 text-danger opacity-70" />
        <span class="truncate">{{ t('panel.command.fileLoadFailed') }}</span>
      </div>
      <!-- D7：无结果空态（拉取成功但目录无文件；query 过滤致空不在此列——源非空不弹本态） -->
      <div
        v-else-if="fileNoResultsVisible"
        class="flex items-center gap-2 px-2.5 py-2 text-[12px] text-neutral-dim"
        data-testid="cmd-file-empty"
      >
        <FolderOpen class="size-[15px] shrink-0 opacity-60" />
        <span class="truncate">{{ t('panel.command.fileNoResults') }}</span>
      </div>
      <!-- 加载中空态（landing `$` 有 cwd 但候选未到）：本次 open 被 1s 节流跳过 / 上一轮请求在途。
           两种来源都是「结果稍后会到」的态，必须有可见行兜住（否则 open 但无渲染）。 -->
      <div
        v-else-if="fileLoadingVisible"
        class="flex items-center gap-2 px-2.5 py-2 text-[12px] text-neutral-dim"
        data-testid="cmd-popover-loading"
      >
        <LoaderCircle class="size-[15px] shrink-0 opacity-60" />
        <span class="truncate">{{ t('panel.command.loading') }}</span>
      </div>
      <!-- 通用无匹配空态：覆盖其余全部「open 但无候选」态——slash/session/subagent/skill 空源、
           landing `@` 无 sessionId、landing `$` 无 cwd、landing `$` 候选源非空但 query 无匹配。
           该行同时是「open 即消费键盘」的反馈前提（见脚本区 fileLoadingVisible 上方注释）。 -->
      <div
        v-else-if="items.length === 0"
        class="flex items-center gap-2 px-2.5 py-2 text-[12px] text-neutral-dim"
        data-testid="cmd-popover-empty"
      >
        <SearchX class="size-[15px] shrink-0 opacity-60" />
        <span class="truncate">{{ t('panel.command.noMatches') }}</span>
      </div>
      <template v-else>
        <!-- list · 行用纯 div（对齐 demo .cmd-row：避免 Button variant=ghost 的 font-medium/ring-offset 噪音）。
             选中态 bg-surface（实色）是 D8 特例——不复用 popover-styles.ts 的 SELECTED_ITEM_CLASS
             （该 class 是 bg-accent-soft，供 ModelSelect/ThinkingLevel 用）；CommandPopover 按 D8 用实色。 -->
        <div class="max-h-[180px] overflow-y-auto py-1">
          <div
            v-for="(item, i) in items"
            :key="item.id"
            class="cmd-row flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] leading-[1.4] transition-colors"
            :class="i === activeIndex ? 'bg-surface text-accent' : 'text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg'"
            :aria-disabled="item.selected ? 'true' : undefined"
            @click="onSelect(item)"
            @mouseenter="activeIndex = i"
          >
            <component
              :is="iconFor(item)"
              :class="['size-[15px] shrink-0', iconClass(item, i === activeIndex)]"
            />
            <!-- file 类型：两行（basename 主 + 父目录路径暗色小字），区分同名文件 + 知道文件位置。
                 file basename 保留 font-mono（路径/文件名等宽对齐是常见范式，与 slash 命令名 sans 区分）。 -->
            <div v-if="props.type === 'file'" class="min-w-0 flex-1">
              <div class="truncate font-mono text-[12px]" :class="i === activeIndex ? 'text-accent' : 'text-neutral-fg'">{{ item.name }}</div>
              <div v-if="item.dirPath" class="truncate font-mono text-[10px] leading-tight text-neutral-dim">{{ item.dirPath }}</div>
            </div>
            <!-- session / subagent 类型：两行（主行 + subText 副行）——session 副行 = cwd · 相对时间、
                 subagent 副行 = agent · status、新建项无副行。主行 sans（标题/短标签语义，与 file 的
                 mono 路径区分）。派生逻辑在 command-popover-symbols.ts（纯函数可单测）。 -->
            <div v-else-if="props.type === 'session' || props.type === 'subagent'" class="min-w-0 flex-1">
              <div class="truncate text-[12px] font-medium" :class="i === activeIndex ? 'text-accent' : 'text-neutral-fg'">{{ item.name }}</div>
              <div v-if="item.subText" class="truncate text-[10px] leading-tight text-neutral-dim">{{ item.subText }}</div>
            </div>
            <!-- slash 类型：单行（命令名加粗 sans + middot + description/kind 提示词）。
                 skill 只显名字（icon+紫色已传达类型，/skill: 前缀对用户冗余）；
                 普通 slash 保留 / 前缀（命令调用语义）。item.name 是完整路由名（含前缀），
                 item.displayName 是显示名（skill 去前缀）——onSelect 传 name 保证路由正确。
                 middot · 与 demo .cmd-mid 对齐（命令名与描述间的视觉分隔）。 -->
            <template v-else>
              <span class="shrink-0 font-semibold" :class="i === activeIndex ? 'text-accent' : 'text-neutral-fg'">{{ item.displayName ?? item.name }}</span>
              <span v-if="item.description" class="shrink-0 text-neutral-faint">·</span>
              <span v-if="item.description" class="ml-auto shrink-0 truncate max-w-[520px] text-neutral-dim">{{ item.description }}</span>
              <!-- skill 已选标记（多 skill 注入 D2）：命中 selectedSkillNames 的项显示「已选」，
                   onSelect 守卫禁选（防同一 skill 重复注入全文） -->
              <span v-if="item.selected" class="ml-auto shrink-0 text-[10px] text-neutral-dim">{{ t('panel.command.skillSelected') }}</span>
              <span v-else-if="!item.description" class="ml-auto shrink-0 text-[10px] text-neutral-dim">{{ item.kind }}</span>
            </template>
          </div>
        </div>
        <!-- D7：DoS 上限 5000 截断提示（runtime truncated 信号；目标文件可能不在候选的感知入口） -->
        <div
          v-if="fileTruncatedVisible"
          class="border-t border-hairline px-2.5 py-1 text-[10px] text-neutral-dim"
          data-testid="cmd-file-truncated"
        >{{ t('panel.command.fileTruncated') }}</div>
      </template>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, FolderOpen, LoaderCircle, SearchX } from '@lucide/vue'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { iconKeyForCommand, filterAndSortFileCandidates, toFileCandidates } from '@taiji/core'
import { SLASH_COMMAND_SOURCE_KEY } from './command-popover-source'
import { buildSessionCandidates, buildSubagentCandidates, buildSlashCandidates, buildPanelSlashCandidates, buildLandingSlashCandidates } from './command-popover-symbols'
import { buildSkillCandidates } from './command-popover-skill-candidates'
import { useCommandPopoverOpenFetch } from './command-popover-open-fetch'
import { useCommandSync } from '@/composables/panel/useCommandSync'
import { useFileSearch } from '@/composables/features/search/useFileSearch'
import { useCommandPopoverKeyboard } from '@/composables/panel/command-popover-keyboard'
import type { SkillInfo } from '@taiji/shared'
import { useSessionStore } from '@/stores/session'
import { useSubagentStore } from '@/stores/subagent'

type CmdType = 'file' | 'slash' | 'session' | 'subagent' | 'skill'

type ComposerVariant = 'panel' | 'landing'

const props = defineProps<{
  open: boolean
  type: CmdType
  /** session 通道订阅键（D8：session.commands 带 sessionId，走 events.on(sessionId)） */
  sessionId?: string
  /** landing 态当前选定目录（Composer 传 flow.currentCwd；panel 态有 sessionId 不消费）。
   *  $ file 路 landing（无 sid）按 cwd 边沿拉候选（open-fetch D2/D3）；无 cwd 无候选源不弹。 */
  cwd?: string | null
  /** composer 形态：landing（新建任务空态）vs panel（对话态）。ADR-0050 二次修订：slash
   *  命令源按 variant 分支（landing = merged + skills 合并；panel = compact + merged，pi
   *  真源 skill 项剔除后由 registry 源补入——换源保留）；skill 候选两态统一 taiji 源。默认 'panel'。 */
  variant?: ComposerVariant
  /** 过滤 query（输入区 / 或 # 后的内容，空串/缺省=不过滤；file 按 name+path 过滤，slash 按命令名过滤） */
  query?: string
  /** 已插入的 skill 名集合（多 skill 注入 D2 已选禁选数据面）：Composer 从当前 segments 取。
   *  命中项显示「已选」并禁选（同一 skill 不重复注入全文，防上下文浪费）。默认空。 */
  selectedSkillNames?: string[]
  /** 全局 skill（useGlobalSkills → skillRegistry globalCache，W4 FR-5）。skill 段两态共用 +
   *  panel slash 段 registry 源 skill 项（ADR-0050 二次修订换源保留）。默认空。 */
  globalSkills?: SkillInfo[]
  /** 当前 cwd 的项目 skill（useProjectSkills 按 cwd key 缓存，W3 ADR-0051；panel 态 cwd =
 *   session cwd，landing 态 = flow.currentCwd——接线在 Composer）。skill 段两态共用 +
 *   panel slash 段 registry 源 skill 项。默认空。 */
  projectSkills?: SkillInfo[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [payload: {
    type: CmdType
    name: string
    icon?: string
    description?: string
    /** slash 路 skill 项标记（D3）：onCmdSelect 按「项类型」而非入口 type 分流到 skill 通路 */
    isSkill?: boolean
    /** skill 路：SKILL.md 绝对路径（可得时带上）；缺省时 runtime 经 get_commands 权威映射解析 */
    location?: string
    /** session 路（#）：选中 session 的 id + 显示 label */
    sessionId?: string
    label?: string
    /** subagent 路（@）：record id + 短标签；「新建」项两字段空串 */
    subagentId?: string
    slug?: string
  }]
}>()

/** 受控 open：双向同步 props.open ↔ emit update:open */
const controlledOpen = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

const { t } = useI18n()
const commandStore = useCommandStore()
const sessionIdRef = toRef(props, 'sessionId')

/** panel 路 file 候选加载：挂载 / 切 session 现拉（无缓存，缓存治理 U1 1-3 退役——每次现跑 file.search）。
 *  触发时机是挂载 + sid 变化，与 open-fetch 的 open 边沿 landing cwd 路是 D2 双路数据源
 *  （panel 有 sid 走本路；原 command-popover-file-candidates.ts，u20 内联回本组件）。 */
const { load: loadFileCandidates } = useFileSearch()
const fileCandidates = ref<ReturnType<typeof toFileCandidates>>([])
async function loadCandidates(): Promise<void> {
  if (!sessionIdRef.value) return
  const nodes = await loadFileCandidates(sessionIdRef.value)
  fileCandidates.value = toFileCandidates(nodes)
}
onMounted(() => { void loadCandidates() })
watch(sessionIdRef, () => { void loadCandidates() })
/**
 * landing cwd 路 $ 候选 + D7 三态（无 sid 时 open-fetch 边沿拉取，D2；panel 有 sid 走上方
 * fileCandidates）。错误态/空态两因区分 + 5000 截断提示 + B5/#10 cwd 快照守卫与 open 边沿清 ref，
 * 拉取与视图态同在 command-popover-open-fetch.ts 的 useCommandPopoverOpenFetch。
 */
const {
  cwdFileCandidates,
  fileErrorVisible,
  fileNoResultsVisible,
  fileTruncatedVisible,
  retryCwdFileFetch,
} = useCommandPopoverOpenFetch({
  open: () => props.open,
  type: () => props.type,
  sessionId: () => props.sessionId,
  cwd: () => props.cwd,
})

/**
 * landing `$` 有 cwd 但候选未到（加载中反馈行）——等价于 open-fetch 内部
 * `cwdFileStatus === 'idle'`：本次 open 因 1s 节流跳过、上一轮请求在途，两者都是
 * 「结果稍后会到」态，需可见行兜住（否则该 open 态什么都不渲染）。
 * 推导与状态机一一对应：success + 空候选 ⇒ fileNoResultsVisible，error ⇒ fileErrorVisible，
 * 故「候选空 且 两态皆假」⟺ idle；用候选长度（非 items）判据，query 过滤致空不误判为加载中。
 * cwd 访问器即 props.cwd（landing `$` 无 cwd 时无候选源，落通用无匹配行）。
 */
const fileLoadingVisible = computed(
  () =>
    props.type === 'file' &&
    !props.sessionId &&
    !!props.cwd &&
    cwdFileCandidates.value.length === 0 &&
    !fileErrorVisible.value &&
    !fileNoResultsVisible.value,
)
// 四符号体系候选源：# sessionStore（sidebar 同款跨 cwd 全量）/ @ subagentStore（per-session 分区）
const sessionStore = useSessionStore()
const subagentStore = useSubagentStore()

/** composer 形态归一化（默认 panel，兼容未透传 variant 的旧调用） */
const variant = computed<ComposerVariant>(() => props.variant ?? 'panel')

/** slash 命令源（W3 收编后：merged 源 = registry 声明 ∪ commandStore pi 真源，ADR-0050 按 variant 分支）。
 * landing：merged（无 session 真源时声明即显示——slice TC2）+ globalSkills ∪ projectSkills 合并。
 * panel：compact + merged（pi 真源 skill 项剔除）+ registry 源 skill 项补入（ADR-0050 二次修订
 * 换源保留：pi 真源 skill 命令是滞后快照故剔除，skill 候选统一 registry 源）。
 * __ 前缀命令过滤（W5 内部命令不可见）；无注入源（独立使用/测试）时降级 pi-only（现状行为兼容）。 */
const slashSource = inject(SLASH_COMMAND_SOURCE_KEY, null)
const slashCommands = computed(() => {
  const piCmds = props.sessionId ? commandStore.getCommands(props.sessionId) : []
  // merged：registry 声明 ∪ pi 真源（resolveSlashCommands 纯函数，壳注入；无注入时退化 pi 真源）
  const merged = slashSource ? slashSource.resolveSlashCommands(piCmds) : piCmds
  if (variant.value === 'landing') {
    return buildLandingSlashCandidates(merged, props.globalSkills ?? [], props.projectSkills ?? [])
  }
  // panel 态：compact + merged（pi 真源 skill 项剔除）+ registry 源 skill 项（换源保留，
  // ADR-0050 二次修订）；组装下沉 command-popover-symbols（≤300 行规范）
  return buildPanelSlashCandidates(
    merged,
    {
      id: 'compact',
      name: 'compact',
      kind: 'builtin',
      icon: 'compact',
      description: t('panel.command.compactDesc'),
    },
    props.globalSkills ?? [],
    props.projectSkills ?? [],
  )
})

/** slash 命令投递闭环（挂载/切 session 补拉 + session.commands 订阅；open 边沿拉取归
 *  useCommandPopoverOpenFetch，双路并存会重复 RPC——详见 useCommandSync） */
useCommandSync(sessionIdRef)

/** 统一候选项视图（四路归一；file/slash 在此派生，session/subagent 委托 command-popover-symbols） */
interface CmdItem {
  id: string
  name: string
  displayName?: string
  kind: string
  icon: string
  /** slash 路专用（skill 图标紫色）；session/subagent 路缺省 falsy */
  isSkill?: boolean
  description?: string
  /** skill 路透传：SKILL.md 绝对路径（select payload → insertSkillChip dataset），可得时带上 */
  location?: string
  /** skill 候选（skill 路 + slash 路的 skill 项，S-2）：已插入过（selectedSkillNames 命中）
   *  →「已选」禁选（多 skill 注入 D2 去重） */
  selected?: boolean
  /** file 路副行（父目录）/ session·subagent 路副行（subText） */
  dirPath?: string
  subText?: string
  /** session / subagent 路透传（select payload → insert*Chip；「新建」项两字段空串） */
  sessionId?: string
  label?: string
  subagentId?: string
  slug?: string
}

const items = computed<CmdItem[]>(() => {
  if (props.type === 'file') {
    // 数据源分路（D2）：panel（有 sid）= fileCandidates hook（store 缓存）；landing（无 sid）= cwd 路 ref
    const source = props.sessionId ? fileCandidates.value : cwdFileCandidates.value
    const fq = (props.query ?? '').trim()
    const sorted = filterAndSortFileCandidates(source, fq)
    return sorted.map((f) => {
      // dirPath：path 去 basename 段的父目录（供第二行展示）；根目录文件 → ''
      const path = f.path ?? ''
      const slashIdx = path.lastIndexOf('/')
      const dirPath = slashIdx >= 0 ? path.slice(0, slashIdx + 1) : ''
      return {
        id: f.id,
        name: f.name,
        displayName: f.name,
        kind: f.kind,
        icon: f.kind === '目录' ? 'folder' : 'file',
        isSkill: false,
        description: undefined,
        dirPath,
      }
    })
  }
  if (props.type === 'session') {
    // # session 候选（G2/D1/D7）：sessionStore 全量跨 cwd 常驻，landing/panel 统一「有数据就列」
    return buildSessionCandidates(sessionStore.list, props.query ?? '')
  }
  if (props.type === 'subagent') {
    // @ subagent 候选（G3）：当前 session 分区 + 固定尾部「新建」项；landing 态返回空
    const records = props.sessionId ? subagentStore.getRecordsBySession(props.sessionId) : []
    return buildSubagentCandidates(records, props.query ?? '', !!props.sessionId, t('panel.command.newSubagent'))
  }
  if (props.type === 'skill') {
    // skill-only 候选（多 skill 注入 D1/D2；ADR-0050 修订：两态统一 taiji 源 globalSkills ∪
    // projectSkills，panel 不再消费 commandStore pi 快照）+ query 过滤 + 已选标记（纯函数拆分）
    return buildSkillCandidates(props)
  }
  // slash 路（行首命令浮层）：query 过滤 + CmdItem 组装（纯函数拆分至 command-popover-symbols）。
  // selectedSkillNames 透传（S-2）：slash 路的 skill 项同样打 selected → 「已选」禁选，
  // 与 skill 入口去重口径合流（否则同一 skill 可经 + 菜单「命令」入口插两次）
  return buildSlashCandidates(slashCommands.value, props.query, iconKeyForCommand, props.selectedSkillNames)
})

const ICONS = SLASH_ICON_COMPONENTS
function iconFor(item: { icon: string }) {
  return ICONS[item.icon] ?? ICONS.file
}

/** 图标色 class：选中→text-accent；未选中 skill→text-reasoning；其他→text-neutral-dim */
function iconClass(item: { isSkill?: boolean }, isSelected: boolean): string {
  if (isSelected) return 'text-accent'
  return item.isSkill ? 'text-reasoning' : 'text-neutral-dim'
}

function onSelect(item: CmdItem): void {
  // 已选禁选守卫（多 skill 注入 D2）：命中 selectedSkillNames 的 skill 项不再派发 select
  // （同一 skill 不重复注入全文）；键盘 Enter/Tab 与鼠标点击共用本函数，一处守卫双路生效
  if (item.selected) return
  emit('select', {
    type: props.type,
    name: item.name,
    icon: item.icon,
    description: item.description,
    isSkill: item.isSkill,
    location: item.location,
    sessionId: item.sessionId,
    label: item.label,
    subagentId: item.subagentId,
    slug: item.slug,
  })
}

// ── 键盘路由（↑↓ ⏎ Tab Esc）+ activeIndex 收敛在 command-popover-keyboard.ts ──────────
// 由该 composable 单点收敛 activeIndex（列表变化 sync 夹到合法区间），故 Enter 读点直取
// list[activeIndex] 不再 Math.min 兜底；window capture 监听与 Escape 关闭也随之下沉。
const { activeIndex, handleKeydown } = useCommandPopoverKeyboard<CmdItem>({
  open: () => props.open,
  items: () => items.value,
  onSelect,
  close: () => {
    controlledOpen.value = false
  },
  resetKeys: () => [props.open, props.type, props.query],
})

// ── D7 三态派生与 landing cwd 候选 ref 见 useCommandPopoverOpenFetch（command-popover-open-fetch.ts）──

defineExpose({ handleKeydown })
</script>
