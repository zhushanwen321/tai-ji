import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Button } from "./Button.vue"

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-[background-color,color,border-color,transform] duration-[var(--duration-fast)] ease-[var(--ease)] active:scale-[0.97] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent),0_0_0_4px_rgba(0,0,0,0.4)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-fg hover:bg-accent-hover",
        secondary:
          "bg-transparent border border-border text-neutral-fg hover:bg-surface-hover",
        ghost: "hover:bg-surface-hover",
        danger: "text-danger hover:bg-danger-soft",
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
