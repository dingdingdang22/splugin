/**
 * version.ts - 插件版本中心与单一事实源 (Single Source of Truth)
 * 
 * 规范守则：
 * 1. 本文件 APP_VERSION 必须与 package.json 中的 version 保持 100% 绝对一致。
 * 2. 界面顶部横幅、标题栏徽标、折叠胶囊、控制台欢迎横幅与自检句柄均统一引用本模块。
 * 3. 任何功能更新、Bug修复或发布构建时，遵循 SemVer 升级版本号，并同步更新此文件与 package.json。
 */

export const APP_VERSION = '1.16.0';
export const DISPLAY_VERSION = `v${APP_VERSION}`;
export const APP_NAME = 'SmartEdu-DoFee 监控器';

/**
 * 构建期注入的 buildId（由 wxt.config.ts 的 version-probe 生成器通过 Vite define 注入）。
 * 它是「当前运行代码」的唯一身份凭证 —— 更新自检用它与磁盘探针对账，
 * 从根本上消灭「把磁盘新 buildId 误登记为已生效」的洗白竞态。
 */
declare const __APP_BUILD_ID__: string | undefined;

export const BUILD_ID: string = (() => {
  try {
    if (typeof __APP_BUILD_ID__ === 'string' && __APP_BUILD_ID__) return __APP_BUILD_ID__;
  } catch (e) {}
  return APP_VERSION;
})();

/**
 * 更新自检相关契约常量（三端共用：Service Worker / content script / 面板）
 */

/** 磁盘版本探针文件名，WXT 会从 public/ 原样拷到扩展产物根目录 */
export const VERSION_PROBE_PATH = 'version.json';

/** storage key：Service Worker 当前「已登记生效」的构建标识 */
export const APPLIED_BUILD_KEY = 'SMARTEDU_APPLIED_BUILD';

/** storage key：检测到但尚未生效的新版本标记 */
export const PENDING_UPDATE_KEY = 'SMARTEDU_PENDING_UPDATE_VERSION';

/** 消息类型：content script 向 SW 询问当前运行构建标识（同时兼作上下文存活心跳） */
export const MSG_PING_UPDATE_STATE = 'PING_UPDATE_STATE';

/** 消息类型：content script 启动时拉取一次完整的更新态 */
export const MSG_GET_UPDATE_STATE = 'GET_UPDATE_STATE';

/** 消息类型：SW → 页面，磁盘已检出新版、即将重载 */
export const MSG_UPDATE_AVAILABLE = 'EXTENSION_UPDATE_AVAILABLE';

/** 消息类型：SW → 页面，扩展已完成重载、页面需刷新才能用上新 content script */
export const MSG_RELOADED_NEW_VERSION = 'EXTENSION_RELOADED_NEW_VERSION';

export interface BuildInfo {
  version: string;
  buildAt: string;
  buildId: string;
}

/**
 * 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0。
 * 用于「磁盘探针版本 vs 运行时版本」的兜底判断（buildId 缺失时）。
 */
export function compareVersion(a: string, b: string): number {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * 运行时安全获取当前版本：
 * 优先取代码绑定的硬版本号（确保 HMR 热更立刻反映最新的内存编译产物）；
 * 同时提供与 manifest 版本的一致性对比。
 */
export function getRuntimeVersion(): string {
  return APP_VERSION;
}

export function getManifestVersion(): string {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      return chrome.runtime.getManifest()?.version || APP_VERSION;
    }
  } catch (e) {}
  return APP_VERSION;
}

/**
 * 安全检测扩展上下文是否有效（用于捕获 Extension context invalidated）
 */
export function isContextValid(): boolean {
  try {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  } catch (e) {
    return false;
  }
}

