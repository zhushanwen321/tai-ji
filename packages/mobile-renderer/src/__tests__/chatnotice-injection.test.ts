// [chatNotice i18n 移动壳接线] 注入行为单测：bootstrap 模块加载期注入后，core 提示行
// 键出口（chatNoticeText）在移动壳解析为译文而非键名回退。
//
// 背景：桌面壳经 useMessageEffects 模块顶层 configureChatNoticeText 注入，移动壳
// bootstrap 缺同一注入 → core 回退键名原文（notice-text.ts「注入时序」段：键名直出 =
// 缺注入的显式信号），双壳行为分叉。本测试锁移动壳装配：import '../bootstrap'（模块
// 加载触发注入）后，ChatNoticeKey 闭集全键可解析；另锁 @taiji/ui locale 下沉域双侧
// 词典完备（zh/en 任一侧缺 key 会静默落 fallback 文案，双壳单源下移动壳无独立机器
// 检查覆盖此点）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/chatnotice-injection.test.ts
import { describe, expect, it } from 'vitest'
import { chatNoticeText } from '@taiji/core'
import { zhCN, enUS } from '@taiji/ui/locale'
import { i18n } from '../i18n'
import '../bootstrap'

// ChatNoticeKey 闭集（core notice-text.ts，三成员）：类型无运行时枚举，字面登记——
// core 侧增键时此处与 useMessageEffects 注入同裸奔，靠 renderer 壳 locale-key-usage-guard
// 的闭集扫描与 ui locale 结构测试补位（双壳共享同一注入键空间）。
const CHAT_NOTICE_KEYS = ['stoppedBeforeStart', 'truncatedMaxTokens', 'truncatedContentFilter'] as const

const t = i18n.global.t as (key: string) => string

describe('chatNotice i18n 移动壳注入（bootstrap 模块加载期）', () => {
  it('chatNoticeText 全键解析为译文，非键名回退（注入缺失的显式信号）', () => {
    for (const key of CHAT_NOTICE_KEYS) {
      const resolved = chatNoticeText(key)
      expect(resolved).not.toBe(`panel.message.chatNotice.${key}`)
      expect(resolved.trim()).not.toBe('')
    }
  })

  it('解析值与移动壳 i18n 实例逐键一致（注入闭包走本壳 t，非透传键名）', () => {
    for (const key of CHAT_NOTICE_KEYS) {
      expect(chatNoticeText(key)).toBe(t('panel.message.chatNotice.' + key))
    }
  })

  it('ui locale 下沉域双侧词典完备：zh-CN / en-US 各含三键非空文案', () => {
    const zh = (zhCN as { panel: { message: { chatNotice: Record<string, string> } } }).panel.message.chatNotice
    const en = (enUS as { panel: { message: { chatNotice: Record<string, string> } } }).panel.message.chatNotice
    for (const key of CHAT_NOTICE_KEYS) {
      expect(zh[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
    }
  })
})
