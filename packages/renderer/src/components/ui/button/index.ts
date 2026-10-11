import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Button } from "./Button.vue"

export const buttonVariants = cva(
  // 图标默认尺寸 = :where() 整体零特异性（生成 `:where(.cls svg)`，特异性 0,0,0）：
  // 使用方在 svg 上写的任何普通尺寸类（size-[17px] 等，0,1,0）结构性恒赢，禁止再退回
  // [&_svg]:size-4 式后代选择器（0,1,1）——它会压制单点尺寸类，逼使用方散布 ! important。
  // size-4 字面保留 rem 缩放语义（未显式指定尺寸的图标仍随根字号 1rem）。
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-[background-color,color,border-color,transform] duration-[var(--duration-fast)] ease-[var(--ease)] active:scale-[0.97] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent),0_0_0_4px_rgba(0,0,0,0.4)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [:where(&_svg)]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-fg hover:bg-accent-hover",
        secondary:
          "bg-transparent border border-border text-neutral-fg hover:bg-surface-hover",
        ghost: "hover:bg-surface-hover",
        danger: "text-danger hover:bg-danger-soft",
        // 危险实底钮（demo pages.css .btn.danger-solid：--danger 底 + --danger-fg 字 + hover
        // brightness 1.1）；消费方 = ConfirmDialog 危险确认分支等需要重钮权重的危险动作
        "danger-solid":
          "bg-danger text-[color:var(--danger-fg)] hover:brightness-110",
      },
      size: {
        "default": "h-9 px-4 py-2",
        "dense": "h-8 px-3",
        "sm": "h-9 rounded-md px-3",
        "icon": "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export type ButtonVariants = VariantProps<typeof buttonVariants>
