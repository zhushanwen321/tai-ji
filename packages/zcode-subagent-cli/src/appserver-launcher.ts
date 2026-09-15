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
// 直传 modelConfig），再以原 argv 启动 zcode.cjs。HOME 保持真实值（共享语义
// 不变：db/plugins/MCP 全继承宿主 HOME）。
//
// 漂移面如实登记：zcode 升级若改变配置读取路径/方式，失败信号 = missing baseURL /
// Model config is missing 明确报错（不静默坏）——与协议漂移直接报错的既有姿态同级。
//
// 源码以内嵌字符串形态进 dist bundle（vendored 面只拷 dist/，独立 .cjs 资产会被
// vendor 脚本漏掉——字符串常量无此问题），运行时幂等落盘 engineDataDir。

import * as fs from "node:fs";
import * as path from "node:path";
import { toErrorMessage } from "./error-message.ts";

/** wrapper 落盘文件名（engineDataDir/engines/zcode/ 下）。 */
export const ZCODE_APPSERVER_LAUNCHER_NAME = "appserver-launcher.cjs";

/**
 * wrapper 源码（CJS；内容即版本——修改须同步本常量，落盘端按内容幂等覆盖）。
 * env 契约：ZCODE_ENG_CLI_PATH（zcode.cjs 绝对路径，必填）、
 * ZCODE_ENG_V2_CONFIG（v2 config 路径，缺省 ~/.zcode/v2/config.json）。
 */
export const APPSERVER_LAUNCHER_SOURCE = `'use strict';
// zcode app-server fs 拦截 wrapper（由 zcode-subagent-cli appserver-launcher 落盘生成）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI_PATH = process.env.ZCODE_ENG_CLI_PATH;
const V2_PATH = process.env.ZCODE_ENG_V2_CONFIG || path.join(os.homedir(), '.zcode', 'v2', 'config.json');
const CONFIG_PATH = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
// 与 constants.ts ZCODE_FALLBACK_DEFAULT_MODEL 双源（内嵌字符串无法 import）——改那边须同步此处
const FALLBACK_MODEL_MAIN = 'builtin:bigmodel-coding-plan/GLM-5.3';

// 合并形态：真实 cli config 原样（model/plugins/mcp/subagents 等 worker 继承面不变）
// + v2 的 provider 字典注入，同 id 时 v2 条目整条优先——GUI 直传 modelConfig 时
// v2 即权威源（进程外等价复刻）；cli config 不在 GUI 管理面、可能残留历史验证
// 配置（2026-08-25 事故：残留旧 key 压过新凭据致 turn 0 401），故不取 real 优先。
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
    // ENOENT = 桌面端未登录（正常 no-patch，静默）；其他失败（JSON 损坏/权限）
    // 出声——否则排障会被原生「请登录」报错误导，与真因（文件损坏）不符
    if (!err || err.code !== 'ENOENT') {
      process.stderr.write('[zcode-launcher] v2 config 读取失败(' + ((err && err.code) || (err && err.message) || 'unknown') + '): ' + V2_PATH + '——凭据注入未生效\\n');
    }
    return null;
  }
  const v2Providers = v2.provider && typeof v2.provider === 'object' ? v2.provider : {};
  const hasKey = (entry) => entry && typeof entry === 'object'
    && entry.options && typeof entry.options.apiKey === 'string' && entry.options.apiKey !== '';
  const injectable = {};
  for (const [id, entry] of Object.entries(v2Providers)) {
    if (hasKey(entry)) injectable[id] = entry;
  }
  if (Object.keys(injectable).length === 0) return null;
  const merged = { ...real };
  merged.provider = { ...(real.provider && typeof real.provider === 'object' ? real.provider : {}), ...injectable };
  if (!merged.model || typeof merged.model !== 'object' || !merged.model.main) {
    const main = (v2.model && v2.model.main) || FALLBACK_MODEL_MAIN;
    merged.model = { ...(merged.model || {}), main };
  }
  return JSON.stringify(merged);
}

if (!CLI_PATH) {
  process.stderr.write('[zcode-launcher] ZCODE_ENG_CLI_PATH 未设置，无法启动 app-server（该 env 由引擎自动设置；手工运行 wrapper 需显式传入）\\n');
  process.exit(2);
}

const text = injectedConfigText();
if (text !== null) {
  // encoding 归一（Node 别名面）：'utf8'/'utf-8'/大小写变体统一按 string 返回——
  // 真实 bundle 的 config 读取恰用 'utf-8' 形态，仅匹配 'utf8' 会错回 Buffer
  // （当下游不只 JSON.parse 而做字符串运算时即 TypeError）
  const shape = (args, value) => {
    const enc = args[0];
    const e = typeof enc === 'string' ? enc
      : (enc && typeof enc === 'object' && typeof enc.encoding === 'string' ? enc.encoding : undefined);
    if (e !== undefined && String(e).toLowerCase().replace(/-/g, '') === 'utf8') return value;
    return Buffer.from(value);
  };
  fs.__origReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p === CONFIG_PATH) {
      const cur = injectedConfigText();
      if (cur !== null) return shape(rest, cur);
    }
    return fs.__origReadFileSync.call(fs, p, ...rest);
  };
  fs.promises.__origReadFile = fs.promises.readFile;
  fs.promises.readFile = function (p, ...rest) {
    if (typeof p === 'string' && p === CONFIG_PATH) {
      const cur = injectedConfigText();
      if (cur !== null) return Promise.resolve(shape(rest, cur));
    }
    return fs.promises.__origReadFile.call(fs.promises, p, ...rest);
  };
  // existsSync 拦截：真实 bundle 的用户 config 读取（loadFileConfig）以 existsSync
  // 为短路门——文件不存在时返回空 config 且 readFileSync 不被调用，GUI-only
  // 登录宿主（cli/config.json 从未被 CLI 侧写过）上注入只挂在读取面 = 不可见
  fs.__origExistsSync = fs.existsSync;
  fs.existsSync = function (p) {
    if (typeof p === 'string' && p === CONFIG_PATH) {
      const cur = injectedConfigText();
      if (cur !== null) return true;
    }
    return fs.__origExistsSync.call(fs, p);
  };
}

// 以原 argv 形态启动 zcode.cjs（argv[0]=node, argv[1]=本 wrapper，argv[2]=app-server——
// zcode.cjs 的 includes('app-server') 判定不受影响）。import() 兼容 CJS/ESM 入口。
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
