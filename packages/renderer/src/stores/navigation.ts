/**
 * Navigation store —— 导航历史栈（D1：状态驱动路由，无 vue-router）。
 *
 * 模式参考 main worktree navigation.ts：entries[] + pointer + back/forward +
 * 分支截断（splice pointer+1）+ MAX_ENTRIES=50 上限（超限丢最早）。
 * 扩展：加 'overview' 第三 view（chat/overview/settings）。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 * 骨架阶段：state/getter 合法初始值，action throw。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { NavEntry } from '@/types'

/** 历史栈容量上限（D1） */
const MAX_ENTRIES = 50

export const useNavigationStore = defineStore('navigation', () => {
  const entries = ref<NavEntry[]>([])
  const pointer = ref(-1)

  /** 空栈时返回合法默认 entry（view:'chat'，无 sessionId），消费方无需判空 */
  const current = computed<NavEntry>(
    () => (pointer.value >= 0 && pointer.value < entries.value.length)
      ? entries.value[pointer.value]
      : { view: 'chat' },
  )

  const canBack = computed(() => pointer.value > 0)
  const canForward = computed(() => pointer.value < entries.value.length - 1)

  /**
   * 入栈：pointer+1 之后的 entry 全丢弃（分支截断），push 新 entry；
   * 超 MAX_ENTRIES 丢最早（push 一次最多超 1 个，单次 shift 即可）。
   */
  function push(entry: NavEntry): void {
    if (pointer.value < entries.value.length - 1) {
      entries.value.splice(pointer.value + 1)
    }
    entries.value.push(entry)
    if (entries.value.length > MAX_ENTRIES) {
      entries.value.shift()
    }
    pointer.value = entries.value.length - 1
  }

  function back(): void {
    if (pointer.value > 0) pointer.value -= 1
  }

  function forward(): void {
    if (pointer.value < entries.value.length - 1) pointer.value += 1
  }

  return { entries, pointer, current, canBack, canForward, push, back, forward }
})
