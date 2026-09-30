/**
 * auth.* 订阅回调捕获 mock 单源（use-provider-oauth / ProviderPage 测试同构段）。
 *
 * 四个 auth 事件订阅方法（onAuthDeviceCode / onAuthAuthUrl / onAuthSuccess / onAuthError）
 * 的类型化 vi.fn 捕获：实现侧 onMounted 注册 handler（须返回 disposer 供 onScopeDispose），
 * 测试侧经 mock.calls[0][0] 取出 handler 后手动派发事件。事件 payload 类型是 transport
 * auth 广播的结构子集，在此登记单源（测试文件按需 import 复用）。
 */
import { vi } from 'vitest'

/** auth.deviceCode 事件载荷（userCode + 验证 URL 族） */
export interface DeviceCodeEvent { // oe-exempt:20260930:test:auth 事件 payload 结构契约，use-provider-oauth 测试的 emit*/registered* 泛型参共用
  providerId: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn?: number
}

/** auth.authUrl 事件载荷（回调 URL） */
export interface AuthUrlEvent { // oe-exempt:20260930:test:auth 事件 payload 结构契约，同上共用
  providerId: string
  url: string
  callbackPort?: number
}

/** auth.success 事件载荷 */
export interface AuthSuccessEvent { // oe-exempt:20260930:test:auth 事件 payload 结构契约，同上共用
  providerId: string
}

/** auth.error 事件载荷 */
export interface AuthErrorEvent { // oe-exempt:20260930:test:auth 事件 payload 结构契约，同上共用
  providerId: string
  message: string
}

/** 单事件订阅捕获（vi.fn 显式参数类型 → mock.calls[0][0] 拿到类型化 handler，派发零断言收窄）。 */
function captureSubscription<P>() {
  return vi.fn<(h: (p: P) => void) => () => void>(() => () => {})
}

/** auth.* 订阅回调捕获集（四个 auth 事件的 handler 捕获；派发侧见 mock.calls[0][0]）。 */
export function authEventCbs() {
  return {
    onAuthDeviceCode: captureSubscription<DeviceCodeEvent>(),
    onAuthAuthUrl: captureSubscription<AuthUrlEvent>(),
    onAuthSuccess: captureSubscription<AuthSuccessEvent>(),
    onAuthError: captureSubscription<AuthErrorEvent>(),
  }
}
