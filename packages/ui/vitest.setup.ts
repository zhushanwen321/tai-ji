/**
 * ui 包 vitest 全局 setup（w6 chat-ui-and-shell）。
 *
 * mock vue-i18n 的 useI18n，让 ui 组件测试中 `const { t } = useI18n()` 正常工作
 * （测试环境无 app.use(i18n)）。
 *
 * t() 默认返回 key（AC1 冒烟不断言中文文案，断言 DOM 结构）。
 * 命名参数 / 复数：按 renderer vitest-i18n-setup 简化模式处理 {key} 替换与 | 复数。
 * 若迁移的行为测试需断言中文文案，在测试内 override vi.mock('vue-i18n') 增强。
 */
import { vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  createI18n: () => ({ global: { t: (k: string) => k } }),
  useI18n: () => ({
    t: (key: string, ...rest: unknown[]) => {
      // 复数形式：t(key, plural, options) — 含 | 的 message 按 count 选段
      let result: string = key
      if (typeof rest[0] === 'number') {
        const count = rest[0]
        const opts = rest[1] as { named?: Record<string, unknown> } | undefined
        const named = opts?.named
        if (typeof result === 'string' && result.includes('|')) {
          const segments = result.split('|').map((s) => s.trim())
          result = count === 1 ? segments[0] : segments[1] ?? segments[0]
        }
        if (named) {
          for (const [k, v] of Object.entries(named)) {
            result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
          }
        }
      } else if (rest[0] && typeof rest[0] === 'object') {
        // 命名参数：t(key, named)
        const named = rest[0] as Record<string, unknown>
        let replaced = false
        for (const [k, v] of Object.entries(named)) {
          const before = result
          result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
          if (result !== before) replaced = true
        }
        // 无 {占位符} 替换时（mock key 不含占位符），append 非空命名值，
        // 模拟 {count} 等参数渲染（供 badge count 类断言 toContain('5')）。
        if (!replaced) {
          const vals = Object.values(named)
            .filter((v) => v !== undefined && v !== null && v !== '')
            .map(String)
          if (vals.length) result = `${result} ${vals.join(' ')}`
        }
      }
      return result
    },
    locale: { value: 'zh-CN' },
    tExists: (_k: string) => true,
  }),
}))
