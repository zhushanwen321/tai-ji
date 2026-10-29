<script setup lang="ts">
/**
 * ViewHost（W3 · T3，C4 契约，S4 IF6 + clarify Q3 修订 + U2 scope 归属）——plugin view 宿主。
 *
 * 消费 ViewHostStore（经注入 ViewHostSource）的 per viewId per-scope GuiComponent 树缓存，
 * 交 ui/src/rendering-protocol/ GuiComponentRenderer 渲染。
 *
 * 归属 prop 为 scope 联合（provider-plugin-access U2 分区键泛化）：{ kind: 'session',
 * sessionId } 会话域（panel.header / scheduler 卡片等会话内挂载点）/ { kind: 'global',
 * mountId, pluginId } 全局域（Provider 页授权挂载位等无会话位置，分区键含插件维度）。
 *
 * 空态语义（IF1）：store 无 view 时按 empty prop 分流——'placeholder'（默认）渲染标题
 * + 等待提示；'hidden'（挂载点用）整组件零 DOM，不占布局空间。
 *
 * 自举补拉（ADR-0097 事件边沿拉）：挂载时分区无内容且 source 可用 → 按当前 (scope,
 * viewId) 过滤拉取插件 UI 快照——transient 推送帧丢失（不入 ring、无重放）后的组件级
 * 收敛通道；拉回写 store → computed view 响应式切换出 placeholder。幂等读无节流
 *（重复挂载重复拉取无害）。
 *
 * 数据源经 inject 注入（VIEW_HOST_SOURCE_KEY），壳 provide 真实实现，单测
 * global.provide mock；无注入时静默空态不崩（design-review R3）。
 */
import { computed, inject, onMounted, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PluginViewScope } from '@taiji/shared'
import { VIEW_HOST_SOURCE_KEY } from './view-host-source'
import { VIEW_SCOPE_SESSION_KEY } from '../rendering-protocol/container-navigation-key'
import GuiComponentRenderer from '../rendering-protocol/GuiComponentRenderer.vue'

const props = withDefaults(
  defineProps<{
    /** plugin view id（挂载点路由键） */
    viewId: string
    /** 视图归属（U2 scope 联合）：会话域 { kind:'session', sessionId } / 全局域 { kind:'global', mountId, pluginId } */
    scope: PluginViewScope
    /** view 标题（空态占位展示）；缺省 fallback view-id */
    title?: string
    /** 空态行为：'placeholder' 渲染占位（默认）｜'hidden' 无 view 时整组件零 DOM（挂载点用） */
    empty?: 'placeholder' | 'hidden'
  }>(),
  { title: undefined, empty: 'placeholder' },
)

const { t } = useI18n()
const source = inject(VIEW_HOST_SOURCE_KEY, null)

// 容器导航的会话注入第一档（§6.4）：把组件树所属视图的会话 provide 给树内交互原语
// （action-bar / list-tree 点击透传给导航执行器）；global scope 无会话 → undefined，
// 执行器回退焦点会话（第二档）。provide 值是纯值非 ref——scope prop 挂载后不变。
provide(VIEW_SCOPE_SESSION_KEY, props.scope.kind === 'session' ? props.scope.sessionId : undefined)

/** 当前 scope + viewId 的 GuiComponent 树缓存条目（无则 undefined → 空态）。
 *  会话域走既有三法（托盘同源读路径），全局域走 scope 联合法（壳未提供时 undefined → 空态）。 */
const view = computed(() => {
  if (props.scope.kind === 'session') {
    return source?.getView(props.scope.sessionId, props.viewId)
  }
  return source?.getViewInScope?.(props.scope, props.viewId)
})

const emptyTitle = computed(() => props.title ?? props.viewId)

// 分区缺失自举补拉：仅 placeholder 态有意义（hidden 挂载点无内容本属常态，不拉）
onMounted(() => {
  if (props.empty !== 'placeholder') return
  if (view.value !== undefined) return
  if (props.scope.kind === 'session') {
    source?.refreshView?.(props.scope.sessionId, props.viewId)
    return
  }
  source?.refreshViewInScope?.(props.scope, props.viewId)
})
</script>

<template>
  <template v-if="view">
    <div data-testid="view-host" class="flex min-h-0 flex-1 flex-col">
      <GuiComponentRenderer
        v-for="(component, i) in view.guiTree"
        :key="i"
        :component="component"
      />
    </div>
  </template>
  <div
    v-else-if="empty === 'placeholder'"
    data-testid="view-host"
    class="flex min-h-0 flex-1 flex-col"
  >
    <div
      data-testid="view-host-empty"
      class="flex flex-col items-center justify-center gap-1 py-10 text-sm"
    >
      <span class="font-medium text-foreground">{{ emptyTitle }}</span>
      <span class="text-muted-foreground">{{ t('common.loading') }}</span>
    </div>
  </div>
</template>
