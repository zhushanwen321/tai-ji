import plugin from 'tailwindcss/plugin'
import type { Config } from 'tailwindcss'
/**
 * xyz-agent 共享 Tailwind preset（v3 冷蓝暗色，ADR-0019）。
 *
 * 提取 renderer / mobile-renderer 两个 tailwind.config.ts 的逐字段相同块（colors 主体 /
 * fontFamily / borderRadius / boxShadow / .content-col plugin），单一 SSOT 防漂移；
 * 色值映射到 style.css 的 CSS 变量（SSOT: docs/DESIGN.md §4）。
 *
 * 约束（packages/shared 全局约束）：纯 JS 对象，零 IO、无 node 内置依赖——tailwind
 * config 只在构建期被 PostCSS 链加载，不进 runtime 产物。
 *
 * 包级差异（留在各 config 的 theme.extend，深合并叠加）：
 *  - renderer：colors['border-hairline'] / borderColor.hairline / taiji-spin animation
 *  - mobile-renderer：keyframes（SSOT 尚未迁 style.css）/ pulse-warn 等专属 animation
 *
 * 等价性守卫：两包 resolveConfig 结果须与提取前逐字段一致（提取时经
 * tailwindcss/resolveConfig 对比验证；后续改动跑同款对比或 diff 两包生成 CSS）。
 */
export default {
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'var(--bg)',
          elevated: 'var(--bg-elevated)',
          input: 'var(--bg-input)',
          card: 'var(--bg-card)', // v6 新增：设置分组卡片
        },
        surface: {
          DEFAULT: 'var(--surface)',
          hover: 'var(--surface-hover)',
          2: 'var(--surface-2)',
        },
        neutral: {
          fg: 'var(--neutral-fg)',
          mid: 'var(--neutral-mid)',
          dim: 'var(--neutral-dim)',
          faint: 'var(--neutral-faint)',
          ico: 'var(--neutral-ico)',
          'ico-hover': 'var(--neutral-ico-hover)',
        },
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          soft: 'var(--accent-soft)',
          ring: 'var(--accent-ring)', // inset 内描边（Card-Active/Input focus/SessionItem 激活）
          // v6 §3.5.1：accent 实色上的前景（深字 #1a1a1c）。与下方 foreground（shadcn 别名=neutral-fg，
          // 服务 ghost hover 蓝底）语义独立，accent 实色 badge/icon 前景必须用 fg 非 foreground。
          fg: 'var(--accent-fg)',
          foreground: 'var(--accent-foreground)', // shadcn text-accent-foreground
        },
        success: { DEFAULT: 'var(--success)', soft: 'var(--success-soft)' },
        warn: { DEFAULT: 'var(--warn)', soft: 'var(--warn-soft)' },
        danger: { DEFAULT: 'var(--danger)', soft: 'var(--danger-soft)' },
        info: { DEFAULT: 'var(--info)', soft: 'var(--info-soft)' },
        // reasoning 紫（draft-message-stream 思考块 / composer 思考等级专属色相）
        reasoning: { DEFAULT: 'var(--reasoning)', soft: 'var(--reasoning-soft)' },
        // ── diff 行/字符级背景（引用 style.css 新增 token，v6 §4.5 柔化 12%）──
        // 行背景中饱和(12%) + 字符级高饱和(45%)，双层亮度差锁定肉眼可辨。
        // 真值源在 style.css（--diff-* token），config 只做映射不重复定义色值。
        // canvas 用 bg-bg-input（暗 #17171a / 亮 #f1f3f6 自动跟随主题），色块叠加其上。
        diff: {
          'add-bg': 'var(--diff-add-bg)',
          'add-strong': 'var(--diff-add-strong)',
          'del-bg': 'var(--diff-del-bg)',
          'del-strong': 'var(--diff-del-strong)',
        },

        // ── shadcn-vue 命名空间（别名映射到 v3 值，不引入新色）──────────
        // 本地 components/ui（shadcn copy）依赖 shadcn 命名约定，补全 utility
        // 映射。同名冲突项维持 v3 语义不覆盖：
        //   • accent.DEFAULT = v3 主色蓝（shadcn hover 软底语义降级，ghost hover 蓝）
        //   • muted = v3 次级文字色（shadcn 背景色语义降级，bg-muted 仅用于 1px 分隔线，视觉正确）
        // 见 design-tokens.md「shadcn 命名映射」节。
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        'muted-foreground': 'var(--muted-foreground)',
        popover: { DEFAULT: 'var(--popover)', foreground: 'var(--popover-foreground)' },
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        input: 'var(--input)',
        ring: 'var(--ring)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['JetBrains Mono', 'IBM Plex Mono', 'ui-monospace', 'Menlo', 'monospace'],
      },
      borderRadius: {
        sm: '6px', // v6 升档（对应 --radius-sm）
        DEFAULT: '8px', // 按钮/卡片默认档（对应 --radius）
        md: '8px',
        lg: '12px', // 面板/弹层（对应 --radius-lg）
        card: '10px', // v6 新增：卡片容器（对应 --radius-card）
      },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)',
        glow: 'var(--shadow-glow)',
      },
    },
  },
  plugins: [
    // 对话流内容列布局原语 .content-col（收敛 mx-auto + w-full + max-w-[var(--content-max-w)]
    // 三件套，7 组件消费：Turn/Composer/AskUserOverlay/SystemNotice/BashOutputBlock/
    // ForkNotice/WidgetArea）。宽度数值 SSOT 仍是 style.css 的 --content-max-w
    // token，本 plugin 只生成「居中 + 封顶」布局类；display/gap 等由使用处 Tailwind 工具类
    // 叠加。不满足 check_css_tokens 白名单「Tailwind 无法表达」判据，故不落 style.css，
    // 经 Tailwind plugin 生成为正统 utility（两包 config 共享，同步维护压力消除）。
    plugin(({ addUtilities }) => {
      addUtilities({
        '.content-col': {
          'margin-inline': 'auto',
          width: '100%',
          'max-width': 'var(--content-max-w)',
        },
      })
    }),
  ],
} satisfies Partial<Config>
