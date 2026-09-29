// window-instances.test.ts —— 窗口实例表（pi-workflow-run-resource-model U1）。
//
// 三视角：
//   ①使用者（U2/U3 收尾接线视角）——窗口内先 get 查表复用、未命中才创建并 register；
//     finalizeRun / 轮 idle 收尾链调 disposeAll 一次，失败清单交收尾围栏统一上报。
//   ②构建者——Map 键控恰一次（重复登记 fail-fast 防第二个实例漏成孤儿进程）；
//     disposeAll 先清空后遍历（幂等构造性成立，重复调用不二次 dispose）；逐实例
//     await，单实例失败（同步 throw / Promise reject）收集后继续。
//   ③观察者——shared-service 实例不进表（get 不可见、dispose 不被调），透传
//     registry 单例路径；多引擎并存互不干扰。
//
// 全部用例用 fake 描述符（普通对象 + dispose 调用计数），不拉真实引擎进程；
// 纯内存模块，零 fs 触碰。

import { describe, expect, it } from "vitest";

import {
  createWindowEngineInstances,
  isSharedServiceProcessModel,
  type EngineProcessModel,
  type WindowEngineInstance,
} from "../window-instances.ts";

/** fake 实例：dispose 记录调用次数并委托可选实现（throw / reject 注入失败形态）。 */
function makeFakeInstance(
  engineId: string,
  processModel: EngineProcessModel = "per-window",
  disposeImpl?: () => void | Promise<void>,
): WindowEngineInstance & { disposeCalls: number } {
  const instance: WindowEngineInstance & { disposeCalls: number } = {
    engineId,
    processModel,
    disposeCalls: 0,
    dispose() {
      instance.disposeCalls += 1;
      return disposeImpl?.();
    },
  };
  return instance;
}

describe("register：同窗口同 engineId 恰一次登记", () => {
  it("重复登记 fail-fast：throw 且表内保留首个实例（第二个不会在收尾时被释放）", () => {
    const table = createWindowEngineInstances();
    const first = makeFakeInstance("pi");
    const second = makeFakeInstance("pi");
    table.register(first);

    expect(() => table.register(second)).toThrow(/already registered/);
    expect(table.get("pi")).toBe(first);

    return table.disposeAll().then((failures) => {
      expect(failures).toEqual([]);
      expect(first.disposeCalls).toBe(1);
      expect(second.disposeCalls).toBe(0);
    });
  });

  it("登记后 get 返回同一实例引用（窗口内复用的查表入口）；未登记返回 undefined", () => {
    const table = createWindowEngineInstances();
    expect(table.get("pi")).toBeUndefined();

    const instance = makeFakeInstance("pi");
    table.register(instance);
    expect(table.get("pi")).toBe(instance);
  });
});

describe("disposeAll：收尾遍历释放", () => {
  it("每个已登记实例 dispose 恰一次，全部成功返回空清单", async () => {
    const table = createWindowEngineInstances();
    const a = makeFakeInstance("pi");
    const b = makeFakeInstance("zcode-fake");
    table.register(a);
    table.register(b);

    expect(await table.disposeAll()).toEqual([]);
    expect(a.disposeCalls).toBe(1);
    expect(b.disposeCalls).toBe(1);
  });

  it("幂等：重复调用不炸、不二次 dispose（第二次返回空清单）", async () => {
    const table = createWindowEngineInstances();
    const instance = makeFakeInstance("pi");
    table.register(instance);

    expect(await table.disposeAll()).toEqual([]);
    expect(await table.disposeAll()).toEqual([]);
    expect(instance.disposeCalls).toBe(1);
  });

  it("单实例失败不阻断：同步 throw 与 Promise reject 均收集，其余实例照常释放", async () => {
    const table = createWindowEngineInstances();
    const syncFail = makeFakeInstance("pi", "per-window", () => {
      throw new Error("sync dispose boom");
    });
    const asyncFail = makeFakeInstance("mid", "per-window", () =>
      Promise.reject(new Error("async dispose boom")),
    );
    const healthy = makeFakeInstance("last");
    table.register(syncFail);
    table.register(asyncFail);
    table.register(healthy);

    const failures = await table.disposeAll();
    expect(syncFail.disposeCalls).toBe(1);
    expect(asyncFail.disposeCalls).toBe(1);
    expect(healthy.disposeCalls).toBe(1);
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => (f as Error).message)).toEqual([
      "sync dispose boom",
      "async dispose boom",
    ]);
  });
});

describe("多引擎并存：一个窗口内多个 engineId 各自登记、互不干扰", () => {
  it("两个引擎各自登记、get 各取所得、收尾全部释放", async () => {
    const table = createWindowEngineInstances();
    const pi = makeFakeInstance("pi");
    const zed = makeFakeInstance("zed");
    table.register(pi);
    table.register(zed);

    expect(table.get("pi")).toBe(pi);
    expect(table.get("zed")).toBe(zed);

    expect(await table.disposeAll()).toEqual([]);
    expect(pi.disposeCalls).toBe(1);
    expect(zed.disposeCalls).toBe(1);
  });
});

describe("shared-service 透传：不进窗口实例表", () => {
  it("register 对 shared-service no-op：get 不可见、disposeAll 不调其 dispose", async () => {
    const table = createWindowEngineInstances();
    const shared = makeFakeInstance("zcode", "shared-service");
    table.register(shared);

    expect(table.get("zcode")).toBeUndefined();

    expect(await table.disposeAll()).toEqual([]);
    expect(shared.disposeCalls).toBe(0);
  });

  it("混合窗口：per-window 正常登记，shared-service 跳过，收尾只释放前者", async () => {
    const table = createWindowEngineInstances();
    const pi = makeFakeInstance("pi", "per-window");
    const zcode = makeFakeInstance("zcode", "shared-service");
    table.register(pi);
    table.register(zcode);

    expect(table.get("pi")).toBe(pi);
    expect(table.get("zcode")).toBeUndefined();

    expect(await table.disposeAll()).toEqual([]);
    expect(pi.disposeCalls).toBe(1);
    expect(zcode.disposeCalls).toBe(0);
  });

  it("isSharedServiceProcessModel 判定：shared-service 为 true，per-window 为 false", () => {
    expect(isSharedServiceProcessModel("shared-service")).toBe(true);
    expect(isSharedServiceProcessModel("per-window")).toBe(false);
  });
});
