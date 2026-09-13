// bootstrap.ts —— mobile 壳 bootstrap 编排（IF3，pre-P1 最小序列）。
//
// 三步编排：
//   1. providePlatform(createMobilePlatformAdapter()) —— 注入 mobile 平台端口到 core
//   2. MOBILE_MOUNT_POINTS.forEach(registerMountPoint) —— 注册 §6.3 mobile 三挂载点
//   3. createApp(App).use(createPinia()).mount('#app') —— 挂载四 zone 布局
//
// pre-P1 形态：不调 core/src/bootstrap.ts（它编排 transport/coordination/session
// restore，依赖 P1 完整能力 + 真实连接；mobile D2 远程 deferred 不具备条件）。
// 壳侧自编最小序列满足 W2 AC5（platform 注入链路 + 挂载点注册 + App 挂载）。
//
// TODO(P1): P1 transport 迁入 core 且 mobile D2 远程落地后，本壳 bootstrap 对接
// core bootstrap() 的 transport/coordination 序列（initConnection → restoreSessions）。
//
// 设计依据：renderer-package-topology.md §6.3/§9/§11.0.3、slice plan IF3。

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { providePlatform } from '@xyz-agent/core'
import App from './App.vue'
import { createMobilePlatformAdapter } from './platform/mobile-platform-adapter'
import { MOBILE_MOUNT_POINTS, registerMountPoint } from './shell/mount-points'

// bootstrap —— mobile 壳启动编排。
// async 签名为 P1 transport init（异步）预留；当前实现同步完成三步。
export async function bootstrap(): Promise<void> {
  // 1. 注入 mobile 平台端口（core PlatformPort 单例）。
  providePlatform(createMobilePlatformAdapter())

  // 2. 注册 §6.3 mobile B+D 子集三挂载点（pre-P4 本地 registrar）。
  MOBILE_MOUNT_POINTS.forEach((name) => registerMountPoint(name, {}))

  // 3. 挂载 App（四 zone 布局）。
  createApp(App).use(createPinia()).mount('#app')
}
