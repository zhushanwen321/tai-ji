import { ref, onBeforeUnmount, type Ref } from 'vue'

/**
 * IME 组合态标记（对齐 contenteditable.ts composing 范式）：浮层自身无输入元素、
 * 组合发生在 composer 输入区，故 compositionstart/end 监听挂 window capture，
 * 才能在 capture 消费 keydown 前感知组合起止。
 * 部分引擎存在 isComposing=false + keyCode 229 先于 compositionend 的乱序面，
 * 需与 KeyboardEvent.isComposing 属性双保险。
 */
export function useCompositionFlag(): { composing: Ref<boolean> } {
  const composing = ref(false)

  if (typeof window !== 'undefined') {
    const onCompositionStart = (): void => {
      composing.value = true
    }
    const onCompositionEnd = (): void => {
      composing.value = false
    }
    window.addEventListener('compositionstart', onCompositionStart, true)
    window.addEventListener('compositionend', onCompositionEnd, true)
    onBeforeUnmount(() => {
      window.removeEventListener('compositionstart', onCompositionStart, true)
      window.removeEventListener('compositionend', onCompositionEnd, true)
    })
  }

  return { composing }
}
