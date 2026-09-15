/**
 * resolve-platform —— platform 装配分叉的唯一收敛点（D2 R2 修正）。
 *
 * 分叉原有两处（main.ts 早期注入 + useSettingsShell bootstrapSettingsCore 兜底段），
 * 收敛为本函数：VITE_MOCK 构建期常量三元（mock=createMockPlatform / 桌面=
 * provideDesktopPlatform——mock 分支的 webSocket.create 返回 mock 桩，否则
 * connect('mock://') 会因原生 WebSocket 不支持 mock scheme 抛错），模块级 memoized
 * ——createMockPlatform 每次调用产新实例，缓存保证全进程单一 platform 实例。
 *
 * 消费方：main.ts 早期注入（App.vue setup 期 settings init 防线，见 main.ts [HISTORICAL] 注释）
 * + App.vue onMounted bootstrap 首步参数（providePlatform 幂等纯赋值，双注入共存无害）。
 *
 * 独立模块（不放 main.ts 内 export）：App.vue 从 main.ts 取值会形成循环 import，且把
 * main.ts 的 createApp/bridge 装配/mount 副作用拉进每个 import App 的测试环境。
 */
import { providePlatform, getPlatform, type PlatformPort } from '@taiji/core/platform/port'
import { createMockPlatform } from '@taiji/core/transport/mock/mock-ws'
import { provideDesktopPlatform } from './desktop-platform'

let cached: PlatformPort | undefined

/** 解析（并在首次调用时注入）平台端口。memoized：后续调用返回同一实例。 */
export function resolvePlatform(): PlatformPort {
  if (!cached) {
    if (import.meta.env.VITE_MOCK === 'true') {
      providePlatform(createMockPlatform())
    } else {
      provideDesktopPlatform()
    }
    cached = getPlatform()
  }
  return cached
}
