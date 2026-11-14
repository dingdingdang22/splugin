/**
 * background.ts - Service Worker 调度中枢 (WXT / TypeScript)
 * 
 * 核心设计：
 * 1. 采用 chrome.alarms 定时触发，规避 MV3 Service Worker 30秒休眠丢失状态的问题；
 * 2. 接收来自 content script 的心跳，确认用户人在主页且处于活跃状态；
 * 3. 维护本地已同步错题 ID 集合，只拉取增量；
 * 4. 代理 content script 发出的跨域请求（BG_HTTP_REQUEST，利用 host_permissions 免除 CORS 限制）。
 */

import { defineBackground } from 'wxt/sandbox';
import { authManager, BACKGROUND_REFRESH_MARGIN_MS } from '../src/core/auth';
import {
  APP_VERSION,
  BUILD_ID,
  APPLIED_BUILD_KEY,
  PENDING_UPDATE_KEY,
  VERSION_PROBE_PATH,
  MSG_PING_UPDATE_STATE,
  MSG_GET_UPDATE_STATE,
  MSG_UPDATE_AVAILABLE,
  MSG_RELOADED_NEW_VERSION,
  type BuildInfo
} from '../src/core/version';

export default defineBackground(() => {
  self.addEventListener('unhandledrejection', (event) => {
    console.log('[SilentSync] 拦截未处理异步异常:', event.reason);
    event.preventDefault();
  });
  self.addEventListener('error', (event) => {
    console.log('[SilentSync] 拦截全局错误:', event.error || event.message);
  });

  const ALARM_NAME = 'SMARTEDU_SILENT_WRONG_SYNC_ALARM';
  const SYNC_INTERVAL_MINUTES = 10;
  const UPDATE_CHECK_ALARM_NAME = 'SMARTEDU_UPDATE_CHECK_ALARM';
  // 未打包扩展没有 Chrome 官方更新节流限制，探针只是本地读一个 JSON，1 分钟一次足够及时且开销极低
  const UPDATE_CHECK_INTERVAL_MINUTES = 1;
  const MAX_HEARTBEAT_AGE_MS = 5 * 60 * 1000;
  // 磁盘探针缓存时长：避免多标签页高频 PING 时重复读盘
  const PROBE_CACHE_MS = 30 * 1000;
  // 广播给页面后，留给消息真正送达的窗口（原实现是「先发后立刻 reload」，消息根本发不出去）
  const RELOAD_GRACE_MS = 1500;

  const STORAGE_KEYS = {
    SYNCED_IDS: 'SMARTEDU_SYNCED_WRONG_IDS',
    SYNCED_EXERCISE_IDS: 'SMARTEDU_SYNCED_EXERCISE_IDS',
    /** 当前学员实际使用的水位 key 映射（由页面编排器登记，SW 无用户上下文） */
    SYNCED_ACTIVE_KEYS: 'SMARTEDU_SYNCED_ACTIVE_KEYS',
    CONFIG: 'SMARTEDU_BACKGROUND_CONFIG',
    TM_IDS: 'SMARTEDU_KNOWN_TM_IDS',
    LAST_LOG: 'SMARTEDU_LAST_SYNC_LOG'
  };

  /**
   * 校验 BG_HTTP_REQUEST 目标 URL 是否在允许的域名白名单内。
   * 仅允许智慧教育平台相关域名、本地开发端口及用户配置的 dofeeApiBase。
   */
  const ALLOWED_HOST_SUFFIXES = [
    '.smartedu.cn',
    'smartedu.cn',
    '.cbern.com.cn',
    'cbern.com.cn',
    '.eduyun.cn',
    'eduyun.cn'
  ];

  function isAllowedBgRequestUrl(rawUrl: string, configuredApiBase?: string): boolean {
    try {
      const u = new URL(rawUrl);
      const host = u.hostname.toLowerCase();
      if (u.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) {
        return true;
      }
      if (u.protocol !== 'https:') return false;
      for (const suffix of ALLOWED_HOST_SUFFIXES) {
        if (suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix) {
          return true;
        }
      }
      if (configuredApiBase) {
        const cfgUrl = new URL(configuredApiBase);
        if (u.origin === cfgUrl.origin) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  class SilentWrongQuestionSyncManager {
    lastHeartbeatTime = 0;
    isSyncing = false;
    /** 磁盘版本探针缓存，避免多标签页高频 PING 反复读盘 */
    private probeCache: { at: number; info: BuildInfo | null } = { at: 0, info: null };
    /** 最近一次页面上报「正在播放/忙碌」的时间戳，用于重载仲裁（绝不打断正在看的课） */
    private lastBusyAt = 0;

    async init() {
      console.log('[SilentSync] Service Worker 初始化中...');

      // 电脑重启自愈：从扩展持久层恢复上次心跳水位线，并清理历史遗留的 SMARTEDU_UC_AUTH 明文凭据
      try {
        await chrome.storage.local.remove(['SMARTEDU_UC_AUTH']);
        const stored = await chrome.storage.local.get(['SMARTEDU_LAST_HEARTBEAT_TIME']);
        if (stored && stored['SMARTEDU_LAST_HEARTBEAT_TIME']) {
          this.lastHeartbeatTime = stored['SMARTEDU_LAST_HEARTBEAT_TIME'];
          console.log('[SilentSync] 成功从 storage 恢复上次心跳水位时间戳');
        }
      } catch (e) {}

      chrome.alarms.get(ALARM_NAME, (alarm) => {
        if (!alarm) {
          chrome.alarms.create(ALARM_NAME, {
            periodInMinutes: SYNC_INTERVAL_MINUTES,
            delayInMinutes: 1
          });
          console.log(`[SilentSync] 定时闹钟已注册，周期：${SYNC_INTERVAL_MINUTES} 分钟`);
        }
      });

      // 无论 alarm 是否已存在都强制重建一次：保证周期从 30 分钟收敛到 1 分钟（旧版本遗留 alarm 的兼容）
      chrome.alarms.get(UPDATE_CHECK_ALARM_NAME, (alarm) => {
        if (alarm) chrome.alarms.clear(UPDATE_CHECK_ALARM_NAME);
        chrome.alarms.create(UPDATE_CHECK_ALARM_NAME, {
          periodInMinutes: UPDATE_CHECK_INTERVAL_MINUTES,
          delayInMinutes: 1
        });
        console.log(`[AutoUpdate] 磁盘探针自检闹钟已注册，周期：${UPDATE_CHECK_INTERVAL_MINUTES} 分钟`);
      });

      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === ALARM_NAME) {
          console.log('[SilentSync] 定时闹钟触发，唤醒执行任务...');
          this.checkAndRefreshTokenInBackground().catch(() => {});
          this.runSyncTask('alarm').catch((e) => console.log('[SilentSync] 闹钟任务捕获:', e.message));
        } else if (alarm.name === UPDATE_CHECK_ALARM_NAME) {
          this.runUpdateCheckCycle().catch(() => {});
        }
      });

      // 启动时主动巡检一次凭据有效性 & 同步扩展角标
      this.checkAndRefreshTokenInBackground().catch(() => {});
      this.updateActionBadge().catch(() => {});

      // SW 每次被唤醒/重载都会执行到这里：登记当前生效构建，并把「代码刚换新」广播给所有页面。
      // 这一步是「扩展已重载、但旧页面还跑着旧 content script」场景下提示能亮起的关键。
      this.registerAppliedBuild().catch(() => {});

      // 唤醒即刻对账一次：磁盘若已换新，立刻触发重载，不必等下一轮闹钟（最长省 1 分钟延迟）
      this.runUpdateCheckCycle().catch(() => {});

      // 方案 A + B 融合：监听新版产物已就绪
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onUpdateAvailable) {
        chrome.runtime.onUpdateAvailable.addListener((details) => {
          console.log(`[AutoUpdate] 监听到新版本 v${details.version} 已在本地就绪待命！`);
          this.handleUpdateAvailable(details);
        });
      }

      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
        chrome.runtime.onInstalled.addListener((details) => {
            if (details.reason === 'update' || details.reason === 'install') {
              console.log(`[AutoUpdate] 扩展生命周期事件: ${details.reason}，上一版本: ${details.previousVersion || '未知'}，当前版本: ${APP_VERSION}`);
              chrome.storage.local.remove([PENDING_UPDATE_KEY]).catch(() => {});
              this.updateActionBadge().catch(() => {});
              // 广播不再限定 smartedu 域名：任何还开着旧 content script 的页面都需要被通知刷新
              this.broadcastToAllTabs(MSG_RELOADED_NEW_VERSION, APP_VERSION).catch(() => {});
            }
        });
      }

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName === 'local' && changes[STORAGE_KEYS.CONFIG]) {
            this.updateActionBadge().catch(() => {});
            const oldCfg = changes[STORAGE_KEYS.CONFIG].oldValue || {};
            const newCfg = changes[STORAGE_KEYS.CONFIG].newValue || {};
            const wrongEnabled = newCfg.syncWrongBook === true;
            const exEnabled = newCfg.syncMyExercises === true;
            const anyEnabled = wrongEnabled || exEnabled;
            const wrongTurnedOn = oldCfg.syncWrongBook !== true && wrongEnabled;
            const exTurnedOn = oldCfg.syncMyExercises !== true && exEnabled;

            if (newCfg.dofeeJwtToken && anyEnabled) {
              if (oldCfg.dofeeJwtToken !== newCfg.dofeeJwtToken) {
                console.log('[SilentSync] 检测到 dofee 账号更新，激活静默同步...');
                this.runSyncTask('dofee_login_detected').catch(() => {});
              } else if (wrongTurnedOn || exTurnedOn) {
                console.log('[SilentSync] 检测到同步开关开启，激活静默同步...');
                this.broadcastRunSilentSync('config_enabled').catch(() => {});
                this.runSyncTask('config_enabled').catch(() => {});
              }
            }
          }
        });
      }

      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        try {
          const isAsync = this.handleMessage(message, sender, sendResponse);
          return isAsync === true;
        } catch (e: any) {
          try { sendResponse({ ok: false, error: e.message }); } catch (_) {}
          return false;
        }
      });

      console.log('[SilentSync] ✅ 初始化完成，后台静默守护已就绪');
    }

    handleMessage(message: any, sender: any, sendResponse: (res: any) => void): boolean {
      if (!message || !message.type) return false;

      const safeSend = (payload: any) => {
        try { sendResponse(payload); } catch (e) {}
      };

      if (message.type === 'SMARTEDU_HEARTBEAT') {
        const data = message.data || {};
        this.lastHeartbeatTime = Date.now();
        chrome.storage.local.set({ 'SMARTEDU_LAST_HEARTBEAT_TIME': this.lastHeartbeatTime });

        // 页面上报「正在播放/忙碌」：重载仲裁用，避免自动更新打断正在看的课
        if (data.busy === true) this.lastBusyAt = Date.now();

        if (Array.isArray(data.teachingMaterialIds) && data.teachingMaterialIds.length > 0) {
          this.addKnownTeachingMaterials(data.teachingMaterialIds).catch(() => {});
        }

        if (data.authTokens && data.authTokens.dofeeConfig) {
          this.saveConfig(data.authTokens.dofeeConfig).catch(() => {});
        }

        if (data.isLoggedIn && data.justLoggedIn) {
          // 平台侧登录/换账号时：仅当「同步错题本」或「同步我的习题」至少开启一项时，才广播并唤醒同步
          this.getConfig().then((cfg) => {
            if (cfg && (cfg.syncWrongBook === true || cfg.syncMyExercises === true)) {
              this.broadcastRunSilentSync('login_detected').catch(() => {});
              this.runSyncTask('login_detected').catch(() => {});
            } else {
              console.log('[SilentSync] 平台已登录，但「错题本」与「我的习题」同步开关均关闭，已跳过自动同步');
            }
          }).catch(() => {});
        }

        safeSend({ ok: true, received: true });
        return false;
      } else if (message.type === MSG_PING_UPDATE_STATE) {
        // content script 的存活心跳 + 构建标识对账：
        // 页面用「自己注入时拿到的 buildId」与「SW 当前运行的 buildId」比对，
        // 只要不等，就说明扩展已经换新、当前页面跑的还是旧 content script，必须刷新页面。
        // 注意：这里必须返回 SW 自身编译期 BUILD_ID（我此刻跑的是哪份代码），
        // 绝不能返回磁盘探针值 —— 磁盘可能已换新而扩展尚未重载，那会把页面误导成「刷新即可」。
        if (message.busy === true) this.lastBusyAt = Date.now();
        safeSend({ ok: true, buildId: BUILD_ID, version: APP_VERSION });
        return false;
      } else if (message.type === MSG_GET_UPDATE_STATE) {
        // 页面首次挂载时拉取一次完整的更新态，避免「广播早于页面挂载」导致提示永久丢失
        this.checkUpdate()
          .then((res) => safeSend({
            ok: true,
            status: res.status,
            version: res.version,
            buildId: res.buildId,
            isUpdateReady: res.status === 'update_available',
            isLocal: res.isLocal,
            source: res.source
          }))
          .catch((err) => safeSend({ ok: false, error: err.message }));
        return true;
      } else if (message.type === 'CHECK_EXTENSION_UPDATE') {
        this.checkUpdate()
          .then((res) => safeSend({
            ok: true,
            status: res.status,
            version: res.version,
            buildId: res.buildId,
            isLocal: res.isLocal,
            source: res.source
          }))
          .catch((err) => safeSend({ ok: false, error: err.message }));
        return true;
      } else if (message.type === 'APPLY_EXTENSION_UPDATE') {
        console.log('[AutoUpdate] 收到前端强制重载更新请求，广播后将执行 chrome.runtime.reload()...');
        safeSend({ ok: true });
        this.handleUpdateAvailable({ version: message.version || APP_VERSION, buildId: message.buildId, force: true });
        return true;
      } else if (message.type === 'GET_SILENT_SYNC_STATUS') {
        // 【修复：同步状态卡「检测中」】面板每次打开都会发这条消息，
        // 旧实现没有对应分支 → handleMessage 返回 false → sendResponse 永不调用 →
        // 面板回调永远不执行，状态文本永久停留在初始的「检测中...」。
        // 现在如实回传 SW 侧掌握的全部状态；页面侧的同步进度由面板从
        // 本地编排器快照合并（同步真正跑在页面世界，见 runSyncTask 注释）。
        this.getSilentSyncStatus()
          .then((s) => safeSend(s))
          .catch((err) => safeSend({ ok: false, error: err?.message || String(err) }));
        return true;
      } else if (message.type === 'TRIGGER_SILENT_SYNC') {
        // 【修复：登录后同步不触发】真正能抓题、能上传的编排器活在页面侧
        // （SW 无页面上下文，见 runSyncTask 注释）。
        // 仅当「同步错题本」或「同步我的习题」至少开启一项时，才广播回 smartedu 标签页触发执行；
        // 每日闸门 + 题目级去重保证幂等，多标签页同时收到也不会重复上传。
        this.getConfig()
          .then((cfg) => {
            if (!cfg || (cfg.syncWrongBook !== true && cfg.syncMyExercises !== true)) {
              safeSend({ ok: true, result: { skipped: true, reason: 'SYNC_DISABLED' } });
              return;
            }
            this.broadcastRunSilentSync(message.trigger || 'manual').catch(() => {});
            return this.runSyncTask(message.trigger || 'manual')
              .then((result) => safeSend({ ok: true, result }));
          })
          .catch((err) => safeSend({ ok: false, error: err && err.message ? err.message : String(err) }));
        return true;
      } else if (message.type === 'BG_HTTP_REQUEST') {
        if (sender && sender.id && chrome.runtime?.id && sender.id !== chrome.runtime.id) {
          safeSend({ ok: false, status: 403, error: '非法请求来源' });
          return false;
        }
        const { url, method = 'GET', headers = {}, data } = message;
        this.getConfig()
          .then((cfg) => {
            if (!url || !isAllowedBgRequestUrl(String(url), cfg?.dofeeApiBase)) {
              safeSend({ ok: false, status: 403, error: '目标 URL 不在扩展允许白名单内' });
              return;
            }
            return fetch(url, {
              method,
              headers,
              body: data ? (typeof data === 'string' ? data : JSON.stringify(data)) : undefined
            })
              .then(async (resp) => {
                const responseText = await resp.text();
                safeSend({
                  ok: true,
                  status: resp.status,
                  responseText
                });
              })
              .catch((err) => {
                safeSend({
                  ok: false,
                  status: 0,
                  error: err.message || '网络请求失败'
                });
              });
          })
          .catch((err) => {
            safeSend({
              ok: false,
              status: 0,
              error: err?.message || '网络请求失败'
            });
          });
        return true;
      }

      return false;
    }

    async saveConfig(cfg: any) {
      if (!cfg) return;
      const old = await this.getConfig();
      const safeCfg = Object.assign({}, cfg);
      const fromHeartbeat = safeCfg._fromHeartbeat === true;
      delete safeCfg._fromHeartbeat;

      // 若心跳携带来旧时间戳配置，拒绝覆写 Popup/其他页面刚写入的新配置
      if (
        fromHeartbeat &&
        typeof old.configUpdatedAt === 'number' &&
        typeof safeCfg.configUpdatedAt === 'number' &&
        safeCfg.configUpdatedAt <= old.configUpdatedAt
      ) {
        return;
      }

      // 防清空保护（Anti-Wipe Guard）：拦截非显式注销途径的空 Token 冲刷
      if (!cfg._explicitLogout) {
        if (safeCfg.dofeeJwtToken === '' && old.dofeeJwtToken) {
          console.warn('[AutoAuth] 🛡️ 后台拦截心跳或未就绪配置对有效 dofeeJwtToken 的空值覆写');
          delete safeCfg.dofeeJwtToken;
        }
        if (safeCfg.dofeeRefreshToken === '' && old.dofeeRefreshToken) {
          console.warn('[AutoAuth] 🛡️ 后台拦截心跳或未就绪配置对有效 dofeeRefreshToken 的空值覆写');
          delete safeCfg.dofeeRefreshToken;
        }
      }

      const merged = Object.assign({}, old, safeCfg);
      await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: merged });
    }

    async getConfig() {
      const data = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
      return data[STORAGE_KEYS.CONFIG] || {};
    }

    async getKnownTeachingMaterials(): Promise<Set<string>> {
      const data = await chrome.storage.local.get(STORAGE_KEYS.TM_IDS);
      return new Set(data[STORAGE_KEYS.TM_IDS] || []);
    }

    async addKnownTeachingMaterials(ids: string[]) {
      const set = await this.getKnownTeachingMaterials();
      let changed = false;
      for (const id of ids) {
        if (!set.has(id)) {
          set.add(id);
          changed = true;
        }
      }
      if (changed) {
        await chrome.storage.local.set({ [STORAGE_KEYS.TM_IDS]: Array.from(set) });
      }
    }

    /**
     * 读取磁盘版本探针 public/version.json
     *
     * 必须由 Service Worker 发起：SW 的源就是扩展自身，
     * fetch(chrome-extension://<id>/version.json) 属同源请求，不需要 web_accessible_resources；
     * 若由 content script 发起则属跨源，会被 CORS 拦掉——这也是探针只能放在 SW 侧的原因。
     *
     * 未打包扩展的磁盘目录不会被 Chrome 缓存成 CRX，因此这里读到的是磁盘上的实时内容。
     */
    async readDiskBuildProbe(force = false): Promise<BuildInfo | null> {
      const now = Date.now();
      if (!force && this.probeCache.info && now - this.probeCache.at < PROBE_CACHE_MS) {
        return this.probeCache.info;
      }
      try {
        const url = chrome.runtime.getURL(VERSION_PROBE_PATH);
        const resp = await fetch(`${url}?t=${now}`, { cache: 'no-store' });
        if (!resp.ok) {
          this.probeCache = { at: now, info: null };
          return null;
        }
        const info = (await resp.json()) as BuildInfo;
        if (!info || typeof info.buildId !== 'string' || !info.buildId) {
          this.probeCache = { at: now, info: null };
          return null;
        }
        this.probeCache = { at: now, info };
        return info;
      } catch {
        this.probeCache = { at: now, info: null };
        return null;
      }
    }

    async getAppliedBuild(): Promise<BuildInfo | null> {
      const data = await chrome.storage.local.get(APPLIED_BUILD_KEY);
      return (data[APPLIED_BUILD_KEY] as BuildInfo) || null;
    }

    async setAppliedBuild(info: BuildInfo) {
      await chrome.storage.local.set({ [APPLIED_BUILD_KEY]: info });
    }

    /**
     * SW 启动登记：把「当前正在运行的代码」的 buildId 落库，并在换新后广播页面提示刷新。
     *
     * 【核心修复 · 严禁洗白】：
     * 只有当磁盘探针 buildId === 运行中代码编译期 BUILD_ID 时，才有资格登记 applied。
     * 若两者不等，说明「磁盘已换新、扩展本体还没重载」—— 此时必须原样返回、留给更新周期
     * 触发 chrome.runtime.reload()。旧实现在这里直接 setAppliedBuild(disk)，
     * 把磁盘新 buildId 洗成「已生效」，导致 checkUpdate 永远 no_update、重载永不触发，
     * 页面刷新也只会注入旧 content script，版本号将永远停在旧值（正是「升不上去」的元凶）。
     */
    async registerAppliedBuild() {
      const disk = await this.readDiskBuildProbe(true);
      if (!disk) return;

      if (disk.buildId !== BUILD_ID) {
        console.log(`[AutoUpdate] 磁盘已有新构建 ${disk.buildId}（当前运行 ${BUILD_ID}），不落库、交由更新周期触发重载`);
        return;
      }

      // 当前运行代码已是磁盘最新版本：清理历史残留的 PENDING 标记并同步角标
      await chrome.storage.local.remove([PENDING_UPDATE_KEY]);
      await this.updateActionBadge();

      const applied = await this.getAppliedBuild();
      if (!applied) {
        await this.setAppliedBuild(disk);
        console.log(`[AutoUpdate] 已登记当前运行构建: ${disk.buildId} (v${disk.version})`);
        return;
      }
      if (applied.buildId !== disk.buildId) {
        await this.setAppliedBuild(disk);
        console.log(`[AutoUpdate] 代码已换新 (${applied.buildId} → ${disk.buildId})，广播页面提示刷新`);
        await this.broadcastToAllTabs(MSG_RELOADED_NEW_VERSION, disk.version);
      }
    }

    /** 一轮完整自检：命中新版则直接走「广播 → 重载」流程 */
    async runUpdateCheckCycle() {
      const res = await this.checkUpdate();
      if (res.status === 'update_available') {
        this.handleUpdateAvailable({ version: res.version || APP_VERSION, buildId: res.buildId });
      }
      return res;
    }

    /**
     * 更新检查：磁盘探针为主路径，requestUpdateCheck 仅作商店态兜底
     *
     * 为什么要换主路径：未打包扩展没有 update_url，Chrome 不会为它做周期性更新检查，
     * requestUpdateCheck() 对它只会返回 no_update 或抛错，onUpdateAvailable 永不触发 ——
     * 这就是「必须手动点小圆圈」的根因。
     */
    async checkUpdate(): Promise<{ status: string; version?: string; buildId?: string; isLocal?: boolean; source: string }> {
      const manifest = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) ? chrome.runtime.getManifest() : null;
      const isUnpacked = !manifest || !('update_url' in manifest);

      // 主路径：磁盘版本探针
      const disk = await this.readDiskBuildProbe(true);
      if (disk) {
        // 【核心判定】磁盘探针 buildId ≠ 运行中代码编译期 BUILD_ID → 磁盘已换新，扩展必须重载。
        // 用「我自己的编译期身份」对账，彻底绕开 applied 存储键可被竞态洗白的问题。
        if (disk.buildId !== BUILD_ID) {
          return { status: 'update_available', version: disk.version, buildId: disk.buildId, isLocal: isUnpacked, source: 'disk-probe' };
        }
        // 磁盘与运行代码一致 → 已是最新（applied 落库与页面广播由 registerAppliedBuild 负责）
        await chrome.storage.local.remove([PENDING_UPDATE_KEY]);
        await this.updateActionBadge();
        return { status: 'no_update', version: disk.version, buildId: disk.buildId, isLocal: isUnpacked, source: 'disk-probe' };
      }

      // 兜底路径：商店托管扩展
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.requestUpdateCheck === 'function') {
        return new Promise((resolve) => {
          try {
            chrome.runtime.requestUpdateCheck((status, details) => {
              console.log('[AutoUpdate] requestUpdateCheck 响应:', status, details?.version);
              if (isUnpacked && (status === 'no_update' || status === 'throttled')) {
                resolve({ status: 'local_mode', version: APP_VERSION, isLocal: true, source: 'requestUpdateCheck' });
              } else {
                resolve({ status, version: details?.version, isLocal: isUnpacked, source: 'requestUpdateCheck' });
              }
            });
          } catch (e: any) {
            resolve({ status: isUnpacked ? 'local_mode' : 'error', version: APP_VERSION, isLocal: isUnpacked, source: 'requestUpdateCheck' });
          }
        });
      }

      return { status: isUnpacked ? 'local_mode' : 'unsupported', version: APP_VERSION, isLocal: isUnpacked, source: 'none' };
    }

    /** 本 SW 生命周期内是否已排定重载，防止「初始化自检 + 闹钟自检」双触发重复排程 */
    private reloadScheduled = false;

    /**
     * 处理已就绪的新版本
     *
     * 关键修复：原实现是「chrome.tabs.query(异步回调) 之后同步 chrome.runtime.reload()」，
     * reload 会立刻销毁扩展上下文，query 回调里的 sendMessage 全部失败 —— 提示永远送不到页面。
     * 现改为 await 广播真正完成后，再延迟一小段窗口重载。
     */
    handleUpdateAvailable(details: { version: string; buildId?: string; force?: boolean }) {
      if (this.reloadScheduled && !details.force) return;
      chrome.storage.local.set({ [PENDING_UPDATE_KEY]: details.version }).catch(() => {});
      this.updateActionBadge().catch(() => {});
      const busy = Date.now() - this.lastBusyAt < 60 * 1000;

      if (busy && !details.force) {
        console.log(`[AutoUpdate] 新版本 v${details.version} 已在磁盘就绪，当前页面正在播放课程（busy），仅广播提示、暂不重载扩展`);
        this.broadcastToAllTabs(MSG_UPDATE_AVAILABLE, details.version).catch(() => {});
        return;
      }

      this.reloadScheduled = true;
      console.log(`[AutoUpdate] 新版本 v${details.version} 已在磁盘就绪，先广播页面提示再重载...`);

      this.broadcastToAllTabs(MSG_UPDATE_AVAILABLE, details.version)
        .catch(() => {})
        .finally(() => {
          console.log(`[AutoUpdate] 页面空闲，${RELOAD_GRACE_MS}ms 后执行重载`);
          setTimeout(() => {
            console.log('[AutoUpdate] 执行 chrome.runtime.reload() 激活新版代码...');
            try { chrome.runtime.reload(); } catch (e) {}
          }, RELOAD_GRACE_MS);
        });
    }

    /**
     * 向所有标签页广播（不再限定 smartedu 域名，任何开着旧 content script 的页面都要通知）。
     * chrome:// 等无权限页面 sendMessage 会失败，静默忽略即可。
     */
    private async broadcastToAllTabs(type: string, version: string) {
      let tabs: chrome.tabs.Tab[] = [];
      try {
        tabs = await chrome.tabs.query({});
      } catch {
        return;
      }
      await Promise.all(
        (tabs || [])
          .filter((t) => typeof t.id === 'number')
          .map((t) => chrome.tabs.sendMessage(t.id as number, { type, version }).catch(() => {}))
      );
    }

    /**
     * 后台无感续签机制（现代化双端点平滑降级）：
     * 解决电脑重启或长时间闲置后，后台执行任务或页面打开遇到 401 报错的缺陷。
     * 优先尝试现代 /api/v1/auth/refresh，自动降级 /api/auth，并将新凭据回写至 chrome.storage.local。
     */
    async tryRefreshTokenInBackground(cfg: any, customRefreshToken?: string): Promise<{ token: string; refreshToken: string } | null> {
      const refreshToken = String(customRefreshToken || cfg?.dofeeRefreshToken || '').trim();
      if (!cfg || !refreshToken || !cfg.dofeeApiBase) return null;
      const apiBase = String(cfg.dofeeApiBase).replace(/\/+$/, '');

      // 1. 尝试现代 v1 架构
      try {
        const v1Resp = await fetch(`${apiBase}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Dofee-Client': 'smartedu-monitor'
          },
          body: JSON.stringify({ refreshToken })
        });
        if (v1Resp.ok) {
          const data = await v1Resp.json();
          const newToken = data.token || data.accessToken || data.data?.token || data.data?.accessToken;
          const nextRefresh = data.refreshToken || data.data?.refreshToken || refreshToken;
          if (newToken) {
            console.log('[AutoAuth] ✅ Service Worker 现代端点自动无感续签成功，JWT 已延长！');
            return { token: newToken, refreshToken: nextRefresh };
          }
        }
      } catch (e: any) {
        console.warn('[AutoAuth] 后台 v1 续签网络异常:', e.message);
      }

      // 2. 降级 Legacy 架构
      try {
        const legacyResp = await fetch(`${apiBase}/api/auth`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Dofee-Client': 'smartedu-monitor'
          },
          body: JSON.stringify({
            action: 'refresh',
            refreshToken
          })
        });
        if (legacyResp.ok) {
          const data = await legacyResp.json();
          const newToken = data.token || data.accessToken || data.data?.token || data.data?.accessToken;
          const nextRefresh = data.refreshToken || data.data?.refreshToken || refreshToken;
          if (newToken) {
            console.log('[AutoAuth] ✅ Service Worker Legacy 端点自动无感续签成功，JWT 已延长！');
            return { token: newToken, refreshToken: nextRefresh };
          }
        }
      } catch (e: any) {
        console.warn('[AutoAuth] 后台 Legacy 续签网络异常:', e.message);
      }

      return null;
    }

    /**
     * 后台凭据定时巡检与主动延期守护
     * 定时检查 Access Token 剩余有效期，在少于 24 小时或已过期且存在 Refresh Token 时静默续期。
     * 支持最多 3 个槽位全部巡检保活。
     */
    async checkAndRefreshTokenInBackground(): Promise<void> {
      try {
        const cfg = await this.getConfig();
        const apiBase = String(cfg.dofeeApiBase || '').trim();
        if (!apiBase) return;

        // 1. 巡检 boundAccounts 中的所有槽位
        const slots: any[] = Array.isArray(cfg.boundAccounts) ? [...cfg.boundAccounts] : [];
        let boundChanged = false;

        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          const sToken = String(slot.dofeeJwtToken || '').trim();
          const sRefresh = String(slot.dofeeRefreshToken || '').trim();
          if (!sRefresh) continue;

          const isExpiring = sToken ? authManager.isTokenExpiringSoon(sToken, BACKGROUND_REFRESH_MARGIN_MS) : true;
          if (isExpiring) {
            console.log(`[AutoAuth] ⏰ 后台巡检：槽位 [${slot.dofeeUsername}] 处于临界过期期，启动续期...`);
            const refreshed = await this.tryRefreshTokenInBackground(cfg, sRefresh);
            if (refreshed) {
              slots[i] = {
                ...slot,
                dofeeJwtToken: refreshed.token,
                dofeeRefreshToken: refreshed.refreshToken
              };
              boundChanged = true;
              // 若该槽位是当前激活账户，同时更新顶层投影
              if (cfg.dofeeUsername === slot.dofeeUsername) {
                await this.saveConfig({
                  dofeeJwtToken: refreshed.token,
                  dofeeRefreshToken: refreshed.refreshToken
                });
              }
            }
          }
        }

        if (boundChanged) {
          await this.saveConfig({ boundAccounts: slots });
        }

        // 2. 检查当前顶层投影（若不在 boundAccounts 内或未设槽位）
        const token = String(cfg.dofeeJwtToken || '').trim();
        const refreshToken = String(cfg.dofeeRefreshToken || '').trim();
        if (refreshToken && (!slots.length || !slots.some((s) => s.dofeeUsername === cfg.dofeeUsername))) {
          const isExpiring = token ? authManager.isTokenExpiringSoon(token, BACKGROUND_REFRESH_MARGIN_MS) : true;
          if (isExpiring) {
            console.log('[AutoAuth] ⏰ 后台巡检：顶层 Token 处于临界过期期或已失效，启动静默保活延期...');
            const refreshed = await this.tryRefreshTokenInBackground(cfg);
            if (refreshed) {
              await this.saveConfig({
                dofeeJwtToken: refreshed.token,
                dofeeRefreshToken: refreshed.refreshToken
              });
            }
          }
        }
      } catch (err: any) {
        console.warn('[AutoAuth] 后台凭据巡检异常:', err?.message || String(err));
      }
    }

    /**
     * 向所有 smartedu 标签页广播「执行静默同步」指令。
     *
     * 为什么限定 smartedu 域：编排器只注入在平台页面上，其它域收不到也执行不了；
     * chrome:// 等无权限页面 sendMessage 会失败，逐 tab catch 静默忽略。
     * 页面侧收到后调 runSilentAutoSync，受三重幂等保护（并发锁 / 每日闸门 / 题目级去重）。
     */
    private async broadcastRunSilentSync(trigger: string) {
      let tabs: chrome.tabs.Tab[] = [];
      try {
        tabs = await chrome.tabs.query({
          url: ['https://basic.smartedu.cn/*', 'https://*.smartedu.cn/*', 'https://*.eduyun.cn/*', 'https://*.cbern.com.cn/*']
        });
      } catch {
        return;
      }
      await Promise.all(
        (tabs || [])
          .filter((t) => typeof t.id === 'number')
          .map((t) => chrome.tabs.sendMessage(t.id as number, { type: 'SMARTEDU_RUN_SILENT_SYNC', trigger }).catch(() => {}))
      );
    }

    /**
     * 同步浏览器顶部扩展图标角标：
     * - 有新版本待生效：显示 `NEW`（琥珀色）
     * - 未登录且无可用刷新令牌/槽位：显示 `!`（红色）
     * - 其余正常态：清空角标保持清爽
     */
    async updateActionBadge(): Promise<void> {
      if (typeof chrome === 'undefined' || !chrome.action?.setBadgeText) return;
      try {
        const pendingData = await chrome.storage.local.get(PENDING_UPDATE_KEY);
        const pendingVer = pendingData && pendingData[PENDING_UPDATE_KEY];
        if (pendingVer) {
          await chrome.action.setBadgeText({ text: 'NEW' });
          await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
          return;
        }
        const cfg = await this.getConfig();
        const hasToken = !!(cfg && (cfg.dofeeJwtToken || cfg.dofeeRefreshToken));
        const hasSlots = Array.isArray(cfg?.boundAccounts) && cfg.boundAccounts.length > 0;
        if (!hasToken && !hasSlots) {
          await chrome.action.setBadgeText({ text: '!' });
          await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
          return;
        }
        await chrome.action.setBadgeText({ text: '' });
      } catch (e) { /* ignore */ }
    }

    /**
     * 汇总 SW 侧掌握的静默同步状态（GET_SILENT_SYNC_STATUS 的响应体）。
     *
     * 注意边界：isSyncing 只反映 SW 自己那层（基本恒 false，因为抓取/上传都在页面）；
     * 页面正在同步与否由面板用本地编排器快照合并后展示，两边都不缺席。
     */
    async getSilentSyncStatus() {
      const cfg = await this.getConfig();
      const now = Date.now();
      const hasActiveHeartbeat = (now - this.lastHeartbeatTime) < MAX_HEARTBEAT_AGE_MS;

      let syncedCount = 0;
      try {
        // 水位 key 自 v1.10.0 起按学员分桶（`<原key>:<username>`）。SW 拿不到当前学员
        // 上下文，改读页面编排器登记的映射；取不到时回退到旧的全局 key。
        const mapData = await chrome.storage.local.get(STORAGE_KEYS.SYNCED_ACTIVE_KEYS);
        const keyMap = mapData[STORAGE_KEYS.SYNCED_ACTIVE_KEYS];
        const wrongKey = (keyMap && keyMap.wrong) || STORAGE_KEYS.SYNCED_IDS;
        const exerciseKey = (keyMap && keyMap.exercise) || STORAGE_KEYS.SYNCED_EXERCISE_IDS;
        const data = await chrome.storage.local.get([wrongKey, exerciseKey]);
        const wrongIds = data[wrongKey];
        const exerciseIds = data[exerciseKey];
        syncedCount = (Array.isArray(wrongIds) ? wrongIds.length : 0)
          + (Array.isArray(exerciseIds) ? exerciseIds.length : 0);
      } catch (e) { /* 读取失败按 0 处理，不阻断状态回报 */ }

      let lastLog: any = null;
      try {
        const d = await chrome.storage.local.get('SMARTEDU_LAST_SILENT_SYNC_LOG');
        lastLog = d['SMARTEDU_LAST_SILENT_SYNC_LOG'] || null;
      } catch (e) { /* ignore */ }

      return {
        ok: true,
        isSyncing: this.isSyncing === true,
        syncWrongBook: cfg.syncWrongBook === true,
        syncMyExercises: cfg.syncMyExercises === true,
        configuredDofee: !!(cfg.dofeeApiBase && (cfg.dofeeJwtToken || cfg.dofeeRefreshToken)),
        hasActiveHeartbeat,
        syncedCount,
        lastLog
      };
    }

    /**
     * 后台静默同步任务。
     *
     * 说明：Service Worker 本身不直接抓取或上传，而是由页面侧编排器承担（通过 broadcastRunSilentSync 通知活跃标签页）。
     * 原因：
     * 1. 页面侧拥有主世界 sniffer DOM 镜像、performance 资源记录与本地登录态上下文，覆盖率完整；
     * 2. Service Worker 侧不持久化平台的 ND_UC_AUTH / mac_key 敏感凭据，避免后台凭据落盘风险。
     */
    async runSyncTask(triggerType: string) {
      if (this.isSyncing) return { skipped: true, reason: 'ALREADY_RUNNING' };

      const cfg = await this.getConfig();
      if (cfg.syncWrongBook !== true && cfg.syncMyExercises !== true) {
        return { skipped: true, reason: 'SYNC_DISABLED' };
      }

      const now = Date.now();
      const hasHeartbeat = (now - this.lastHeartbeatTime) < MAX_HEARTBEAT_AGE_MS;
      if (!hasHeartbeat && triggerType !== 'manual' && triggerType !== 'login_detected' && triggerType !== 'config_enabled') {
        return { skipped: true, reason: 'NO_ACTIVE_HEARTBEAT' };
      }

      const apiBase = String(cfg.dofeeApiBase || '').replace(/\/+$/, '');
      const token = String(cfg.dofeeJwtToken || '').trim();

      if (!apiBase || !token) {
        return { skipped: true, reason: 'MISSING_DOFEE_CREDENTIALS' };
      }

      // 到此为止：凭据齐全且心跳有效，由活跃标签页内的页面编排器执行自动静默同步。
      try {
        await chrome.storage.local.set({
          SMARTEDU_PENDING_SYNC_REQUEST: { trigger: triggerType, at: now }
        });
      } catch (e) { /* ignore */ }

      console.log(`[SilentSync] 后台任务已转发给页面编排器（${triggerType}）。`);

      return {
        skipped: true,
        reason: 'DELEGATED_TO_PAGE_ORCHESTRATOR',
        hint: '已通知活跃的智慧平台页面执行自动静默同步'
      };
    }
  }

  const syncManager = new SilentWrongQuestionSyncManager();
  syncManager.init();
});
