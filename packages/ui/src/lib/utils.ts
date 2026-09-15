/**
 * ui 包 cn 工具（shadcn-vue 原语依赖）。
 *
 * 从 renderer src/lib/utils.ts 原样迁入（w6 chat-ui-and-shell T2 shadcn 原语迁移前置）。
 * 原语组件用 cn() 合并 tailwind class（class-variance-authority + clsx + tailwind-merge）。
 */
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
