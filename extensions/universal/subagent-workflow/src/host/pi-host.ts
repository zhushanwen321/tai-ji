// src/host/pi-host.ts
//
// pi 壳宿主实现（subagent-core 包抽离 u0-wire）。设计权威源：
// docs/architecture/subagent-core-package-extraction.md §3.3 D2（含计划期契约细化 3 条）。
//
// 本文件属壳侧（shell），不进 core 切面——对 pi SDK 与 pi 宿主协作件
// （@earendil-works/pi-coding-agent / @zhushanwen/pi-extension-logger /
// @zhushanwen/pi-pending-notifications / @zhushanwen/session-delivery）的运行时
// import 收敛在此层，core 闭包（D9 守卫对象）不得出现这些包。
//
// 端口语义：
//   - dataRoot / discoveryRoots 每次调用现取 getAgentDir()，禁止模块级缓存：
//     getAgentDir 尊重 PI_CODING_AGENT_DIR 实例隔离（taiji 按 session dir
//     隔离 pi 实例），缓存会把后续切换实例的进程钉死在首个 agentDir。
//   - discoveryRoots 的根清单/顺序/source 标签与 shared/resource-discovery.ts
//     buildScanTargets、orchestration/skill-discovery.ts resolveSkillPath 的现推导
//     逐项一致（user-pi / npm / npm-dev 字面即现 ResourceSource 标签）。
//     project/workspace 根不在壳侧提供——core 消费方按 workspaceRoot 自行推导
//     （u0-data-discovery 波次接注入消费）。C5⑥ 起 agents kind 追加第 4 根：
//     core 包一级父目录（source "npm"）——core agents/ 资产进 pi 发现面，见
//     corePackageNpmRoot 注释。[P5 D4-2] agents/workflows 的 npm/npm-dev 两根
//     形态感知（taiji 态指 agentDir 父目录 = 实际安装目录，独立态保留 agentDir
//     直拼），且 core 根对 workflows kind 同样注入（staged 副本入扫描面）——
//     见 agentDirKindRoots 注释。skills/engines 的同构 npm 槽错位不在 P5 范围
//     （D4 发现层 = agents/workflows 注入面；skills 另有「刻意不补」既有决策）。
//   - countActiveFromEntries 适配：pi 侧真函数返回 CountActiveResult 对象，core
//     端口契约是 number（core 消费面只读 .count，notify-ports.ts 契约注释）——
//     foundation 单元登记给本单元的适配责任。
//   - createDelivery 透传：@zhushanwen/session-delivery 的 createDelivery 与 core
//     的 Delivery* 结构化类型逐字段结构兼容（DeliveryHandle 的 sendChecked/depth
//     是结构超集成员，多不碍兼容）——结构兼容由本注入点 typecheck 守护，上游签名
//     漂移即红（notify-ports.ts「闭包红线」段）。

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { countActiveFromEntries } from "@zhushanwen/pi-pending-notifications";
import { createDelivery } from "@zhushanwen/session-delivery";

import type { DiscoveryRoot, HostServices } from "@zhushanwen/subagent-core";
import type { LogLevel } from "@zhushanwen/subagent-core";
import type { NotifyDomainPorts } from "@zhushanwen/subagent-core";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

/**
 * core 包（@zhushanwen/subagent-core）agents/ 资产进 pi 发现面的注入根（C5⑥，
 * convergence §5.4 检查点 2）。
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
 *  user-pi → npm → npm-dev 段（根列表按优先级低→高排列，D2 语义边界）。
 *
 *  [P5 D4-2 扫描根修正] npm/npm-dev 两根形态感知：taiji 宿主注入态改指 taiji
 *  实际安装目录（agentDir 的父目录——taiji 布局迁移后 npm/extensions 是 agentDir
 *  的 sibling，对齐 runtime pi-paths.ts getNpmDir/getExtensionsDir 的推导），独立
 *  pi 形态保留 getAgentDir() 派生的 pi 语义根（现状即正确）。 */
function agentDirKindRoots(kind: "agents" | "workflows"): DiscoveryRoot[] {
  const agentDir = getAgentDir();
  // taiji 态 npm/extensions 布局 = agentDir 的 sibling（<dataDir>/npm、
  // <dataDir>/extensions，agentDir = <dataDir>/agent）；旧 agentDir 直拼形态在
  // taiji 态恒为不存在目录——taiji 形态下 npm 安装位与 staged 包发现面恒空的
  // 病灶根因。已知误判面（有意接受，登记 deviations）：独立态用户以 -e 手动加载
  // 本扩展时 argv 同样有 --extension，npm 槽根指到不存在的 <agentDir> 父目录 →
  // 扫描静默空（损失 = 罕见场景的 npm 安装位发现；agentDir/npm 本就非 pi 官方布局）。
  const installBase = isTaijiHostInjected() ? dirname(agentDir) : agentDir;
  const roots: DiscoveryRoot[] = [
    // 1. user .pi/agent/<kind>/
    { dir: join(agentDir, kind), source: "user-pi" },
    // 2. npm global: <installBase>/npm/node_modules/*/<pkg>/
    { dir: join(installBase, "npm", "node_modules"), source: "npm" },
    // 3. npm dev symlink: <installBase>/extensions/*/<pkg>/
    { dir: join(installBase, "extensions"), source: "npm-dev" },
  ];
  // 4. core 包根（C5⑥ + P5）：agents/workflows 两 kind 都追加在既有 npm 根之后——
  //    同标签多根依注入序扫描 + last-writer-wins，core（随本包依赖分发的新模板）
  //    遮蔽同安装位内旧版残留副本；序位仍在 user 级之上、project 级之下（红线 1）。
  //    [P5] workflows kind 的「刻意不注入」禁区拆除：原顾虑 = <available_workflows>
  //    的 <location> 是 CA2 快照不豁免面（红线 8 豁免仅限 agent 角色路径前缀）。
  //    P-C6 实施期核查裁决：CA2 锚定测试为 fixture 输入驱动（不消费运行时路径），
  //    turn 间字节稳定由工厂渲染缓存 + 码点序构造性保证——staged 绝对路径渲染
  //    <location> 不破坏快照稳定性，内置 workflow 因此可列出、路径可派发。
  const coreNpmRoot = corePackageNpmRoot();
  if (coreNpmRoot !== undefined) {
    roots.push({ dir: coreNpmRoot, source: "npm" });
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
 * TAIJI_AGENT_ENGINE_ROOTS（W9 注入），此处承载 pi 宿主的常规安装路径：
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

    // [D2 扩展加载显式化] 孙进程扩展路径集（per-host 常量，双形态解析见
    // resolveGrandchildExtensionPaths 注释）。每次调用现解析（P-C2 惰性求值：
    // configureCore 只挂函数引用，取值发生在 core run 派发期）。
    extensionPaths(): string[] {
      return resolveGrandchildExtensionPaths(process.argv);
    },
  };
}

// ── [D2 扩展加载显式化] 孙进程扩展白名单注入源（双形态） ──

/**
 * 孙进程（subagent 任务子进程）schema 强制所需的最小扩展集（P-C5 起步裁决：
 * 仅 structured-output）。全量 staged 下发会让孙进程加载全部无关扩展——每包都
 * 可能注册工具/注入提示词，孙进程的工具面与 system prompt 行为不可控。
 *
 * 白名单组成唯一登记处（runtime 侧 getExtensionPaths 全量下发、本常量收窄，
 * 无第二份判据副本——扩白名单只改此处并同步 pi-host.test.ts 用例）。
 */
const GRANDCHILD_EXTENSION_PKG_SEGMENTS = "@zhushanwen/pi-structured-output";

/**
 * 孙进程扩展路径集解析（设计 D2 双形态；argv 与 peerDep 解析器经参数注入，纯函数
 * 可测——HostServices 方法闭包传 process.argv）：
 *   1. taiji 宿主形态：主 pi 进程 argv 的 `--extension` 全量值 = runtime
 *      extension-service 经 spawn argv 下发的 staged 集——按白名单收窄。该形态
 *      判据 = argv 有 `--extension`（taiji spawn 恒带）。
 *   2. 独立 pi 形态（npm 安装、无 taiji runtime）：从包自身 optional peerDep 解析
 *      structured-output sibling 路径（安装了即解析、未安装则空）。
 * 双源皆空 = 空数组（不炸；带 schema run 的 fail-fast 属 H3 断言，非本通道职责）。
 */
export function resolveGrandchildExtensionPaths(
  argv: readonly string[],
  resolvePeer: () => string | undefined = resolveStructuredOutputPeer,
): string[] {
  const stagedAll = collectExtensionFlagValues(argv);
  const whitelisted = stagedAll.filter(isGrandchildExtensionPath);
  if (whitelisted.length > 0) return whitelisted;
  const peer = resolvePeer();
  return peer !== undefined ? [peer] : [];
}

/** 路径是否命中孙进程扩展白名单：路径段序列包含 `<scope>/<pkg>` 连续两段
 *  （目录形态 `.../@zhushanwen/pi-structured-output` 与入口文件形态
 *  `.../@zhushanwen/pi-structured-output/index.js` 都命中；末尾越界段取
 *  undefined 不等，天然界内）。 */
function isGrandchildExtensionPath(p: string): boolean {
  const segs = p.split(/[\\/]/).filter((s) => s.length > 0);
  const wanted = GRANDCHILD_EXTENSION_PKG_SEGMENTS.split("/");
  return segs.some((_, i) => wanted.every((w, j) => segs[i + j] === w));
}

/**
 * 独立形态回退源：optional peerDep sibling 解析（package.json 锚点 → 包根目录）。
 * 解析失败（未安装 / 布局异常）= undefined，不炸——空集回退。
 */
function resolveStructuredOutputPeer(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve(`${GRANDCHILD_EXTENSION_PKG_SEGMENTS}/package.json`));
  } catch (err) {
    getLogger("pi-host").debug(
      "[pi-host] structured-output optional peerDep 未解析（独立形态未安装，孙进程扩展集回退空）",
      { reason: toErrorMessage(err) },
    );
    return undefined;
  }
}

/**
 * 从 argv 提取 `--extension` / `-e` 的全部值（等号与空格两种形式；自旧
 * mirrorMainProcessFlags 的解析规则精简迁移——该镜像机制已废弃，此处只取
 * extension 值，布尔镜像面不再透传）。
 *
 * 有值 flag 表（跳过其他 flag 的值时不误吃）与 MF-7a 判定（`--extension` 后跟
 * `--` 开头 token 不吃值）逐字保留原语义——解析坑防回归见旧测试族
 * （spawn-args.test.ts 历史，git 可追溯）。
 */
const ARGV_VALUED_FLAGS = new Set<string>([
  "--extension", "-e",
  "--skill",
  // g4-allow: argv 有值 flag 解析词表（跳过非 extension flag 的值防误吃），非模型引用拼装
  "--model", "--system-prompt", "--append-system-prompt", // g4-allow: 同上——解析词表成员，非拼装
  "--tools", "-t", "--exclude-tools", "-xt",
  "--fork", "--session-dir", "--mode",
  "--thinking", "--models",
]);

/** argv 中 flag 起始索引：argv[0]=runtime，argv[1]=binary 路径。 */
const ARGV_FLAG_START = 2;

/**
 * taiji 宿主注入态判据（P5 D4-2 扫描根修正；形态判据复用 H2 先例）：主 pi 进程
 * argv 含 --extension/-e 值即 taiji spawn（runtime 恒带 staged 全量集下发的
 * --extension；独立 pi 经 settings 清单加载扩展，argv 无该 flag）。
 * 与 resolveGrandchildExtensionPaths 的白名单收窄是两个决策——此处只做形态判定
 * （决定扫描根指向），不做白名单（白名单只约束孙进程扩展集）。
 */
function isTaijiHostInjected(argv: readonly string[] = process.argv): boolean {
  return collectExtensionFlagValues(argv).length > 0;
}

function collectExtensionFlagValues(argv: readonly string[]): string[] {
  const values: string[] = [];
  const flagArgs = argv.length > ARGV_FLAG_START ? argv.slice(ARGV_FLAG_START) : [];
  for (let i = 0; i < flagArgs.length; i++) {
    const tok = flagArgs[i];
    const eqMatch = /^(--extension|-e)=(.*)$/.exec(tok);
    if (eqMatch !== null) {
      if (eqMatch[2]) values.push(eqMatch[2]);
      continue;
    }
    if (tok === "--extension" || tok === "-e") {
      const next = flagArgs[i + 1];
      // 单 `-` 开头的合法路径不是 flag（原 MF-7a）；`--` 开头是真 flag，不吃值
      if (next !== undefined && !next.startsWith("--") && next.length > 0) {
        values.push(next);
        i++;
      }
      continue;
    }
    if (ARGV_VALUED_FLAGS.has(tok)) {
      i++;
      continue;
    }
  }
  return values;
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
