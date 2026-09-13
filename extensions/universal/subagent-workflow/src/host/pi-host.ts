// src/host/pi-host.ts
//
// pi 壳宿主实现（subagent-core 包抽离 u0-wire）。设计权威源：
// docs/architecture/subagent-core-package-extraction.md §3.3 D2（含计划期契约细化 3 条）。
//
// 本文件属壳侧（shell），不进 core 切面——对 pi SDK 与 pi 宿主协作件
// （@earendil-works/pi-coding-agent / @zhushanwen/pi-extension-logger /
// @zhushanwen/pi-pending-notifications / @xyz-agent/session-delivery）的运行时
// import 收敛在此层，core 闭包（D9 守卫对象）不得出现这些包。
//
// 端口语义：
//   - dataRoot / discoveryRoots 每次调用现取 getAgentDir()，禁止模块级缓存：
//     getAgentDir 尊重 PI_CODING_AGENT_DIR 实例隔离（xyz-agent 按 session dir
//     隔离 pi 实例），缓存会把后续切换实例的进程钉死在首个 agentDir。
//   - discoveryRoots 的根清单/顺序/source 标签与 shared/resource-discovery.ts
//     buildScanTargets、orchestration/skill-discovery.ts resolveSkillPath 的现推导
//     逐项一致（user-pi / npm / npm-dev 字面即现 ResourceSource 标签）。
//     project/workspace 根不在壳侧提供——core 消费方按 workspaceRoot 自行推导
//     （u0-data-discovery 波次接注入消费）。C5⑥ 起 agents kind 追加第 4 根：
//     core 包一级父目录（source "npm"）——core agents/ 资产进 pi 发现面，见
//     corePackageNpmRoot 注释。
//   - countActiveFromEntries 适配：pi 侧真函数返回 CountActiveResult 对象，core
//     端口契约是 number（core 消费面只读 .count，notify-ports.ts 契约注释）——
//     foundation 单元登记给本单元的适配责任。
//   - createDelivery 透传：@xyz-agent/session-delivery 的 createDelivery 与 core
//     的 Delivery* 结构化类型逐字段结构兼容（DeliveryHandle 的 sendChecked/depth
//     是结构超集成员，多不碍兼容）——结构兼容由本注入点 typecheck 守护，上游签名
//     漂移即红（notify-ports.ts「闭包红线」段）。

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { countActiveFromEntries } from "@zhushanwen/pi-pending-notifications";
import { createDelivery } from "@xyz-agent/session-delivery";

import type { DiscoveryRoot, HostServices } from "@zhushanwen/subagent-core";
import type { LogLevel } from "@zhushanwen/subagent-core";
import type { NotifyDomainPorts } from "@zhushanwen/subagent-core";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

/**
 * core 包（@zhushanwen/subagent-core）agents/ 资产进 pi 发现面的注入根（C5⑥，
 * convergence §5.4 检查点 2；探针证据 docs/design/subagent-core-convergence.probe-c5.md）。
 *
 * 解析锚点 = `@zhushanwen/subagent-core/workflows/README.md`：`./workflows/*` 子入口
 * 在 workspace TS 直引与 npm dist 两种发布形态下同径（publishConfig 保留该子入口），
 * README.md 是两形态都必在的资产文件。core 包根 = 锚点上两级；npm 槽注入其一级
 * 父目录——npm 槽语义：dir 下一级子项 = 包目录，core 无 pi manifest → 扫 agents/
 * 约定目录命中 10 内置角色。
 *
 * 布局覆盖（探针 P2-P5 实测）：dev workspace（core 在仓库 packages/ 下）与发布态
 * 嵌套布局（core 在本包 node_modules 内）下这是唯一命中通路；发布态平铺布局
 * （core 与本包同层）下既有 npm 根已命中，本注入是幂等兜底（重复发现被 core
 * realpath 去重吸收）。
 *
 * 每次调用现解析（不 memo）：发现调用点稀疏（session_start + 缓存 miss），解析
 * 成本可忽略；失败（异常布局/解析器不可用）降级为不注入并 warn——绝不因资产
 * 接线失败阻断发现主链。
 */
function corePackageNpmRoot(): string | undefined {
  try {
    // createRequire 锚定本模块（jiti 加载器下 import.meta.url 可用；不可用则随
    // catch 降级）。require.resolve 沿 pi-sw 自身的依赖解析链——workspace 与发布态
    // 都从本包出发命中 core。
    const require = createRequire(import.meta.url);
    const anchor = require.resolve("@zhushanwen/subagent-core/workflows/README.md");
    return dirname(dirname(dirname(anchor)));
  } catch (err) {
    // getLogger 惰性调用（catch 是冷路径——测试环境对 pi-extension-logger 的
    // module-level mock 可能返回 undefined，模块级持有会在 import 期踩 undefined）
    getLogger("pi-host").warn(
      "[pi-host] core 包 agents/ 注入根解析失败——10 内置角色可能不可发现",
      { reason: toErrorMessage(err) },
    );
    return undefined;
  }
}

/** agents/workflows 共享的 agentDir 派生根（末级目录名由 kind 决定）。
 *  顺序与 source 标签逐项对齐 resource-discovery.ts buildScanTargets 的
 *  user-pi → npm → npm-dev 段（根列表按优先级低→高排列，D2 语义边界）。 */
function agentDirKindRoots(kind: "agents" | "workflows"): DiscoveryRoot[] {
  const agentDir = getAgentDir();
  const roots: DiscoveryRoot[] = [
    // 1. user .pi/agent/<kind>/
    { dir: join(agentDir, kind), source: "user-pi" },
    // 2. npm global: agentDir/npm/node_modules/*/<pkg>/
    { dir: join(agentDir, "npm", "node_modules"), source: "npm" },
    // 3. npm dev symlink: agentDir/extensions/*/<pkg>/
    { dir: join(agentDir, "extensions"), source: "npm-dev" },
  ];
  // 4. core 包根（C5⑥，仅 agents kind）：追加在既有 npm 根之后——同标签多根依注入
  //    序扫描 + last-writer-wins，core（随本包依赖分发的新模板）遮蔽同 agentDir 内
  //    旧版残留副本；序位仍在 user 级之上、npm-dev/project 级之下（红线 1）。
  //    workflows kind 刻意不注入：<available_workflows> 的 <location> 是 CA2 快照
  //    不豁免面（红线 8 豁免仅限 10 内置 agent 角色路径前缀），注入会翻转内置
  //    workflow 的胜出路径。
  if (kind === "agents") {
    const coreNpmRoot = corePackageNpmRoot();
    if (coreNpmRoot !== undefined) {
      roots.push({ dir: coreNpmRoot, source: "npm" });
    }
  }
  return roots;
}

/** skills 的 agentDir 派生根。对齐 skill-discovery.ts resolveSkillPath 的两处
 *  推导（<agentDir>/skills + <agentDir>/npm/node_modules）——现状无 npm-dev 根，
 *  刻意不补（避免静默引入新发现源）。 */
function skillRoots(): DiscoveryRoot[] {
  const agentDir = getAgentDir();
  return [
    { dir: join(agentDir, "skills"), source: "user-pi" },
    { dir: join(agentDir, "npm", "node_modules"), source: "npm" },
  ];
}

/**
 * 引擎包发现根（W4 L1 第二通道，设计 §3.4）。打包态主通道 = env
 * XYZ_AGENT_ENGINE_ROOTS（W9 注入），此处承载 pi 宿主的常规安装路径：
 *   1. 宿主包自身 node_modules——引擎包（<engine>-subagent-cli）作为本包
 *      dependencies 安装位（W9「扩展 package.json 声明引擎包为 dependencies」）；
 *   2. <agentDir>/npm/node_modules——pi npm 安装位（org 分组二层布局由扫描器
 *      下钻覆盖）；
 *   3. <agentDir>/extensions——dev symlink 位（agents kind 同款 npm-dev 根）。
 * 根目录不存在时由扫描器静默跳过（不在此预检）。 */
function engineRoots(): DiscoveryRoot[] {
  const agentDir = getAgentDir();
  const roots: DiscoveryRoot[] = [];
  const selfNodeModules = hostPackageNodeModulesRoot();
  if (selfNodeModules !== undefined) {
    roots.push({ dir: selfNodeModules, source: "npm" });
  }
  roots.push({ dir: join(agentDir, "npm", "node_modules"), source: "npm" });
  roots.push({ dir: join(agentDir, "extensions"), source: "npm-dev" });
  return roots;
}

/** 宿主包（本扩展）node_modules 根：src/host/pi-host.ts 上溯三级 = 包根。
 *  jiti 加载下 import.meta.url 可用（corePackageNpmRoot 同款可靠性先例）；解析失败
 *  降级为不注入并 warn——绝不因根定位失败阻断发现主链。 */
function hostPackageNodeModulesRoot(): string | undefined {
  try {
    const here = fileURLToPath(import.meta.url);
    // src/host/pi-host.ts → src/host → src → 包根
    const packageRoot = dirname(dirname(dirname(here)));
    return join(packageRoot, "node_modules");
  } catch (err) {
    getLogger("pi-host").warn(
      "[pi-host] 宿主包 node_modules 引擎发现根解析失败——dependencies 安装的引擎包可能不可发现",
      { reason: toErrorMessage(err) },
    );
    return undefined;
  }
}

/** pi 宿主 HostServices 实现（扩展初始化最早处经 configureCore 注入）。 */
export function createPiHostServices(): HostServices {
  return {
    // 每次现取 getAgentDir（实例隔离，见文件头）；env 覆盖段与 warn-once 留 core
    // data-dir.ts，壳只返回数据根本身（D2 计划期细化③分段归属）。
    dataRoot(): string {
      return getAgentDir();
    },

    // 桥接到 pi-extension-logger：component 即 extName（复用其 loggerCache 单例
    // 与 appendEntry/文件日志通路），按 level 分派方法，(message, data) 透传。
    log(level: LogLevel, component: string, message: string, data?: unknown): void {
      const logger = getLogger(component);
      if (level === "error") logger.error(message, data);
      else if (level === "warn") logger.warn(message, data);
      else logger.debug(message, data);
    },

    discoveryRoots(): {
      agents?: DiscoveryRoot[];
      skills?: DiscoveryRoot[];
      workflows?: DiscoveryRoot[];
      engines?: DiscoveryRoot[];
    } {
      return {
        agents: agentDirKindRoots("agents"),
        skills: skillRoots(),
        workflows: agentDirKindRoots("workflows"),
        engines: engineRoots(),
      };
    },
  };
}

/**
 * pi 侧通知域窄端口实现（configureNotifyDomain 注入）。zsw 壳不注入本端口
 * （其完成通知走 HostServices.notify，P2 落地）。
 *
 * [F1 形态升级] 跨 session 残留过滤基准（W4 读侧过滤②）不走 factory 定型——本装配
 * 在扩展模块加载时执行一次，session id 逐 session 变化（session_start 每次更新），
 * factory 参数表达不了 per-call 基准；且生产装配点从未传参（注释声称的防御实际
 * 缺基准）。现形态 = core 端口契约第二参（NotifyDomainPorts.countActiveFromEntries
 * 的 opts）per-call 透传，基准由 core 读侧按「被读 entries 所属 session」提供
 * （session-pending.ts 读 pi session 文件首行 SessionHeader.id）——fork 继承的父级
 * 注册残留不进后代判定差集，防御真实生效。
 */
export function createPiNotifyDomainPorts(): NotifyDomainPorts {
  return {
    // pi 真函数返回 CountActiveResult，core 契约只读 .count——壳侧拆数值。
    // [W4 读侧过滤② / F1] per-call 基准透传差集口径（缺省 undefined = 不过滤，
    // 向后兼容：无基准的调用方零改动行为不变）。
    countActiveFromEntries(entries: unknown[], opts?: { currentSessionId?: string }): number {
      return countActiveFromEntries(entries, { currentSessionId: opts?.currentSessionId }).count;
    },

    // 投递内核工厂直传本体（结构兼容论证见文件头）；不经包装避免多一层间接面。
    createDelivery,
  };
}
