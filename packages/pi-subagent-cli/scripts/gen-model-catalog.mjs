#!/usr/bin/env node
// scripts/gen-model-catalog.mjs — `pnpm gen:model-catalog`（impl-plan §2.7）
//
// 构建期生成 manifest modelCatalog 快照：读宿主 ~/.pi/agent/models.json（pi 的
// 自定义模型清单），生成 ModelCatalogEntry[] 写入 package.json 的
// taiji.subagentEngine.modelCatalog。
//
// 语义边界：pi 模型面是运行期动态的（provider 可用性 / 自定义 models.json 随时
// 变化），构建期快照只服务于「静态目录消费面」（RemoteEngine.validateModel 的
// manifest 判定）；dynamic 恒 true——快照未命中不构成同步拒（运行期 pi 本体解析
// 仍是权威）。无 models.json（CI / 未配置宿主）→ models: [] 占位（显式空清单 =
// 生成器缺席态，运行期 listModels 诊断面给真值）。**绝不把 apiKey 或任何凭据
// 字段写进产物**（只取 provider/model id）。

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PKG = new URL("../package.json", import.meta.url);
const PI_MODELS = join(homedir(), ".pi", "agent", "models.json");

function main() {
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  let models = [];
  try {
    const raw = JSON.parse(readFileSync(PI_MODELS, "utf8"));
    // pi models.json 形态：{ "<provider>": { models: { "<id>": {...} } } }
    if (raw && typeof raw === "object") {
      for (const [pid, entry] of Object.entries(raw)) {
        const list = entry && typeof entry === "object" && entry.models && typeof entry.models === "object"
          ? Object.keys(entry.models)
          : [];
        for (const model of list) models.push({ id: `${pid}/${model}`, canonicalRef: `${pid}/${model}` });
      }
    }
  } catch {
    // 无 models.json / 解析失败 → 空（占位形态，见文件头语义边界）
  }
  // 去重（同 id 多源时 manifest 快照只保留一份）
  models = [...new Map(models.map((m) => [m.id, m])).values()];
  pkg["taiji"].subagentEngine.modelCatalog = { dynamic: true, models };
  writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`[gen-model-catalog] wrote ${models.length} model entries (${PI_MODELS} source)`);
}

main();
