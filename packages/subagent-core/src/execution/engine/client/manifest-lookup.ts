// src/execution/engine/client/manifest-lookup.ts
//
// manifest 注册期快照的纯查表面（自 remote-engine.ts 提取，行为等价）：
// ① 模型目录命中（matchCatalogEntry）——validateModel 的静态目录判定；
// ② 跨引擎模型 ref 翻译（translateByTable / translateByTableReverse 正反向）——
//    [engine-ref-translation D5] 声明表查表改写。
// 提取动机：remote-engine.ts 折算行越过 max-lines 500；全部是无状态、无 this 依赖的
// 纯查表函数，独立成文件不改变调用语义（remote-engine.test.ts /
// remote-engine-translation.test.ts 全量覆盖）。

import type { ModelCatalogEntry } from "@zhushanwen/subagent-engine-sdk";

/** manifest 目录条目命中：id / canonicalRef / 任一 alias 与 ref 全等。 */
export function matchCatalogEntry(
  entries: ModelCatalogEntry[],
  ref: string,
): ModelCatalogEntry | undefined {
  return entries.find(
    (entry) =>
      entry.id === ref || entry.canonicalRef === ref || entry.aliases?.includes(ref) === true,
  );
}

/**
 * [engine-ref-translation D5] 翻译面（manifest 声明表查表改写，同步无协议）：
 * ref 含 "/" 时按 provider 段查快照表命中改写、未命中原样透传（幂等——翻译产物
 * 的 account:/个人 id 不在表内）；模型段原样保留（大小写归一由引擎侧再翻译承担
 * ——引擎内 resolveZcodeModelRef 的同名翻译分支对翻译产物幂等，且持内建目录
 * 可做清单校验/大小写归一，代理侧无目录不复制该职责）。
 *
 * 与 in-process 引擎类实装（如 zcode translatePiModelRefToZcode）的语义差：
 * 代理侧纯查表不触目录（无 model_not_available 抛错面）——目录校验失败在引擎
 * 侧 prepare 期显式报错承接（首败即停语义不变，仅失败时点后移到 record 创建后
 * ——cli 形态的既有取舍）。声明表缺席时本成员已在 RemoteEngine 构造器摘除。
 *
 * 自有属性判定（Object.hasOwn）：table 来自 manifest JSON，原型链键（toString /
 * constructor）不得当作合法 provider 段命中（`toString/model` 必须原样透传）。
 */
export function translateByTable(
  table: Record<string, string>,
  modelRef: string,
): string {
  if (!modelRef.includes("/")) return modelRef;
  const provider = modelRef.slice(0, modelRef.indexOf("/"));
  const target = Object.hasOwn(table, provider) ? table[provider] : undefined;
  if (target === undefined) return modelRef;
  return `${target}/${modelRef.slice(modelRef.indexOf("/") + 1)}`;
}

/**
 * 反向查表改写（translateByTable 的逆半边）：声明表值域（引擎原生 provider 段）→
 * 键域（pi 词汇 provider 段）。消费方 = 宿主显示侧——record 盖章值是派发期正向翻译
 * 后的引擎原生 ref，而展示链（下拉候选 / 覆盖意图 / 目录校验）全程 pi 词汇，显示前
 * 需翻回。provider 段按值反查（Object.entries 只遍历自有键，原型链值不入表）；未
 * 命中 / 裸 id 不分段恒等透传（1:1 provider 的 ref 本就是 pi 词汇；反向幂等——
 * 翻回产物（pi 词汇）不在值域，再入恒等）。模型段原样保留（两世界大小写拼写差由
 * 消费方按 pi 清单行归一，本层无清单不复制该职责）。
 */
export function translateByTableReverse(
  table: Record<string, string>,
  modelRef: string,
): string {
  const i = modelRef.indexOf("/");
  if (i <= 0) return modelRef;
  const provider = modelRef.slice(0, i);
  const piProvider = Object.entries(table).find(([, native]) => native === provider)?.[0];
  if (piProvider === undefined) return modelRef;
  return `${piProvider}/${modelRef.slice(i + 1)}`;
}
