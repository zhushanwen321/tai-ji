// src/execution/engine/engines/zcode/appserver-launcher.ts
//
// app-server 启动 wrapper（2026-09 共享宿主 HOME 形态的凭据供数机制）。
//
// 为什么需要：CLI 形态的 zcode app-server 只从 `$HOME/.zcode/cli/config.json` 的
// provider 字段读凭据（bundle 实测：路径硬编码，userConfigPath/modelConfig 参数仅对
// GUI 同代码库内嵌调用方开放，env/argv/协议面无配置注入通道）；而 GUI 把凭据放
// `~/.zcode/v2/config.json` 且从不写 cli/config.json——外部 spawn 的 app-server 在
// 真实 HOME 下是「无源之水」（实测报 "Model provider ... is missing baseURL"）。
//
// 解法（fs 拦截 wrapper，用户拍板「包一层」）：spawn 的不是 zcode.cjs 而是本模块
// 落盘的 launcher 脚本——它 patch fs.readFileSync/fsPromises.readFile/existsSync
// （真实 bundle 的用户 config 读取是 existsSync 短路在前：文件不存在直接返回空
// config，readFileSync 不被调用——GUI-only 登录宿主上不拦 existsSync = 注入整体
// 不可见），把对 cli/config.json 精确路径的读取重定向为「真实文件 + v2 provider
// 注入」的内存合并结果（同 id 时 v2 整条优先——v2 是权威凭据源，等价复刻 GUI
// 直传 modelConfig），再启动 zcode.cjs（import 前把 argv[1] 改写为 zcode.cjs 路径
// ——上游 provider bootstrap 以 argv[1] 为入口锚，不改写则启动即退，见下方漂移
// 面登记）。HOME 保持真实值（共享语义不变：db/plugins/MCP 全继承宿主 HOME）。
//
// 漂移面如实登记：
// ① 配置读取路径/方式：zcode 升级若改变，失败信号 = missing baseURL / Model config
//    is missing 明确报错（不静默坏）——与协议漂移直接报错的既有姿态同级。
// ② argv[1] 入口锚：上游 provider bootstrap 以 argv[1] 为入口锚定位 CLI 内建
//    provider 配置（本修复针对的行为事实，import 前改写 argv[1] = CLI_PATH）。3.12.x
//    起内建 provider 配置文件挪位（<cliDir>/provider/ → app Resources/config/provider/，
//    用户侧 ~/.zcode/v2/runtime/provider/<plat>-<arch> 或 Rust arch 变体如
//    darwin-aarch64/<ver>/endpoint-*/），CLI 改为
//    依赖宿主注入 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 定位——wrapper import 前补齐
//    该键（显式传入优先，否则按上述目录派生），缺席时原生报错透出。上游若改变
//    bootstrap 锚定方式，失败信号 = 「无法定位 CLI ZCode Built-in Provider Config」，
//    恢复动作 = 核对 wrapper 的 argv 改写与上游锚定方式是否一致。
// ③ 模块标识维度（require.main / process.mainModule）：import() 形态下仍指向
//    wrapper（CLI 模块自身作用域的 __filename 不受影响，解析为 CLI 自身路径）
//    ——现行 0.16.5 实证无此类消费（行为由 argv[1] 驱动），登记为
//    观察项；上游未来引入模块标识入口判定致静默漂移时，指定对策 = spawn 改
//    `node --require <wrapper> <cliPath>` preload 形态（设计 §3.1 方案 E——wrapper
//    退化为纯 fs-patch preload，argv 与模块标识双双恢复原生）。
//
// D3 换轨装载通道（engine-provider-unification §3.3 D3，2026-10-12 A0 实测后）：
// zcode CLI 0.16.9 的 Provider Registry 个人 provider 供数 = 进程直读真实
// `~/.zcode/v2/provider_config.json`（HOME 覆写与 env 通道均绕不过，wrapper 补注入
// cli config 的条目 Registry 不消费）——同一 patch 基建增加该路径分支：命中时返回
// merge(真实文件实时内容, taiji 同步副本) 的合并 JSON，Registry 直读该路径即读到
// 合并视图。merge 每次读取重算（事实驱动，无缓存/时间窗）；preparer.ts 的校验链
// 读取同一 merge 规则（mergePersonalProviderConfig——两侧对账单测锁步）。
//
// 源码以内嵌字符串形态进 dist bundle（vendored 面只拷 dist/，独立 .cjs 资产会被
// vendor 脚本漏掉——字符串常量无此问题），运行时幂等落盘 engineDataDir。
// （2026-10 review：CLI 源码补丁段与账号元数据段两个字符串区块拆至
// appserver-launcher-patches.ts 载体模块原样内插——行数守卫拆分 + 同批 review 行为
// 修正随段迁移（存在性守卫/括号配平/窗口收紧/语法自检），变更点见段内就地注释。）

import * as fs from "node:fs";
import * as path from "node:path";
import { toErrorMessage } from "./error-message.ts";
import { ACCOUNT_METADATA_SECTION, CLI_PATCH_SECTION } from "./appserver-launcher-patches.ts";

/** wrapper 落盘文件名（engineDataDir/engines/zcode/ 下）。 */
export const ZCODE_APPSERVER_LAUNCHER_NAME = "appserver-launcher.cjs";

/**
 * wrapper 源码（CJS；内容即版本——修改须同步本常量，落盘端按内容幂等覆盖）。
 * CLI 补丁段与元数据段两区块自 appserver-launcher-patches.ts 内插（见该文件头注）。
 * env 契约：ZCODE_ENG_CLI_PATH（zcode.cjs 绝对路径，必填）、
 * ZCODE_ENG_V2_CONFIG（v2 config 路径，缺省 ~/.zcode/v2/config.json）、
 * ZCODE_ENG_PROVIDER_CONFIG（taiji 同步副本路径——D3 换轨后语义收窄：补注入段
 * 读取源 + 真实 provider_config.json 拦截分支的副本源；未设 = 拦截分支不激活）。
 */
export const APPSERVER_LAUNCHER_SOURCE = `'use strict';
// zcode app-server fs 拦截 wrapper（由 zcode-subagent-cli appserver-launcher 落盘生成）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI_PATH = process.env.ZCODE_ENG_CLI_PATH;
const V2_PATH = process.env.ZCODE_ENG_V2_CONFIG || path.join(os.homedir(), '.zcode', 'v2', 'config.json');
// 真实 provider_config.json（Registry 直读路径，A0 探针实证）——与 CONFIG_PATH 同款
// homedir 推导形态，不受 env 重定向（merge 分支要读的正是这个真实路径本身）
const REAL_PROVIDER_CONFIG_PATH = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
// taiji 同步副本路径（ZCODE_ENG_PROVIDER_CONFIG 语义收窄；'' = 未设 → merge 分支不激活）
const PI_SYNCED_PATH = process.env.ZCODE_ENG_PROVIDER_CONFIG || '';
const PROVIDER_CONFIG_PATH = process.env.ZCODE_ENG_PROVIDER_CONFIG || REAL_PROVIDER_CONFIG_PATH;
const CONFIG_PATH = path.join(os.homedir(), '.zcode', 'cli', 'config.json');

// 合并形态：真实 cli config 原样（model/plugins/mcp/subagents 等 worker 继承面不变）
// + v2 的 provider 字典注入，同 id 时 v2 条目整条优先——GUI 直传 modelConfig 时
// v2 即权威源（进程外等价复刻）；cli config 不在 GUI 管理面、可能残留历史验证
// 配置（2026-08-25 事故：残留旧 key 压过新凭据致 turn 0 401），故不取 real 优先。
// model.main 缺失时只从 v2 透传（v2 也没有则不伪造——CLI 缺省解析自会落到注册表
// 可用模型；plan 家族 id 已不可用，不再兜底伪造）。
// [D3 顺带发现 6] provider_config.json（引擎侧模型校验源）补注入：仅存在于
// providerRules 的个人 provider（v2 字典未物化）不在注入集 → app-server 注册表
// 缺条目，显式模型首派即报「Provider Registry 中不存在 Model」。为带 apiKey+baseUrl
// 且 v2/real 均缺失的 rule 合成 cli-config 条目（形状照抄现网个人条目）。
// 返回 null = 无可注入凭据（v2 无 provider 条目）——不 patch，让原生报错透出。
// 读源经 readOrig 间接取：patch 前首调 = fs.readFileSync 本体；patch 后 = 原函数
// （防 patch 后的递归自调用）。
function injectedConfigText() {
  const readOrig = fs.__origReadFileSync || fs.readFileSync;
  let real = {};
  try { real = JSON.parse(readOrig(CONFIG_PATH, 'utf8')); } catch { /* 无/损坏 → 空 */ }
  let v2 = {};
  try { v2 = JSON.parse(readOrig(V2_PATH, 'utf8')); }
  catch (err) {
    // ENOENT = 桌面端未登录（正常 no-patch，不构成错误；跳过决策由安装门日志承载）；其他失败（JSON 损坏/权限）
    // 出声——否则排障会被原生「请登录」报错误导，与真因（文件损坏）不符
    if (!err || err.code !== 'ENOENT') {
      process.stderr.write('[zcode-launcher] v2 config 读取失败(' + ((err && err.code) || (err && err.message) || 'unknown') + '): ' + V2_PATH + '——凭据注入未生效\\n');
    }
    return null;
  }
  const realProviders = real.provider && typeof real.provider === 'object' ? real.provider : {};
  const v2Providers = v2.provider && typeof v2.provider === 'object' ? v2.provider : {};
  const hasKey = (entry) => entry && typeof entry === 'object'
    && entry.options && typeof entry.options.apiKey === 'string' && entry.options.apiKey !== '';
  const injectable = {};
  for (const [id, entry] of Object.entries(v2Providers)) {
    if (hasKey(entry)) injectable[id] = entry;
  }
  // provider_config.json 补注入（读取失败静默降级——校验源缺席时引擎侧校验同样不可
  // 用，注入面维持 v2-only 现状；providerRules 缺失不构成凭据错误）。
  try {
    const pc = JSON.parse(readOrig(PROVIDER_CONFIG_PATH, 'utf8'));
    const pcCfg = pc && typeof pc.config === 'object' && pc.config ? pc.config : {};
    const pcr = typeof pcCfg.providerConfigRules === 'object' && pcCfg.providerConfigRules ? pcCfg.providerConfigRules : {};
    const rules = Array.isArray(pcr.providerRules) ? pcr.providerRules : [];
    const mcr = typeof pcCfg.modelConfigRules === 'object' && pcCfg.modelConfigRules ? pcCfg.modelConfigRules : {};
    const modelRules = Array.isArray(mcr.providerModelRules) ? mcr.providerModelRules : [];
    const modelMeta = {};
    for (const mr of modelRules) {
      if (!mr || typeof mr !== 'object' || typeof mr.providerId !== 'string' || typeof mr.modelId !== 'string') continue;
      (modelMeta[mr.providerId] = modelMeta[mr.providerId] || []).push(mr);
    }
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue;
      const id = typeof rule.providerId === 'string' ? rule.providerId : '';
      const cfg = rule.config && typeof rule.config === 'object' ? rule.config : {};
      const access = cfg.access && typeof cfg.access === 'object' ? cfg.access : {};
      const api = cfg.api && typeof cfg.api === 'object' ? cfg.api : {};
      // v2/real 已有 → 不重复合成（v2 条目更全，整条优先语义不受影响）
      if (!id || injectable[id] || realProviders[id]) continue;
      // hasKey 纪律同款：无 apiKey 不合成；无 baseUrl（endpoint 由模板提供的形态）
      // 不合成——残缺条目比不注入更糟，原生「不存在 Model」报错照旧透出
      if (typeof access.apiKey !== 'string' || access.apiKey === '') continue;
      if (typeof api.baseUrl !== 'string' || api.baseUrl === '') continue;
      const order = Array.isArray(cfg.modelOrder) ? cfg.modelOrder
        : (Array.isArray(cfg.personalModelIds) ? cfg.personalModelIds : []);
      const models = {};
      for (const mr of modelMeta[id] || []) {
        const mrCfg = mr.config && typeof mr.config === 'object' ? mr.config : {};
        if (mrCfg.enabled === false) continue; // 禁用模型不进注册表（GUI 语义一致）
        const props = mrCfg.properties && typeof mrCfg.properties === 'object' ? mrCfg.properties : {};
        models[mr.modelId] = typeof props.contextWindow === 'number'
          ? { limit: { context: props.contextWindow } }
          : {};
      }
      for (const mid of order) {
        if (typeof mid === 'string' && mid !== '' && !(mid in models)) models[mid] = {};
      }
      // kind 按条目 api.type 派生（D3）：anthropic-messages → anthropic，其余
      // （openai-chat-completions / api.type 缺席 / 未知值）→ openai-compatible
      // ——对齐 v2 config.json 既有 kind 两值形态；作用于补注入段全部条目（含透传
      // 真实条目，anthropic 协议真实条目从旧错配值 openai-compatible 顺带修正）。
      // 未知协议值错配时请求期协议错误可见（不阻塞注册表装载），真机漂移信号明确
      injectable[id] = {
        name: typeof rule.providerName === 'string' ? rule.providerName : id,
        kind: api.type === 'anthropic-messages' ? 'anthropic' : 'openai-compatible',
        options: { apiKey: access.apiKey, baseURL: api.baseUrl },
        source: 'custom',
        models: models,
      };
    }
  } catch { /* provider_config 缺失/损坏 → 补注入面静默降级（v2 注入不受影响） */ }
  if (Object.keys(injectable).length === 0) return null;
  const merged = { ...real };
  merged.provider = { ...realProviders, ...injectable };
  if ((!merged.model || typeof merged.model !== 'object' || !merged.model.main)
      && v2.model && typeof v2.model === 'object' && v2.model.main) {
    merged.model = { ...(merged.model || {}), main: v2.model.main };
  }
  return JSON.stringify(merged);
}

// [merge-fn-start]（对账单测提取锚——appserver-launcher.test.ts 按标记截取本函数
// eval 执行；preparer.ts mergePersonalProviderConfig 与本函数同规则锁步，改任一侧
// 须同步另一侧并跑对账单测）
// merge(真实, 副本)——D3 换轨版规则：
//   - 副本非对象 → 原样返回 real（副本缺席回落语义；wrapper 侧更早短路，防御形态）
//   - 真实非对象（ENOENT/损坏）→ 原样返回 copy（副本独有条目为全集：providerRules
//     仅副本条目 + order 仅副本序，顶层字段随副本保持形态完整）
//   - providerRules：真实条目整条保留在前，副本独有 id 追加（真实优先 = 同名让位
//     的运行时第二道防线）；无有效 providerId 的副本条目丢弃，真实条目原样保留
//   - providerOrder：真实现值序 + 副本独有 id 追加（去重保序）
//   - 其余字段（含 config 内其他键）取真实现值
function mergeProviderConfig(realObj, copyObj) {
  const isRec = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isRec(copyObj)) return realObj;
  if (!isRec(realObj)) return copyObj;
  const cfgOf = (obj) => (isRec(obj.config) ? obj.config : {});
  const rulesOf = (obj) => {
    const pcr = cfgOf(obj).providerConfigRules;
    const r = isRec(pcr) ? pcr.providerRules : undefined;
    return Array.isArray(r) ? r : [];
  };
  const strArr = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim() !== '') : []);
  const mergedRules = [];
  const seen = {};
  for (const rule of rulesOf(realObj)) {
    mergedRules.push(rule);
    if (isRec(rule) && typeof rule.providerId === 'string' && rule.providerId !== '') seen[rule.providerId] = true;
  }
  for (const rule of rulesOf(copyObj)) {
    if (!isRec(rule) || typeof rule.providerId !== 'string' || rule.providerId === '') continue;
    if (seen[rule.providerId]) continue;
    seen[rule.providerId] = true;
    mergedRules.push(rule);
  }
  const mergedOrder = [];
  for (const id of strArr(cfgOf(realObj).providerOrder).concat(strArr(cfgOf(copyObj).providerOrder))) {
    if (mergedOrder.indexOf(id) === -1) mergedOrder.push(id);
  }
  const outCfg = Object.assign({}, cfgOf(realObj), {
    providerOrder: mergedOrder,
    providerConfigRules: Object.assign(
      {},
      isRec(cfgOf(realObj).providerConfigRules) ? cfgOf(realObj).providerConfigRules : {},
      { providerRules: mergedRules },
    ),
  });
  return Object.assign({}, realObj, { config: outCfg });
}
// [merge-fn-end]

// D3 换轨装载通道：命中真实 provider_config.json 的读取重定向为 merge(真实实时
// 内容, taiji 同步副本)——每次读取重算（事实驱动，无缓存/时间窗，ZCode 端变更
// 实时生效）。副本缺失/不可读 → null = 调用方短路回原文件（回落真实文件语义，
// 零行为变化）；env 未设 → null（分支不激活）。读取一律经 readOrig 间接取（防
// patch 面递归自调用）。
function mergedProviderConfigText() {
  if (!PI_SYNCED_PATH) return null;
  const readOrig = fs.__origReadFileSync || fs.readFileSync;
  let copyObj;
  try {
    copyObj = JSON.parse(readOrig(PI_SYNCED_PATH, 'utf8'));
  } catch { return null; }
  if (!copyObj || typeof copyObj !== 'object' || Array.isArray(copyObj)) return null;
  let realObj = null;
  try {
    const parsed = JSON.parse(readOrig(REAL_PROVIDER_CONFIG_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) realObj = parsed;
  } catch { /* ENOENT/损坏 → 副本独有条目为全集 */ }
  return JSON.stringify(mergeProviderConfig(realObj, copyObj));
}

if (!CLI_PATH) {
  process.stderr.write('[zcode-launcher] ZCODE_ENG_CLI_PATH 未设置，无法启动 app-server（该 env 由引擎自动设置；手工运行 wrapper 需显式传入）\\n');
  process.exit(2);
}

// [2026-10-13 account 直通] 内建目录读取拦截：给 zhipu-account 条目注入 entitled:true。
// app-server 注册表装载判据 = access.entitled === true，外部 spawn 从目录构建的账号
// 条目默认非 entitled（YXe 硬编码 !1）→ plan 家族引用一律「不存在 Model」。用户裁决：
// zai 系走 account provider 配置并绕过该限制——patch 只发生在本 wrapper 的读取返回值，
// ZCode.app 磁盘文件零触碰。null = 目录无 zhipu-account 条目（无需 patch）。
// 本函数必须以定位后的真实路径调用（安装门传 CATALOG_PATH）——无参调用会在读文件
// 时抛错被 catch 恒返 null，曾致纯 account 宿主补丁层静默不安装（见安装门处注释）。
let CATALOG_PATH = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || null;
const __catalogPatchCache = new Map();
// 跳过决策归因（2026-10 审查补）：catalogPatchText 把「无条目需补」与「读取/解析失败
// （文件缺失/损坏）」都折成 null，跳过日志若不区分会把损坏态误报成「无条目」，排障被误导
const __catalogPatchStatus = new Map(); // path -> 'no-entries' | 'unreadable'
function catalogPatchText(path) {
  if (__catalogPatchCache.has(path)) return __catalogPatchCache.get(path);
  let result = null;
  try {
    const readOrig = fs.__origReadFileSync || fs.readFileSync;
    const parsed = JSON.parse(readOrig(path, 'utf8'));
    const rules = parsed && parsed.config && parsed.config.providerConfigRules
      && Array.isArray(parsed.config.providerConfigRules.providerRules)
      ? parsed.config.providerConfigRules.providerRules : null;
    let touched = 0;
    if (rules) for (const rule of rules) {
      const acc = rule && rule.config && rule.config.access;
      if (acc && acc.type === 'zhipu-account' && acc.entitled !== true) { acc.entitled = true; touched++; }
    }
    result = touched > 0 ? JSON.stringify(parsed) : null;
    __catalogPatchStatus.set(path, 'no-entries');
  } catch { result = null; __catalogPatchStatus.set(path, 'unreadable'); }
  __catalogPatchCache.set(path, result);
  return result;
}

${CLI_PATCH_SECTION}

// 内建 provider 配置定位（漂移面②）：3.12.x 起配置文件挪位 + CLI 依赖宿主注入
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 直接定位；ZCode 桌面 spawn 链自带该键，
// 本 wrapper 链需自给。显式传入优先 → v2 runtime 目录下平台目录（精确
// <plat>-<arch> 优先，Rust arch 变体如 darwin-aarch64 字典序跟后）× 版本目录
// （semver 最大）的 endpoint-*/zcode-builtin.json → 都找不到则不设键，让 CLI
// 原生报错透出（错误文案含恢复指引）。
// [位置：安装门之前] 定位/env 推导必须先于安装门判定完成——catalogPatchText
// 需要定位后的真实路径参与门判定。曾因门先于定位执行且无参调用，
// fs.readFileSync(undefined) 抛错被 catch 恒返 null → 门退化为 text!==null，
// 纯 account 宿主（v2 无凭据条目 → text=null）下补丁层静默不安装、account
// 直通整体失效且零日志（2026-10 回归修复）。
if (!process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
  let located = null;
  try {
    const providerRoot = path.join(os.homedir(), '.zcode', 'v2', 'runtime', 'provider');
    // 平台目录双命名：Node 形态 <plat>-<arch>（darwin-arm64）与桌面 app 的 Rust
    // arch 命名（darwin-aarch64/linux-x86_64）并存——按平台前缀收集子目录，
    // 精确形态排最先（向后兼容自建布局），Rust 变体按字典序跟后逐个尝试
    const exact = process.platform + '-' + process.arch;
    const platDirs = fs.readdirSync(providerRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(process.platform + '-'))
      .map((d) => d.name)
      .sort((a, b) => {
        if ((a === exact) !== (b === exact)) return a === exact ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    const byVerDesc = (a, b) => {
      const pa = a.split('.'), pb = b.split('.');
      for (let i = 0; i < 3; i++) {
        const na = parseInt(pa[i], 10) || 0, nb = parseInt(pb[i], 10) || 0;
        if (na !== nb) return nb - na;
      }
      return 0;
    };
    for (const plat of platDirs) {
      const rtRoot = path.join(providerRoot, plat);
      let vers = [];
      try { vers = fs.readdirSync(rtRoot).filter((v) => /^\\d+\\.\\d+/.test(v)).sort(byVerDesc); } catch { /* 平台目录不可读 → 试下一个 */ }
      for (const ver of vers) {
        const verDir = path.join(rtRoot, ver);
        let endpoints = [];
        try { endpoints = fs.readdirSync(verDir).filter((e) => e.startsWith('endpoint-')).sort(); } catch { /* 版本目录不可读 → 跳过 */ }
        for (const ep of endpoints) {
          const candidate = path.join(verDir, ep, 'zcode-builtin.json');
          if (fs.existsSync(candidate)) { located = candidate; break; }
        }
        if (located) break;
      }
      if (located) break;
    }
  } catch { /* provider 目录缺失/不可读 → 不设键 */ }
  if (located) process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = located;
  CATALOG_PATH = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || null;
  // endpoint origin 对齐（2026-09-29 迁移同步）：CLI 按 ZCODE_BASE_URL 派生 active
  // 目录路径（sha256(origin) 前缀）；GUI 安装的目录在 refresh 控制文件的 endpointKey
  // 下（如 https://zcode.z.ai），与 CLI 缺省 origin（bigmodel.cn）不同——不注入则
  // active 路径算到不存在的目录，触发无谓的联网重装尝试。从已定位目录的邻位控制
  // 文件读出 origin 注入（无硬编码）；显式 env 优先，不覆盖。
  if (located && !process.env.ZCODE_BASE_URL && !process.env.ZCODE_ENDPOINT_ORIGIN) {
    try {
      const ctlPath = path.join(path.dirname(located), 'zcode-builtin-refresh.json');
      const ctlText = fs.__origReadFileSync
        ? fs.__origReadFileSync.call(fs, ctlPath, 'utf8')
        : fs.readFileSync(ctlPath, 'utf8');
      const ctl = JSON.parse(ctlText);
      if (ctl && typeof ctl.endpointKey === 'string' && ctl.endpointKey.indexOf('http') === 0) {
        process.env.ZCODE_BASE_URL = ctl.endpointKey;
      }
    } catch { /* 控制文件缺失/损坏 → 不注入（CLI 用缺省 origin 派生） */ }
  }
}

${ACCOUNT_METADATA_SECTION}

// 安装门：任一 patch 源可用即安装拦截层；决策两态都出声（装了哪些 patch / 为何
// 跳过）——补丁层的失效形态是静默的（account 直通失效 = plan 家族报「不存在
// Model」而无任何日志），跳过同样必须留痕。
const text = injectedConfigText();
const catalogPatch = CATALOG_PATH !== null ? catalogPatchText(CATALOG_PATH) : null;
const cliPatchProbe = CLI_PATH ? patchedCliSource(CLI_PATH) : null;
// 三处改写的应用态由 patchedCliSource 发布（__cliPatchStatus）——曾以产物子串判定：
// header-port 在未打补丁的 3.15.3 bundle 上恒真（8 处既有同名属性）→ 门对锚点
// 漂移零检测力；standalone 同理由标志驱动（三处判定各自具名）。
const cliPatchStatus = CLI_PATH ? __cliPatchStatus.get(CLI_PATH) : null;
if (text !== null || catalogPatch !== null || cliPatchProbe !== null) {
  process.stderr.write('[zcode-launcher] 补丁层已安装: cli-config-inject=' + (text !== null ? 'on' : 'off')
    + ', catalog-entitled=' + (catalogPatch !== null ? 'on' : 'off')
    + ', provider-merge=' + (PI_SYNCED_PATH ? 'armed' : 'off')
    + ', cli-source-bypass=' + (cliPatchProbe !== null ? 'armed' : 'off')
    + ', standalone-account=' + (cliPatchStatus && cliPatchStatus.standalone ? 'armed' : 'off')
    + ', header-port=' + (cliPatchStatus && cliPatchStatus.headerPort ? 'armed' : 'off') + '\\n');
  // encoding 归一（Node 别名面）：'utf8'/'utf-8'/大小写变体统一按 string 返回——
  // 真实 bundle 的 config 读取恰用 'utf-8' 形态，仅匹配 'utf8' 会错回 Buffer
  // （当下游不只 JSON.parse 而做字符串运算时即 TypeError）
  // shape 同时服务四处 patch 源（config / provider merge / 内建目录 / ——encoding 归一
  // 语义相同，单副本：目录条目曾另持逐字重复副本 catalogShape，已并回本函数）
  const shape = (args, value) => {
    const enc = args[0];
    const e = typeof enc === 'string' ? enc
      : (enc && typeof enc === 'object' && typeof enc.encoding === 'string' ? enc.encoding : undefined);
    if (e !== undefined && String(e).toLowerCase().replace(/-/g, '') === 'utf8') return value;
    return Buffer.from(value);
  };
  fs.__origReadFileSync = fs.readFileSync;
  // standalone 账号元数据键供给（ADR-0139）：仅当 standalone 补丁已武装时执行——
  // 未武装（上游漂移/版本不支持）时这些键无消费方，写用户共享 credentials.json
  // 只增风险；此处读源仍是原生 fs（readFileSync 拦截尚未安装）。
  if (cliPatchStatus && cliPatchStatus.standalone) ensureAccountMetadata();
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p === CONFIG_PATH) {
      const cur = injectedConfigText();
      if (cur !== null) return shape(rest, cur);
    }
    // D3 换轨：Registry 直读真实 provider_config.json → merge(真实, 副本) 视图
    if (typeof p === 'string' && p === REAL_PROVIDER_CONFIG_PATH) {
      const cur = mergedProviderConfigText();
      if (cur !== null) return shape(rest, cur);
    }
    // account 直通：内建目录读取 → zhipu-account 注入 entitled:true。按文件名匹配
    // （app-server 按 ZCODE_BASE_URL 自派生 endpoint 目录，读路径≠env 定位路径）。
    if (typeof p === 'string' && p.endsWith('zcode-builtin.json')) {
      const cur = catalogPatchText(p);
      if (cur !== null) return shape(rest, cur);
    }
    // account 直通②：CLI bundle 源码 → YXe entitled:!1 内存翻转为 !0
    if (typeof p === 'string' && p === CLI_PATH) {
      const cur = patchedCliSource(p);
      if (cur !== null) return cur;
    }
    return fs.__origReadFileSync.call(fs, p, ...rest);
  };
  fs.promises.__origReadFile = fs.promises.readFile;
  fs.promises.readFile = function (p, ...rest) {
    if (typeof p === 'string' && p === CONFIG_PATH) {
      const cur = injectedConfigText();
      if (cur !== null) return Promise.resolve(shape(rest, cur));
    }
    if (typeof p === 'string' && p === REAL_PROVIDER_CONFIG_PATH) {
      const cur = mergedProviderConfigText();
      if (cur !== null) return Promise.resolve(shape(rest, cur));
    }
    if (typeof p === 'string' && p.endsWith('zcode-builtin.json')) {
      const cur = catalogPatchText(p);
      if (cur !== null) return Promise.resolve(shape(rest, cur));
    }
    if (typeof p === 'string' && p === CLI_PATH) {
      const cur = patchedCliSource(p);
      if (cur !== null) return Promise.resolve(cur);
    }
    return fs.promises.__origReadFile.call(fs.promises, p, ...rest);
  };
  // [account 直通② 载体] .js 扩展处理器挂钩：Node 对 CJS 入口源码的读取走原生
  // internalModuleReadFile 通道，fs 猴补丁不可见——CLI bundle 源码补丁改在扩展
  // 处理器层拦截（仅命中 CLI_PATH；其余文件全权委托原 handler，零额外开销）。
  const __Module = require('node:module');
  const __origJsHandler = __Module._extensions['.js'];
  __Module._extensions['.js'] = function (mod, filename) {
    if (CLI_PATH && filename === CLI_PATH) {
      const patched = patchedCliSource(filename);
      if (patched !== null) {
        let src = patched.charCodeAt(0) === 0xfeff ? patched.slice(1) : patched;
        if (src.startsWith('#!')) src = src.slice(src.indexOf('\\n') + 1);
        return mod._compile(src, filename);
      }
    }
    return __origJsHandler(mod, filename);
  };

  // existsSync 拦截：真实 bundle 的用户 config 读取（loadFileConfig）以 existsSync
  // 为短路门——文件不存在时返回空 config 且 readFileSync 不被调用，GUI-only
  // 登录宿主（cli/config.json 从未被 CLI 侧写过）上注入只挂在读取面 = 不可见。
  // D3 换轨：真实 provider_config.json 的存在性 = 真实或副本任一存在即 true
  //（真实缺失 + 副本存在时 Registry 的 existsSync 门不得拦掉 merge 视图读取）
  fs.__origExistsSync = fs.existsSync;
  fs.existsSync = function (p) {
    if (typeof p === 'string' && p === CONFIG_PATH) {
      const cur = injectedConfigText();
      if (cur !== null) return true;
    }
    if (typeof p === 'string' && p === REAL_PROVIDER_CONFIG_PATH && PI_SYNCED_PATH) {
      if (fs.__origExistsSync.call(fs, REAL_PROVIDER_CONFIG_PATH)) return true;
      return fs.__origExistsSync.call(fs, PI_SYNCED_PATH);
    }
    return fs.__origExistsSync.call(fs, p);
  };
} else {
  process.stderr.write('[zcode-launcher] 补丁层未安装(跳过): 无凭据可注入(v2 config 无 provider 条目)'
    + (CATALOG_PATH !== null
      ? (__catalogPatchStatus.get(CATALOG_PATH) === 'unreadable'
        ? '; 内建目录已定位但 catalog 读取/解析失败(文件缺失或损坏，排障入口: zcode-builtin.json——非「无条目」)'
        : '; 内建目录已定位但无 zhipu-account 条目需补(目录读取原生透出)')
      : '; 内建目录未定位(env 未设且自定位未命中)')
    + '\\n');
}

// 上游 provider bootstrap 以 argv[1] 为入口锚，从该路径邻近定位 CLI 内建
// provider 配置——wrapper 形态下 argv[1] = 本 wrapper 落盘路径，bootstrap 会在
// wrapper 邻域找 provider 配置而失败（真机报「无法定位 CLI ZCode Built-in Provider
// Config」启动即退）。import 前把 argv[1] 改写为 CLI_PATH：CLI 看到的 argv 序列与
// 无 wrapper 直跑（node <cliPath> app-server ...）逐位一致，argv[0]=node、
// argv[2]='app-server' 不变，includes('app-server') 子命令判定不受影响。
// import() 兼容 CJS/ESM 入口。
process.argv[1] = CLI_PATH;
import(CLI_PATH).catch((err) => {
  process.stderr.write('[zcode-launcher] zcode.cjs 加载失败: ' + (err && err.message || err) + '\\n');
  process.exit(3);
});
`;

/**
 * 幂等落盘 launcher 脚本并返回其绝对路径（内容未变跳过写——mtime 免重写）。
 * @param engineDataDir 引擎数据根（launcher 落 engineDataDir/engines/zcode/）
 */
export function ensureAppServerLauncher(engineDataDir: string): string {
  const dir = path.join(engineDataDir, "engines", "zcode");
  const file = path.join(dir, ZCODE_APPSERVER_LAUNCHER_NAME);
  const existing = fs.existsSync(file) && fs.statSync(file).isFile()
    ? fs.readFileSync(file, "utf8")
    : undefined;
  if (existing === APPSERVER_LAUNCHER_SOURCE) return file;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, APPSERVER_LAUNCHER_SOURCE);
    fs.renameSync(tmp, file);
  } catch (err) {
    // 裸 errno（EACCES/ENOSPC）不含恢复动作——与 probe 失败的错误姿态对齐
    const reason = toErrorMessage(err);
    throw new Error(
      `zcode app-server launcher 落盘失败: ${file}（${reason}）。恢复：检查引擎数据目录` +
        ` 写权限与磁盘空间（engineDataDir 由宿主传入，路径见上）后重试。`,
    );
  }
  return file;
}
