/**
 * desktop-platform.ts —— 桌面壳平台端口注入（bootstrap 时序修复，2026-08-04）。
 *
 * [HISTORICAL] 连接死锁事故：providePlatform 原只在 AppShell setup（useSettingsShell ①）
 * 调用，但 AppShell 仅在 connectionState==='connected' 后才渲染（App.vue v-if）——
 * core ws-client.connect 第一步 getPlatform()（fail-fast）需要 platform，而 platform
 * 注入依赖连接成功 → 死锁：renderer 永远停在「连接中…」过渡屏，runtime 侧零连接日志。
 *
 * 对齐架构 §11.0.3 bootstrap 时序 + mobile-renderer bootstrap.ts 模式（P5 壳接线缺口
 * 的运行时实化）：platform 注入必须发生在连接编排（useConnection.init，App onMounted）
 * 之前。桌面壳在 main.ts createApp 前调用本函数，AppShell 的 useSettingsShell 保留
 * 原注入（providePlatform 幂等，core 模块级单例覆盖，重复调用无害——settings 域壳
 * 接入顺序不变，HMR 场景也安全）。
 */
import { providePlatform } from '@taiji/core'
import type { WebSocketLike } from '@taiji/core/platform/port'
import { LocalStorageAdapter } from '@/composables/shell/local-storage-adapter'

/** 注入桌面平台端口：LocalStorageAdapter（KVStorage）+ wsFactory（原生 WebSocket）。 */
export function provideDesktopPlatform(): void {
  providePlatform({
    kind: 'electron',
    storage: new LocalStorageAdapter(),
    webSocket: {
      // native WebSocket 是 platform 的具体 WS 实现；WebSocketLike 为抽象端口，此处声明接口满足。
      create: (url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike,
    },
  })
}
