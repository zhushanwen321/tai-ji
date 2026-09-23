<template>
  <!--
    容器组件 · Search Modal（overlays/spec.md · L0 Overlay 级）。
    ⌘K / Ctrl+K 唤起的全局搜索浮层：模糊遮罩 + 居中浮层，浮于所有 Region 之上。
    范围：全局·跨项目（命令/文件/符号/会话四类分组）。

    [w4 迁移] 自 renderer components/overlays/SearchModal.vue（381 行）迁入 ui 包
    overlays/（C-NT-4，架构文档 §10.3 SSOT）。变化：useSearch/useSearchJump/useSearchModal/
    segments/SearchItem 从 @taiji/core import（w1/w3 产物）；SearchDeps 经 props.deps
    注入（C-W4-1）；useSideDrawer 拆除改 props.onOpenDrawer（C-NT-3）；useToast 拆除改
    props.onToastError（C-W4-5，noop fallback）；void useRecents() 删除（core useSearch
    内部已接线 recents）。模板/键盘导航/分组渲染/防抖逻辑逐字迁移（CT-4，不做功能改动）。

    Wave3 重构：编排下沉至 composable（useSearch 编排聚合 / useSearchJump 跳转 / useRecents 持久化）。
    本组件只承担 UI：输入 → debounce 120ms → useSearch.query → 分组渲染 / ↑↓导航 → confirm。
    DEFERRED：⌘K toggle（Wave4 #10.1，现状监听在 Sidebar，本组件只处理 Esc/点遮罩关闭）。

    W1 i18n-frontend-p2：组件根改为 inline overlay div（不走 reka-ui Dialog Teleport）。
    动机：happy-dom + Teleport 把 DialogContent 内容渲染到 document.body，导致 wrapper.html() 拿不到搜索结果
    （SearchModal 测试断言依赖整棵 DOM 在 mount root 内）。生产行为对齐：
    - 居中遮罩 + 内容区（fixed 全屏遮罩 + pt-[10vh] 内容上移，复用 Dialog 视觉风格）
    - ESC 关闭（dialog div 内 keydown listener，onGlobalKeydown 处理——input 事件冒泡到 dialog div）
    - 点击遮罩关闭（onBackdropClick，仅 .self 触发）
    - focus 管理：input 装上时通过 nextTick autofocus
  -->
  <div
    v-if="open"
    data-testid="search-modal-overlay"
    class="fixed inset-0 z-[1000] flex items-start justify-center bg-black/80 px-4 pt-[10vh] backdrop-blur-sm"
    @click.self="onBackdropClick"
  >
    <div
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      :aria-label="t('search.title')"
      tabindex="-1"
      class="relative w-full max-w-[620px] overflow-hidden rounded-lg border bg-surface shadow-2 outline-none"
      @click.stop
      @keydown="onGlobalKeydown"
    >
      <div data-testid="search-modal-root">
        <!-- W1：sr-only a11y label（替代 reka-ui DialogTitle/Description，因 DialogHeader 依赖 DialogRootContext，
            而本组件已脱离 Dialog 包装以避免 happy-dom + Teleport 内容逃逸到 body） -->
        <h2 class="sr-only">{{ t('search.title') }}</h2>
        <p class="sr-only">{{ t('search.description') }}</p>

        <!-- 输入区：唤起即 focus（Dialog 默认聚焦首个可聚焦元素） -->
        <div class="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Search class="size-[18px] flex-shrink-0 text-neutral-dim" />
          <Input
            ref="inputRef"
            v-model="query"
            data-testid="search-input"
            class="h-8 border-0 bg-transparent px-0 text-[14px] shadow-none focus-visible:ring-0"
            :placeholder="t('search.placeholder')"
            @keydown="onKeydown"
          />
          <!-- v6 §6.5：esc 关闭快捷键提示徽标（对齐 demo） -->
          <kbd class="ml-auto rounded border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[10px] text-neutral-dim">esc</kbd>
        </div>

        <!-- 结果区 -->
        <div ref="resultsRef" class="max-h-[380px] overflow-y-auto py-1.5">
          <!-- loading 态（AC-8.1 防闪烁：扫描 >200ms 才显，避免快速查询闪烁） -->
          <div
            v-if="loading"
            data-testid="search-loading"
            class="flex items-center justify-center gap-2 px-6 py-6 text-[12px] text-neutral-dim"
          >
            <Loader2 class="size-3.5 animate-spin" />
            <span>{{ t('search.searching') }}</span>
          </div>

          <!-- 有结果：分组渲染（空查询=最近+建议命令；有查询=按命中类型分组） -->
          <template v-else-if="total > 0">
            <div
              v-for="s in sections"
              :key="s.label"
              :data-testid="`search-section-${s.label}`"
              class="py-1"
            >
              <div
                class="flex items-center gap-2 px-4 pb-1 pt-2 font-mono text-[10px] tracking-wider text-neutral-dim"
              >
                <span>{{ s.label }}</span>
                <span class="text-neutral-dim">{{ s.items.length }}</span>
              </div>
              <div
                v-for="it in s.items"
                :key="it.idx"
                role="option"
                :aria-selected="it.idx === selIdx"
                :data-idx="it.idx"
                :data-testid="`search-item-${it.idx}`"
                class="flex w-full cursor-pointer items-center gap-3 px-4 py-2 transition-colors"
                :class="it.idx === selIdx ? 'bg-surface-hover' : 'hover:bg-surface-hover'"
                @mouseenter="selIdx = it.idx"
                @click="confirmSel"
              >
                <component
                  :is="ICON[it.type]"
                  class="size-4 flex-shrink-0"
                  :class="it.idx === selIdx ? 'text-accent' : 'text-neutral-dim'"
                />
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="truncate text-[13.5px] text-neutral-fg">
                    <template v-for="(seg, i) in segments(it.title, query.trim())" :key="i">
                      <!-- v6 §6.5：高亮 font-semibold 不染蓝，颜色继承父元素（title=neutral-fg / sub=neutral-dim） -->
                      <mark v-if="seg.hit" class="bg-transparent font-semibold text-inherit">{{ seg.text }}</mark>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                  <span class="truncate font-mono text-[11px] text-neutral-dim">
                    <template v-for="(seg, i) in segments(it.sub, query.trim())" :key="i">
                      <mark v-if="seg.hit" class="bg-transparent font-semibold text-inherit">{{ seg.text }}</mark>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                </span>
                <Clock
                  v-if="!query.trim()"
                  class="size-[13px] flex-shrink-0 text-neutral-dim"
                />
              </div>
            </div>
          </template>

          <!-- 空结果：区分 recents 库空（首用）vs 查询无结果（AC-7.13） -->
          <div
            v-else
            data-testid="search-empty"
            class="flex flex-col items-center gap-2 px-6 py-10 text-center"
          >
            <Search class="size-7 text-neutral-dim" />
            <!-- recents 库空（空查询 + 无最近/建议）：首用引导 -->
            <p v-if="!query.trim()" class="text-[14px] text-neutral-fg">{{ t('search.startHint') }}</p>
            <!-- 查询无结果（非空 query 无命中）：带引号提示 -->
            <template v-else>
              <p class="text-[14px] text-neutral-fg">
                {{ t('search.noResult', { query: query.trim() }) }}
              </p>
              <p class="text-[12px] text-neutral-dim">{{ t('search.tryOther') }}</p>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted, type Component, type ComponentPublicInstance } from 'vue'
import { Search, Terminal, FileText, Code, MessageSquare, Clock, Loader2 } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
// ui 原语走包内相对导入（不经 @taiji/ui 顶层 barrel）：SearchModal 经顶层 barrel
// 再导出，顶层 barrel 自引用会闭合循环依赖环（R2 S-1）
import { Input } from '../primitives/input'
import { useSearch, useSearchJump, useSearchModal, segments } from '@taiji/core'
import type { SearchDeps, SearchItem } from '@taiji/core'

type SearchType = SearchItem['type']
interface IdxItem extends SearchItem { idx: number }

/** AC-7.15 查询防抖延迟（D-020，避免每次按键触发全量拉取） */
const DEBOUNCE_MS = 120
/** AC-8.1 loading 防闪烁延迟（扫描超过此时长才显示加载条，避免快速查询闪烁） */
const LOADING_DELAY_MS = 200

const props = withDefaults(
  defineProps<{
    open: boolean
    activeSessionId?: string | null
    /** search 编排依赖（core SearchDeps；壳层 Sidebar.vue 组装真实现，C-W4-1 props 注入） */
    deps: SearchDeps
    /** drawer 打开动作（C-NT-3 拆除 useSideDrawer：file 跳转返 drawerTab:'detail' 时打开 SideDrawer；壳提供实现） */
    onOpenDrawer?: (tab: string) => void
    /** toast 通知（C-W4-5 拆除 useToast；confirm {ok:false} 时展示错误；noop fallback） */
    onToastError?: (message: string) => void
  }>(),
  { activeSessionId: null, onOpenDrawer: () => {}, onToastError: () => {} },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const { t } = useI18n()

const ICON: Record<SearchType, Component> = { command: Terminal, file: FileText, symbol: Code, session: MessageSquare }

/**
 * #9 Tab 切类：activeType ref（null=全部）。Tab/Shift+Tab 循环切换四类 + 全部。
 * AH-S3：空查询（recents 态）下 Tab 切类仍生效——recents 分组恒显（kind='recent' 与 type_filtered 正交非互斥），其余按 activeType 过滤。
 */
const activeType = ref<SearchType | null>(null)

/**
 * section.kind → SearchType 映射（#9 activeType 过滤用；W1 i18n-frontend-p2 改为 kind-based computed）。
 *
 * 设计要点：
 *  - 不再用 s.label 做字符串匹配（避免 en-US 下 's.label === \'最近\'' 之类硬编码字面量回归——AH-S3 修复点）。
 *  - 改为 computed（虽然当前映射是静态常量，挂 computed 是为未来 locale-sensitive 派生预留响应性；
 *    当前等价于静态映射常量）。
 *  - 非四类 kind（'recent'/'suggested'/'shortcut'）无对应 SearchType → undefined，调用方据此跳过过滤。
 */
const kindToType = computed<Record<string, SearchType | undefined>>(() => ({
  command: 'command',
  file: 'file',
  symbol: 'symbol',
  session: 'session',
  recent: undefined,
  suggested: undefined,
  shortcut: undefined,
}))

// w1/w3 编排接线：useSearch 编排聚合 / useSearchJump 跳转分发（recents 持久化在 core 内部接线）
// activeSessionId 归一为 Ref<string|null>（props 可选 undefined → 统一 null，useSearch/useSearchJump 契约）
const activeSessionIdRef = computed(() => props.activeSessionId ?? null)
const { query: runQuery } = useSearch(activeSessionIdRef, props.deps)
const { confirm } = useSearchJump(props.deps)

const query = ref('')
const { query: externalQuery } = useSearchModal()

// 与外部 useSearchModal.query 双向同步：打开时预填搜索词，输入时同步回单例。
// 两个 watch 都加 !== 守卫保持对称，避免一方回写触发另一方形成死循环（W12）。
watch(() => externalQuery.value, (v) => {
  if (v !== query.value) query.value = v
}, { immediate: true })
watch(query, (v) => {
  if (v !== externalQuery.value) externalQuery.value = v
})
const selIdx = ref(0)
const resultsRef = ref<HTMLElement | null>(null)
/** 浮层根 div（替代 reka-ui Dialog 的 focus trap 容器；用于自管理 focus） */
const dialogRef = ref<HTMLElement | null>(null)
/** 输入框组件实例 ref（Input 是单根组件，$el 即根 <input>；用于 open 时自动 focus，替代 Dialog 默认聚焦首个可聚焦元素） */
const inputRef = ref<ComponentPublicInstance | null>(null)

/** useSearch.query 返回的分组（四类 Section[]，符号占位恒在） */
const remoteSections = ref<Awaited<ReturnType<typeof runQuery>>>([])

/** loading 态（AC-8.1 防闪烁：200ms 后才显，快速查询不闪烁） */
const loading = ref(false)
/** error 态（AC-8.5 transient：仅编排层意外异常时设置，新查询/close 时重置；单源失败由分组空态表达 AH-S2） */
const errorMsg = ref('')
let loadingTimer: ReturnType<typeof setTimeout> | undefined
/** debounce 120ms（AC-7.15，D-020） */
let debounceTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 拉取结果（编排归 useSearch.query；BC-9 loadSeq 守卫在 query 内部，此处不重复守卫 AH-C1）。
 * AC-8.1：开扫 200ms 后显 loading（防闪烁），finally 清 timer+loading。
 * T5.4 容错：query 抛错 catch（不崩，清 loading，分组维持旧值/空态）。
 */
async function loadResults(): Promise<void> {
  const q = query.value.trim()
  loadingTimer = setTimeout(() => { loading.value = true }, LOADING_DELAY_MS)
  try {
    remoteSections.value = await runQuery(q, { activeSessionId: props.activeSessionId ?? null })
  } catch (e) {
    // T5.4：编排层意外异常不崩（useSearch 内部 allSettled 已兜底单源错误，此处仅防未预期抛出）
    // 分组维持原值供用户换词重试，设 error 态让用户感知（AH-S2：意外异常才进全局 error）
    console.error('[SearchModal] loadResults 意外异常', e)
    errorMsg.value = t('search.errorHint')
  } finally {
    clearTimeout(loadingTimer)
    loading.value = false
  }
}

/** 当前可见分组（每项带跨组扁平 idx，供键盘导航） */
const sections = computed<{ label: string; items: IdxItem[] }[]>(() => {
  const raw = remoteSections.value
  // #9 AC-9.2：activeType 非空时只显所选类分组。
  // AH-S3：kind='recent' 分组恒显（recents 是跨类型最近项列表，与 type_filtered 正交非互斥）；
  // 其他非四类 kind（如 'suggested'）按 activeType 过滤（activeType 选中时它们无对应类被隐藏）。
  // W1：改用 kind-based 判定（不再比较 s.label 字面量，locale 切换不受影响）。
  const filtered = activeType.value
    ? raw.filter((s) => s.kind === 'recent' || kindToType.value[s.kind] === activeType.value)
    : raw
  let base = 0
  return filtered.map((s) => ({ label: s.label, items: s.items.map((it) => ({ ...it, idx: base++ })) }))
})
const flatItems = computed<IdxItem[]>(() => sections.value.flatMap((s) => s.items))
const total = computed(() => flatItems.value.length)

function onKeydown(e: KeyboardEvent) {
  // IME 组合输入中不拦截：拼音/日文候选导航的 Enter/Arrow 属输入法操作，非浮层导航——
  // 否则选中候选词会触发 confirmSel 跳转并关闭浮层（与表单 overlay/Composer 守卫一致）。
  if (e.isComposing) return
  // #9 AC-9.1：Tab/Shift+Tab 循环切类（先于 total 守卫，使空过滤态仍可继续切换出空类型）。
  if (e.key === 'Tab') {
    e.preventDefault()
    const types: (SearchType | null)[] = [null, 'command', 'file', 'symbol', 'session']
    const cur = types.indexOf(activeType.value)
    activeType.value = e.shiftKey
      ? types[(cur - 1 + types.length) % types.length]
      : types[(cur + 1) % types.length]
    selIdx.value = 0 // AH-B4：切类时 selIdx 重置（避免选中被过滤隐藏的项）
    return
  }
  if (total.value === 0) return
  if (e.key === 'ArrowDown') { e.preventDefault(); selIdx.value = (selIdx.value + 1) % total.value; scrollToSel() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selIdx.value = (selIdx.value - 1 + total.value) % total.value; scrollToSel() }
  else if (e.key === 'Enter') { e.preventDefault(); void confirmSel() }
}

/**
 * W1：替代 reka-ui Dialog 的全局 ESC 关闭（在 dialog div 上 keydown，冒泡到 content）。
 * reka-ui Dialog 默认全局监听 keydown.Escape，这里改为 div 内 keydown——只覆盖浮层打开时焦点在
 * 浮层内的情况（input 自然会冒泡到 dialog div）；input 内 Escape 用户体感一致。
 */
function onGlobalKeydown(e: KeyboardEvent) {
  // IME 组合输入中 Esc 用于取消候选词，不关浮层（同 onKeydown 守卫）
  if (e.isComposing) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('update:open', false)
  }
}

/** W1：替代 reka-ui Dialog 的 click-outside 关闭（遮罩 .self 触发，内容区 .stop 阻止冒泡） */
function onBackdropClick(): void {
  emit('update:open', false)
}

function scrollToSel() {
  nextTick(() => {
    const el = resultsRef.value?.querySelector(`[data-idx="${selIdx.value}"]`) as HTMLElement | null
    // #10.2 AC-10.2 / BC-7：scrollIntoViewIfNeeded 避免 spec 违规（scrollIntoView 会触发 OD 预览 iframe 滚动冲突）。
    // 非标准 API（Chrome/webview 支持，happy-dom/test 环境无），用 'in' 特性检测 + 类型断言，fallback 到 scrollIntoView。
    if (el && 'scrollIntoViewIfNeeded' in el) {
      ;(el as Element & { scrollIntoViewIfNeeded: (center?: boolean) => void }).scrollIntoViewIfNeeded(false)
    } else {
      el?.scrollIntoView({ block: 'nearest' })
    }
  })
}

/** 确认选中（AC-6.7 异常恢复：confirm {ok:true} 才关浮层，{ok:false} 保持打开 + toast） */
async function confirmSel(): Promise<void> {
  const cur = flatItems.value[selIdx.value]
  if (!cur) return
  // 显式字段搬运：confirm 只吃 SearchItem（IdxItem 的 idx 是渲染专用，不传）。
  // isSkill/location 必须一并搬运——漏传会让 skill 命令项在 useSearchJump 里读不到标记，
  // 静默退回命令 chip 通路（丢 SKILL.md 路径与多 skill 共存）。
  const { type, title, sub, icon, commandKind, isSkill, location } = cur
  const result = await confirm(
    { type, title, sub, icon, commandKind, isSkill, location },
    { activeSessionId: props.activeSessionId ?? null },
  )
  if (result.ok) {
    // file 跳转返 drawerTab:'detail'：打开 SideDrawer detail tab 让 DetailPane 挂载渲染文件内容。
    // （DetailPane 只在 activeTab==='detail' 时挂载；useSearchJump 编排层不直接调 drawer，由本组件接线
    //   props.onOpenDrawer——C-NT-3 拆除 useSideDrawer 依赖）
    if (result.drawerTab) props.onOpenDrawer(result.drawerTab)
    emit('update:open', false)
  } else {
    // C-W4-5：toast 经 props 注入（壳实现），confirm {ok:false} 保持浮层打开 + 通知用户
    props.onToastError(result.error)
  }
}

/** 查询变化 → debounce 120ms → 重置选中 + 拉新结果（AC-7.15） */
watch(query, () => {
  // MR-7.1 孤儿查询守卫：浮层关闭后 query 变化（close 分支置 ''）不得再调度 loadResults——
  // 否则 close 后 120ms 仍有幽灵加载，且其 finally 可能清掉重开后的 loadingTimer（S-3）。
  if (!props.open) return
  errorMsg.value = '' // AC-8.5：新查询清除上一次 error（transient）
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    selIdx.value = 0
    void loadResults()
  }, DEBOUNCE_MS)
})
/**
 * 打开/关闭切换（immediate 处理初始 open=true 挂载场景）：
 * - open=true：加载初始结果（recent + suggested）
 * - open=false：清查询 + 重置状态 + 清定时器（AC-7.14 资源清理，MR-7.1 孤儿查询守卫）
 */
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    void loadResults()
    // W1：open=true 时 nextTick 后 focus input（替代 reka-ui Dialog 默认聚焦首个可聚焦元素）。
    // Input 组件是单根组件（template 根为 <input>），ref 拿到 component instance，需用 $el 拿 DOM。
    nextTick(() => {
      // $el 为 Element（ComponentPublicInstance），instanceof + focus 函数检查做运行时守卫
      // （Input 根元素若换成非输入元素不崩）。Input 无 defineExpose → $el 恒为根 <input>，无 fallback 分支。
      const el = inputRef.value?.$el
      if (el instanceof HTMLElement && typeof el.focus === 'function') el.focus()
    })
  } else {
    query.value = ''
    selIdx.value = 0
    activeType.value = null // #9：close 重置切类（跨查询保持，但 close 时回全部）
    errorMsg.value = '' // AC-8.5：close 重置 error（transient，不持久跨查询）
    clearTimeout(debounceTimer)
    clearTimeout(loadingTimer)
    loading.value = false
  }
}, { immediate: true })

/** 组件卸载清理定时器（AC-8.4 资源清理） */
onUnmounted(() => {
  clearTimeout(debounceTimer)
  clearTimeout(loadingTimer)
})
</script>
