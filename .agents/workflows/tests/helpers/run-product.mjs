// run-product.mjs — 测试 helper：在 mock 宿主环境中执行 workflow 产物
// （pi 产物按 pi worker 真实执行形态 = 全文包进 async 函数体；zcode 产物先经
// typescript.transpileModule 剥 TS。平台注入物全部 mock，业务命令按分发器应答——
// 不产生任何真实对外动作，agent 调用一律返回 error 走失败终态路径。）
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const WF = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadTypescript() {
  try {
    return createRequire(import.meta.url)("typescript");
  } catch {
    return createRequire(import.meta.url)(join(homedir(), "Code", "zsw-skills", "node_modules", "typescript"));
  }
}

// mock world.run 分发器：确定性应答，不执行任何真实命令。
// - 存在性探测（EXISTS）统一返回「不存在」→ preflight/preflight 类检查快速失败
// - zcode 产物的 runNode 经 sh -c 包裹探针脚本，sh 分支按脚本内容识别探针
// - git/sh/node -e 常规探针返回无害成功值，放流程走到第一个 step 的观测边界
// - opts.gitStatus 覆盖 git status --porcelain 输出（dev-merge-gates 的发起前预检走脏区
//   fail-fast 路径用：非空输出 = 预检 failure）
// - opts.obsLayerHash 应答 B-1 观测层源 hash 探针（模拟「源与构建一致」的自洽环境；
//   传 productObsLayerHash(产物) 的提取值——mock 不读真实文件，保持确定性应答；传
//   任意其他 hex 值 = 驱动不一致终止分支，setup-guards.test.mjs 用）
// - opts.wtShape 应答 D-1 worktree 存在性探针三态（dir/missing/file，默认 dir——
//   missing/file 驱动两类拒启分支）
// - opts.gitTopLevelStderr 覆盖 git rev-parse --show-toplevel 为 exit 128 + 该 stderr
//   （D-1 git 根失败归因拆分分支驱动）
export function makeMockWorldRun(captured, opts = {}) {
  const res = (exitCode, stdout = "", stderr = "") => ({ exitCode, stdout, stderr });
  const gitStatusOut = opts.gitStatus ?? "";
  const answerProbe = (script) => {
    if (script.includes("workflow-observability")) return "obs";
    if (script.includes("realpathSync")) return res(0, "fake-proj-12345678");
    if (script.includes("homedir")) return res(0, "/tmp/prl-selftest-home");
    if (script.includes("new Date().toISOString")) return res(0, "2026-11-01T00:00:00.000Z");
    if (script.includes("existsSync")) return res(1); // 不存在 → 检查失败
    return res(0);
  };
  const dispatch = async (cmd, argsArr, _opts) => {
    // bash 包装形态（dev-merge-gates 的统一命令执行）：["-c", script, "bash", cmd, ...args]
    // ——解包后按真实命令递归应答，git/sh/node 分支对包装内外一视同仁
    if (cmd === "bash" && argsArr[0] === "-c" && argsArr[2] === "bash") {
      return dispatch(String(argsArr[3] ?? ""), argsArr.slice(4), _opts);
    }
    // bash -c 直发探针（D-1 worktree 存在性：["-c", script] 无 "bash" 尾参，与上方
    // runSh 包装形态区分）：按 opts.wtShape 三态应答
    if (cmd === "bash" && argsArr[0] === "-c") {
      const script = String(argsArr[1] ?? "");
      if (script.includes("echo dir") && script.includes("echo missing")) {
        return res(0, opts.wtShape ?? "dir");
      }
      return res(1, "", "selftest-mock: 未登记的 bash -c 脚本");
    }
    if (cmd === "node" && argsArr[0] === "-e") {
      // zcode 壳 obsAppend 形态：argv = ["-e", appendScript, filePath, eventJsonLine]
      //（filePath 含 workflow-observability 落盘目录；appendScript 本身不含路径字面）
      if (String(argsArr[2] ?? "").includes("workflow-observability")) {
        if (captured) captured.push(argsArr[3] ?? "");
        return res(0);
      }
      const probeScript = String(argsArr[1] ?? "");
      // B-1 观测层源 hash 探针（脚本同样含 workflow-observability 字面，须先于下方
      // answerProbe 的 "obs" 捕获分支区分——它是读探针不是写事件）：应答产物内嵌 hash
      if (probeScript.includes("createHash") && probeScript.includes("workflow-observability")) {
        if (!opts.obsLayerHash) {
          return res(1, "", "selftest-mock: obs hash 探针缺 opts.obsLayerHash——夹具未传产物内嵌值");
        }
        return res(0, opts.obsLayerHash);
      }
      const a = answerProbe(probeScript);
      if (a === "obs") {
        // 防御：公共层不经 node -e 直传事件
        if (captured) captured.push(argsArr[3] ?? "");
        return res(0);
      }
      return a;
    }
    if (cmd === "sh") {
      const script = String(argsArr[1] ?? "");
      // pr-lifecycle 的 runNode 形态：sh -c '<nodeAbs> -e <探针>'——nodeAbs 含 nvm 时
      // 整串命中下方 node 定位分支，node 路径被误当探针输出（skillDataDir home/slug
      // 探针拿到 node 路径假输出）。探针内容特征优先判定，定位探针特征殿后。
      const probeHit =
        script.includes("homedir") ||
        script.includes("realpathSync") ||
        script.includes("new Date().toISOString") ||
        script.includes("workflow-observability") ||
        script.includes("existsSync") ||
        script.includes("readFileSync");
      if (probeHit) {
        const a = answerProbe(script);
        return a === "obs" ? res(0) : a;
      }
      if (script.includes("command -v node") || script.includes("nvm")) return res(0, process.execPath);
      if (script.includes("workflow-observability")) return res(0); // 防御：观测不经 sh 路
      // runNode 形态：sh -c '<node> "-e" <探针>'——探针判定直接对整串做 includes
      //（产物把 -e 一并 shq，形态为 '-e'，不能按裸 " -e " 切分）
      const a = answerProbe(script);
      return a === "obs" ? res(0) : a;
    }
    if (cmd === "git") {
      const sub = argsArr[0] ?? "";
      if (sub === "rev-parse" && argsArr[1] === "--show-toplevel") {
        if (opts.gitTopLevelStderr) return res(128, "", opts.gitTopLevelStderr); // D-1 归因拆分分支驱动
        return res(0, "/tmp/prl-selftest-wt\n");
      }
      if (sub === "rev-parse") return res(0, "fakebasehash0000\n");
      if (sub === "status") return res(0, gitStatusOut);
      return res(0, "");
    }
    // gh / fallow / bash gate 脚本等一律失败 → preflight 前置条件未过 → 失败终态
    return res(1, "", "selftest-mock: 命令不可用");
  };
  return dispatch;
}

// 产物内嵌 OBS_LAYER_SHA256 提取（B-1 探针 mock 应答值 = 产物构建期注入值——自洽，
// 不依赖本机观测层安装状态）。产物缺注入行 = 构建器注入契约破坏或产物过期，显性报错
export function productObsLayerHash(productPath) {
  const m = readFileSync(productPath, "utf8").match(/const OBS_LAYER_SHA256 = "([0-9a-f]{64})"/);
  if (!m) throw new Error(`产物未含 OBS_LAYER_SHA256 注入行（${productPath}）——构建器注入契约破坏或产物过期，恢复：node .agents/workflows/scripts/build-workflows.mjs 后重跑测试`);
  return m[1];
}

// platform: "pi"（产物即 JS）| "zcode"（TS 产物先剥类型）
export async function runProduct(productPath, platform, injected) {
  let code = readFileSync(productPath, "utf8");
  if (platform === "zcode") {
    const ts = loadTypescript();
    code = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
  }
  const sandbox = {
    // pi worker 注入物
    $ARGS: injected.$ARGS ?? {},
    $MODEL: injected.$MODEL ?? "selftest-mock-model",
    agent: injected.agent,
    log: injected.log ?? (() => {}),
    phase: injected.phase ?? (() => {}),
    // zcode 引擎注入物（zcode 产物用；pi 产物壳内自带 world/files/report/artifact 定义，
    // 与此处同名注入物不冲突——sandbox 键被壳内 const 覆盖属预期）
    args: injected.args ?? {},
    world: injected.world,
    files: injected.files,
    report: injected.report ?? (() => {}),
    artifact: injected.artifact,
    require: createRequire(import.meta.url),
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    URL,
  };
  // pi worker 真实执行形态：全文包进 async 函数体（顶层 await 与顶层 return 合法）
  const wrapped = "(async () => {\n" + code + "\n})()";
  return vm.runInNewContext(wrapped, sandbox, { timeout: 60_000 });
}
