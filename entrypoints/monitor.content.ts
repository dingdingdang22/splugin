/**
 * monitor.content.ts - 学习监控与错题探针主装配入口 (WXT Content Script / ISOLATED World)
 */

import { defineContentScript } from 'wxt/sandbox';
import { diagnosticPanel } from '../src/ui/diagnostic-panel';
import { videoMonitor } from '../src/features/video-monitor';
import { catalogSync } from '../src/features/catalog-sync';
import { studyRecordSync } from '../src/features/study-record-sync';
import { wrongQuestionPanel } from '../src/ui/wrong-question-panel';
import { wrongQuestionProbe } from '../src/features/wrong-question-probe';
import { WrongQuestionAdapter } from '../src/adapters/wrong-question-adapter';
import { SmartEduAdapter } from '../src/adapters/smartedu-adapter';
import { initPortalHeartbeat } from '../src/features/portal-heartbeat';
import { storage } from '../src/core/storage';
import { uploader } from '../src/core/uploader';
import { wrongQuestionSync } from '../src/features/wrong-question-sync';
import {
  readSmarteduIdentity,
  setConfirmUserSwitchHandler,
  type UserSwitchPrompt
} from '../src/core/import-user-guard';
import {
  APP_VERSION,
  BUILD_ID,
  DISPLAY_VERSION,
  MSG_PING_UPDATE_STATE,
  MSG_GET_UPDATE_STATE,
  MSG_UPDATE_AVAILABLE,
  MSG_RELOADED_NEW_VERSION
} from '../src/core/version';

export default defineContentScript({
  matches: [
    'https://basic.smartedu.cn/*',
    'https://*.smartedu.cn/*',
    'https://*.eduyun.cn/*',
    'https://*.cbern.com.cn/*'
  ],
  runAt: 'document_end',
  allFrames: true,
  main() {
    /**
     * 是否顶层框架 —— UI 收归顶层的唯一判据。
     *
     * 为什么必须有这道闸门：本入口声明了 `allFrames: true`，
     * 因此页面里每一个 iframe（含播放器 iframe、埋点 iframe）都会注入并执行本脚本，
     * 每个 frame 各有独立 document，于是 diagnosticPanel / wrongQuestionPanel
     * 会在每个 iframe 里各挂一个悬浮胶囊 —— 页面上出现多个浮窗、且层级互相打架。
     *
     * 为什么不能简单改成 allFrames: false：`_scanAndBindVideo()` 仍保留在每个 frame 运行，
     * 万一平台把播放页整体套进 iframe，顶层扫不到 video 时 iframe 里的实例还能兜住。
     * 业务探测保持全 frame，只把「看得见的 UI」收归顶层 —— 零功能回退。
     *
     * 补充佐证：video-monitor 的 `_scanAndBindVideo()` 首行即 `isStudentSelfStudyPage()`
     * 路径守卫（`/syncClassroom/`、`/basicWork/`），播放器 iframe 不会命中这些路由，
     * 因此 iframe 里的实例实际是空转，收归 UI 不会丢失任何真实监控能力。
     */
    const isTopFrame = (() => {
      try { return window.top === window.self; } catch { return true; }
    })();

    // 自愈清理：旧版本曾在页面/iframe 里挂载过浮窗，脚本重新注入时主动摘除残留节点。
    document.getElementById('smartedu-monitor-diag-host')?.remove();
    document.getElementById('smartedu-wrong-host')?.remove();

    console.log(`%c[smartedu-monitor] 扩展已加载 (WXT 现代架构 ${DISPLAY_VERSION})！当前URL: ` + window.location.href,
      'background: #1769aa; color: #fff; font-size: 14px; padding: 6px 12px; border-radius: 4px; font-weight: bold;');

    /**
     * ---------- 更新自检（未打包扩展专用闭环）----------
     *
     * 背景：以「加载未打包的扩展程序」方式使用时，Chrome 不会自动检查更新，
     * onUpdateAvailable 永不触发；而扩展被重载后，已打开页面里的 content script
     * 不会自动重新注入 —— 页面会一直跑旧代码，这才是「更新没生效」的真实体感。
     *
     * 闭环三要素：
     * 1. 监听器必须在第一个执行周期同步注册（原来放在 init() 里、且 init 还等 DOMContentLoaded，
     *    后台早于页面挂载发出的广播会永久丢失）；
     * 2. 每 3 秒向 SW 打一次 PING，同时上报页面是否正在播放（供重载仲裁避免打断）；
     * 3. 用「本页注入时的 buildId」与「SW 当前 buildId」对账，不等即说明页面该刷新了。
     */
    // 本页脚本的编译期身份 —— 固定不变；SW 侧返回它自己运行代码的 BUILD_ID，
    // 两者不等 = 扩展已换新而本页还跑着旧脚本，必须刷新页面。
    let injectedBuildId: string = BUILD_ID;
    const DRIFT_WATCH_MS = 3000;

    const handleUpdateMessage = (message: any) => {
      if (!message || !message.type) return;
      if (message.type === MSG_UPDATE_AVAILABLE || message.type === MSG_RELOADED_NEW_VERSION) {
        diagnosticPanel.setUpdateReady(message.version);
      }
    };

    try {
      // 仅顶层注册：SW 的 tabs.sendMessage 默认只投递到主 frame，iframe 里注册了也收不到
      if (isTopFrame && typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener(handleUpdateMessage);
      }
    } catch (e) {}

    /** 向 SW 打探针：既是对账，也是「扩展上下文是否还活着」的探测 */
    const pingBackground = (): Promise<{ ok: boolean; buildId: string | null; version?: string }> =>
      new Promise((resolve) => {
        try {
          if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.runtime.sendMessage) {
            resolve({ ok: false, buildId: null });
            return;
          }
          // 页面是否正在播放课程：SW 据此决定是「立即重载」还是「只提示、择机刷新」
          const busy = Array.from(document.querySelectorAll('video')).some((v) => !v.paused);
          chrome.runtime.sendMessage({ type: MSG_PING_UPDATE_STATE, busy }, (res) => {
            const err = chrome.runtime.lastError;
            if (err || !res || res.ok !== true) {
              resolve({ ok: false, buildId: null });
              return;
            }
            resolve({ ok: true, buildId: res.buildId || null, version: res.version });
          });
        } catch {
          // 同步抛错通常就是「Extension context invalidated」——扩展刚被重载
          resolve({ ok: false, buildId: null });
        }
      });

    /** 页面挂载后主动拉一次更新态，兜住「广播早于面板挂载」的窗口 */
    const restoreUpdateState = (): Promise<void> =>
      new Promise((resolve) => {
        try {
          if (typeof chrome === 'undefined' || !chrome.runtime?.id) { resolve(); return; }
          chrome.runtime.sendMessage({ type: MSG_GET_UPDATE_STATE }, (res) => {
            if (chrome.runtime.lastError || !res) { resolve(); return; }
            if (res.isUpdateReady) diagnosticPanel.setUpdateReady(res.version);
            resolve();
          });
        } catch {
          resolve();
        }
      });

    function startBuildDriftWatch() {
      void (async () => {
        // 首次探测仅作上下文存活确认；本页身份（injectedBuildId）固定为编译期 BUILD_ID，不再被覆盖
        await pingBackground();

        setInterval(async () => {
          const r = await pingBackground();
          if (!r.ok) {
            // 扩展上下文失效 / 探测不通：本页 content script 已成孤儿，刷新页面才能用上新代码
            diagnosticPanel.setUpdateReady('新版');
            return;
          }
          if (r.buildId && r.buildId !== injectedBuildId) {
            console.log(`[smartedu-monitor] 检测到扩展已更新 (${injectedBuildId} → ${r.buildId})，提示刷新页面`);
            diagnosticPanel.setUpdateReady(r.version || '新版');
          }
        }, DRIFT_WATCH_MS);
      })();
    }

    function bindHistoryHooks() {
      try {
        // 主世界 sniffer.content.ts 已拦截页面 history.pushState/replaceState 并派发 smartedu-route-change；
        // 此处同时监听 popstate / hashchange 与跨世界 smartedu-route-change 事件。
        const onRouteChange = () => {
          setTimeout(() => {
            videoMonitor._scanAndBindVideo();
            if (!isTopFrame) return;
            diagnosticPanel.init();
            if (WrongQuestionAdapter.isWrongQuestionPage()) {
              wrongQuestionPanel.init();
              wrongQuestionProbe.start();
            } else {
              wrongQuestionPanel.destroy();
            }
          }, 300);
        };
        window.addEventListener('popstate', onRouteChange);
        window.addEventListener('hashchange', onRouteChange);
        window.addEventListener('smartedu-route-change', onRouteChange);
      } catch (e) {
        console.warn('[smartedu-monitor] 挂载路由 Hook 异常:', e);
      }
    }

    /**
     * 顶部扩展图标 Popup 通信桥（仅顶层 frame 注册）。
     * 负责：
     * 1. `POPUP_GET_SNAPSHOT`：一次性返回诊断快照与错题探针快照；
     * 2. `POPUP_STREAM` 长连接：实时推送视频播放进度、日志、错题提取/上传状态变化；
     * 3. `POPUP_RUN_ACTION`：执行页面侧业务动作（目录同步、队列冲刷/清空、学习记录体检/同步、
     *    错题提取/同步、习题导出/重扫），并在触发用户切换确认时将确认上下文回传 Popup 内联处理。
     */
    function bindPopupBridge() {
      if (!isTopFrame || typeof chrome === 'undefined' || !chrome.runtime) return;

      const buildCombinedSnapshot = () => ({
        ok: true,
        diagnostic: diagnosticPanel.getSnapshot(),
        wrongQuestion: wrongQuestionPanel.getSnapshot(),
        config: storage.getConfig()
      });

      const activePorts = new Set<chrome.runtime.Port>();
      let pushTimer: any = null;
      const schedulePush = () => {
        if (activePorts.size === 0 || pushTimer) return;
        pushTimer = setTimeout(() => {
          pushTimer = null;
          if (activePorts.size === 0) return;
          const snap = buildCombinedSnapshot();
          for (const port of activePorts) {
            try {
              port.postMessage({ type: 'POPUP_SNAPSHOT_PUSH', data: snap });
            } catch (e) {
              activePorts.delete(port);
            }
          }
        }, 80);
      };

      diagnosticPanel.onChange(schedulePush);
      wrongQuestionPanel.onChange(schedulePush);

      try {
        chrome.runtime.onConnect?.addListener((port) => {
          if (port.name !== 'POPUP_STREAM') return;
          activePorts.add(port);
          port.onDisconnect.addListener(() => {
            activePorts.delete(port);
          });
          try {
            port.postMessage({ type: 'POPUP_SNAPSHOT_PUSH', data: buildCombinedSnapshot() });
          } catch (e) {
            activePorts.delete(port);
          }
        });
      } catch (e) {}

      const withPopupConfirmGuard = async <T>(
        confirmedUserSwitch: boolean,
        fn: () => Promise<T>
      ): Promise<{ result?: T; needUserSwitchConfirm?: boolean; switchPrompt?: UserSwitchPrompt }> => {
        let capturedPrompt: UserSwitchPrompt | null = null;
        setConfirmUserSwitchHandler(async (prompt) => {
          if (confirmedUserSwitch) return true;
          capturedPrompt = prompt;
          return false;
        });
        try {
          const result = await fn();
          if (capturedPrompt) {
            return { needUserSwitchConfirm: true, switchPrompt: capturedPrompt };
          }
          return { result };
        } finally {
          setConfirmUserSwitchHandler(null);
        }
      };

      const runPopupAction = async (action: string, payload: any = {}): Promise<any> => {
        const confirmed = payload?.confirmedUserSwitch === true;

        switch (action) {
          case 'FLUSH_QUEUE': {
            await uploader.flushQueue();
            diagnosticPanel.updateQueueCount(storage.getQueue().length);
            return { ok: true };
          }
          case 'CLEAR_QUEUE': {
            storage.clearQueue();
            diagnosticPanel.updateQueueCount(0);
            diagnosticPanel.addLog('warn', '已清空离线队列');
            return { ok: true };
          }
          case 'SYNC_CATALOG': {
            diagnosticPanel.setCatalogOverride({
              statusText: '正在重新识别教材与同步...',
              statusColor: '#0284c7',
              bookText: '识别中...'
            });
            try {
              const guarded = await withPopupConfirmGuard(confirmed, () =>
                catalogSync.syncCurrentLessonCatalog({ force: true })
              );
              if (guarded.needUserSwitchConfirm) {
                diagnosticPanel.setCatalogOverride(null);
                return { ok: false, needUserSwitchConfirm: true, switchPrompt: guarded.switchPrompt };
              }
              const out = guarded.result;
              if (out && out.success) {
                const count = out.catalogData?.totalLessons || 0;
                const modeText = out.reused ? '秒级复用' : '落库';
                diagnosticPanel.addLog('success', `教材目录同步成功（${modeText} ${count} 节课）`);
                diagnosticPanel.setCatalogOverride({
                  statusText: `已同步 (${count} 节)`,
                  statusColor: '#16a34a',
                  bookText: out.catalogData?.textbookTitle
                });
                return { ok: true, out };
              }
              if (out && out.skipped && out.reason === 'TM_ID_NOT_FOUND') {
                diagnosticPanel.setCatalogOverride({
                  statusText: '待进入具体课时',
                  statusColor: '#64748b'
                });
                return { ok: false, error: '待进入具体课时' };
              }
              const errMsg = out?.error || out?.reason || '请确认已进入视频课时页并登录 dofee';
              diagnosticPanel.addLog('warn', `目录同步未完成: ${errMsg}`);
              if (errMsg.includes('D1') || errMsg.includes('额度')) {
                diagnosticPanel.setCatalogOverride({
                  statusText: 'D1超额(明早8点重置)',
                  statusColor: '#f59e0b'
                });
              } else {
                diagnosticPanel.setCatalogOverride({
                  statusText: '同步未完成',
                  statusColor: '#dc2626'
                });
              }
              return { ok: false, error: errMsg };
            } catch (e: any) {
              diagnosticPanel.setCatalogOverride({ statusText: '同步未完成', statusColor: '#dc2626' });
              return { ok: false, error: e?.message || String(e) };
            }
          }
          case 'STUDY_HEALTH': {
            diagnosticPanel.addLog('info', '学习记录同步体检开始...');
            try {
              const h = await studyRecordSync.healthCheck();
              const idt = (h as any).platform_identity;
              const who = idt
                ? `（查询身份：${idt.display_name || '无展示名'} / ID ${idt.user_id || '未知'}）`
                : '';
              const acc = (h as any).access;
              const accessTxt = acc ? `业务域 ${acc.biz_type}/${acc.url_shape}` : '';
              if (h.ok) {
                diagnosticPanel.addLog('success', `体检通过：平台记录共 ${h.platform_total ?? '?'} 条，双端就绪 ${who}${accessTxt ? '｜' + accessTxt : ''}`);
              } else {
                const triedTxt = acc && Array.isArray(acc.tried) && acc.tried.length ? `（已试：${acc.tried.join('、')}）` : '';
                diagnosticPanel.addLog('warn', '体检发现问题' + who + triedTxt + '：' + h.problems.join('；'));
              }
              return { ok: h.ok, health: h };
            } catch (e: any) {
              diagnosticPanel.addLog('error', `体检异常：${String(e?.message || e)}`);
              return { ok: false, error: e?.message || String(e) };
            }
          }
          case 'STUDY_DRY_RUN':
          case 'STUDY_SYNC': {
            const dryRun = action === 'STUDY_DRY_RUN';
            const label = dryRun ? 'dry_run 预览' : '学习记录同步';
            if (studyRecordSync.isBusy()) {
              diagnosticPanel.addLog('warn', '学习记录同步进行中，请稍候再发起');
              return { ok: false, error: '学习记录同步进行中，请稍候再发起' };
            }
            diagnosticPanel.addLog('info', `${label} 开始...`);
            try {
              const guarded = await withPopupConfirmGuard(confirmed, () =>
                studyRecordSync.runSync({ dryRun })
              );
              if (guarded.needUserSwitchConfirm) {
                return { ok: false, needUserSwitchConfirm: true, switchPrompt: guarded.switchPrompt };
              }
              const rep = guarded.result;
              diagnosticPanel.setStudyReport(label, rep);
              if (rep && rep.ok) {
                diagnosticPanel.addLog(
                  'success',
                  `${label} 完成：发送 ${rep.sent ?? 0} 条，更新 ${rep.upserted ?? 0}，完成翻转 ${rep.completed_flipped ?? 0}` +
                  (rep.first_full ? '（首次全量）' : '')
                );
                if (Array.isArray(rep.skipped) && rep.skipped.length > 0) {
                  const byReason: Record<string, number> = {};
                  for (const s of rep.skipped) byReason[s.reason || 'unknown'] = (byReason[s.reason || 'unknown'] || 0) + 1;
                  diagnosticPanel.addLog('info', `跳过明细：${Object.entries(byReason).map(([k, v]) => `${k}×${v}`).join('、')}`);
                }
                if (Array.isArray(rep.warnings) && rep.warnings.length > 0) {
                  diagnosticPanel.addLog('warn', `告警 ${rep.warnings.length} 条，首条：${rep.warnings[0]}`);
                }
              } else {
                diagnosticPanel.addLog('error', `${label} 未完成：${(rep && rep.error) || '未知错误'}`);
              }
              await diagnosticPanel.refreshStudyCursor();
              return { ok: !!rep?.ok, report: rep, error: rep?.error };
            } catch (e: any) {
              diagnosticPanel.addLog('error', `${label} 异常：${String(e?.message || e)}`);
              await diagnosticPanel.refreshStudyCursor();
              return { ok: false, error: e?.message || String(e) };
            }
          }
          case 'REFRESH_CONFIG_CHANGED': {
            await storage.ensureHydrated();
            diagnosticPanel.refreshWrongSyncStatusNow();
            wrongQuestionPanel.refresh();
            if (payload?.notifyProbe) {
              try { (window as any).SmartEduWrongProbe?.onSyncConfigChanged?.(); } catch (e) {}
            }
            if (payload?.runSilentScope) {
              wrongQuestionSync.runSilentAutoSync({
                trigger: payload.trigger || 'config_enabled',
                scope: payload.runSilentScope
              }).catch(() => {});
            }
            if (payload?.syncCatalog) {
              catalogSync.syncCurrentLessonCatalog().catch(() => {});
            }
            return { ok: true };
          }
          case 'WRONG_RUN_EXTRACT': {
            wrongQuestionPanel.setErrorText('');
            try {
              const autoUpload = storage.getConfig().syncWrongBook === true;
              const guarded = await withPopupConfirmGuard(confirmed, () =>
                wrongQuestionSync.run({ withAnswer: true, waitMs: 15000, autoUpload })
              );
              if (guarded.needUserSwitchConfirm) {
                return { ok: false, needUserSwitchConfirm: true, switchPrompt: guarded.switchPrompt };
              }
              wrongQuestionPanel.applyRunResult(guarded.result);
              return { ok: true };
            } catch (e: any) {
              wrongQuestionPanel.setErrorText((e && e.message) ? e.message : String(e));
              return { ok: false, error: e?.message || String(e) };
            }
          }
          case 'WRONG_UPLOAD': {
            if (storage.getConfig().syncWrongBook !== true) {
              const msg = '「同步错题本」开关当前已关闭，请先在「学习监控」页签开启后再同步。';
              wrongQuestionPanel.setErrorText(msg);
              wrongQuestionPanel.setUploadState({ phase: 'error', text: msg });
              return { ok: false, error: msg };
            }
            wrongQuestionPanel.setErrorText('');
            wrongQuestionPanel.setUploadState({ phase: 'busy', text: '同步中…' });
            try {
              const guarded = await withPopupConfirmGuard(confirmed, () =>
                wrongQuestionSync.upload({ dryRun: false })
              );
              if (guarded.needUserSwitchConfirm) {
                wrongQuestionPanel.setUploadState(null);
                return { ok: false, needUserSwitchConfirm: true, switchPrompt: guarded.switchPrompt };
              }
              const res: any = guarded.result;
              const impl = {
                implVersion: res?.impl_version || '',
                stale: !!res?.stale_endpoint,
                missingImpl: Array.isArray(res?.missing_impl) ? res.missing_impl : []
              };
              if (!res?.ok) {
                const detail = (res?.errors || []).length
                  ? res.errors.map((e: any) => e.message || e.reason || JSON.stringify(e)).join('\n')
                  : (res?.error || '暂未完成');
                wrongQuestionPanel.setUploadState(Object.assign({ phase: 'error' as const, text: detail }, impl));
                return { ok: false, error: detail };
              }
              wrongQuestionPanel.setUploadState(Object.assign({
                phase: 'done' as const,
                inserted: res.inserted,
                updated: res.updated,
                skipped: res.skipped,
                staged: res.staged,
                errors: Array.isArray(res.errors) ? res.errors : [],
                text: res.message || ('已同步 dofee：新增 ' + res.inserted + ' 题，更新 ' + res.updated + ' 题'
                  + (res.skipped ? '，跳过 ' + res.skipped + ' 题' : ''))
              }, impl));
              return { ok: true };
            } catch (e: any) {
              wrongQuestionPanel.setUploadState({ phase: 'error', text: e?.message || String(e) });
              return { ok: false, error: e?.message || String(e) };
            }
          }
          case 'EX_UPLOAD': {
            if (storage.getConfig().syncMyExercises !== true) {
              const msg = '「同步我的习题」开关当前已关闭，请先在「学习监控」页签开启后再同步。';
              wrongQuestionPanel.setErrorText(msg);
              return { ok: false, error: msg };
            }
            wrongQuestionPanel.setErrorText('');
            try {
              const guarded = await withPopupConfirmGuard(confirmed, () =>
                wrongQuestionSync.uploadExercises({ dryRun: false })
              );
              if (guarded.needUserSwitchConfirm) {
                return { ok: false, needUserSwitchConfirm: true, switchPrompt: guarded.switchPrompt };
              }
              const res: any = guarded.result;
              if (!res?.ok) {
                const msg = res?.error || '暂未完成';
                wrongQuestionPanel.setErrorText(msg);
                return { ok: false, error: msg };
              }
              wrongQuestionPanel.setUploadState({
                phase: 'done',
                inserted: res.inserted || 0,
                updated: res.updated || 0,
                skipped: res.skipped || 0,
                staged: res.staged || 0,
                text: res.message || ('已静默同步入库：新增 ' + (res.inserted || 0) + ' 题，更新 ' + (res.updated || 0) + ' 题')
              });
              return { ok: true };
            } catch (e: any) {
              const msg = e?.message || String(e);
              wrongQuestionPanel.setErrorText(msg);
              return { ok: false, error: msg };
            }
          }
          case 'EX_EXPORT': {
            const fmt = payload?.format === 'md' || payload?.format === 'html' ? payload.format : 'json';
            wrongQuestionSync.exportExercises(fmt);
            return { ok: true };
          }
          case 'EX_RESCAN': {
            wrongQuestionPanel.autoExtract();
            return { ok: true };
          }
          default:
            return { ok: false, error: `未知指令: ${action}` };
        }
      };

      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || !msg.type) return false;
        if (msg.type === 'POPUP_GET_SNAPSHOT') {
          sendResponse(buildCombinedSnapshot());
          return false;
        }
        if (msg.type === 'POPUP_RUN_ACTION') {
          runPopupAction(msg.action, msg.payload)
            .then((res) => sendResponse(res))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
          return true;
        }
        return false;
      });
    }

    function init() {
      try {
        const idt = readSmarteduIdentity();
        storage.activateSlotBySmarteduUserId(idt?.user_id || null);

        // videoMonitor 兜底策略：顶层恒启动（正常业务路径）；
        // iframe 仅当它自身就是自主学习业务页时才启动 —— 万一平台把播放页整体套进 iframe 仍能兜住，
        // 同时避免播放器 iframe、埋点 iframe 空转 MutationObserver 与心跳定时器。
        if (isTopFrame || SmartEduAdapter.isStudentSelfStudyPage()) {
          videoMonitor.start();
        }

        if (!isTopFrame) return;

        diagnosticPanel.init();
        initPortalHeartbeat();

        if (WrongQuestionAdapter.isWrongQuestionPage()) {
          wrongQuestionPanel.init();
          wrongQuestionProbe.start();
        }

        bindHistoryHooks();

        // 轻量级自动学习记录同步（时机 1：页面加载延时 1.5s 触发；时机 2：登录凭证变更触发）
        setTimeout(() => { void studyRecordSync.autoSync('page_init'); }, 1500);
        // 自主学习页面初始化时自动静默探测与同步当前教材目录（无需等待点击播放）
        setTimeout(() => {
          if (SmartEduAdapter.isStudentSelfStudyPage()) {
            void catalogSync.syncCurrentLessonCatalog({ guardMode: 'silent' });
          }
        }, 1800);
        try {
          window.addEventListener('storage', (e) => {
            if (e?.key && /ND_UC_AUTH|SMARTEDU_MONITOR_CONFIG/i.test(e.key)) {
              const curId = readSmarteduIdentity()?.user_id || null;
              storage.activateSlotBySmarteduUserId(curId);
              setTimeout(() => { void studyRecordSync.autoSync('login'); }, 1000);
            }
          });
        } catch (e) {}

        // 更新自检：主动拉一次完整更新态 + 启动构建标识对账
        // （广播监听器已在 content script 顶层同步注册，此处不再重复注册）
        void restoreUpdateState();
        startBuildDriftWatch();

        // 挂载控制台自检全局句柄
        (window as any).__SMARTEDU_MONITOR__ = {
          version: `${APP_VERSION}-wxt`,
          displayVersion: DISPLAY_VERSION,
          mounted: () => !!document.getElementById('smartedu-monitor-diag-host'),
          config: () => storage.getConfig(),
          queueLength: () => storage.getQueue().length,
          catalogSync: catalogSync,
          studyRecordSync: studyRecordSync,
          resetPos: () => diagnosticPanel.resetPosition(),
          checkUpdate: () => {
            if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
              chrome.runtime.sendMessage({ type: 'CHECK_EXTENSION_UPDATE' }, (res) => {
                console.log('[Monitor] 检查更新响应:', res);
              });
            }
          },
          applyUpdate: () => {
            if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
              chrome.runtime.sendMessage({ type: 'APPLY_EXTENSION_UPDATE' });
            }
          },
          openPanel: () => {
            diagnosticPanel.isOpen = true;
            return '请点击浏览器顶部扩展图标打开控制面板';
          }
        };

        bindPopupBridge();

        console.log('%c[smartedu-monitor] 初始化完成，请点击顶部扩展图标打开控制面板',
          'color:#0ea5e9;font-weight:bold');
      } catch (err) {
        console.error('[smartedu-monitor] 启动失败:', err);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
});
