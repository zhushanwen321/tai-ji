/**
 * SystemNotice.vue 组件测试（U2b 定向气泡渲染 + [system-notice-rendering-upgrade U3] 增强规格）。
 *
 * 覆盖：
 * - subagent-directive custom message（reload 形态：role system + customType + details +
 *   display:true）→ 渲染「→ @slug：text」定向气泡 DOM（左对齐轻量样式，testid 锚定）
 * - parseSubagentDirective 返回 null（details 畸形）→ 不渲染定向气泡，降级兜底 system 行
 *   （消息不静默消失——「渲染过滤不丢消息」规则 9）
 * - respawn 提示条分支派发与降级（[u8-pi-respawn]）
 * - [U3] background-bash 结构化行三分支：details 命中（natural / timeout）/ parse null 兜底原文
 * - [U3] D3 增强规格：两端渐隐横线 / 主文案与 mono 主体分档 / meta 钉右拆段（tokens 从文案拆出）
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/SystemNotice.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

// mock vue-i18n 的 useI18n：自包含 t（UI 包的 vitest.setup mock 只回 key，本文件需断言真实文案
// 形态——tokens 拆段 / 「后台」chip / 「已超时」复用键，口径同 Turn.test.ts 的 RC-2 i18n provide）
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const msgs: Record<string, string> = {
        'panel.message.compacted': '已压缩上下文',
        'panel.message.compactedTokens': '{tokens} tokens',
        'panel.message.branchCreated': '已创建分支（自 {from}）',
        'panel.message.branchCreatedNoFrom': '已创建分支',
        'panel.message.bashBackgroundChip': '后台',
        'panel.message.bashTimeout': '已超时',
        'panel.message.respawnRestored': '会话引擎已从崩溃中恢复。',
        'panel.message.respawnFailed': '引擎恢复失败，点此重试或新建会话',
        'panel.message.respawnFailedHint': '多次自动恢复未成功',
        'panel.message.respawnRetry': '重试恢复',
      }
      let s = msgs[key] ?? key
      if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v))
      return s
    },
  }),
}))

import { mount } from '@vue/test-utils'
import { SystemNotice } from '@taiji/ui'
import { PI_RESPAWN_NOTICE_CUSTOM_TYPE } from '@taiji/shared'
import type { Message } from '@taiji/shared'

const NOW = Date.now()

/** D3 渐隐横线（两端各一条，transparent → --border-strong 18% → 82% → transparent） */
const LINE_GRADIENT_CLASS =
  'bg-[image:linear-gradient(to_right,transparent,var(--border-strong)_18%,var(--border-strong)_82%,transparent)]'

/** 构造 reload 形态的 subagent-directive Message（mapSessionEntries 覆写 display:true 后的投影） */
function directiveMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'cm-1',
    role: 'system',
    customType: 'subagent-directive',
    content: '刚才的测试结果再展开讲讲',
    details: { subagentId: 'rec-1', slug: 'build-api', direction: 'user' },
    display: true,
    status: 'complete',
    timestamp: NOW,
    ...over,
  } as Message
}

describe('SystemNotice subagent 定向气泡（U2b）', () => {
  it('subagent-directive 消息 → 渲染「@slug：text」定向气泡 DOM（slug 高亮 + 正文可见）', () => {
    const wrapper = mount(SystemNotice, { props: { message: directiveMessage() } })
    const bubble = wrapper.find('[data-testid="subagent-directive-bubble"]')
    expect(bubble.exists()).toBe(true)
    // slug 高亮（accent 色 mono）+ 文本正文都在用户可见 DOM 中
    const slug = bubble.find('[data-testid="subagent-directive-slug"]')
    expect(slug.text()).toBe('@build-api')
    expect(slug.classes()).toContain('text-accent')
    expect(bubble.text()).toContain('刚才的测试结果再展开讲讲')
    // 定向气泡形态区别于普通 system 行（无居中两侧横线结构）
    expect(wrapper.find('.system-notice').exists()).toBe(false)
  })

  it('details 畸形（parseSubagentDirective null）→ 不渲染定向气泡，降级兜底 system 行', () => {
    const wrapper = mount(SystemNotice, {
      props: {
        message: directiveMessage({ details: { subagentId: 123 }, content: '畸形留痕' }),
      },
    })
    expect(wrapper.find('[data-testid="subagent-directive-bubble"]').exists()).toBe(false)
    // 兜底 system 行仍可见（消息不静默消失）：居中行 + content 文本
    const fallback = wrapper.find('.system-notice')
    expect(fallback.exists()).toBe(true)
    expect(fallback.text()).toContain('畸形留痕')
  })

  it('content 空串（防御场景：parse 契约「content 非 string 时 text 归空串」的合法对应态）→ 气泡仍渲染，携带 @slug 去向', () => {
    const wrapper = mount(SystemNotice, {
      props: { message: directiveMessage({ content: '' }) },
    })
    const bubble = wrapper.find('[data-testid="subagent-directive-bubble"]')
    expect(bubble.exists()).toBe(true)
    expect(bubble.find('[data-testid="subagent-directive-slug"]').text()).toBe('@build-api')
  })

  it('compactionSummary 消息 → 现有 system 行形态（回归，不进定向分支）', () => {
    const wrapper = mount(SystemNotice, {
      props: {
        message: {
          id: 'sys-1',
          role: 'system',
          content: '',
          status: 'complete',
          timestamp: NOW,
          compactionSummary: { summary: '已压缩', tokensBefore: 1000 },
        } as Message,
      },
    })
    expect(wrapper.find('[data-testid="subagent-directive-bubble"]').exists()).toBe(false)
    expect(wrapper.find('.system-notice').exists()).toBe(true)
  })
})

// ── respawn 提示条分支（[u8-pi-respawn]，D7）──────────────
//
// SystemNotice 的 v-else-if respawn 渲染分支：customType = pi-respawn-notice 且
// parseRespawnNoticeVariant(details) 可解析 → 渲染 RespawnNoticeBar（restored = T4
// 文案 / restoreFailed = 失败态 + 重试按钮，retry 事件透传壳层）；解析失败（variant
// 非法 / details 非 object）→ respawn 为 null → 降级兜底 system 行（消息不静默消失，
// subagent 定向气泡同款降级语义）。RespawnNoticeBar 本体细节由同目录
// RespawnNoticeBar.test.ts 覆盖，此处锁定 SystemNotice 的分支派发与降级契约。

/**
 * 构造 reload 形态的 pi-respawn-notice Message（chat store appendRespawnNotice 投影）。
 * details 放宽为 unknown：畸形载荷用例（降级分支）刻意构造契约外形态。
 */
function respawnMessage(over: Omit<Partial<Message>, 'details'> & { details?: unknown } = {}): Message {
  return {
    id: 'respawn-1',
    role: 'system',
    customType: PI_RESPAWN_NOTICE_CUSTOM_TYPE,
    content: '',
    details: { variant: 'restored' },
    display: true,
    status: 'complete',
    timestamp: NOW,
    ...over,
  } as Message
}

describe('SystemNotice respawn 提示条分支（u8-pi-respawn）', () => {
  it('pi-respawn-notice 消息（variant=restored）→ 渲染 RespawnNoticeBar，不走兜底 system 行', () => {
    const wrapper = mount(SystemNotice, { props: { message: respawnMessage() } })
    const bar = wrapper.find('[data-testid="respawn-notice-bar-slot"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('data-variant')).toBe('restored')
    // 恢复成功无重试按钮（手动出口仅 restoreFailed 形态）
    expect(wrapper.find('[data-testid="respawn-notice-retry"]').exists()).toBe(false)
    // 分支互斥：兜底 system 行与定向气泡均不渲染
    expect(wrapper.find('.system-notice').exists()).toBe(false)
    expect(wrapper.find('[data-testid="subagent-directive-bubble"]').exists()).toBe(false)
  })

  it('variant=restoreFailed → 失败态提示条 + 重试按钮可见，点击透传 respawnRetry（壳层接 session.restore）', async () => {
    const wrapper = mount(SystemNotice, {
      props: { message: respawnMessage({ details: { variant: 'restoreFailed' } }) },
    })
    const bar = wrapper.find('[data-testid="respawn-notice-bar-slot"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('data-variant')).toBe('restoreFailed')
    const btn = wrapper.find('[data-testid="respawn-notice-retry"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('respawnRetry')).toHaveLength(1)
  })

  it('variant 非法（details.variant 未知值）→ 降级兜底 system 行不抛错（消息不静默消失）', () => {
    const wrapper = mount(SystemNotice, {
      props: { message: respawnMessage({ details: { variant: 'bogus' }, content: '降级留痕' }) },
    })
    expect(wrapper.find('[data-testid="respawn-notice-bar-slot"]').exists()).toBe(false)
    const fallback = wrapper.find('.system-notice')
    expect(fallback.exists()).toBe(true)
    expect(fallback.text()).toContain('降级留痕')
  })

  it('details 非 object（损坏载荷）→ 同款降级兜底 system 行，不抛错', () => {
    const wrapper = mount(SystemNotice, {
      props: { message: respawnMessage({ details: 'corrupted', content: '损坏留痕' }) },
    })
    expect(wrapper.find('[data-testid="respawn-notice-bar-slot"]').exists()).toBe(false)
    const fallback = wrapper.find('.system-notice')
    expect(fallback.exists()).toBe(true)
    expect(fallback.text()).toContain('损坏留痕')
  })
})

// ── background-bash 结构化行（[system-notice-rendering-upgrade U3]，D1/D2）──────
//
// 生产端（base-tool-enhance notify.ts）在 sendMessage 附 details（taskId / command /
// durationMs / endReason / exitCode），消费侧经 shared `parseBackgroundBashDetails`
// 单点防御解析：命中 → 结构化行（命令 mono 主体 + 「后台」chip + exit/耗时钉右 meta）；
// 解析 null（旧 session 无 details / 畸形载荷）→ 兜底原文行（Archive + content 原文，
// 逐字节回到现状——content 给 LLM 接力的语义不受渲染形态影响）。

/** 构造 reload 形态的 background-bash Message（details 可覆盖为畸形/缺失形态） */
function bashMessage(over: Omit<Partial<Message>, 'details'> & { details?: unknown } = {}): Message {
  return {
    id: 'bb-1',
    role: 'system',
    customType: 'background-bash',
    content: '[background-bash] bt-3 finished (exit 0, 3m12s): pnpm test --workspace extensions',
    details: {
      taskId: 'bt-3',
      command: 'pnpm test --workspace extensions',
      durationMs: 192_000,
      endReason: 'natural',
      exitCode: 0,
    },
    display: true,
    status: 'complete',
    timestamp: NOW,
    ...over,
  } as Message
}

describe('SystemNotice background-bash 结构化行（U3 / D2）', () => {
  it('details 命中（natural / exit 0）→ 结构化行：SquareTerminal 图标 + 命令 mono 主体 + 「后台」chip + exit 0 · 耗时绿 meta；协议头不上屏', () => {
    const wrapper = mount(SystemNotice, { props: { message: bashMessage() } })
    const row = wrapper.find('.system-notice')
    expect(row.exists()).toBe(true)
    // 图标语义：SquareTerminal（accent，D2）+ 13px/stroke 2.2（D3）
    const icon = row.find('svg')
    expect(icon.classes()).toContain('lucide-square-terminal')
    expect(icon.classes()).toContain('size-[13px]')
    expect(icon.classes()).toContain('text-accent')
    expect(icon.attributes('stroke-width')).toBe('2.2')
    // 命令 = mono 主体（details.command，非 content 原文）
    const body = row.find('[data-testid="system-notice-text"]')
    expect(body.text()).toBe('pnpm test --workspace extensions')
    expect(body.classes()).toContain('font-mono')
    // 「后台」chip
    expect(row.find('[data-testid="system-notice-chip"]').text()).toBe('后台')
    // 钉右 meta：exit 0 · 3m12s（秒级精度同 content 原文口径；成功绿）
    const meta = row.find('[data-testid="system-notice-meta"]')
    expect(meta.text()).toBe('exit 0 · 3m12s')
    expect(meta.classes()).toContain('text-success')
    // content 是写给 LLM 的协议原文，不再上屏
    expect(row.text()).not.toContain('[background-bash]')
  })

  it('exit ≠ 0（natural）→ 同结构行，meta 换 warn 色（语义色只随 exit 结果走）', () => {
    const wrapper = mount(SystemNotice, {
      props: {
        message: bashMessage({
          details: { taskId: 'bt-4', command: 'pnpm vitest run', durationMs: 5000, endReason: 'natural', exitCode: 1 },
        }),
      },
    })
    const meta = wrapper.find('[data-testid="system-notice-meta"]')
    expect(meta.text()).toBe('exit 1 · 5s')
    expect(meta.classes()).toContain('text-warn')
    expect(wrapper.find('[data-testid="system-notice-chip"]').text()).toBe('后台')
  })

  it('endReason=timeout → meta「已超时」（复用 bashTimeout 键，warn 色，不显 exit 段）', () => {
    const wrapper = mount(SystemNotice, {
      props: {
        message: bashMessage({
          details: { taskId: 'bt-9', command: 'sleep 999', durationMs: 600_000, endReason: 'timeout', exitCode: null },
        }),
      },
    })
    const meta = wrapper.find('[data-testid="system-notice-meta"]')
    expect(meta.text()).toBe('已超时')
    expect(meta.classes()).toContain('text-warn')
    expect(meta.text()).not.toContain('exit')
  })

  it('解析 null（旧数据无 details）→ 兜底原文行逐字节回到现状（Archive 图标 + content 原文，无 chip / meta）', () => {
    const wrapper = mount(SystemNotice, { props: { message: bashMessage({ details: undefined }) } })
    const row = wrapper.find('.system-notice')
    expect(row.find('svg').classes()).toContain('lucide-archive')
    expect(row.find('[data-testid="system-notice-text"]').text()).toBe(
      '[background-bash] bt-3 finished (exit 0, 3m12s): pnpm test --workspace extensions',
    )
    expect(row.find('[data-testid="system-notice-chip"]').exists()).toBe(false)
    expect(row.find('[data-testid="system-notice-meta"]').exists()).toBe(false)
  })

  it('details 畸形（缺 command 必需字段）→ 同款兜底原文行，不抛错', () => {
    const wrapper = mount(SystemNotice, {
      props: {
        message: bashMessage({ details: { taskId: 'bt-3', durationMs: 192_000, endReason: 'natural' } }),
      },
    })
    const row = wrapper.find('.system-notice')
    expect(row.find('[data-testid="system-notice-chip"]').exists()).toBe(false)
    expect(row.find('[data-testid="system-notice-text"]').text()).toContain('[background-bash]')
    expect(row.find('svg').classes()).toContain('lucide-archive')
  })
})

// ── D3 增强规格（横线分隔行族）────────────────────────────────────────────
//
// 用户裁决的增强版（demo §1 对照定稿）：① 横线 hairline → border-strong(0.13) 两端渐隐；
// ② 主文案 text-xs/mid/400 → text-sm/fg/550；③ 图标 13px/stroke 2.2；④ meta 钉右
// （mono text-2xs/500/tabular-nums/dim）；⑤ 行距 py-1 → py-1.5。不动项：静态无交互
// （通知族二分判据）、content-col 宽度、animate-notice-in 动效、居中三段 flex 结构。
// 规格行同步修订落 DESIGN.md（U4 同 commit）。

describe('SystemNotice D3 增强规格（U3）', () => {
  /** 压缩完成行 fixture（tokens 拆段断言的主场景） */
  function compactionMessage(tokensBefore?: number): Message {
    return {
      id: 'sys-c',
      role: 'system',
      content: '',
      status: 'complete',
      timestamp: NOW,
      compactionSummary: tokensBefore === undefined ? { summary: '已压缩' } : { summary: '已压缩', tokensBefore },
    } as Message
  }

  it('横线：两端各一条 h-px flex-1，background-image 为 border-strong 18%/82% 渐隐（族规格升级）', () => {
    const wrapper = mount(SystemNotice, { props: { message: compactionMessage(1000) } })
    const lines = wrapper.findAll(`.system-notice span.h-px`)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line.classes()).toContain('flex-1')
      expect(line.classes()).toContain(LINE_GRADIENT_CLASS)
    }
  })

  it('主文案：text-sm + 550 字重 + fg 提色；行距 py-1.5；动效与内容列宽度不动', () => {
    const wrapper = mount(SystemNotice, { props: { message: compactionMessage(1000) } })
    const row = wrapper.find('.system-notice')
    expect(row.classes()).toContain('py-1.5')
    expect(row.classes()).toContain('animate-notice-in')
    expect(row.classes()).toContain('content-col')
    const text = row.find('[data-testid="system-notice-text"]')
    expect(text.classes()).toEqual(
      expect.arrayContaining(['text-[length:var(--text-sm)]', 'font-[550]', 'text-neutral-fg']),
    )
  })

  it('压缩完成：tokens 从主文案拆出为钉右 meta（mono 2xs/500/tabular-nums/dim），主文案只剩短语', () => {
    const wrapper = mount(SystemNotice, { props: { message: compactionMessage(237_186) } })
    const text = wrapper.find('[data-testid="system-notice-text"]')
    const meta = wrapper.find('[data-testid="system-notice-meta"]')
    expect(text.text()).toBe('已压缩上下文')
    expect(meta.text()).toBe('237.2K tokens')
    expect(meta.classes()).toEqual(
      expect.arrayContaining([
        'shrink-0',
        'font-mono',
        'text-[length:var(--text-2xs)]',
        'font-medium',
        'tabular-nums',
        'text-neutral-dim',
      ]),
    )
    // 钉右语义：meta 与主文案并列（不是内嵌文案），且不被截断（shrink-0）
    expect(text.element.nextElementSibling).toBe(meta.element)
  })

  it('压缩完成无 tokensBefore（字段缺失）→ 只渲染主文案，meta 整段不渲染（不留空占位）', () => {
    const wrapper = mount(SystemNotice, { props: { message: compactionMessage() } })
    expect(wrapper.find('[data-testid="system-notice-text"]').text()).toBe('已压缩上下文')
    expect(wrapper.find('[data-testid="system-notice-meta"]').exists()).toBe(false)
  })

  it('branchSummary 行同族同规格（分支提示无 meta，主文案走 D3 档）', () => {
    const wrapper = mount(SystemNotice, {
      props: {
        message: {
          id: 'sys-b',
          role: 'system',
          content: '',
          status: 'complete',
          timestamp: NOW,
          branchSummary: { fromId: 'msg-7' },
        } as Message,
      },
    })
    const row = wrapper.find('.system-notice')
    expect(row.find('svg').classes()).toContain('lucide-git-branch')
    expect(row.find('[data-testid="system-notice-text"]').text()).toBe('已创建分支（自 msg-7）')
    expect(row.find('[data-testid="system-notice-text"]').classes()).toContain('text-[length:var(--text-sm)]')
    expect(row.find('[data-testid="system-notice-meta"]').exists()).toBe(false)
  })
})
