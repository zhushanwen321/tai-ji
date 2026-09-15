import type { Config } from 'tailwindcss'
import sharedPreset from '@taiji/shared/tailwind-preset'

/**
 * taiji Tailwind 配置 · v3 冷蓝暗色（ADR-0019）。
 * colors 主体 / fontFamily / borderRadius / boxShadow / .content-col plugin 经
 * @taiji/shared/tailwind-preset 共享（与 mobile-renderer 单一 SSOT，防两包漂移；
 * 等价性守卫见 preset 文件头注释）。本文件只落 renderer 专属差异：
 *  - colors['border-hairline']（v6 §4.3 hairline 0.05 弱分隔语义色映射）
 *  - borderColor.hairline（生成 .border-hairline 工具类，见下方 [HISTORICAL] 注释）
 *  - taiji-spin 品牌 animation
 * shadcn-vue 装机会在此基础上扩展，此处只落 design-tokens 对齐项。
 */
export default {
  presets: [sharedPreset],
  content: ['./src/**/*.{vue,ts,tsx}', '../ui/src/**/*.{vue,ts}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // v6 §4.3：hairline 0.05 弱分隔色映射（settings wave followup「hairline 语义类补映射」）
        'border-hairline': 'var(--hairline)',
      },
      // [HISTORICAL] 修复潜伏配置 bug：colors 键 'border-hairline' 生成的工具类是
      // border-border-hairline（无人使用），而代码里 10 处 border-hairline 用法从未
      // 生成过规则——一直静默落到 preflight 灰 200 兜底。borderColor.hairline 才能产出
      // .border-hairline（v6 §4.3 hairline 0.05 弱分隔语义类，2026-08-21 由 trace 左侧
      // 轨道竖线暴露并修复；既有用法边框由灰 200 回归 0.05 弱分隔的设计本意）。
      borderColor: {
        hairline: 'var(--hairline)',
      },
      // keyframes SSOT 已迁移至 style.css 全局（v6 §5.9：只在全局定义一次；
      // pulse-accent 改用 CSS 变量派生，跟随主题，不再硬编码 rgba）。
      // 此处仅保留 animation 简写，引用全局 @keyframes 名。
      animation: {
        'pulse-accent': 'pulse-accent 2s var(--ease) infinite',
        // [chat-flow-polish] sidebar running/waiting badge 呼吸（复用全局 pulse-dot keyframes）
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
        blink: 'blink 1s step-end infinite',
        'loader-spin': 'loader-spin 1.4s linear infinite',
        'ask-user-slide-up': 'ask-user-slide-up var(--duration-slow) var(--ease)',
        'pulse-strong': 'pulse-strong 1.4s ease-in-out infinite',
        'notice-in': 'notice-in 200ms var(--ease)',
        // 品牌旋转（太极「周而复始」）：静态简写注册供 JIT 生成；TaijiLogo 用 inline
        // animation-duration 覆盖时长（default 8s，可传 prop）。motion-reduce:animate-none
        // 在 class 层覆盖 animation 简写（name 置 none），inline duration 不影响 name。
        'taiji-spin': 'taiji-spin 8s linear infinite',
      },
    },
  },
} satisfies Config
