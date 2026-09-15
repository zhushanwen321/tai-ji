import type { Config } from 'tailwindcss'
import sharedPreset from '@taiji/shared/tailwind-preset'

/**
 * taiji Tailwind 配置 · v3 冷蓝暗色（ADR-0019）。
 * colors 主体 / fontFamily / borderRadius / boxShadow / .content-col plugin 经
 * @taiji/shared/tailwind-preset 共享（与 renderer 单一 SSOT，防两包漂移；
 * 等价性守卫见 preset 文件头注释）。本文件只落 mobile-renderer 专属差异：
 *  - keyframes SSOT 尚未迁移 style.css 全局（renderer 已迁，见其 config 注释；迁移后此块可删）
 *  - pulse-warn / steer-breathe / working-pulse / wiggle 等专属 animation
 */
export default {
  presets: [sharedPreset],
  content: ['./src/**/*.{vue,ts,tsx}', '../ui/src/**/*.{vue,ts}'],
  darkMode: 'class',
  theme: {
    extend: {
      // 状态点脉冲（SessionItem / SessionCard 共享，running=accent / waiting=warn）。
      // 原两组件各自 scoped 定义同一份 keyframes，收敛到 SSOT 避免漂移。
      keyframes: {
        'pulse-accent': {
          '0%': { 'box-shadow': '0 0 0 0 rgba(79, 142, 247, 0.5)' },
          '70%': { 'box-shadow': '0 0 0 5px rgba(79, 142, 247, 0)' },
          '100%': { 'box-shadow': '0 0 0 0 rgba(79, 142, 247, 0)' },
        },
        // 注意：rgba 值对应暗色 --warn (#b08a3e)。亮色 --warn (#8a6a2e) 下 pulse 环会有色相差，
        // 已知限制——keyframe 无法读运行时 CSS 变量，需后续用 CSS @property 或独立动画方案解决。
        'pulse-warn': {
          '0%': { 'box-shadow': '0 0 0 0 rgba(176, 138, 62, 0.5)' },
          '70%': { 'box-shadow': '0 0 0 5px rgba(176, 138, 62, 0)' },
          '100%': { 'box-shadow': '0 0 0 0 rgba(176, 138, 62, 0)' },
        },
        // Composer S6 流式态呼吸 ring（steer 提交引导）
        'steer-breathe': {
          '0%, 100%': { 'box-shadow': '0 0 0 3px rgba(79, 142, 247, 0.22)' },
          '50%': { 'box-shadow': '0 0 0 4px rgba(79, 142, 247, 0.40)' },
        },
        // message-stream working-dot 脉冲（turn-meta working 态，draft .working-dot）
        'working-pulse': {
          '0%, 100%': { opacity: '1', 'box-shadow': '0 0 0 0 rgba(79, 142, 247, 0.4)' },
          '50%': { opacity: '0.55', 'box-shadow': '0 0 0 5px rgba(79, 142, 247, 0)' },
        },
        // 流式光标闪烁（turn-summary / trace-tool streaming）
        blink: {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        },
        // message-stream trace 块 running 态双环 loader（Demo H，普通 tool/subagent/workflow 共用）。
        // 1.4s 线性旋转，prefers-reduced-motion 由 style.css 全局 @media reduce 兜底。
        'loader-spin': {
          to: { transform: 'rotate(360deg)' },
        },
        // session status icons（方案 C 优化版 v3）
        wiggle: {
          '0%, 100%': { transform: 'rotate(-6deg)' },
          '50%': { transform: 'rotate(6deg)' },
        },
        'pulse-strong': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.65', transform: 'scale(0.92)' },
        },
        // ask-user inline overlay 入场（覆盖 composer 位置时滑入，对齐 demo v2 slideUp）
        'ask-user-slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        // ForkNotice 反馈行入场（spec §3：从 -4px translateY 淡入，200ms ease）
        'notice-in': {
          from: { opacity: '0', transform: 'translateY(-4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'pulse-accent': 'pulse-accent 2s var(--ease) infinite',
        'pulse-warn': 'pulse-warn 2s var(--ease) infinite',
        'steer-breathe': 'steer-breathe 2.6s ease-in-out infinite',
        'working-pulse': 'working-pulse 1.4s ease-in-out infinite',
        blink: 'blink 1s step-end infinite',
        'loader-spin': 'loader-spin 1.4s linear infinite',
        'ask-user-slide-up': 'ask-user-slide-up var(--duration-slow) var(--ease)',
        wiggle: 'wiggle 1.2s ease-in-out infinite',
        'pulse-strong': 'pulse-strong 1.4s ease-in-out infinite',
        'notice-in': 'notice-in 200ms var(--ease)',
      },
    },
  },
} satisfies Config
