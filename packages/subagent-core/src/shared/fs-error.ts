// src/shared/fs-error.ts
//
// fs 错误码归一原语（unknown → Node errno code）。
//
// 单一来源：sessions-index 的读失败分支与 execution/persistence/fs-error.ts 的
// isMissingFsError 判别共用同一提取逻辑，避免各写一份 errno 判别。包内 errno 归一
// 存量仍有多处（折叠列为机会点——本文件只承载新 helper 的单源）。
//
// 形态宽松：任何携带 string `code` 字段的对象（不限于 Error 实例）都取码——fs 错误经
// Node 抛出时恒为 Error，宽松形态对既有调用方等价；非对象 / 非 string code → undefined
//（调用方按「非 ENOENT」处理）。

/** unknown → Node fs 错误码（非对象或无 string code → undefined）。 */
export function errorCodeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = Reflect.get(err, "code");
  return typeof code === "string" ? code : undefined;
}
