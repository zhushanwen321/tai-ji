// mobile 壳 vue-i18n 装配（remote-use D10 bootstrap 行：ui 组件内部 useI18n() 依赖
// app 级 i18n 装配，移动壳新增依赖）。locale 来源 = ui locale 模块域文件级下沉
// （与桌面 renderer 聚合同源，无壳层文案副本——单源裁决）。
//
// 与桌面 i18n 的差异：移动壳无 settings store / localStorage 偏好链，语言检测用
// navigator.language 简单映射（zh* → zh-CN，其余 → en-US，默认 zh-CN）；双侧 messages
// 静态注册（仅文案 key，体积可忽略——桌面懒加载是为 13 域全量，移动壳无此量级）。
import { createI18n } from 'vue-i18n'
import type { DefaultLocaleMessageSchema } from 'vue-i18n'
import { enUS, zhCN } from '@taiji/ui/locale'
import mobileZh from './locales/zh-CN'
import mobileEn from './locales/en-US'

export type MobileLocale = 'zh-CN' | 'en-US'

/** navigator.language 简单映射：zh 前缀 → zh-CN，其余 → en-US；解析异常默认 zh-CN */
function detectLocale(): MobileLocale {
  try {
    return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
  } catch {
    return 'zh-CN'
  }
}

// 显式泛型对齐 renderer i18n 形态：默认推断会把 locale 窄化为字面量，setLocale 写路径需 cast。
// messages = ui locale 下沉域（common/panel/... 单源）+ mobile 壳自有 key（mobile 命名空间）。
export const i18n = createI18n<[DefaultLocaleMessageSchema], string, false>({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': { ...zhCN, ...mobileZh },
    'en-US': { ...enUS, ...mobileEn },
  },
})
