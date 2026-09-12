/**
 * Vitest 全局 setup —— mock vue-i18n 的 useI18n，让组件测试中
 * `const { t } = useI18n()` 正常工作（测试环境无 app.use(i18n)）。
 *
 * t() 从 zh-CN locale 递归取值，这样现有测试断言中文文案无需改。
 * createI18n / i18n 实例保留原样，不影响 settings-i18n.test.ts。
 */
import { vi } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'

// __APP_VERSION__ 是 vite define 注入的全局常量（renderer/vite.config.ts），
// vitest 环境无 vite define 故缺失。统一在此 stub，避免每个使用该常量的组件测试
// 都要手动 vi.stubGlobal（Sidebar / SystemPage / UpdateButton 等）。
vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

function resolveFromLocale(key: string): string {
  const parts = key.split('.')
  let obj: unknown = zhCN
  for (const p of parts) {
    if (obj == null || typeof obj !== 'object') return key
    obj = (obj as Record<string, unknown>)[p]
  }
  // mock 需对齐 message compiler 的字面量转义语义：生产路径经 @intlify 编译 {'@'} 渲染为字面量 @，
  // 本 mock 原样返回会把 {'@'} 带进断言文本（f47ed9dee 引入该转义后组件测试断言失败），故返回前还原。
  return typeof obj === 'string' ? obj.replace(/\{\s*'@'\s*\}/g, '@') : key
}

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      // vue-i18n v10 t 复数/命名参数签名（vue-i18n.d.ts:1189/1334）：
      //   t(key, plural, options: TranslateOptions)  ← options.named 是命名参数
      //   t(key, named: NamedValue)
      //   t(key, named, plural)
      // mock 兼容：含 | 的 message 按 count 选段（1→首段，否则次段）；
      // 命名参数从 options.named 或直接 named 取，{key} 全局替换。
      t: (key: string, ...rest: unknown[]) => {
        let result: unknown = resolveFromLocale(key)
        let named: Record<string, unknown> | undefined
        let count: number | undefined
        // 形式1：t(key, plural, options) — options.named 存命名参数
        if (typeof rest[0] === 'number') {
          count = rest[0]
          const opts = rest[1] as { named?: Record<string, unknown> } | undefined
          named = opts?.named
        } else if (rest[0] && typeof rest[0] === 'object') {
          const first = rest[0] as Record<string, unknown>
          // 形式2：t(key, named) — first 直接是命名参数对象
          if ('named' in first && first.named && typeof first.named === 'object') {
            named = first.named as Record<string, unknown>
          } else {
            named = first
          }
        }
        // vue-i18n 复数：含 | 的 message 按 count 选段（count===1 首段，否则次段）
        if (typeof result === 'string' && result.includes('|') && count !== undefined) {
          const parts = result.split('|')
          result = (count === 1 ? parts[0] : (parts[1] ?? parts[0])).trim()
        }
        // 命名参数 {key} 全局替换
        if (named && typeof result === 'string') {
          for (const [k, v] of Object.entries(named)) {
            result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
          }
        }
        return result
      },
      locale: { value: 'zh-CN' },
    }),
  }
})

/**
 * [w5] 全局 providePlatform（mock 平台端口）。
 *
 * new-task-search 域壳接线后，useCommandStore 壳单例 / useSearchModalDeps 在组件 setup
 * 即调 getPlatform()（fail-fast）。测试环境无 AppShell 的 useSettingsShell providePlatform，
 * 故在全局 setup 注入 mock platform（InMemoryStorage + fake WS），避免每个受影响测试
 * 重复 provide。幂等：个别测试自行 providePlatform/__resetPlatformForTesting 覆盖本注入
 * （settings/ws-client/spike 先例不受影响——spike 的 fail-fast 断言在 reset 后仍成立）。
 */
import { providePlatform } from '@xyz-agent/core'

providePlatform({
  kind: 'mock',
  storage: {
    get: async () => null,
    set: async () => {},
    remove: async () => {},
  },
  webSocket: {
    create: () => ({
      readyState: 0,
      send: () => {},
      close: () => {},
      onopen: null,
      onclose: null,
      onmessage: null,
      onerror: null,
    }),
  },
  ipc: null,
})
