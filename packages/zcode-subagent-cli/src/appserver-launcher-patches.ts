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
//     （identity / auth-source）幂等供给（仅缺时追加，ADR-0139）。
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
        const defIdx = src.indexOf(defAnchor);
        if (defIdx >= 0) {
          const paramsEnd = src.indexOf(')', defIdx + defAnchor.length);
          if (paramsEnd > defIdx) {
            const params = src.slice(defIdx + defAnchor.length, paramsEnd);
            // 仅在**唯一** '={}' 缺省参数时改写：曾用 split/join 全量替换，多参数
            // 函数会把 standalone 注入到错误参数（语法仍合法，自检无法发现）；
            // 多于一处 = 无法确定注入点 → 回退调用点锚（第二参语义等价）。
            const firstDefault = params.indexOf('={}');
            if (firstDefault >= 0 && firstDefault === params.lastIndexOf('={}')) {
              src = src.slice(0, defIdx + defAnchor.length)
                + params.slice(0, firstDefault) + '={standalone:{}}' + params.slice(firstDefault + 3)
                + src.slice(paramsEnd);
              standaloneApplied = true;
            }
          }
        }
        // 锚点 B（回退）：调用点注入 create:r(()=><fn>( → (<arg>,{standalone:{}})
        if (!standaloneApplied) {
          const callAnchor = 'create:r(()=>' + fnName + '(';
          const callIdx = src.indexOf(callAnchor);
          if (callIdx >= 0) {
            const argStart = callIdx + callAnchor.length;
            // 括号深度配平找与 fnName( 配对的闭括号：实参含内层调用（如 fnName(w(z))）
            // 时首个 ')' 落在内层，注入错位进内层调用 = 外层保持 host 模式的假成功
            let depth = 1;
            let closeIdx = -1;
            for (let i = argStart; i < src.length; i++) {
              if (src[i] === '(') depth++;
              else if (src[i] === ')') { depth--; if (depth === 0) { closeIdx = i; break; } }
            }
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
        src = src.slice(0, closeIdx)
          + ',providerRuntimeHeadersPort:' + regMatch[1] + '.providerRuntimeHeadersPort'
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
 * 安装门 standalone 已武装分支——未武装时不写共享凭据库）。 */
export const ACCOUNT_METADATA_SECTION = `
// [2026-10-16 standalone account metadata] standalone 账号源要求
// account-provider:<planProviderId>:identity / :auth-source 两条**元数据**键才承认
// account provider（缺 identity 直接丢弃该 provider → 派发报「Provider Registry 中
// 不存在 Model」）。两键非秘密（身份 ID / 认证来源），真凭据仍是 ZCode 自有项
// （oauth token 或 plan api-key，均在 credentials.json，由 ZCode 登录/配置写入）。
// 本步幂等供给：仅缺时追加、不触碰既有键；任何失败只 warn 不阻断 spawn（缺键的
// 报错路径与恢复指引由引擎侧既有文案承载）。catches：文件缺失/坏 JSON/目录不可写。
// 并发边界（ADR-0139 登记）：对与 GUI 共享的凭据库做无锁 read-modify-write 全量
// 写回，与 GUI token 刷新并发存在毫秒级丢更新窗口——后果自愈（GUI 侧重试刷新 /
// 本侧缺键下次 spawn 幂等补齐），事实驱动原则下不加锁、不做时间补偿。
// 调用契约（2026-10 review）：仅在安装门确认 standalone 补丁已武装时调用——这些
// 元数据键只被 standalone 账号源消费，补丁链失败（版本漂移）时写入用户共享
// credentials.json 无任何运行时收益，只增风险。
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
    for (const pid of planIds) {
      const idKey = 'account-provider:' + pid + ':identity';
      const srcKey = 'account-provider:' + pid + ':auth-source';
      let identity = typeof creds[idKey] === 'string' ? creds[idKey] : '';
      if (!identity) {
        // 从 host 态 plan api-key 键名派生身份：
        // account-provider:coding-plan:<pid>:account:<identity>:api-key
        const prefix = 'account-provider:coding-plan:' + pid + ':account:';
        const suffix = ':api-key';
        for (const k of Object.keys(creds)) {
          if (k.indexOf(prefix) === 0 && k.slice(-suffix.length) === suffix) {
            const mid = k.slice(prefix.length, k.length - suffix.length);
            if (mid) { try { identity = decodeURIComponent(mid); } catch (e2) { identity = mid; } break; }
          }
        }
      }
      if (!identity) continue;
      // auth-source：全部从凭据库数据推导（零家族名写死）——扫 oauth:<family>:access_token
      // 键，若 provider id 以 account:<family> 开头即绑定该家族的 oauth 凭据；否则回落
      // manual（该身份名下的 plan api-key 存在时）。
      let authSource = '';
      const oauthPrefix = 'oauth:';
      const oauthSuffix = ':access_token';
      for (const k of Object.keys(creds)) {
        if (k.indexOf(oauthPrefix) !== 0 || k.slice(-oauthSuffix.length) !== oauthSuffix) continue;
        const fam = k.slice(oauthPrefix.length, k.length - oauthSuffix.length);
        if (!fam) continue;
        const token = creds[k];
        if (typeof token !== 'string' || token === '') continue;
        if (pid.indexOf('account:' + fam) === 0) { authSource = 'oauth'; break; }
      }
      if (!authSource && creds['account-provider:coding-plan:' + pid + ':account:' + encodeURIComponent(identity) + ':api-key']) authSource = 'manual';
      if (!authSource) continue;
      // 仅缺时追加（ADR-0139 契约；identity 分支已先读既有非空值故非空天然不覆写）：
      // 空串/缺失/非串 = 缺失态 → 派生值兜底填充；既有非空值是 ZCode 登录/GUI 流程
      // 的权威写入，不回写覆盖（写目标是与 GUI 共享的凭据库——auth-source 曾无差别
      // 覆写差异值，违反「不触碰既有键」契约，2026-10-16 review 修正）
      if (typeof creds[idKey] !== 'string' || creds[idKey] === '') { creds[idKey] = identity; added.push(idKey); }
      if (typeof creds[srcKey] !== 'string' || creds[srcKey] === '') { creds[srcKey] = authSource; added.push(srcKey); }
    }
    if (added.length === 0) return;
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
    process.stderr.write('[zcode-launcher] account metadata provisioned: ' + added.join(', ') + '\\n');
  } catch (err) {
    process.stderr.write('[zcode-launcher] account metadata provisioning failed (non-blocking): ' + ((err && err.message) || String(err)) + '\\n');
  }
}
`;
