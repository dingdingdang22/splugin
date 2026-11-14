import { defineConfig } from 'wxt';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 磁盘版本探针生成器 —— 未打包扩展「更新自动检测」的唯一可靠信号源。
 *
 * 为什么必须有它：
 * 1. 以「加载未打包的扩展程序」方式安装的扩展，manifest 中没有 update_url，
 *    Chrome 不会对其做任何周期性更新检查；
 * 2. 因此 chrome.runtime.onUpdateAvailable 永远不会触发，
 *    chrome.runtime.requestUpdateCheck() 也只会返回 no_update 或直接报错；
 * 3. 用户在 chrome://extensions 手动点「小圆圈刷新」之所以有效，
 *    是因为那是一次「强制重新读取磁盘目录」，与版本号比较无关。
 *
 * 对策：每次构建（wxt dev / wxt build 启动时）向 public/version.json 写入
 * { version, buildAt, buildId }。WXT 会把 public/ 原样拷进产物根目录，
 * Service Worker 用 fetch(chrome.runtime.getURL('version.json')) 读到的是
 * 磁盘上的最新值；一旦与「SW 内存中已登记的 buildId」不一致，
 * 即可判定磁盘代码已更新，由扩展自己触发 chrome.runtime.reload()，
 * 无需用户去点小圆圈。
 *
 * buildId 内含 Date.now()，因此「改了代码但没升版本号」同样能被检出。
 */
function emitVersionProbe(): string {
  const rootDir = process.cwd();
  const pkgPath = path.join(rootDir, 'package.json');
  const publicDir = path.join(rootDir, 'public');
  const buildIdFallback = `unknown-${Date.now()}`;
  try {
    if (!fs.existsSync(pkgPath)) return buildIdFallback;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const buildId = `${pkg.version}-${Date.now()}`;
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(
      path.join(publicDir, 'version.json'),
      JSON.stringify({ version: pkg.version, buildAt: new Date().toISOString(), buildId }, null, 2),
      'utf8'
    );
    console.log(`[version-probe] ✅ 已生成磁盘版本探针 public/version.json (buildId: ${buildId})`);
    return buildId;
  } catch (e: any) {
    console.warn(`[version-probe] ⚠️ 生成失败（更新自检将降级）: ${e?.message || e}`);
    return buildIdFallback;
  }
}

const BUILD_ID = emitVersionProbe();

// https://wxt.dev/api/config.html
export default defineConfig({
  // 把构建期 buildId 注入进所有产物（SW / content script / 面板共用），
  // 作为「当前运行代码」的编译期身份，更新自检用它与磁盘探针对账。
  vite: () => ({
    define: {
      __APP_BUILD_ID__: JSON.stringify(BUILD_ID),
    },
  }),
  manifest: (env) => {
    const isDev = env.mode === 'development';
    return {
      name: 'SmartEdu-DoFee 学习进度监控器',
      description: '监控国家中小学智慧教育平台「课程教学 - 学生自主学习」页面的真实播放进度并上报至 dofee 学习系统。',
      icons: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
      action: {
        default_title: 'SmartEdu-DoFee 学习进度监控器',
        default_icon: {
          16: 'icon/16.png',
          32: 'icon/32.png',
          48: 'icon/48.png',
          128: 'icon/128.png',
        },
      },
      permissions: ['storage', 'alarms', 'declarativeNetRequest', 'tabs'],
      host_permissions: [
        'https://basic.smartedu.cn/*',
        'https://*.smartedu.cn/*',
        'https://*.ykt.cbern.com.cn/*',
        'https://*.cbern.com.cn/*',
        'https://*.ykt.eduyun.cn/*',
        'https://*.eduyun.cn/*',
        ...(isDev ? ['http://localhost:*/*', 'http://127.0.0.1:*/*'] : []),
      ],
      optional_host_permissions: [
        'https://*/*',
        'http://localhost:*/*',
        'http://127.0.0.1:*/*',
      ],
    };
  },
});
