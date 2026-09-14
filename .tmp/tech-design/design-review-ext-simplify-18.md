# ext-simplify-18 对抗式审查报告（合并落盘）

> 审查对象：`docs/architecture/ext-simplify-18-shared-adoption.md`
> 日期：2026-09-14 | 结论：**双 PASS，must_fix = 0**
> 轨迹：r1 双审（主审 PASS 0 MF + 7 S + 4 INFO；影响面 NEEDS-FIX 2 MF + 2 S）→ v2 修复 → r2 影响面定向复审 PASS（MF/S 全闭合）。

## r1 主审（tech-design-review）：PASS

- 6 个 D 项全 PASS：迁移面清单独立 rg 复扫逐行号吻合（26 处 toErrorMessage / 8 副本 isRecord / 3 处 isEnoentError）；允数组→严版等价论证独立核验通过（session-reader 隐藏前提 normalizeCallStatus/mapBudget/pickSessionRefs 实测成立）；与 17 号裁决零冲突。
- 7 S（全修于 v2）：structured-output 消费点漏列（10 位点/11 次）；V1 grep 词边界；cache-probe:73 论据重锚 pi-ai 实装构造点（systemInstruction 恒 string 或缺席，两版恒 false）；V8 名实不符改真机；计数 6→5 / 5→4；system-prompt-trace 改直接删导出（taiji 组非独立发布）；§5.3 barrel 锚点失实。
- 4 INFO（全收）：relay.mjs:86 补负面清单；依赖现状 9 包；V4 测试路径 `src/__tests__/`；baseline.ts:30 论证路径校准。

## r1 影响面（tech-design-impact-review）：NEEDS-FIX → 修复后 r2 PASS

- MF-1（D6 触发面）：守卫执行点仅 pre-commit（install-hooks.sh:1317 正则不含 model-ref.ts），CI 零引用——「只改 model-ref.ts」场景守卫不执行。v2 修复：触发正则补 `^packages/subagent-core/src/shared/model-ref\.ts$` + hook 头注释 + C-build-10 summary 同步；V5 补 hook 路径实测。r2 判定：闭合。
- MF-2（D6 提取适配）：`extractConstListMembers` 正则要求 `const NAME:` 类型标注，THINKING_ORDER 无标注实装失配。v2 修复：正则改标注可选 + `\s*=` 空格吸收（经三真实源文件实测：llm-shared Set / pi-rpc 带标注数组 / subagent-core 无标注数组均正确提取七值）；明确不选「加标注」路线（as const 字面量联合推导坑）；self-test 补第三形态。r2 判定：闭合。
- S-1 消费点清单补全 / S-2 re-export 别名清理通道（§6 收尾义务登记进 index 18 号行债务清账段）：r2 判定均闭合。
- 其余四面 PASS：导出面（structured-output 深路径可达 → re-export 保名正确；spt 直接删导出经 mandatory-extensions.json 实证复核成立）；依赖面（check-extension-dependencies 不拦，ext-guards 零传递依赖）；行为微变（D4 "provider/" 仅手写配置可达、D2 契约面内等价）；遗漏面（bundle/changeset/doc-symbol-drift 无漏）。

## r2 定向复审结论

**PASS**——r1 的 2 MF + 2 S 全部闭合；遗留 1 条非阻断 INFO（计数口径 10 位点/11 次调用统一，已随 v2 顺手修正）。
