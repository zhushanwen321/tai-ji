// appserver-launcher-patches.ts —— APPSERVER_LAUNCHER_SOURCE 的两个补丁段载体
// （2026-10 review 自 appserver-launcher.ts 按 max-lines 行数守卫拆出：拆分搬运 + 同批
// review 行为修正随段迁移——存在性守卫/括号配平/窗口收紧/语法自检/重复行清除，
// 变更点见段内就地注释）。
//
// 本文件是「wrapper 源码的字符串段」而非可执行 TS：两个常量按原文逐字节内插进
// appserver-launcher.ts 的 APPSERVER_LAUNCHER_SOURCE 模板，随 wrapper 幂等落盘为
// appserver-launcher.cjs。段边界即职责边界：
//   - CLI_PATCH_SECTION：patchedCliSource——CLI bundle 源码内存补丁三锚（① entitled
//     翻转 ② standalone 选项注入 ③ 认证头端口注入），锚 miss 各自 stderr warn。
//   - ACCOUNT_METADATA_SECTION：ensureAccountMetadata——standalone 账号元数据键
//     （identity / auth-source）幂等供给（缺时追加 + 无凭据支撑的孤儿值矫正，ADR-0143）。
// 改段内容 = 改 wrapper 产物内容（appserver-launcher.test.ts 的落盘产物 ===
// APPSERVER_LAUNCHER_SOURCE 断言自动跟随）；真机回归守卫与锚点变体测试同文件。

/** wrapper 源码段：CLI bundle 源码内存补丁（__cliPatchCache + patchedCliSource）。 */
export const CLI_PATCH_SECTION = `
// [2026-10-13 account 直通②] CLI bundle 源码内存补丁：外部 spawn 的账号条目构建
// 硬编码 entitled:!1（YXe），数据面注入（目录 entitled 字段）被其无视——按用户裁决
// 改 zcode 源码绕过：拦截 CLI bundle 源码读取，内存替换该字面量为 !0（ZCode.app
// 磁盘文件零触碰；锚串含 ]]:[] 尾缀唯一命中 YXe 构造，另一处同名条件逻辑不受影响）。
// 锚不命中（上游混淆形态变化）→ 原文透出：仅 account 家族继续被拒，个人 provider
// 不受影响。
// 补丁段内联扫描器（2026-10 review·MF-1-5）：跳过字符串/模板字面量/注释，让括号
// 配平与参数切分只在代码面上进行——bundle 内联串里的 ')' 曾把调用点参数配平带偏。
// 返回 -1 = 该位置不是字面量/注释起点（正常代码字符）。
function __skipLiteralOrComment(src, i) {
  const ch = src[i];
  if (ch === '"' || ch === "'") {
    i++;
    while (i < src.length) {
      if (src.charCodeAt(i) === 92) { i += 2; continue; }
      if (src[i] === ch) return i + 1;
      i++;
    }
    return i;
  }
  if (ch === '\`') {
    i++;
    while (i < src.length) {
      if (src.charCodeAt(i) === 92) { i += 2; continue; }
      const c = src[i];
      if (c === '\`') return i + 1;
      if (c === '$' && src[i + 1] === '{') {
        let depth = 1;
        i += 2;
        while (i < src.length && depth > 0) {
          const cc = src[i];
          if (cc === '"' || cc === "'" || cc === '\`') { i = __skipLiteralOrComment(src, i); continue; }
          if (cc === '/' && src[i + 1] === '/') { const nl = src.indexOf('\\n', i + 2); i = nl < 0 ? src.length : nl + 1; continue; }
          if (cc === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
          if (cc === '{') depth++;
          else if (cc === '}') depth--;
          i++;
        }
        continue;
      }
      i++;
    }
    return i;
  }
  if (ch === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\\n', i + 2);
    return nl < 0 ? src.length : nl + 1;
  }
  if (ch === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  return -1;
}
// 与 openIdx 处 '(' 配对的闭括号（跳过字面量/注释）；-1 = 不配平。
function __matchingParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const skip = __skipLiteralOrComment(src, i);
    if (skip >= 0) { i = skip - 1; continue; }
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
// [start,end) 内按顶层逗号切分（括号/方括号/对象字面量与字面量内的逗号不计）；
// 返回绝对偏移段列表。
function __splitTopLevel(src, start, end) {
  const parts = [];
  let depth = 0;
  let segStart = start;
  for (let i = start; i < end; i++) {
    const skip = __skipLiteralOrComment(src, i);
    if (skip >= 0) { i = Math.min(skip, end) - 1; continue; }
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push({ start: segStart, end: i }); segStart = i + 1; }
  }
  parts.push({ start: segStart, end: end });
  return parts;
}
const __cliPatchCache = new Map();
// 应用态标志发布（2026-10 review）：安装门曾以补丁产物子串判定 header-port——真实
// 3.15.3 bundle 本就含 8 处 'providerRuntimeHeadersPort:'（2 处 ',providerRuntimeHeadersPort:'）
// → 子串判定恒真、对锚点漂移零检测力。改由补丁函数本身发布 {entitled,standalone,
// headerPort}（缓存命中仍可读），门只读标志（三处判定各自具名，漂移不静默）。
const __cliPatchStatus = new Map();
function patchedCliSource(path) {
  if (__cliPatchCache.has(path)) return __cliPatchCache.get(path);
  let result = null;
  let entitledApplied = false;
  let standaloneApplied = false;
  let portInjected = false;
  try {
    const readOrig = fs.__origReadFileSync || fs.readFileSync;
    let src = readOrig(path, 'utf8');
    // ① 版本鲁棒锚（2026-10-13 修订）：minified 标识符（Uk/I3 等）随 zcode 重新打包
    // 漂移，属性名（zcodeBuiltinProviders / zhipu-account / entitled）是数据/契约
    // 真名不被混淆——以属性名定位 + 600 字符窗口内把账号条目构建的 entitled:!1
    // 翻转为 !0。窗口零命中 = 上游形态漂移 → 原文透出 + stderr warn（漂移可见，
    // 进 app-server stderr 日志）。
    const anchorIdx = src.indexOf('zcodeBuiltinProviders.entries()');
    if (anchorIdx >= 0) {
      const window = src.slice(anchorIdx, Math.min(src.length, anchorIdx + 600));
      if (window.indexOf('zhipu-account') >= 0 && window.indexOf('entitled:!1') >= 0) {
        src = src.slice(0, anchorIdx)
          + window.split('entitled:!1').join('entitled:!0')
          + src.slice(anchorIdx + 600);
        entitledApplied = true;
      }
    }
    if (!entitledApplied) {
      process.stderr.write('[zcode-launcher] account bypass: CLI bundle anchor not found (zcode upstream shape drifted?) - account family stays gated\\n');
    }
    // ② [2026-10-16 standalone account] 协议路径的 provider registry 恒以 host-account
    // 模式创建（源码：create:r(()=>xCt(z),"create") 不传 standalone）——该模式下
    // account 族请求必须由宿主应答 providerRuntimeHeaders；taiji 的 headless spawn 无
    // 宿主参与该协议，应答帧畸形 → zod invalid_union(headersApplied)（2026-10-16 真机
    // 事故根因；宿主日志零踪迹 = 请求从未到达任何 host 实现）。本补丁给该调用注入
    // {standalone:{}}：standalone 模式自建本地账号源（entitled 由凭据存在性计算，
    // 读 credentials.json）并注入本地 providerRuntimeHeaders 端口——账号族全链本地
    // 完成、零宿主依赖。锚点两处稳定串（非 minified）：模块导出映射
    // startProcessProviderRegistryRuntime:()=> 取函数名 + 调用点 create:r(()=><fn>(。
    const exportAnchor = 'startProcessProviderRegistryRuntime:()=>';
    const exportIdx = src.indexOf(exportAnchor);
    if (exportIdx >= 0) {
      // 名称尾部须是分隔符（真实形态 = 导出映射对象 ',' / '}'）：'{0,10}' 上限会静默
      // 截断更长的 minified 名 → 取到错误函数名；要求分隔符后截断不成立（漂移可见）。
      const nameMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)(?=[,}:])/.exec(src.slice(exportIdx + exportAnchor.length));
      const fnName = nameMatch ? nameMatch[1] : null;
      if (fnName) {
        // 锚点 A（首选，抗漂移最强）：函数定义默认参数法——
        // 'function <fnName>(e,t={}){' → 'function <fnName>(e,t={standalone:{}}){'。
        // 语义：调用方省略第二参（协议路径 xCt(z)）→ t = {standalone:{}}；显式传
        // {}（skipUserConfig 路径）或 {standalone:{...}}（TUI 路径）不受影响。
        const defAnchor = 'function ' + fnName + '(';
        // 结构校验（2026-10 review·MF-1-5）：曾取首个文本命中——真实 bundle 有数百个
        // 重名 function 定义（同名不代表唯一），错改一处仍是语法合法 bundle，自检无法
        // 发现且门会报 armed。定义必须**唯一**且位于导出映射之前；第二处出现或定义
        // 落在导出映射之后 = 无法确定导出对象指向的实现 → 放弃本锚（回退调用点锚 /
        // not armed），宁可漏补也不默默改错位置。
        let defCount = 0;
        let defIdx = -1;
        for (let scan = src.indexOf(defAnchor); scan >= 0; scan = src.indexOf(defAnchor, scan + 1)) {
          defCount++;
          if (scan < exportIdx) defIdx = scan;
        }
        if (defCount !== 1) defIdx = -1;
        if (defIdx >= 0) {
          const paramsEnd = __matchingParen(src, defIdx + defAnchor.length - 1);
          if (paramsEnd > defIdx) {
            // 必须恰好两个顶层参数且第二个以 '={}' 收尾：曾只要求 '={}' 唯一——
            // function f(e={},t) 会把 standalone 注入第一个参数（语法合法、语义错误），
            // function f(e,t={},o={}) 也不确定注入点（既有回退用例）。
            const params = __splitTopLevel(src, defIdx + defAnchor.length, paramsEnd);
            if (params.length === 2) {
              const second = params[1];
              let secondEnd = second.end;
              while (secondEnd > second.start && src.charCodeAt(secondEnd - 1) <= 32) secondEnd--;
              // 函数体窗口令牌（可选保险）：真实注册源实装引用 .standalone /
              // credentialStore——同名但无关的定义（或字符串内伪命中）不得被改写。
              const bodyWindow = src.slice(paramsEnd + 1, paramsEnd + 500);
              if (secondEnd - second.start > 3 && src.slice(secondEnd - 3, secondEnd) === '={}'
                  && (bodyWindow.indexOf('standalone') >= 0 || bodyWindow.indexOf('credentialStore') >= 0)) {
                const at = secondEnd - 3;
                src = src.slice(0, at) + '={standalone:{}}' + src.slice(secondEnd);
                standaloneApplied = true;
              }
            }
          }
        }
        // 锚点 B（回退）：调用点注入 create:r(()=><fn>( → (<arg>,{standalone:{}})。
        // 结构校验与定义锚同口径（2026-10 review·N-1）：全文件出现次数必须恰好 1
        // ——曾取首个文本命中，未来版本出现两处同款调用时注入落在无关调用上、
        // standaloneApplied 仍置 true = 真实协议路径 host 模式而门报 armed 的假成功。
        // count > 1 = 无法确定协议路径调用点 → 放弃本锚（not armed）。
        if (!standaloneApplied) {
          const callAnchor = 'create:r(()=>' + fnName + '(';
          let callCount = 0;
          let callIdx = -1;
          for (let scan = src.indexOf(callAnchor); scan >= 0; scan = src.indexOf(callAnchor, scan + 1)) {
            callCount++;
            callIdx = scan;
          }
          if (callCount === 1) {
            const argStart = callIdx + callAnchor.length;
            // 括号配平找与 fnName( 配对的闭括号（扫描器跳过字面量/模板/注释——实参
            // 含内联串或内层调用时首个 ')' 落在错误层级 = 注入错位的假成功）
            const closeIdx = __matchingParen(src, argStart - 1);
            if (closeIdx > argStart) {
              src = src.slice(0, closeIdx) + ',{standalone:{}}' + src.slice(closeIdx);
              standaloneApplied = true;
            }
          }
        }
      }
    }
    if (!standaloneApplied) {
      process.stderr.write('[zcode-launcher] standalone account: CLI bundle anchor not found (zcode upstream shape drifted?) - account family stays host-dependent\\n');
    }
    // ③ [2026-10-16 standalone account·端口注入] 协议路径的 app 创建（
    // createZCodeApp:r((ut={})=>INn({...q0c(...)}) 唯一命中）未传
    // providerRuntimeHeadersPort——app 因此回落 host 请求端口（mai），而 taiji 链上无
    // 宿主任应答 → zod invalid_union(headersApplied)（②只修了 registry 侧：provider
    // 已能进注册表，但认证头仍走 host 请求）。本步把 registry runtime 对象上的
    // providerRuntimeHeadersPort（standalone 模式 = 本地端口）注入该 app 创建选项：
    // 账号族认证头由本进程本地解析（凭据 = credentials.json 中 ZCode 自有项）。
    const appAnchor = 'createZCodeApp:r(';
    const appIdx = src.indexOf(appAnchor);
    if (appIdx >= 0) {
      const closeAnchor = '}),"createZCodeApp")';
      const closeIdx = src.indexOf(closeAnchor, appIdx);
      // 搜索窗以收口锚为界（曾用 appIdx+1600 固定窗——窗口越过收口会捕获选项对象外
      // 的无关同名形态，注入错误变量名 → 加载期 ReferenceError 且补丁层无 warn）
      const regMatch = closeIdx > appIdx
        ? /([A-Za-z_$][A-Za-z0-9_$]*)\.runtime\.registryService/.exec(src.slice(appIdx, closeIdx))
        : null;
      if (closeIdx > appIdx && regMatch) {
        // 条件 spread（2026-10 review·S-4）：上游 kEt 以 \`n.providerRuntimeHeadersPort ??
        // mai(e,t)\` 把宿主请求端口显式交给 createZCodeApp（...q0c($0c(ut,n),...) 已含该值）；
        // 无条件尾插 <reg>.providerRuntimeHeadersPort 在 standalone 未武装形态（值为
        // undefined）会 shadow 掉宿主端口、抹除 host 回落。改为仅在本地端口存在时覆盖：
        // standalone 形态字节等价，host 形态保留调用方值。
        const reg = regMatch[1];
        src = src.slice(0, closeIdx)
          + ',...(' + reg + '.providerRuntimeHeadersPort?{providerRuntimeHeadersPort:' + reg + '.providerRuntimeHeadersPort}:{})'
          + src.slice(closeIdx);
        portInjected = true;
      }
    }
    if (!portInjected) {
      process.stderr.write('[zcode-launcher] standalone account: header-port injection anchor not found (zcode upstream shape drifted?) - account auth stays host-dependent\\n');
    }
    // 交付条件含 portInjected（2026-10 review 修正）：曾只认 entitled/standalone——
    // 端口锚单独命中时补丁产物被静默丢弃（③ 形同虚设，无任何信号）。
    if (entitledApplied || standaloneApplied || portInjected) {
      // 缓存前语法自检（廉价保险）：锚漂移形态下插错位置会产出语法非法 bundle，
      // app-server 启动即裸 SyntaxError 且难归因补丁层——缓存前 try 编译一次，
      // 失败回退原文 + stderr warn（走既有「原文透出」降级语义）。BOM/shebang 剥离
      // 与 .js 扩展处理器同款（否则合法 CJS 被误判非法）。
      let check = src;
      if (check.charCodeAt(0) === 0xfeff) check = check.slice(1);
      if (check.startsWith('#!')) check = check.slice(check.indexOf('\\n') + 1);
      try {
        new Function(check);
        result = src;
      } catch (syntaxErr) {
        process.stderr.write('[zcode-launcher] cli-source patch produced invalid JS (' + ((syntaxErr && syntaxErr.message) || 'unknown') + ') - falling back to unpatched source\\n');
        result = null;
      }
    } else {
      result = null;
    }
  } catch { result = null; }
  __cliPatchCache.set(path, result);
  // 标志只描述「已交付产物」：语法自检失败/异常回退（result=null）时全部 false——
  // 门不得把未生效的补丁报成 armed。
  __cliPatchStatus.set(path, {
    entitled: result !== null && entitledApplied,
    standalone: result !== null && standaloneApplied,
    headerPort: result !== null && portInjected,
  });
  return result;
}`;

/** wrapper 源码段：standalone 账号元数据键幂等供给（ensureAccountMetadata；调用点 =
 * 安装门确认 standalone + header-port 双锚已武装分支——未武装时不写共享凭据库）。 */
export const ACCOUNT_METADATA_SECTION = `
// [2026-10-16 standalone account metadata] standalone 账号源要求
// account-provider:<planProviderId>:identity / :auth-source 两条**元数据**键才承认
// account provider（缺 identity 直接丢弃该 provider → 派发报「Provider Registry 中
// 不存在 Model」）。两键非秘密（身份 ID / 认证来源），真凭据仍是 ZCode 自有项
// （oauth token 或 plan api-key，均在 credentials.json，由 ZCode 登录/配置写入）。
// 本步幂等供给：缺时追加 + **孤儿值矫正**（2026-10 review·MF-1-1）——派生值每次
// spawn 重算，既有非空值仍是权威（不无差别覆写），仅当其背后凭据已不存在时才
// 改写（oauth 撤销 / plan key 轮换 / 账号切换）；否则旧身份/旧来源会永久门控该
// provider 且永不收敛。任何失败只 warn 不阻断 spawn（缺键的报错路径与恢复指引由
// 引擎侧既有文案承载）。catches：文件缺失/坏 JSON/目录不可写。
// 并发边界（ADR-0143 登记）：对与 GUI 共享的凭据库做无锁 read-modify-write 全量
// 写回，与 GUI token 刷新并发存在毫秒级丢更新窗口——后果自愈（GUI 侧重试刷新 /
// 本侧缺键下次 spawn 幂等补齐），事实驱动原则下不加锁、不做时间补偿。元数据键
// 面另加 compare-and-skip 防线（2026-10 review·N-3）：写回前重读磁盘比对
// identity/auth-source 两键，检测到并发写入即放弃本次写入（见落库段注释）。
// 调用契约（2026-10 review·S-3）：仅在安装门确认 standalone 与 header-port 两锚
// 均已武装时调用——这些元数据键只被 standalone 账号源消费，且账号链要成立还要求
// 认证头走本地端口；任一锚漂移（版本不支持）时写入用户共享 credentials.json 无
// 任何运行时收益，只增风险。
function ensureAccountMetadata() {
  try {
    const credPath = path.join(os.homedir(), '.zcode', 'v2', 'credentials.json');
    const readOrig = fs.__origReadFileSync || fs.readFileSync;
    if (!fs.existsSync(credPath)) return;
    const creds = JSON.parse(readOrig.call(fs, credPath, 'utf8'));
    if (!creds || typeof creds !== 'object' || Array.isArray(creds)) return;
    if (!CATALOG_PATH) return;
    let planIds = [];
    try {
      const cat = JSON.parse(readOrig.call(fs, CATALOG_PATH, 'utf8'));
      const pcr = (cat && cat.config && cat.config.providerConfigRules) || {};
      const rules = Array.isArray(pcr.providerRules) ? pcr.providerRules : [];
      planIds = rules
        // 过滤面刻意宽于 3.15.3 standalone 快照的消费判据（源码 NNn：type=zhipu-account
        // && mode=individual-coding-plan && accountType 非空 && builtinModelIds 非空；
        // 真实目录 10 条命中、仅 2 条被 individual 快照消费）：多写的键是非秘密元数据、
        // 缺时追加成本≈零；而 mode 值域（individual/team/start/off-peak/
        // highspeed）跨 CLI 版本仍在演化，按当前版本收窄会让别的版本/未来消费面
        // 静默缺键。宽度是有意的，不按 3.15.3 收窄（2026-10 review·S-5 核实后保留）。
        .filter(function (r) { return r && r.config && r.config.access && r.config.access.type === 'zhipu-account'; })
        .map(function (r) { return String(r.providerId || ''); })
        .filter(Boolean);
    } catch (e) {
      // 目录损坏/不可读 = identity/auth-source 无法供给的真因，不能静默返回（否则
      // standalone 派发报「Provider Registry 中不存在 Model」时排障无入口）
      process.stderr.write('[zcode-launcher] account metadata: builtin catalog unreadable (' + ((e && e.message) || String(e)) + ') - skipping account provider metadata\\n');
      return;
    }
    const added = [];
    const reconciled = [];
    // compare-and-skip 基线（2026-10 review·N-3）：全部 plan 两键的读时原始值（首见
    // 捕获——后续改写 creds 不影响基线）。写回前重读磁盘逐键比对，检测「快照读取
    // →写回」窗口内的 GUI/登录并发写入，防陈旧快照覆盖权威新值。
    const metaBaseline = Object.create(null);
    for (const pid of planIds) {
      const idKey = 'account-provider:' + pid + ':identity';
      const srcKey = 'account-provider:' + pid + ':auth-source';
      if (metaBaseline[idKey] === undefined) metaBaseline[idKey] = creds[idKey];
      if (metaBaseline[srcKey] === undefined) metaBaseline[srcKey] = creds[srcKey];
      // host 态 plan api-key 键名模板：account-provider:coding-plan:<pid>:account:<identity>:api-key
      const apiKeyPrefix = 'account-provider:coding-plan:' + pid + ':account:';
      const apiKeySuffix = ':api-key';
      const hasPlanApiKey = (id) => {
        if (!id) return false;
        return Boolean(creds[apiKeyPrefix + encodeURIComponent(id) + apiKeySuffix]);
      };
      let identity = typeof creds[idKey] === 'string' ? creds[idKey] : '';
      const authSource = typeof creds[srcKey] === 'string' ? creds[srcKey] : '';
      // 派生身份每次 spawn 重算（不读既有键）。多 plan api-key（旧+新 account / 轮换
      // 残留）时「Object.keys 首个命中」会永久指向陈旧 account 且 hasPlanApiKey 恒真、
      // 永不自愈（2026-10 review·DG-R2-01）——派生优先级：
      //   ① project-key-location:v1:[origin,family,identity,...] 键内嵌 identity
      //      （ZCode 登录写入的确定性信号；键名尾段 URL 编码 JSON 数组，第 2/3 元素
      //      = family/identity，family 与 pid 前缀匹配同 oauth 家族判据）全体去重后
      //      唯一且该 identity 名下确有 plan api-key → 用它；
      //   ② 无①信号时，该 pid 名下 plan api-key 键的 identity 去重后唯一 → 用它
      //      （单 account 常态）；
      //   ③ 多候选且无①确定性信号 → 不猜测：不派生（保留既有 stored identity）并
      //      log 歧义——猜测改写比保留陈旧值更糟（陈旧值至少是登录流程写过的）。
      let derivedIdentity = '';
      let ambiguousIdentity = false;
      const keyLocPrefix = 'project-key-location:v1:';
      const keyLocIds = [];
      for (const k of Object.keys(creds)) {
        if (k.indexOf(keyLocPrefix) !== 0) continue;
        try {
          const arr = JSON.parse(decodeURIComponent(k.slice(keyLocPrefix.length)));
          if (Array.isArray(arr) && typeof arr[1] === 'string' && typeof arr[2] === 'string'
              && pid.indexOf('account:' + arr[1]) === 0 && keyLocIds.indexOf(arr[2]) === -1) {
            keyLocIds.push(arr[2]);
          }
        } catch (e2) { /* 形态外键（损坏/非数组）不构成确定性信号 */ }
      }
      if (keyLocIds.length === 1 && hasPlanApiKey(keyLocIds[0])) {
        derivedIdentity = keyLocIds[0];
      } else {
        const apiKeyIds = [];
        for (const k of Object.keys(creds)) {
          if (k.indexOf(apiKeyPrefix) !== 0 || k.slice(-apiKeySuffix.length) !== apiKeySuffix) continue;
          const mid = k.slice(apiKeyPrefix.length, k.length - apiKeySuffix.length);
          if (!mid) continue;
          let id; try { id = decodeURIComponent(mid); } catch (e2) { id = mid; }
          if (apiKeyIds.indexOf(id) === -1) apiKeyIds.push(id);
        }
        if (apiKeyIds.length === 1) derivedIdentity = apiKeyIds[0];
        else if (apiKeyIds.length > 1) ambiguousIdentity = true;
      }
      if (ambiguousIdentity) {
        process.stderr.write('[zcode-launcher] account metadata: multiple plan api-key identities for ' + pid + ', no deterministic signal - keeping stored identity\\n');
      }
      // oauth 家族凭据存在性：扫 oauth:<family>:access_token，provider id 以
      // account:<family> 开头即绑定该家族（零家族名写死）。
      let oauthBacked = false;
      const oauthPrefix = 'oauth:';
      const oauthSuffix = ':access_token';
      for (const k of Object.keys(creds)) {
        if (k.indexOf(oauthPrefix) !== 0 || k.slice(-oauthSuffix.length) !== oauthSuffix) continue;
        const fam = k.slice(oauthPrefix.length, k.length - oauthSuffix.length);
        if (!fam) continue;
        const token = creds[k];
        if (typeof token !== 'string' || token === '') continue;
        if (pid.indexOf('account:' + fam) === 0) { oauthBacked = true; break; }
      }
      // ① 身份孤儿矫正：既有非空身份是权威写入，但只在「认证形态要求身份对应 plan
      // api-key」时判定孤儿——oauth 形态下身份不参与凭据查找（CLI 登录写入的身份
      // 可能永无 api-key），不得用残留键名覆写。孤儿 = 无对应 api-key 且当前可派生
      // → 改成当前身份（否则 manual 查旧身份凭据恒失败、永不收敛）。日志在落库
      // 点发（无可用 auth-source 时 continue，不得留下“已矫正”而未写盘的假日志）。
      let identityCorrectedFrom = '';
      if (identity && !hasPlanApiKey(identity) && (authSource === 'manual' || !oauthBacked)
          && derivedIdentity && derivedIdentity !== identity) {
        identityCorrectedFrom = identity;
        identity = derivedIdentity;
      }
      if (!identity) identity = derivedIdentity;
      if (!identity) continue;
      // ② auth-source 派生 + 孤儿矫正：oauth 需匹配家族的 access_token；manual 需该
      // 身份名下的 plan api-key。既有值与当前事实一致时原样保留（GUI/登录写入的
      // manual 在 oauth 同时存在时仍是权威——曾无差别覆写差异值）。
      const derivedAuthSource = oauthBacked ? 'oauth' : (hasPlanApiKey(identity) ? 'manual' : '');
      let nextAuthSource = authSource || derivedAuthSource;
      if (authSource === 'oauth' && !oauthBacked) nextAuthSource = derivedAuthSource;
      else if (authSource === 'manual' && !hasPlanApiKey(identity)) nextAuthSource = derivedAuthSource;
      if (!nextAuthSource) continue;
      // 落库判定：缺失态（空串/非串）记 provisioned，非空旧值被矫正记 reconciled。
      if (creds[idKey] !== identity) {
        if (identityCorrectedFrom) {
          reconciled.push(idKey + ' (' + identityCorrectedFrom + ' -> ' + identity + ')');
        } else if (typeof creds[idKey] !== 'string' || creds[idKey] === '') {
          added.push(idKey);
        }
        creds[idKey] = identity;
      }
      if (creds[srcKey] !== nextAuthSource) {
        if (typeof creds[srcKey] === 'string' && creds[srcKey] !== '') {
          reconciled.push(srcKey + ' (' + creds[srcKey] + ' -> ' + nextAuthSource + ')');
        } else added.push(srcKey);
        creds[srcKey] = nextAuthSource;
      }
    }
    if (added.length === 0 && reconciled.length === 0) return;
    // compare-and-skip（2026-10 review·N-3）：无锁 RMW 的陈旧覆盖防线——写回前重读
    // 磁盘，任一 plan 两键当前值 ≠ 读时基线 = 窗口内 GUI/登录已完成权威写入 → 放弃
    // 本次写入（log 说明，下次 spawn 幂等重算；放弃后的恢复 = 重新登录/配置或删除
    // 该键，ADR-0143 并发边界）。重读/解析失败 = 窗口不可判定，同样保守放弃。
    try {
      const reread = JSON.parse(readOrig.call(fs, credPath, 'utf8'));
      if (!reread || typeof reread !== 'object' || Array.isArray(reread)) {
        throw new Error('credentials reread is not an object');
      }
      for (const mk of Object.keys(metaBaseline)) {
        if ((reread[mk] || '') !== (metaBaseline[mk] || '')) {
          throw new Error('concurrent write detected on ' + mk);
        }
      }
    } catch (skipErr) {
      process.stderr.write('[zcode-launcher] account metadata skipped (' + ((skipErr && skipErr.message) || String(skipErr)) + ') - retry on next spawn\\n');
      return;
    }
    const tmp = credPath + '.taiji-tmp-' + process.pid;
    // rename 换 inode——tmp 不带 mode 落盘会把 GUI 侧收紧过的文件权限静默放宽为
    // 缺省 umask 值，写前读既有 mode 随写传递（stat 失败回退 0600）；写/rename
    // 失败清理 tmp，不在用户凭据目录留残片。
    let writeMode = 0o600;
    try { writeMode = fs.statSync(credPath).mode & 0o777; } catch { /* 缺省 0600 */ }
    try {
      fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: writeMode });
      fs.renameSync(tmp, credPath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* tmp 未生成或已 rename */ }
      throw err;
    }
    if (added.length > 0) process.stderr.write('[zcode-launcher] account metadata provisioned: ' + added.join(', ') + '\\n');
    if (reconciled.length > 0) process.stderr.write('[zcode-launcher] account metadata reconciled: ' + reconciled.join(', ') + '\\n');
  } catch (err) {
    process.stderr.write('[zcode-launcher] account metadata provisioning failed (non-blocking): ' + ((err && err.message) || String(err)) + '\\n');
  }
}
`;
