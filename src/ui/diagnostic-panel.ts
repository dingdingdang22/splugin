/**
 * diagnostic-panel.ts - 学习进度监控状态中枢 (Headless Controller / TypeScript)
 *
 * 职责（顶部扩展图标下拉模式）：
 * 1. 不再向智慧平台网页注入右下角悬浮胶囊与 Shadow DOM（避免遮挡视频与页面控件），
 *    并主动清理历史遗留的 `#smartedu-monitor-diag-host` 节点；
 * 2. 维护页面侧运行时状态快照：视频播放态、教材目录同步状态、学习记录同步游标/报告、
 *    后台静默错题同步状态、更新就绪状态与最近 150 条实时上报流水日志；
 * 3. 接收后台静默同步指令 (`SMARTEDU_RUN_SILENT_SYNC`) 并转发至 `wrongQuestionSync`；
 * 4. 向顶部 Popup 弹窗提供统一快照读取与状态变更推送能力。
 */

import { storage } from '../core/storage';
import { uploader } from '../core/uploader';
import { authManager } from '../core/auth';
import { SmartEduAdapter } from '../adapters/smartedu-adapter';
import { catalogSync } from '../features/catalog-sync';
import { videoMonitor } from '../features/video-monitor';
import { wrongQuestionSync } from '../features/wrong-question-sync';
import { readSmarteduIdentity } from '../core/import-user-guard';
import { studyRecordSync } from '../features/study-record-sync';
import { DISPLAY_VERSION } from '../core/version';

export interface DiagnosticLogItem {
  time: string;
  type: string;
  message: string;
}

export interface WrongSyncSnapshot {
  statusText: string;
  statusColor: string;
  syncedCount: number;
  lastSyncTime: string;
}

export interface DiagnosticSnapshot {
  version: string;
  isUpdateReady: boolean;
  pendingVersion: string | null;
  url: string;
  isSelfStudyPage: boolean;
  currentSmartedu: { user_id: string; display_name: string } | null;
  queueLength: number;
  videoState: {
    hasVideo: boolean;
    paused: boolean;
    currentTime: number;
    duration: number;
    realPlayedSeconds: number;
    resourceInfo: any;
  };
  catalogState: {
    statusText: string;
    statusColor: string;
    bookText: string;
  };
  wrongSync: WrongSyncSnapshot;
  studyCursor: {
    text: string;
    color: string;
  };
  studyReport: {
    label: string;
    rep: any;
  } | null;
  logs: DiagnosticLogItem[];
}

const MAX_LOGS = 150;

function safeChromeSendMessage(payload: any, callback?: (res: any) => void) {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id || !chrome.runtime.sendMessage) {
    if (typeof diagnosticPanel !== 'undefined') diagnosticPanel.setUpdateReady('最新版');
    return;
  }
  try {
    const p: any = chrome.runtime.sendMessage(payload, (res) => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        if (lastErr.message?.includes('invalidated') || lastErr.message?.includes('context')) {
          if (typeof diagnosticPanel !== 'undefined') diagnosticPanel.setUpdateReady('最新版');
        }
        return;
      }
      if (typeof callback === 'function') callback(res);
    });
    if (p && typeof p.catch === 'function') {
      p.catch((err: any) => {
        if (err?.message?.includes('invalidated') || err?.message?.includes('context')) {
          if (typeof diagnosticPanel !== 'undefined') diagnosticPanel.setUpdateReady('最新版');
        }
      });
    }
  } catch (e: any) {
    if (e?.message?.includes('invalidated') || e?.message?.includes('context')) {
      if (typeof diagnosticPanel !== 'undefined') diagnosticPanel.setUpdateReady('最新版');
    }
  }
}

export class DiagnosticPanel {
  hostElement: HTMLElement | null = null;
  shadowRoot: ShadowRoot | null = null;
  isOpen = false;
  mounted = false;
  isUpdateReady = false;
  pendingVersion: string | null = null;

  private heartbeatTimer: any = null;
  private wrongStatusTimer: any = null;
  private silentSyncRelayBound = false;
  private dataSourcesBound = false;
  private changeListeners: Set<() => void> = new Set();

  private logs: DiagnosticLogItem[] = [
    { time: '--:--:--', type: 'muted', message: '[探针已启动，等待播放视频...]' }
  ];

  private videoState: DiagnosticSnapshot['videoState'] = {
    hasVideo: false,
    paused: true,
    currentTime: 0,
    duration: 0,
    realPlayedSeconds: 0,
    resourceInfo: null
  };

  private wrongSyncState: WrongSyncSnapshot = {
    statusText: '检测中...',
    statusColor: '#16a34a',
    syncedCount: 0,
    lastSyncTime: '-'
  };

  private catalogOverride: { statusText: string; statusColor: string; bookText?: string } | null = null;
  private studyReport: { label: string; rep: any } | null = null;
  private studyCursor: { text: string; color: string } = { text: '检测中...', color: '#64748b' };
  private queueCount = 0;

  init() {
    // 清理旧版网页悬浮宿主，确保升级后不残留页内胶囊
    if (typeof document !== 'undefined') {
      document.getElementById('smartedu-monitor-diag-host')?.remove();
    }
    this.mounted = true;
    this.queueCount = storage.getQueue().length;

    authManager.onAuthStateChange(() => {
      this._notifyChange();
    });

    this._bindSilentSyncRelay();
    this._bindDataSources();
    void this.refreshStudyCursor();

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (typeof document !== 'undefined') {
          document.getElementById('smartedu-monitor-diag-host')?.remove();
        }
        if (typeof chrome !== 'undefined' && (!chrome.runtime || !chrome.runtime.id)) {
          this.setUpdateReady('最新版');
        }
      }, 2000);
    }
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => {
      this.changeListeners.delete(cb);
    };
  }

  private _notifyChange() {
    for (const cb of this.changeListeners) {
      try { cb(); } catch (e) { /* ignore */ }
    }
  }

  setUpdateReady(version?: string, force = false) {
    if (this.isUpdateReady) {
      if (version && version !== '新版' && this.pendingVersion !== version) {
        this.pendingVersion = version;
      }
      if (force) this._notifyChange();
      return;
    }
    this.isUpdateReady = true;
    this.pendingVersion = version || '最新版';

    console.log(
      `%c[DiagnosticPanel] ⚡ 检测到扩展新版本 (${this.pendingVersion}) 已就绪！点击顶部扩展图标刷新即可启用。`,
      'background: #b45309; color: #fff; font-size: 13px; padding: 4px 8px; border-radius: 4px; font-weight: bold;'
    );

    this.addLog('warn', `新版本 (${this.pendingVersion}) 已在后台就绪！点击浏览器顶部插件图标可刷新启用。`);
    this._notifyChange();
  }

  resetPosition(): string {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('SMARTEDU_DIAG_POS');
      }
    } catch (e) {}
    return '已切换为顶部扩展图标下拉面板，无需重置悬浮位置';
  }

  setCatalogOverride(override: { statusText: string; statusColor: string; bookText?: string } | null) {
    this.catalogOverride = override;
    this._notifyChange();
  }

  setStudyReport(label: string, rep: any) {
    this.studyReport = { label, rep };
    this._notifyChange();
  }

  async refreshStudyCursor(): Promise<void> {
    try {
      const c = await studyRecordSync.getCursor();
      if (!c || !c.max_platform_updated_at) {
        this.studyCursor = { text: '未建立（首次同步将全量对账）', color: '#d97706' };
      } else {
        this.studyCursor = {
          text: `已推进至 ${String(c.max_platform_updated_at).slice(0, 19).replace('T', ' ')}`,
          color: '#16a34a'
        };
      }
      this._notifyChange();
    } catch (e) { /* ignore */ }
  }

  refreshWrongSyncStatusNow(): void {
    this._refreshWrongSyncStatusOnce();
  }

  getSnapshot(): DiagnosticSnapshot {
    const config = storage.getConfig();
    const currentCtx = SmartEduAdapter.extractCourseContext();
    const currentMeta = (currentCtx.subject || currentCtx.grade)
      ? `${currentCtx.subject || ''} ${currentCtx.grade ? currentCtx.grade + '年级' : ''}`.trim()
      : '';
    const lastCatalog = storage.getLastSyncedCatalog(config.dofeeUsername);
    const isSubjectMismatch = Boolean(currentCtx.subject && lastCatalog && lastCatalog.title && (
      (currentCtx.subject === 'Chemistry' && !lastCatalog.title.includes('化学')) ||
      (currentCtx.subject === 'Physics' && !lastCatalog.title.includes('物理')) ||
      (currentCtx.subject === 'English' && !lastCatalog.title.includes('英语')) ||
      (currentCtx.subject === 'Chinese' && !lastCatalog.title.includes('语文')) ||
      (currentCtx.subject === 'Mathematics' && !lastCatalog.title.includes('数学')) ||
      (currentCtx.subject === 'History' && !lastCatalog.title.includes('历史')) ||
      (currentCtx.subject === 'Politics' && !lastCatalog.title.includes('道德与法治') && !lastCatalog.title.includes('思想政治'))
    ));

    const defaultCatalogStatus = (lastCatalog && !isSubjectMismatch)
      ? `已同步 (${lastCatalog.totalLessons || 0} 节)`
      : '播放任意视频自动触发';
    const defaultCatalogBook = (lastCatalog && !isSubjectMismatch)
      ? (lastCatalog.title || lastCatalog.tmId || '-')
      : (currentMeta || '-');

    return {
      version: DISPLAY_VERSION,
      isUpdateReady: this.isUpdateReady,
      pendingVersion: this.pendingVersion,
      url: typeof window !== 'undefined' ? window.location.href : '',
      isSelfStudyPage: SmartEduAdapter.isStudentSelfStudyPage(),
      currentSmartedu: readSmarteduIdentity(),
      queueLength: storage.getQueue().length,
      videoState: { ...this.videoState },
      catalogState: {
        statusText: this.catalogOverride?.statusText || defaultCatalogStatus,
        statusColor: this.catalogOverride?.statusColor || '#16a34a',
        bookText: this.catalogOverride?.bookText || defaultCatalogBook
      },
      wrongSync: { ...this.wrongSyncState },
      studyCursor: { ...this.studyCursor },
      studyReport: this.studyReport,
      logs: this.logs.slice()
    };
  }

  private _bindSilentSyncRelay() {
    if (this.silentSyncRelayBound) return;
    this.silentSyncRelayBound = true;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((msg: any) => {
          if (!msg || msg.type !== 'SMARTEDU_RUN_SILENT_SYNC') return false;
          Promise.resolve()
            .then(async () => {
              const cfg = await storage.ensureHydrated();
              if (cfg.syncWrongBook !== true && cfg.syncMyExercises !== true) return;
              return wrongQuestionSync.runSilentAutoSync({ trigger: String(msg.trigger || 'background_relay') });
            })
            .catch((e: any) => console.log('[DiagnosticPanel] 静默同步指令执行失败（已降级）:', e?.message || String(e)));
          return false;
        });
      }
    } catch (e) { /* 上下文失效不影响页面主流程 */ }
  }

  private _bindDataSources() {
    if (this.dataSourcesBound) return;
    this.dataSourcesBound = true;

    videoMonitor.setStateChangeListener((state) => {
      this.updateStateView(state);
    });

    uploader.setLogListener((logItem) => {
      this.addLog(logItem.type, logItem.message);
      this.updateQueueCount(storage.getQueue().length);
    });

    catalogSync.setLogListener((logItem) => {
      this.addLog(logItem.type, logItem.message);
    });

    this._pollWrongSyncStatus();
  }

  private _pollWrongSyncStatus() {
    if (this.wrongStatusTimer) return;
    const tick = () => this._refreshWrongSyncStatusOnce();
    tick();
    this.wrongStatusTimer = setInterval(tick, 5000);
  }

  private _refreshWrongSyncStatusOnce() {
    const curCfg = storage.getConfig();
    const curWrongEnabled = curCfg.syncWrongBook === true;
    const curExEnabled = curCfg.syncMyExercises === true;

    let snap: any = null;
    try { snap = wrongQuestionSync.snapshot(); } catch (e) { snap = null; }
    const pageSyncing = !!(snap && (snap.silentSyncRunning || snap.running));
    const lastPageLog = snap ? snap.lastSilentSyncLog : null;

    if (!curWrongEnabled && !curExEnabled && !pageSyncing) {
      this.wrongSyncState.statusText = '已关闭 (请在上方勾选开启)';
      this.wrongSyncState.statusColor = '#64748b';
    }

    let localCount = 0;
    try {
      let keys: string[] = [];
      try {
        const rawMap = localStorage.getItem('SMARTEDU_SYNCED_ACTIVE_KEYS');
        const map = rawMap ? JSON.parse(rawMap) : null;
        if (map && (map.wrong || map.exercise)) {
          keys = [map.wrong, map.exercise].filter(Boolean);
        }
      } catch (e) { /* ignore */ }
      if (keys.length === 0) {
        keys = ['SMARTEDU_SYNCED_WRONG_IDS', 'SMARTEDU_SYNCED_EXERCISE_IDS'];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.indexOf('SMARTEDU_SYNCED_WRONG_IDS:') === 0 || k.indexOf('SMARTEDU_SYNCED_EXERCISE_IDS:') === 0)) {
            keys.push(k);
          }
        }
      }
      for (const k of keys) {
        const raw = localStorage.getItem(k);
        const arr = raw ? JSON.parse(raw) : null;
        if (Array.isArray(arr)) localCount += arr.length;
      }
    } catch (e) { /* ignore */ }

    safeChromeSendMessage({ type: 'GET_SILENT_SYNC_STATUS' }, (res) => {
      const latestCfg = storage.getConfig();
      const syncWrongEnabled = latestCfg.syncWrongBook === true;
      const syncExEnabled = latestCfg.syncMyExercises === true;
      const anySyncEnabled = syncWrongEnabled || syncExEnabled;
      const scopeLabel = syncWrongEnabled && syncExEnabled
        ? '错题本+我的习题'
        : (syncWrongEnabled ? '仅错题本' : '仅我的习题');
      const bgSyncing = !!(res && res.isSyncing);
      const configured = res
        ? !!res.configuredDofee
        : !!(latestCfg && (latestCfg.dofeeJwtToken || latestCfg.dofeeRefreshToken));
      const heartbeat = res ? !!res.hasActiveHeartbeat : false;

      if (pageSyncing || bgSyncing) {
        this.wrongSyncState.statusText = '正在静默同步中...';
        this.wrongSyncState.statusColor = '#0284c7';
      } else if (!anySyncEnabled) {
        this.wrongSyncState.statusText = '已关闭 (请在上方勾选开启)';
        this.wrongSyncState.statusColor = '#64748b';
      } else if (!configured) {
        this.wrongSyncState.statusText = `已开启(${scopeLabel}) · 待登录 dofee 激活`;
        this.wrongSyncState.statusColor = '#eab308';
      } else if (heartbeat) {
        this.wrongSyncState.statusText = `已开启(${scopeLabel}) · 静默守护中`;
        this.wrongSyncState.statusColor = '#16a34a';
      } else {
        this.wrongSyncState.statusText = `已开启(${scopeLabel}) · 每日自动同步`;
        this.wrongSyncState.statusColor = '#16a34a';
      }

      const bgCount = res && typeof res.syncedCount === 'number' ? res.syncedCount : 0;
      this.wrongSyncState.syncedCount = Math.max(bgCount, localCount);

      const finishedAt = (lastPageLog && (lastPageLog.finishedAt || lastPageLog.endTime))
        || (res && res.lastLog && (res.lastLog.finishedAt || res.lastLog.endTime));
      if (finishedAt) {
        const d = new Date(finishedAt);
        this.wrongSyncState.lastSyncTime = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
      } else if (pageSyncing || bgSyncing) {
        this.wrongSyncState.lastSyncTime = '同步中...';
      } else {
        this.wrongSyncState.lastSyncTime = '-';
      }

      this._notifyChange();
    });
  }

  updateStateView(state: any) {
    this.videoState = {
      hasVideo: !!state?.hasVideo,
      paused: state?.paused !== false,
      currentTime: Number(state?.currentTime || 0),
      duration: Number(state?.duration || 0),
      realPlayedSeconds: Number(state?.realPlayedSeconds || 0),
      resourceInfo: state?.resourceInfo || null
    };
    this._notifyChange();
  }

  updateQueueCount(count: number) {
    this.queueCount = count;
    this._notifyChange();
  }

  addLog(type: string, text: string) {
    const time = new Date().toLocaleTimeString();
    this.logs.push({ time, type, message: text });
    if (this.logs.length > MAX_LOGS) {
      this.logs.splice(0, this.logs.length - MAX_LOGS);
    }
    this._notifyChange();
  }
}

export const diagnosticPanel = new DiagnosticPanel();

if (typeof window !== 'undefined') {
  (window as any).SmartEduDiagnostic = diagnosticPanel;
}
