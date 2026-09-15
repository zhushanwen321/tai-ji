import type { VariantProps } from 'class-variance-authority'
import { cva } from 'class-variance-authority'

// variants 定义独立成文件（R2 S-1）：Button.vue 与本目录 barrel 都从此处导入，
// 避免 Button.vue ↔ index.ts 目录 barrel 自引用环（barrel 再导出 Button.vue，
// Button.vue 又 from '.' 取 variants 会闭合环）。原导出位置经 index.ts
// `export *` 保持不变，外部消费方 import 路径零变化。
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-fg hover:bg-accent-hover',
        secondary:
          'bg-transparent border border-border text-neutral-fg hover:bg-surface-hover',
        ghost: 'hover:bg-surface-hover',
        danger: 'text-danger hover:bg-danger-soft',
      },
      size: {
        default: 'h-9 px-4 py-2',
        dense: 'h-8 px-3',
        sm: 'h-9 rounded-md px-3',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export type ButtonVariants = VariantProps<typeof buttonVariants>
