/**
 * view-host-store.ts —— ViewHostStore（IF10 + clarify Q1 + U2 分区键泛化）。
 *
 * plugin view 的 GuiComponent 树缓存：per viewId + per-scope 双键分区（createSessionScopedMap，
 * 分区键 = scope 串，形态 SSOT = shared plugin-view-scope：会话域 `session:<sessionId>` /
 * 全局域 `global:<mountId>:<pluginId>`——后者插件维度并入键，双插件同挂载位互不覆盖 S25）。
 * s2 阶段数据源为 extension-widget 事件（widget:lines 纯文本 / widgetGui:gui 结构化 GuiComponent），
 * s3 的 plugin:viewUpdate 广播到达后同走此事件（经 MessageBusBridge → extension-widget；
 * U2 起事件携带 sessionId / mountId 二选一，消费端按 scope 形态落分区）。
 *
 * 窄化规则（clarify Q1 裁决——types.ts WidgetPayload.guiTree 保持 unknown[]，bridge 生产形状
 * 是 wire 真值不改动）：
 * - isGuiComponent 校验通过 → 直存 GuiComponent[]
 * - string 行（widget:lines 纯文本）→ 包装为 { type: 'ansi-text', props: { lines: [行] } }
 *   （与 P2 GuiComponentRenderer 的 AnsiText 降级语义一致）
 * - null（widgetGui gui:null 清除语义）→ invalidate 该 viewId（清缓存条目）
 *
 * 契约（IF10 + U2）：getView / setView / invalidate(scope, viewId?)，invalidate 无 viewId
 * 清空该 scope 全部 view（plugin 重载/崩溃时）；session-destroyed → 会话域分区 cleanup（ERR4）。
 * GuiComponent 类型从 @zhushanwen/extension-protocol import（P2 同源）。
 */
import { isGuiComponent } from '@zhushanwen/extension-protocol'
import type { GuiComponent, WidgetMeta } from '@zhushanwen/extension-protocol'
import type { PluginViewScope } from '@taiji/shared'
import { pluginViewScopeKey } from '@taiji/shared'
import type { InternalEventBus } from './internal-event-bus'
import type { SessionScopedMap } from './utils/session-scoped-map'
import type { WidgetPayload } from './types'

/** view 缓存条目（IF10 契约）。meta 为 widget 宿主元数据（托盘 widget 区 head/badge 渲染），可选。
 *  generation 为全量替换代际（U2，plugin:viewUpdate 源携带；extension:widget 纯文本源无）。 */
export interface ViewCacheEntry {
  viewId: string
  pluginId: string
  guiTree: GuiComponent[]
  meta?: WidgetMeta
  generation?: number
  updatedAt: number
}

export interface ViewHostStoreDeps {
  bus: InternalEventBus
  /** 分区值类型：viewId → ViewCacheEntry（per-scope 分区，键 = scope 串） */
  sessionScoped: SessionScopedMap<Map<string, ViewCacheEntry>>
}

export class ViewHostStore {
  private unsubscribe: (() => void)[] = []

  constructor(private deps: ViewHostStoreDeps) {}

  /** 订阅 extension-widget（更新 view 树）+ session-destroyed（cleanup）。返回取消订阅函数。 */
  subscribe(): () => void {
    if (this.unsubscribe.length > 0) return this.dispose.bind(this)
    this.unsubscribe.push(this.deps.bus.on('extension-widget', (e) => {
      this.consumeWidget(e.sessionId, e.mountId, e.widget)
    }))
    this.unsubscribe.push(this.deps.bus.on('session-destroyed', (e) => {
      this.deps.sessionScoped.cleanup(pluginViewScopeKey({ kind: 'session', sessionId: e.sessionId }))
    }))
    return this.dispose.bind(this)
  }

  getView(scope: PluginViewScope, viewId: string): ViewCacheEntry | undefined {
    return this.deps.sessionScoped.get(pluginViewScopeKey(scope))?.get(viewId)
  }

  /**
   * 列出该 scope 当前有缓存内容的全部 viewId（widget 消费端动态发现用）。
   *
   * **顺序契约 = 当前插入序**：实现为 `[...partition.keys()]`，即内部 Map 的迭代序（Map 迭代序 =
   * 插入序，ECMAScript 规范语义；renderer 侧 reactive 包装不改迭代序）——**invalidate 后重新注册
   * 的 key 落尾部**，不回原位（是「当前插入序」而非「首次出现序」）。消费端（renderer 托盘 widget 区：
   * known-order `['todo','goal']` 优先 + 其余 key 按本数组序追加）直接消费该序：有 entry 即出现、
   * invalidate 即消失。**勿新增自增 seq 字段**重建同一派生态——赋值时机引入顺序依赖，且每次重推
   * 换 seq 会让未知 key 起伏抖动（比 Map 原地保位更差），见 docs/design/composer-task-tray.md §3.3 D6（已删除，git 可追溯）。
   */
  getViewIds(scope: PluginViewScope): string[] {
    const partition = this.deps.sessionScoped.get(pluginViewScopeKey(scope))
    return partition ? [...partition.keys()] : []
  }

  private listeners = new Set<() => void>()
  /** 注册 view 缓存变化监听（renderer 响应式粘合：bump version 触发 computed 重算）。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private notifyListeners(): void {
    for (const fn of this.listeners) fn()
  }

  setView(scope: PluginViewScope, viewId: string, entry: ViewCacheEntry): void {
    this.deps.sessionScoped.update(pluginViewScopeKey(scope), (partition) => {
      partition.set(viewId, entry)
    })
  }

  /** 清缓存：无 viewId 清空该 scope 全部 view（plugin 重载/崩溃时，IF10 契约）。 */
  invalidate(scope: PluginViewScope, viewId?: string): void {
    if (viewId === undefined) {
      this.deps.sessionScoped.cleanup(pluginViewScopeKey(scope))
      return
    }
    this.deps.sessionScoped.update(pluginViewScopeKey(scope), (partition) => {
      partition.delete(viewId)
    })
  }

  /**
   * extension-widget 事件消费：窄化 widget.guiTree 后按 scope 形态落分区（U2 形态分流，
   * 替换旧 `sessionId === undefined` 早退）。
   * - sessionId 有值 → 会话域（extension:widget / 会话域 viewUpdate 恒带会话）；
   * - 否则 mountId 有值 → 全局域，分区键并入 widget.pluginId（S25 多插件隔离维度，
   *   pluginId 来自帧数据——runtime 广播侧已按通道身份落值）；
   * - 两字段皆无（wire 坏形状）→ 丢弃 + warn 留痕（bridge 侧已有 parse 检查，此处防御）。
   */
  private consumeWidget(sessionId: string | undefined, mountId: string | undefined, widget: WidgetPayload): void {
    let scope: PluginViewScope
    if (sessionId !== undefined) {
      scope = { kind: 'session', sessionId }
    } else if (mountId !== undefined) {
      scope = { kind: 'global', mountId, pluginId: widget.pluginId }
    } else {
      console.warn(`[view-host-store] view "${widget.viewId}" 缺归属（sessionId/mountId 二选一）已丢弃`)
      return
    }
    // gui:null 清除语义：guiTree=[null] → invalidate 该 viewId（clarify Q1）
    if (widget.guiTree.length === 1 && widget.guiTree[0] === null) {
      this.invalidate(scope, widget.viewId)
      this.notifyListeners()
      return
    }
    const guiTree = this.narrowGuiTree(widget.guiTree, widget.viewId)
    const meta = this.narrowMeta(widget.meta)
    this.setView(scope, widget.viewId, {
      viewId: widget.viewId,
      pluginId: widget.pluginId,
      guiTree,
      ...(meta !== undefined ? { meta } : {}),
      ...(widget.generation !== undefined ? { generation: widget.generation } : {}),
      updatedAt: Date.now(),
    })
    this.notifyListeners()
  }

  /** 窄化 unknown → WidgetMeta：title 是 string 即认（最小形状校验，progress/status
   *  深度字段由消费端（托盘 widget 区）按可选处理，脏数据不崩）。非法形状丢弃（undefined）。 */
  private narrowMeta(raw: unknown): WidgetMeta | undefined {
    if (raw === null || typeof raw !== 'object') return undefined
    const obj = raw as Record<string, unknown>
    return typeof obj.title === 'string' ? (raw as WidgetMeta) : undefined
  }

  /**
   * 窄化 unknown[] → GuiComponent[]：isGuiComponent 直存；string 行包装 ansi-text（clarify Q1）；
   * 其余形状（非法对象等）丢弃不阻断其余项，console.warn 留痕（viewId + 位置 + 实际形状，
   * STANDARDS §11.2 静默丢弃必须登记）供 extension 作者定位坏数据。
   */
  private narrowGuiTree(raw: unknown[], viewId: string): GuiComponent[] {
    const result: GuiComponent[] = []
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i]
      if (isGuiComponent(item)) {
        result.push(item)
      } else if (typeof item === 'string') {
        result.push({ type: 'ansi-text', props: { lines: [item] } })
      } else {
        const shape = Array.isArray(item) ? 'array' : typeof item
        console.warn(`[view-host-store] view "${viewId}" guiTree[${i}] 非法形状已丢弃（期待 GuiComponent 对象或 string 行，收到 ${shape}）；其余合法项已保留`)
      }
    }
    return result
  }

  /** 取消全部订阅（幂等）。 */
  dispose(): void {
    for (const unsub of this.unsubscribe) unsub()
    this.unsubscribe = []
    this.listeners.clear()
  }
}
