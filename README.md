# SmartEdu-DoFee 学习进度监控器 (方案 C 现代化重构版)

基于 **WXT (Next-Gen Web Extension Framework) + TypeScript + Vite 6** 全面重构的 Manifest V3 浏览器扩展工程。

---

## 一、 项目背景与架构升级

本项目是对原 `smartedu-monitor` 的现代化重构，彻底解决了原生散装开发模式下**“每次修改代码都需要手动在扩展管理页面刷新 + 手动刷新测试网页”**的痛点。

### 架构演进对比

| 维度 | 原项目 (`smartedu-monitor`) | 本项目 (`smartedu-dofee-plugin`) |
| :--- | :--- | :--- |
| **工程底座** | 纯原生无构建，靠文件首尾字符串拼接 | **WXT + Vite 6 + TypeScript 5** 现代工程化脚手架 |
| **模块机制** | IIFE 闭包，依赖 `manifest.json` 数组顺序与全局变量 | **标准 ES Module (ESM)**，类型安全，显式依赖 |
| **代码热更 (HMR)** | 无热更，必须每次手动在 `chrome://extensions` 点击刷新 | **内置全自动 HMR**（保存代码即刻毫秒级自动重载/刷新） |
| **执行世界管理** | 手写 `manifest.json` 中的 `world: "MAIN"` | 声明式入口 (`sniffer.content.ts` 自动声明 `MAIN` 世界) |
| **打包产物** | 平铺脚本，易受加载顺序和作用域污染影响 | **Rollup/Vite 树摇优化**，生成高内聚规范包 (`.output/chrome-mv3`) |

---

## 二、 目录结构规范

```text
smartedu-dofee-plugin/
├── entrypoints/                      # 扩展顶层声明式入口 (由 WXT 自动识别生成 manifest)
│   ├── background.ts                 # Service Worker 调度中枢 (alarms 保活/跨域代理/心跳)
│   ├── sniffer.content.ts            # 主世界拦截嗅探器 (world: 'MAIN', runAt: 'document_start')
│   ├── monitor.content.ts            # 隔离世界主装配脚本 (runAt: 'document_end')
│   └── popup/                        # 浏览器顶部工具栏点击下拉弹窗 (学习监控 + 错题/习题 Tab)
├── src/                              # 业务与核心源码层
│   ├── core/                         # 核心算法与数据通信
│   │   ├── question-source.ts        # 题库 CDN、ZIP Range 解压、QTI 解析、双树映射严防门
│   │   ├── storage.ts                # 类型安全配置管理、离线待发队列、幂等时间桶
│   │   └── uploader.ts               # 学习进度向自建服务端上报、无感续签
│   ├── adapters/                     # 平台 DOM 与选择器适配层 (抗版本漂移)
│   │   ├── smartedu-adapter.ts       # 播放器页面课时 ID 识别与课程上下文提取
│   │   └── wrong-question-adapter.ts # 错题本/习题库页面自适应判断、卡片信息提取、Fiber 扫描
│   ├── features/                     # 具体业务域
│   │   ├── catalog-sync.ts           # 播放视频自动提取教材完整待学目录并推送
│   │   ├── video-monitor.ts          # 真实播放行为监控（秒级去重防拖拽/刷时长）
│   │   ├── portal-heartbeat.ts       # 智慧平台主页在线心跳与登录态同步
│   │   ├── study-record-sync.ts      # 智慧平台学习记录体检、dry_run 预览与增量同步
│   │   ├── wrong-question-sync.ts    # 错题增量提取与两段式同步
│   │   ├── wrong-question-probe.ts   # 错题页面路由监控与自动探测调度
│   │   └── my-questions-export.ts    # 习题库提取导出工具 (JSON/Markdown/HTML)
│   └── ui/                           # 兼容状态提供者与历史面板模块
├── wxt.config.ts                     # WXT 配置文件 (扩展权限、名称、构建选项)
├── tsconfig.json                     # TypeScript 配置
└── package.json                      # 依赖与脚本
```

---

## 三、 本地开发与热更新指南

### 1. 启动开发模式（享受自动重载）
在项目根目录运行：
```bash
npm run dev
```
运行后，WXT 会：
1. 在 `.output/chrome-mv3` 输出带 HMR 客户端的开发构建产物；
2. 启动本地 HMR WebSocket 守护服务；
3. **在浏览器中加载扩展**：打开 Chrome / Edge 的 `chrome://extensions`，开启“开发者模式”，点击**“加载已解压的扩展程序”**，选中构建产物目录：
   ```text
   ./.output/chrome-mv3
   ```
4. **配置自建服务端地址**：
   - 开源版本默认**不预置**任何私有后端域名（服务端地址为空）；
   - 点击浏览器顶部工具栏扩展图标，在下拉弹窗的「**dofee 网站与高级选项**」中输入您自建的后端 API 地址（如 `https://your-domain.example` 或本地调试地址 `http://localhost:8787`），点击「保存域名」并授予域名访问权限后即可使用。

### 2. 生产打包构建
当需要发布或交付时，运行：
```bash
npm run build
```
输出经过压缩优化、严格遵循 Chrome Web Store 安全规范的标准产物至 `.output/chrome-mv3`（总大小约 100 KB）。

---

## 四、 核心业务红线保障

本重构版本 100% 继承并忠实遵循了原项目确立的全部铁律与契约：
1. **入库约束（严防双树映射）**：
   - 在 `src/core/question-source.ts` 和各同步链路上完整保留 `assertNoTreeMapping` 防线，严禁 `textbook_node_id`、`chapter_path`、`topic_names` 等映射列流出插件。
2. **难易度中文五级**：
   - 难度严格统一归一化为中文标准五级：`易` / `较易` / `中` / `较难` / `难`。
3. **真实播放行为防刷**：
   - 保留基于秒级覆盖桶（`watchedSecondBuckets`）的物理播放时长去重机制，过滤拖拽快进与重复刷时长。
4. **双世界隔离契约**：
   - 主世界嗅探器通过 `world: 'MAIN'` 早期截获 SPA 接口数据，通过安全的 `postMessage` 问答桥向隔离世界同步数据。

---

## 五、 版本号管理与热更新检测规范

为了直观检测热更新是否已成功触发生效，并在后续更新与构建中始终保持版本一致性，本项目建立了严格的单一事实源（Single Source of Truth）机制与防呆门禁：

1. **界面顶端显著版本透视**：
   - 点击浏览器顶部工具栏的扩展图标即可展开统一操作弹窗，面板最顶部设置专用的深色高对比度状态栏，显著显示 `VERSION v1.16.0` 以及 `● 热更新已生效` 绿灯；
   - **HMR 实时检测**：代码一旦热重载，弹窗顶部的版本号同步更新，无需盲猜刷新。
2. **构建门禁与自动校验**：
   - 源码模块 `src/core/version.ts` 与 `package.json` 双核绑定；
   - 运行 `npm run compile` 或 `npm run build` 时，前置自动触发 `scripts/check-version.js`，版本不一致直接拦截构建；
   - 支持一键同步：`npm run version:sync`。
3. **详细规范与 SOP**：
   - 请查阅根目录 [VERSION_GUIDE.md](./VERSION_GUIDE.md)。

---

## 六、 开源协议与免责声明

- **开源协议**：本项目基于 [GNU General Public License v3.0 (GPL-3.0)](./LICENSE) 开源发布。
- **合规免责声明**：
  1. 本项目为个人学习记录统计、错题整理与技术研究用途的非官方浏览器扩展工具，与国家中小学智慧教育平台没有任何官方关联；
  2. 本项目**不提供**任何跳过播放校验、自动刷课、代学作弊或绕过平台安全机制的功能，所有播放时长统计均基于物理秒级去重；
  3. 使用者应严格遵守目标平台的服务条款与相关法律法规，任何因不当使用本项目产生的后果由使用者自行承担。
