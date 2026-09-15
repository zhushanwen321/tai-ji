#!/usr/bin/env node
// scripts/gen-model-catalog.mjs — `pnpm gen:model-catalog`（impl-plan §2.5）
//
// 构建期生成 manifest modelCatalog 快照：读宿主 ~/.zcode/v2/config.json（ZCode
// 桌面登录态，与运行期 preparer.listZcodeModels 同判据——带 apiKey 的 provider ×
// 其 models 清单），生成 ModelCatalogEntry[] 写入 package.json 的
// taiji.subagentEngine.modelCatalog。
//
// 语义边界（deviation 登记，见任务书验收）：zcode 模型面是运行期动态的（桌面端
// 登录态决定），构建期快照只服务于「静态目录消费面」（RemoteEngine.validateModel
// 的 manifest 判定）；dynamic 恒 true——快照未命中不构成同步拒（运行期
// resolveZcodeModelRef 仍是权威）。无 v2 config（CI / 未登录宿主）→ models: []
// 占位（显式空清单 = 生成器缺席态，运行期 listModels 诊断面给真值）。
// **绝不把 apiKey 或任何凭据字段写进产物**（只取 provider/model id）。

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PKG = new URL("../package.json", import.meta.url);
const V2_CONFIG = join(homedir(), ".zcode", "v2", "config.json");

function hasApiKey(entry) {
  return Boolean(
    entry && typeof entry === "object" &&
    entry.options && typeof entry.options.apiKey === "string" && entry.options.apiKey !== "",
  );
}

function main() {
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  let providers = {};
  try {
    const v2 = JSON.parse(readFileSync(V2_CONFIG, "utf8"));
    if (v2 && typeof v2.provider === "object" && v2.provider !== null) providers = v2.provider;
  } catch {
    // 未登录 / 无 config → 空（占位形态，见文件头语义边界）
  }
  const models = [];
  for (const [pid, entry] of Object.entries(providers)) {
    if (!hasApiKey(entry)) continue;
    const list = entry.models && typeof entry.models === "object" ? Object.keys(entry.models) : [];
    for (const model of list) models.push({ id: `${pid}/${model}`, canonicalRef: `${pid}/${model}` });
  }
  pkg["taiji"].subagentEngine.modelCatalog = { dynamic: true, models };
  writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`[gen-model-catalog] wrote ${models.length} model entries (${V2_CONFIG} source)`);
}

main();
