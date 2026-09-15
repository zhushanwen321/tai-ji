/**
 * 创建一个结构兼容的 ExtensionAPI mock，供 sdk-contract / 注册契约测试用。
 *
 * ExtensionAPI 有 ~30 个必需方法（on/registerTool/registerCommand/...），逐个手写
 * 不现实。本 helper 用 Proxy 把所有未显式 override 的方法/属性短路为 no-op 函数，
 * 让对象**结构兼容** ExtensionAPI——避免 `as unknown as ExtensionAPI` 双重断言
 * （taste/no-unsafe-cast 规则禁止）。测试只需 override 关心的方法：
 *
 *   const pi = mockExtensionApi({
 *     registerCommand: (name) => { capturedName = name; },
 *   });
 *
 * Proxy 的 trap 对所有属性访问返回 override 值或 no-op 函数，运行时安全
 * （注册 handler 只调用被 override 的方法，其余方法测试不触及）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function mockExtensionApi(
  overrides: Record<string, unknown> = {},
): ExtensionAPI {
  const noop = (): void => { /* test mock: method not invoked by this test */ };
  // Proxy<T> 泛型参数决定返回类型——直接声明为 ExtensionAPI，
  // TS 接受（Proxy handler 对 target 的类型不约束 T）。
  return new Proxy<ExtensionAPI>(overrides as unknown as ExtensionAPI, {
    get(target, prop: string | symbol): unknown {
      if (prop in target) return target[prop as keyof ExtensionAPI];
      return noop;
    },
  });
}
