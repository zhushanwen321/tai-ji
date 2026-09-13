// src/execution/engine/engine-discovery.ts
//
// [U7 → W4] 引擎列表状态文件同步（→ <agentDir>/subagents/engines.json）。
//
// 为什么落文件而不是 session entry：Settings 引擎选择器在无活跃 session 时也要可开
// （冷启动/全局设置），session entry 绑定会话生命周期兜不住；engines.json 是进程外
// 可读的全局状态，extension（pi 进程）为唯一写入者，runtime RPC 读——数据所有权清晰。
//
// 动态性（W4 协议化）：清单来自「三级发现的装载结果 ∪ 代码注册表」——发现器
// （engine-discovery-scan.ts）在同步前扫描（L1 env 根 / HostServices.engines /
// L2 node 解析 / L3 config.json），把引擎包 manifest 自注册的 cli descriptor 装载进
// 注册表；inproc 过渡注册（组合根 registerXxxEngine）与发现装载合流构成本次投影。
// 新引擎 = 装一个包（W5/W7 后），本文件与前端都不枚举引擎。
//
// 投影契约（设计 §3.4 投影面表）：清单 = 已发现且可执行的 id 数组；契约
// {v:1, engines: string[]} 不改（A11 宿主表面不变量）。

import * as fs from "node:fs";
import * as path from "node:path";

import { SUBAGENTS_ENGINES_FILENAME, type SubagentEnginesFile } from "@xyz-agent/extension-protocol";

import { listEngines } from "./registry.ts";
import { discoverAndRegisterEngines, loadedDiscoveryIds } from "./engine-discovery-scan.ts";
import { writeAtomicFileSync } from "../../shared/atomic-write.ts";

/** engines.json 落盘缩进（与 subagent-core 其他 JSON store 的 JSON_INDENT 约定一致）。 */
const JSON_INDENT = 2;

/** engines.json 绝对路径（与 config.json 同目录；config.ts 的 getGlobalConfigPath 同构）。 */
export function getEnginesFilePath(agentDir: string): string {
  return path.join(agentDir, "subagents", SUBAGENTS_ENGINES_FILENAME);
}

/**
 * 三级发现装载 + 把引擎清单同步到 engines.json（session_start 时调用）。
 *
 * 发现时机（W4 §2.4）：与 syncEnginesFile 同点——扩展组合根的模块加载点与
 * session_start 兜底点即本函数既有调用点（调用方零改动），扫描一次 + 装载进注册表
 * （装载结果即缓存）；只读 manifest 不握手（portFactory 惰性，扫描不 spawn 引擎）。
 *
 * 投影源（§3.4 投影面表「清单 = 已发现且可执行」）= 本次发现装载结果 ∪ inproc 过渡
 * 注册快照（listEngines() 剔除历史发现装载的 id——registry 无撤销 API，引擎包卸载
 * 后已装载 descriptor 会滞留，投影时经 loadedDiscoveryIds 排除即「卸载 → 下次扫描
 * 自动消失」清理通道；A4 新引擎装包零改 core 出现在清单）。W11 删 inproc 后清单 =
 * 纯发现结果（零命中 → 空清单，GUI 按既有语义给 engine_not_found + 安装指引）。
 *
 * 幂等：内容与现文件一致时零写入（mtime 不动——读侧无谓失效）；写入走 tmp+rename
 * 原子替换（shared/atomic-write 统一原语，U6b 迁移——与池 config 同防线）。
 * fail-safe：发现与 IO 异常都吞掉（可发现性降级不阻塞 session 启动——GUI 兜底显示
 * 既有清单）。
 */
/** 发现注入面（测试密闭化）：透传 discoverAndRegisterEngines 的隔离选项——
 * env 覆盖 L1 宿主发现根读取，nodeModuleRoots 覆盖 L2 宿主 node_modules 解析域。
 * 缺省 = 生产语义（process.env + 宿主解析域）。测试必传密闭值（env:{} + 
 * nodeModuleRoots:[]），防宿主环境（如打包态 XYZ_AGENT_ENGINE_ROOTS）污染注册表
 * 导致断言依赖机器环境（TaiJi 会话 env 曾注入引擎根，致 discovery 测试机器相关红）。 */
export interface SyncEnginesFileOptions {
  env?: NodeJS.ProcessEnv;
  nodeModuleRoots?: string[];
}

export function syncEnginesFile(agentDir: string, opts?: SyncEnginesFileOptions): void {
  try {
    // inproc 过渡注册快照：注册表全集剔除历史发现装载的 id（清理通道语义，见头注释）
    const loadedIds = new Set(loadedDiscoveryIds());
    const inprocSnapshot = listEngines().filter((id) => !loadedIds.has(id));
    // [W4] 三级发现装载（fail-safe 内——扫描失败不阻塞投影与 session 启动）。
    const scan = discoverAndRegisterEngines({ hostKind: "pi", agentDir, ...opts });
    const filePath = getEnginesFilePath(agentDir);
    const engines = [...new Set([...inprocSnapshot, ...scan.discovered.map((e) => e.id)])];
    const payload: SubagentEnginesFile = { v: 1, engines, updatedAt: Date.now() };
    const serialized = JSON.stringify(payload, null, JSON_INDENT);
    try {
      const existing = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(existing) as Partial<SubagentEnginesFile>;
      // 引擎清单未变则跳过（updatedAt 仅诊断，不参与判变）
      if (
        Array.isArray(parsed.engines) &&
        JSON.stringify(parsed.engines) === JSON.stringify(payload.engines) &&
        parsed.v === 1
      ) {
        return;
      }
    } catch (err) {
      // 现文件缺失/损坏 → 走写入
      void err;
    }
    writeAtomicFileSync(filePath, serialized);
  } catch (err) {
    // 吞掉：见文件头 fail-safe 说明
    void err;
  }
}
