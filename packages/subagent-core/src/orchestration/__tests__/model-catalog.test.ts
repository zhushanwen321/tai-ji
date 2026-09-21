// src/orchestration/__tests__/model-catalog.test.ts
//
// [D8 Q1] 模型目录（model-catalog）单测：命中/未命中分类（not_found vs
// provider_drift）/可用清单渲染/恢复指引/assertModelInCatalog 拒单，以及与
// shared/model-ref.assertCanonicalModelRef 的一致性锁定（无孪生 registry 下两裁决
// 逐输入等价——命中谓词单一权威的机器守卫；孪生面由派发期 identity 全量裁决，
// 目录刻意不复制，见 model-catalog.ts 头注）。

import { describe, expect, it } from "vitest";

import {
  assertModelInCatalog,
  resolveModelInCatalog,
  type ModelCatalogEntry,
  type ModelCatalogSource,
} from "../model-catalog.ts";
import { assertCanonicalModelRef } from "../../shared/model-ref.ts";

function makeSource(entries: ReadonlyArray<ModelCatalogEntry>): ModelCatalogSource {
  return { getAvailable: () => entries };
}

const CATALOG: ReadonlyArray<ModelCatalogEntry> = [
  { provider: "prov1", id: "good-a" },
  { provider: "prov1", id: "good-b" },
  { provider: "prov2", id: "solo" },
];

describe("resolveModelInCatalog 命中", () => {
  it("全等命中返回 provider/id", () => {
    expect(resolveModelInCatalog("prov1/good-a", makeSource(CATALOG))).toEqual({
      ok: true,
      provider: "prov1",
      id: "good-a",
    });
  });

  it("合法 thinking 后缀被 strip 后命中", () => {
    expect(resolveModelInCatalog("prov2/solo:xhigh", makeSource(CATALOG))).toEqual({
      ok: true,
      provider: "prov2",
      id: "solo",
    });
  });
});

describe("resolveModelInCatalog 未命中分类", () => {
  it("provider 在目录、id 查无 → not_found + 可用清单 + 输入侧恢复指引", () => {
    const miss = resolveModelInCatalog("prov1/typo", makeSource(CATALOG));
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.classification).toBe("not_found");
    expect(miss.message).toContain('provider "prov1" is configured but has no model "typo"');
    expect(miss.message).toContain("Available models:");
    expect(miss.message).toContain("prov1/good-a");
    expect(miss.message).toContain("prov2/solo");
    expect(miss.message).toContain("Recovery: retry with an exact entry from the list");
  });

  it("provider 不在目录 → provider_drift + 配置侧恢复指引（models.json）", () => {
    const miss = resolveModelInCatalog("retired/m1", makeSource(CATALOG));
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.classification).toBe("provider_drift");
    expect(miss.message).toContain('provider "retired" has no models');
    expect(miss.message).toContain("provider configuration drift");
    expect(miss.message).toContain("models.json under the pi agent dir");
  });

  it("目录空 → provider_drift + 空清单显式", () => {
    const miss = resolveModelInCatalog("prov1/good-a", makeSource([]));
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.classification).toBe("provider_drift");
    expect(miss.message).toContain("model catalog is empty");
    expect(miss.message).toContain("Available models: (none)");
  });

  it("非规范形（无斜杠）→ not_found + 格式指引", () => {
    const miss = resolveModelInCatalog("just-an-id", makeSource(CATALOG));
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.classification).toBe("not_found");
    expect(miss.message).toContain('expected "provider/modelId" format');
  });

  it("可用清单超上限截断（20 + 余量行）", () => {
    const many: ModelCatalogEntry[] = Array.from({ length: 25 }, (_, i) => ({
      provider: "p",
      id: `m${i}`,
    }));
    const miss = resolveModelInCatalog("p/none", makeSource(many));
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.message).toContain("p/m19");
    expect(miss.message).not.toContain("p/m20\n");
    expect(miss.message).toContain("… and 5 more");
  });
});

describe("assertModelInCatalog", () => {
  it("未命中同步抛分类化错误（来源标签并入首行）", () => {
    expect(() =>
      assertModelInCatalog("prov1/typo", makeSource(CATALOG), { source: "run-level model override" }),
    ).toThrowError(/run-level model override.*not in the pi engine model catalog/s);
  });

  it("命中放行并返回全等 ref", () => {
    expect(assertModelInCatalog("prov1/good-a", makeSource(CATALOG))).toEqual({
      ok: true,
      provider: "prov1",
      id: "good-a",
    });
  });
});

describe("与 assertCanonicalModelRef 的一致性（机器锁）", () => {
  // 无孪生 registry：目录命中谓词与 canonical ref 全等裁决必须逐输入等价。
  // 孪生输入不在本表（目录刻意不含孪生守卫——派发期 identity 全量裁决兜住）。
  const INPUTS = [
    "prov1/good-a",
    "prov1/good-b",
    "prov2/solo",
    "prov2/solo:high",
    "prov1/typo",
    "unknown/m",
    "PROV1/good-a",
    "prov1/GOOD-A",
    "bare",
    "",
    "prov1/",
  ];

  it("逐输入等价：目录 ok ⟺ assertCanonicalModelRef 不抛", () => {
    const source = makeSource(CATALOG);
    for (const input of INPUTS) {
      const catalog = resolveModelInCatalog(input, source);
      let canonicalThrew = false;
      try {
        assertCanonicalModelRef(input, source);
      } catch {
        canonicalThrew = true;
      }
      expect(catalog.ok === true, `input=${input}`).toBe(!canonicalThrew);
    }
  });
});
