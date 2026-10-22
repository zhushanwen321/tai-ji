# check-prompt-outposts 黑盒测试与检查脚本白名单指纹漂移

状态：未解决（2026-10-22 登记；单测层整治第二波全量验收时发现，非该波引入——测试与检查脚本的最后修改均在本次 merge 范围之前）

## 现象

`scripts/__tests__/check-prompt-outposts.test.mjs` 9 条用例中 4 条红（fixture 形态类用例），本地复现命令：

```bash
pnpm exec vitest run scripts/__tests__/check-prompt-outposts.test.mjs
```

失败形态：fixture 注入的 `client.prompt(` 调用点在检查侧「命中放行 0 处」（期望 2 处），违规拦截用例期望 exit 2 实际 exit 0——`.githooks/check_prompt_outposts.py` 的 `OUTPOST_CALLSITES` 白名单指纹（file_suffix + line_snippet + injection 语义）已随内核化重构演化（如 deliverOne 注入形态），测试 fixture 仍写旧指纹，白名单匹配落空。

## 为什么一直没暴露

该测试不在 CI `test-extensions` job 的「Test - scripts guards」步骤文件清单内（`.github/workflows/ci.yml` 该步骤为固定文件列表，未含此文件），仅本地全量跑 `scripts/__tests__/` 才会命中。

## 影响面

该检查（防未登记的用户内容出站调用点）的黑盒回归保护失效——检查本体仍在 pre-commit 生效，但其行为回归无人看护。

## 恢复动作（择一）

1. 按现行 `OUTPOST_CALLSITES` 指纹重写 fixture 注入内容（保持黑盒定位粒度）；
2. 或测试直接 import/exec 检查脚本常量生成 fixture（消指纹漂移，代价是少一层「指纹真实存在」的独立断言）；
3. 修完把它加进 CI「Test - scripts guards」步骤清单，防再漂移。
