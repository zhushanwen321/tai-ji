/**
 * tray 测试共享的 ViewHost 响应式 mock 数据源（composer-tray / tray-widget 两文件逐字重复收敛于此）。
 *
 * 同构壳层桥（shallowReactive 外层分区 Map + reactive 内层分区 Map）：外层 reactive 保证
 * 「分区后建」也触发重算（computed 首次求值短路的经典 stale 陷阱），内层 reactive 保证
 * set/delete/keys 迭代被追踪——与生产桥的依赖面一致。分区键（sessionId）由调用方注入，
 * push / invalidate 作用于该分区。
 */
import { reactive, shallowReactive } from 'vue'
import type { GuiComponent, WidgetMeta } from '@zhushanwen/extension-protocol'
import type { ViewCacheEntry, ViewHostSource } from '@taiji/ui/extension-host'

/** 固定 updatedAt（组件不消费，仅满足 ViewCacheEntry 形状；无需 fake timers） */
const UPDATED_AT = 1_760_000_000_000

export interface MockWidgetSource {
  source: ViewHostSource
  /** 推送/更新一条 widget entry（= event-adapter → ViewHostStore.setView） */
  push: (entry: ViewCacheEntry) => void
  /** 清屏一条 widget（= setWidget(key, undefined) → invalidate） */
  invalidate: (viewId: string) => void
}

/** 一行 ansi-text 正文（面板 body 的最小可用 payload） */
export function ansiLine(text: string): GuiComponent {
  return { type: 'ansi-text', props: { lines: [text] } }
}

export function makeEntry(viewId: string, guiTree: GuiComponent[], meta?: WidgetMeta): ViewCacheEntry {
  return { viewId, pluginId: 'ext-x', guiTree, updatedAt: UPDATED_AT, ...(meta ? { meta } : {}) }
}

export function makeWidgetSource(sessionId: string): MockWidgetSource {
  const partitions = shallowReactive(new Map<string, Map<string, ViewCacheEntry>>())

  function partitionOf(sid: string): Map<string, ViewCacheEntry> | undefined {
    return partitions.get(sid)
  }

  return {
    source: {
      getViewIds: (sid) => {
        const partition = partitionOf(sid)
        return partition ? [...partition.keys()] : []
      },
      getView: (sid, viewId) => partitionOf(sid)?.get(viewId),
    },
    push: (entry) => {
      let partition = partitionOf(sessionId)
      if (!partition) {
        partition = reactive(new Map<string, ViewCacheEntry>())
        partitions.set(sessionId, partition)
      }
      partition.set(entry.viewId, entry)
    },
    invalidate: (viewId) => {
      partitionOf(sessionId)?.delete(viewId)
    },
  }
}
