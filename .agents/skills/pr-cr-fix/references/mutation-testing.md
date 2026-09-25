# Mutation testing 深检（StrykerJS）

> 从 SKILL.md 迁入（pr-cr-fix 精简改造 D8），触发条件与指针见 SKILL.md。

覆盖率证明「代码被跑过」，**mutation score 证明「断言真能抓 bug」**——覆盖率高但断言弱的测试（无断言/toMatchSnapshot 滥用/只断言不抛错）覆盖率满分也抓不住回归。对高风险模块的测试质量存疑时用。

**工具**：StrykerJS（`@stryker-mutator/core` + `@stryker-mutator/vitest-runner` ≥ 9.3，2025-11 起官方支持 vitest 4；perTest coverage 分析、只跑与被突变文件相关的测试；不支持 vitest Browser Mode——本项目 happy-dom/node 环境不受影响）。

**何时跑**（不进默认 gate——全量 mutation 太慢，一个中型包 10-30 分钟）：
1. Gate-1.5 `targets.high_crap` 靶子的函数已补测试后，验证断言强度
2. review-test-coverage 报告「弱断言」疑点（覆盖了但可疑）
3. 修复 bug 后验证回归测试真能拦住（mutant = 人为重引入 bug，测试必须杀掉）

**定向跑法**（只突变指定文件，非全包）：

```bash
cd <pkg> && pnpm add -D @stryker-mutator/core @stryker-mutator/vitest-runner
cat > stryker.config.json << 'EOF'
{ "testRunner": "vitest", "coverageAnalysis": "perTest",
  "mutate": ["src/<target-file>.ts"], "reporters": ["clear-text", "progress"] }
EOF
npx stryker run
```

判定参考：mutation score ≥ 60% 可接受、≥ 80% 良好；存活的 mutant 逐个看——要么断言缺（补），要么等价变异（记录豁免）。产出不进 `.review/`（临时深检，结论写进 test-coverage 维度报告即可）。
