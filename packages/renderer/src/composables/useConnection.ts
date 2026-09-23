/**
 * useConnection —— 连接生命周期编排（装配点，架构审计 §10.2 D-1）。
 *
 * 主体逻辑已迁 @taiji/core/transport/use-connection.ts（core headless：
 * 零 DOM / 零 import.meta / 零 store import，DOM 经 visibility 端口、env 经端口、
 * store 副作用经 useMessageEffects 注入）。本文件只做三件事：
 *
 * 1. 构建 ConnectionPorts 实现（从 renderer 取 ipc / visibility / env / t /
 *    useMessageEffects——D3 后 pending/events/subscribe 三件套已删，core 直连
 *    transport/api 真实模块，壳不再注入）
 * 2. setConnectionPorts 注入（模块级一次，幂等）
 * 3. useConnection() = core useConnection() 薄包装（App.vue 的
 *    { state, init, teardown, retryRuntime } 接口不变）
 *
 * 依赖方向：useConnection（装配）→ core use-connection + lib/ipc + useMessageEffects
 *   + i18n。
 */
import {
  useConnection as useCoreConnection,
  setConnectionPorts,
  type ConnectionPorts,
} from '@taiji/core'
import i18n from '@/i18n'
import {
  getRuntimePort,
  getRuntimePortOffset,
  getRuntimeStartError,
  getRuntimeToken,
  onRuntimePort,
  onRuntimeError,
  onRuntimeRestarting,
  onRuntimeFailed,
  restartRuntime,
} from '../lib/ipc'
import { createInboundEffects, handleRuntimeUnavailable } from './effects/useMessageEffects'
// i18n.global.t 的类型窄化 cast：vue-i18n 的 t 是复杂重载签名，ConnectionPorts.t 只需
// `(key, params?) => string`。cast 保持调用方用法不变（t('connection.runtimeExited', { reason })）。
const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

/**
 * 装配点：构建 core ConnectionPorts 实现（模块级一次构建，引用全部稳定：
 * ipc 模块级函数、effects 工厂返回稳定函数引用）。
 */
const connectionPorts: ConnectionPorts = {
  ipc: {
    getRuntimePort,
    getRuntimePortOffset,
    getRuntimeToken,
    onRuntimePort: (cb) => onRuntimePort(cb),
    onRuntimeRestarting: (cb) => onRuntimeRestarting(cb),
    onRuntimeFailed: (cb) => onRuntimeFailed(cb),
    // RD-3#2：启动失败真因消费（core 编排负责置 failed 短路徒劳重连；真因显示/落台账
    // 在壳层 App.vue 经 lib/ipc 直连，本装配点只负责端口注入）
    onRuntimeError: (cb) => onRuntimeError(cb),
    getRuntimeStartError,
    restartRuntime,
  },
  // DOM 端口：core 零 document，visibility 读/监听由壳实现
  visibility: {
    isVisible: () => document.visibilityState === 'visible',
    onVisibilityChange: (handler) => {
      document.addEventListener('visibilitychange', handler)
      return () => document.removeEventListener('visibilitychange', handler)
    },
  },
  // env 端口：core 零 import.meta，VITE_MOCK/DEV 由壳读取
  env: {
    isMock: import.meta.env.VITE_MOCK === 'true',
    isDev: Boolean(import.meta.env.DEV),
  },
  effects: createInboundEffects(),
  t,
  onRuntimeUnavailable: handleRuntimeUnavailable,
}

// 幂等注入（模块加载一次；HMR 重载时重新注入，core 侧取最新实现）
setConnectionPorts(connectionPorts)

export function useConnection() {
  return useCoreConnection()
}
