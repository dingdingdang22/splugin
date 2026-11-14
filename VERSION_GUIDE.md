# SmartEdu-DoFee 插件版本管理与发布构建规范 (VERSION_GUIDE)

> **修订日期**：2026-10-22  
> **适用范围**：SmartEdu-DoFee 浏览器插件工程 (`smartedu-dofee-plugin`)  
> **权威事实源**：`package.json` & `src/core/version.ts`

---

## ★【核心铁律】代码变更与版本递增铁律

> **只要对工程代码进行了实质性功能改动、Bug 修复、架构优化或自愈能力升级，严禁保持原版本号不变！必须根据 SemVer 语义化规范同步更新 `package.json` 与 `src/core/version.ts`，完成 `compile` 校验与 `build` 构建闭环，并说明新版本号及递增原因。**

---

## 一、 为什么必须严格管理版本号？

在浏览器扩展开发过程中，最常遇到的痛点就是**“不知道当前页面运行的是新代码还是旧缓存”**：
1. **热更新（HMR）直观反馈**：顶部工具栏下拉弹窗最顶部已植入醒目的高对比度版本徽标（如 `v1.16.0`）与 `● 热更新已生效` 绿灯。代码修改一旦被 WXT 热推送，弹窗顶部的版本号便会立即变化，开发者与使用者能**瞬间确认新版本已生效**，彻底告别盲猜；
2. **线上诊断与排查凭证**：用户截屏反馈或控制台报错时，界面顶部的版本号即为唯一版本证据，杜绝因版本漂移导致的误报；
3. **Manifest 与打包一致性**：Chrome Web Store 与开发者模式加载产物（`manifest.json`）的版本号必须与内部逻辑严格匹配。

---

## 二、 核心机制：双核绑定与工程防呆门禁

为了杜绝“改了 package.json 却忘了改代码”或“代码更新了却未同步构建”的人为遗漏，本项目建立了两道刚性工程门禁：

```text
       ┌──────────────────────┐        ┌──────────────────────┐
       │     package.json     │ <────> │ src/core/version.ts  │
       │  "version": "1.8.1"  │ (严格一致)│ APP_VERSION = '1.8.1'│
       └──────────┬───────────┘        └──────────┬───────────┘
                  │                               │
                  ▼                               ▼
       ┌──────────────────────┐        ┌──────────────────────┐
       │ WXT 生成产物         │        │ 插件界面最顶部展示    │
       │ manifest.json        │        │ 控制台自检 / 句柄    │
       └──────────────────────┘        └──────────────────────┘
                  ▲                               ▲
                  └───────────────┬───────────────┘
                                  │
                    scripts/check-version.js
                     (pre-build / pre-compile 门禁)
```

1. **单一事实源绑定**：
   - 插件外部声明基准：`package.json` 中的 `version` 字段；
   - 源码模块基准：`src/core/version.ts` 中的 `APP_VERSION` 常量；
   - 所有 UI 面板（`diagnostic-panel.ts`、`wrong-question-panel.ts`）、装配脚本（`monitor.content.ts`、`sniffer.content.ts`）与控制台挂载句柄（`__SMARTEDU_MONITOR__.version`）**一律从 `src/core/version.ts` 导入**，禁止在业务代码中硬编码版本字符串。

2. **自动化防呆拦截门禁 (`scripts/check-version.js`)**：
   - 无论是执行 `npm run build` 还是 `npm run compile`，脚本前置钩子均会自动执行版本核验；
   - 一旦两处版本不一致，构建立即阻断（Exit Code 1）并输出详细对齐指引；
   - 支持一键自动同步：`npm run version:sync`。

---

## 三、 版本号递增规则 (SemVer 语义化规范)

版本格式遵循 `MAJOR.MINOR.PATCH`（例如 `1.8.1`）：

| 级别 | 递增示例 | 触发场景 | 说明 |
| :--- | :--- | :--- | :--- |
| **PATCH** (修订号) | `1.8.0` → `1.8.1` | Bug 修复、样式调整、文案微调、防拖拽逻辑微调 | 不破坏既有功能与接口协议 |
| **MINOR** (次版本号) | `1.8.1` → `1.9.0` | 新增功能模块（如新增题库来源、新增嗅探协议、重构特定面板） | 向后兼容的新增功能 |
| **MAJOR** (主版本号) | `1.8.1` → `2.0.0` | 框架升级（如 Manifest V4 / 新架构重构）、不可逆协议变更 | 存在不兼容重大更新 |

---

## 四、 后续每次更新/构建标准操作流程 (SOP)

每次对插件进行功能迭代、Bug 修复或正式打包发布时，必须严格执行以下五步：

### 第一步：确定新版本号
依据上述 SemVer 规则决定本次的版本号，例如准备从 `1.8.1` 升级至 `1.8.2`。

### 第二步：同步更新版本号
推荐操作方式（二选一）：
- **方式 A（全自动同步，推荐）**：
  在 `package.json` 中修改 `"version": "1.8.2"`，然后在终端执行：
  ```bash
  npm run version:sync
  ```
  脚本会自动将 `src/core/version.ts` 同步更新为最新版本。
- **方式 B（手动修改）**：
  同时编辑以下两个文件，将版本号均更改为目标版本：
  1. `package.json` -> `"version": "1.8.2"`
  2. `src/core/version.ts` -> `export const APP_VERSION = '1.8.2';`

### 第三步：运行类型与版本双重核验
```bash
npm run compile
```
- 控制台输出 `[check-version] ✅ 版本号一致性核查通过！当前插件版本: v1.8.2`；
- TypeScript 编译器验证 0 错误通过。

### 第四步：构建或启动热更新开发
- **开发调试时**：
  ```bash
  npm run dev
  ```
  WXT 启动并在代码保存后自动增量热推送。
- **发布构建时**：
  ```bash
  npm run build
  ```
  自动生成产物至 `.output/chrome-mv3`，产物内 `manifest.json` 与代码内的版本号均严格保持最新。

### 第五步：验证热更新生效表现
1. 点击浏览器顶部工具栏的扩展图标，打开下拉弹窗：最顶部高对比度深色状态条显著呈现 `VERSION v1.16.0`，右侧带绿色呼吸小圆点 `● 热更新已生效`；
2. 打开浏览器 DevTools 控制台：输出头部包含 `%c[smartedu-monitor] 扩展已加载 (WXT 现代架构 v1.16.0)！`；
3. 控制台输入 `__SMARTEDU_MONITOR__.version`，返回值应准确显示 `'1.16.0-wxt'`。

---

## 五、 违规与常见错误防范

1. ❌ **严禁跳过校验**：禁止在未经 `check-version` 校验的情况下手动强推带不一致版本的包。
2. ❌ **严禁在代码中写死版本常量**：严禁在 `entrypoints/` 或 `src/` 中硬编码 `'1.8.x'` 字符串，必须从 `src/core/version.ts` 导入引用。
3. ❌ **严禁忽视热更新检验**：若发现保存代码后页面顶部版本号未变化，说明当前页面的 HMR 客户端脱落，应手动刷新一次网页或检查 `wxt dev` 终端连接。

---

## 六、 自动化热更新与分发全景架构 (方案 B 最佳实践)

为了彻底解决“版本升级后必须去 `chrome://extensions` 寻找小圆圈刷新按钮”的痛点，本项目完整落地了**开发态全自动热更 + 生产态平滑协同**的方案：

### 1. 本地开发调试：方案 B（WXT Dev 全自动 HMR）
- **核心命令**：
  ```bash
  npm run dev
  ```
- **工作机制**：
  - WXT 会在产物中自动挂载 Virtual Background 与 WebSocket 客户端；
  - **无需去管理页点刷新**：保存 `background.ts` 代码，WXT Dev Server 自动重载 Service Worker；
  - **无需手动按 F5**：修改 `content-script` 或 UI 组件，WXT 自动重新注入并驱动页面刷新；
  - `wxt.config.ts` 已配置环境动态权限：开发态自动包含 `localhost` 与 `127.0.0.1`，方便本地前后端联调。

### 2. 正式发布：Web Store / CWS 分发规范
- **打包发布命令**：
  ```bash
  npm run zip
  ```
  该命令执行生产纯净构建，**自动剥离 HMR 调试脚本**，并在 `manifest.json` 中自动移除非法的 `localhost` 权限，生成符合 Chrome Web Store 审核要求的合规 `.zip`。
- **生产环境更新协同机制**：
  - 由 Chrome 官方静默下载新版包，触发 `chrome.runtime.onUpdateAvailable`；
  - 后台避免暴力中断正在播放的课程，向前台广播新版就绪；
  - 前台面板顶栏亮起琥珀金药丸：`⚡ 新版已就绪: [🔄 刷新页面生效]`；
  - 心跳守卫与通信层已植入上下文断联熔断机制，杜绝控制台抛出 `Extension context invalidated`。


