/**
 * 清空 toast 模块级队列（测试用）。
 *
 * 承载一条易忘的时序知识：toast 队列是模块级单例，fake timers 下自动移除不触发——测试
 * 必须显式清，否则上一个用例的残留会串味到下一个用例且失败原因隐晦。
 */
import { useToast } from '@/composables/useToast'

export function clearToasts(): void {
  const { toasts, remove } = useToast()
  for (const toast of [...toasts.value]) remove(toast.id)
}
