// src/execution/engine/window-instances.ts
//
// 窗口实例表（pi-workflow-run-resource-model U1）。设计权威源：
// docs/adr/decisions.md ADR-0079（workflow run 资源模型）+ 技术设计文档
// §3.1 机制 2 / §3.3 决策 6 / §5 U1。
//
// per-window 引擎（manifest `taiji.subagentEngine.processModel` = 'per-window'，缺省）
// 的实例生命周期归「派发窗口」（一个 workflow run 或一个 chat record 轮次）：窗口内
// 首次取用时创建并登记、后续复用，窗口收尾统一 dispose——薄壳死 = 孙进程同进程组
// 连带收割。shared-service 引擎（如 zcode）不进本表，透传 engine/registry.ts 的
// 进程级单例路径（现状即终态）：isSharedServiceProcessModel 供接线方在实例创建
// 之前分流（避免为 shared-service 产出有副作用的实例再丢弃），register 对该形态
// no-op 兜住漏判。
//
// 本模块只提供窗口侧的登记与释放机制，不改 registry、不做取用分流接线——表对象
// 的挂载点（WorkflowRun 状态对象 / 轮执行上下文）与 getEngine 分流归收尾接线单元
// （U2 workflow finalizeRun / U3 chat 轮 idle 收尾链）。

/**
 * 引擎进程形态（manifest `taiji.subagentEngine.processModel` 契约字面量，设计
 * §3.3 决策 3）：'per-window' = 窗口作用域实例，随派发窗口生灭；'shared-service'
 * = 进程级懒加载单例，随宿主（taiji）存活。manifest 未声明时解析层缺省
 * 'per-window'（轻壳是常态，重服务是显式特例）。
 */
export type EngineProcessModel = "per-window" | "shared-service";

/**
 * 窗口实例描述符：窗口表登记的最小引擎实例描述（engineId + 进程形态 + dispose
 * 能力），不承载协议调用面——取用仍走实例本体（如 EngineClient），本表只管
 * 「本窗口用过哪些引擎实例」的记账与收尾清理。
 */
export interface WindowEngineInstance { // oe-exempt:20260927:framework:窗口实例描述符 ports 契约——本仓「类型契约先行、接口先立单实现常态」（ADR-0079 窗口实例表交付面）
  /** 引擎 id（窗口表键；同一窗口内唯一）。 */
  readonly engineId: string;
  /** manifest 声明的进程形态（'shared-service' 不进窗口表）。 */
  readonly processModel: EngineProcessModel;
  /**
   * 实例释放（薄壳进程回收：dispose 请求 → 按进程组终止兜底）。同步或 Promise
   * 均可；disposeAll 逐实例 await，单实例失败收集后继续其余实例。
   */
  dispose(): void | Promise<void>;
}

/** 窗口实例表：一个派发窗口一个实例（per-window 引擎实例的登记与收尾释放）。 */
export interface WindowEngineInstances { // oe-exempt:20260927:framework:窗口实例表 ports 契约——登记/查表/收尾释放面先立，u2/u3 接线与 u5 registry 改造消费
  /**
   * 登记引擎实例。'shared-service' 实例不进表（no-op——透传 registry 单例路径）；
   * per-window 实例以 engineId 为键恰一次登记，同 engineId 重复登记 throw。
   *
   * fail-fast 理由：登记是窗口内实例创建路径的唯一写入点，重复登记 = 调用方绕过
   * 「先 get 查表复用」约定——静默幂等会把第二个实例漏成不可达进程（表中无登记、
   * disposeAll 触达不到，薄壳进程泄漏为孤儿）；fail-fast 让接线错误在开发期暴露。
   */
  register(instance: WindowEngineInstance): void;
  /** 按引擎 id 取已登记实例（窗口内复用的查表入口）；未登记返回 undefined。 */
  get(engineId: string): WindowEngineInstance | undefined;
  /**
   * 收尾遍历释放：dispose 全部已登记实例，返回失败错误清单（空数组 = 全部成功，
   * 由调用方在收尾围栏内统一上报——本模块自身无日志副作用）。幂等：表先清空后
   * 遍历，重复调用构造性 no-op、绝不二次 dispose；单实例 dispose 失败（同步
   * throw 或 Promise reject）收集后继续其余实例，不阻断释放。
   */
  disposeAll(): Promise<readonly unknown[]>;
}

/**
 * shared-service 判定（接线分流入口）：'shared-service' 引擎走 registry 单例路径，
 * 不创建窗口实例。per-window（含缺省）返回 false，走窗口实例表。
 */
export function isSharedServiceProcessModel(processModel: EngineProcessModel): boolean {
  return processModel === "shared-service";
}

/** 创建窗口实例表（一个派发窗口一个；表状态闭包持有，无进程级共享状态）。 */
export function createWindowEngineInstances(): WindowEngineInstances {
  const instances = new Map<string, WindowEngineInstance>();
  return {
    register(instance: WindowEngineInstance): void {
      if (isSharedServiceProcessModel(instance.processModel)) return;
      if (instances.has(instance.engineId)) {
        throw new Error(
          `window-instances: engine '${instance.engineId}' is already registered in this window. ` +
            `Reuse the registered instance via get() instead of creating a second one — ` +
            `a duplicate would leak as an undisposed process.`,
        );
      }
      instances.set(instance.engineId, instance);
    },
    get(engineId: string): WindowEngineInstance | undefined {
      return instances.get(engineId);
    },
    async disposeAll(): Promise<readonly unknown[]> {
      // 先清空后遍历：登记条目只可能被本函数消费一次，重复调用遍历空表（幂等），
      // dispose 过程中也不可能对同一实例二次 dispose。
      const batch = [...instances.values()];
      instances.clear();
      const failures: unknown[] = [];
      for (const instance of batch) {
        try {
          await instance.dispose();
        } catch (err) {
          failures.push(err);
        }
      }
      return failures;
    },
  };
}
