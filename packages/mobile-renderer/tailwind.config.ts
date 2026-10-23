import type { Config } from 'tailwindcss'
import sharedPreset from '@taiji/shared/tailwind-preset'

/**
 * taiji Tailwind 配置 · v3 冷蓝暗色（ADR-0019）。
 * colors 主体 / fontFamily / borderRadius / boxShadow / .content-col plugin 经
 * @taiji/shared/tailwind-preset 共享（与 renderer 单一 SSOT，防两包漂移；
 * 等价性检查见 preset 文件头注释）。本文件只落 mobile-renderer 专属差异：
 *  - 动画 keyframes 注册（mobile 壳样式入口 tokens.css 不含全局 keyframes 段，
 *    不走桌面 style.css 的 keyframes SSOT；消费方经 animate-* 类引用）
 */
export default {
  presets: [sharedPreset],
  content: ['./src/**/*.{vue,ts,tsx}', '../ui/src/**/*.{vue,ts}'],
  darkMode: 'class',
  theme: {
    extend: {
      keyframes: {
        // 流式光标闪烁（turn-summary / trace-tool streaming）
        blink: {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        },
        // message-stream trace 块 running 态呼吸弧 loader（Demo H，普通 tool/subagent/workflow 共用）。
        // 本包 animation 值 = 1.4s 线性旋转，prefers-reduced-motion 由 style.css 全局 @media reduce 兜底。
        'loader-spin': {
          to: { transform: 'rotate(360deg)' },
        },
        // ForkNotice 反馈行入场（spec §3：从 -4px translateY 淡入，200ms ease）
        'notice-in': {
          from: { opacity: '0', transform: 'translateY(-4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        blink: 'blink 1s step-end infinite',
        'loader-spin': 'loader-spin 1.4s linear infinite',
        'notice-in': 'notice-in 200ms var(--ease)',
      },
    },
  },
} satisfies Config
