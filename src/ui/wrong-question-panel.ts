/**
 * wrong-question-panel.ts - 错题 / 习题探针状态控制器 (Headless Controller / TypeScript)
 *
 * 职责（顶部扩展图标下拉模式）：
 * 1. 不再向错题本 / 习题库网页左下角注入悬浮胶囊与 Shadow DOM，
 *    并主动清理历史遗留的 `#smartedu-wrong-host` 节点；
 * 2. 承接探针 (`wrongQuestionProbe`) 与编排器 (`wrongQuestionSync`) 的状态更新，
 *    维护探测报告、提取进度、上传结果与预览文本；
 * 3. 向顶部 Popup 弹窗「错题 / 习题」Tab 提供统一快照数据与状态变更通知。
 */

import { wrongQuestionSync } from '../features/wrong-question-sync';
import { questionSource } from '../core/question-source';
import { WrongQuestionAdapter } from '../adapters/wrong-question-adapter';
import { DISPLAY_VERSION } from '../core/version';
import { storage } from '../core/storage';

const POS_KEY = 'SMARTEDU_WRONG_POS';

export interface UploadState {
  phase: 'busy' | 'preview' | 'done' | 'error';
  text?: string;
  preview?: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  staged?: number;
  errors?: any[];
  implVersion?: string;
  stale?: boolean;
  missingImpl?: string[];
}

export interface WrongQuestionSnapshot {
  version: string;
  isWrongOrExercisePage: boolean;
  isExercisePage: boolean;
  report: any;
  sync: any;
  uploadState: UploadState | null;
  syncResult: string;
  errorText: string;
  exercisePreview: string;
  canUploadWrong: boolean;
}

export class WrongQuestionPanel {
  host: HTMLElement | null = null;
  shadow: ShadowRoot | null = null;
  isOpen = false;

  private heartbeat: any = null;
  private lastReport: any = null;
  private lastSync: any = null;
  private syncResult = '';
  private errorText = '';
  private uploadState: UploadState | null = null;
  private changeListeners: Set<() => void> = new Set();

  init(): void {
    if (typeof document !== 'undefined') {
      document.getElementById('smartedu-wrong-host')?.remove();
    }
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        if (typeof document !== 'undefined') {
          document.getElementById('smartedu-wrong-host')?.remove();
        }
      }, 2000);
    }
  }

  resetPosition(): string {
    try {
      localStorage.removeItem(POS_KEY);
    } catch (e) { /* ignore */ }
    return '已切换为顶部扩展图标下拉面板，无需重置悬浮位置';
  }

  destroy(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.host?.remove();
    this.host = null;
    this.shadow = null;
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => {
      this.changeListeners.delete(cb);
    };
  }

  private _notifyChange(): void {
    for (const cb of this.changeListeners) {
      try { cb(); } catch (e) { /* ignore */ }
    }
  }

  private _renderExercisePreview(exResults: any[]): string {
    if (!exResults || !exResults.length) return '';
    try {
      const md = questionSource.buildMarkdown(exResults);
      if (md) return md;
    } catch (e) { /* 回落到 JSON */ }
    try { return JSON.stringify(exResults, null, 2); } catch (e) { return ''; }
  }

  getSnapshot(): WrongQuestionSnapshot {
    const rep = this.lastReport || null;
    const isEx = !!(rep && rep.isExercisePage);
    const exResults = wrongQuestionSync.exerciseResults || [];
    const running = !!(this.lastSync && this.lastSync.running);
    const up: UploadState | null = this.uploadState
      || (wrongQuestionSync.lastUploadResult && wrongQuestionSync.lastUploadResult.ok
        ? {
            phase: 'done',
            inserted: wrongQuestionSync.lastUploadResult.inserted || 0,
            updated: wrongQuestionSync.lastUploadResult.updated || 0,
            skipped: wrongQuestionSync.lastUploadResult.skipped || 0,
            staged: wrongQuestionSync.lastUploadResult.staged || 0,
            text: (wrongQuestionSync.lastUploadResult as any).message || '解析完成后已自动静默上传至 dofee'
          }
        : null);

    // 读取配置以确保最新状态
    try { storage.getConfig(); } catch (e) { /* ignore */ }

    return {
      version: DISPLAY_VERSION,
      isWrongOrExercisePage: WrongQuestionAdapter.isWrongQuestionPage(),
      isExercisePage: isEx,
      report: rep,
      sync: this.lastSync || wrongQuestionSync.snapshot(),
      uploadState: up,
      syncResult: this.syncResult,
      errorText: this.errorText,
      exercisePreview: isEx ? this._renderExercisePreview(exResults) : '',
      canUploadWrong: !!wrongQuestionSync.results.length && !running
    };
  }

  setUploadState(state: UploadState | null): void {
    this.uploadState = state;
    this._notifyChange();
  }

  setErrorText(text: string): void {
    this.errorText = text;
    this._notifyChange();
  }

  setSyncResult(text: string): void {
    this.syncResult = text;
    this._notifyChange();
  }

  /** 由 probe 调用：更新探针报告数据 */
  update(report: any): void {
    this.lastReport = report;
    this._notifyChange();
  }

  /** 由编排器调用：静默更新提取进度 */
  setSync(snap: any): void {
    this.lastSync = snap;
    this._notifyChange();
  }

  /** 由 probe 在习题库模式调用：同步报告 + 进度 */
  updateExercise(report: any, snap: any): void {
    this.lastReport = report;
    this.lastSync = snap;
    this._notifyChange();
  }

  /** 把一次 run() 的结果落到状态 */
  applyRunResult(snap: any, S?: any): string {
    const SY = S || wrongQuestionSync;
    this.lastSync = snap;

    const results = Array.isArray(SY.results) ? SY.results : [];
    this.syncResult = results.length ? SY.json() : '';

    const errs = (snap && Array.isArray(snap.errors)) ? snap.errors
      : (Array.isArray(SY.errors) ? SY.errors : []);

    this.errorText = errs
      .map((e: any) => '[' + ((e && e.stage) || 'run') + '] ' + ((e && (e.reason || e.message)) || String(e)))
      .join('\n');

    this._notifyChange();
    return this.errorText;
  }

  openPanel(): string {
    this.isOpen = true;
    return '请点击浏览器顶部扩展图标打开面板并切换至「错题/习题」标签页';
  }

  refresh(): void {
    this._notifyChange();
  }

  autoExtract(): void {
    try {
      const probe: any = (window as any).SmartEduWrongProbe;
      if (probe && typeof probe._poll === 'function') {
        (probe as any).lastSig = '';
        (probe as any)._poll();
        return;
      }
    } catch (e) { /* ignore */ }
    console.log('[智慧习题探针] 探针句柄不可用，请刷新页面后重试');
  }
}

export const wrongQuestionPanel = new WrongQuestionPanel();

if (typeof window !== 'undefined') {
  (window as any).SmartEduWrongPanel = wrongQuestionPanel;
  (window as any).__SMARTEDU_WRONG_PANEL__ = wrongQuestionPanel;
}
