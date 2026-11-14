/**
 * video-monitor.ts - 核心视频播放监控与真实学习证据采集模块 (TypeScript / ESM)
 */

import { storage } from '../core/storage';
import { uploader } from '../core/uploader';
import { SmartEduAdapter } from '../adapters/smartedu-adapter';
import { catalogSync } from './catalog-sync';

export class VideoProgressMonitor {
  currentVideo: HTMLVideoElement | null = null;
  private boundHandlers: Record<string, EventListener> = {};
  private heartbeatTimer: any = null;
  private observer: MutationObserver | null = null;
  private sessionId: string;
  private currentVideoSrc = '';
  private lastPosition = 0;
  private lastReportTime = 0;
  realPlayedDuration = 0;
  private watchedSecondBuckets = new Map<number, number>();
  currentResourceInfo: any = null;
  private hasTriggeredStarted = false;
  private hasTriggeredCompleted = false;
  private hasTriggeredEnded = false;
  private onStateChangeCallback: ((state: any) => void) | null = null;

  constructor() {
    this.sessionId = this._generateUUID();
  }

  private _generateUUID(): string {
    return 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  }

  _getCappedRealPlayedSeconds(): number {
    const duration = this.currentVideo && isFinite(this.currentVideo.duration) ? this.currentVideo.duration : 0;
    if (duration > 0) {
      return Math.min(this.realPlayedDuration, duration);
    }
    return this.realPlayedDuration;
  }

  setStateChangeListener(cb: (state: any) => void) {
    this.onStateChangeCallback = cb;
  }

  _notifyState(extra: Record<string, any> = {}) {
    if (this.onStateChangeCallback) {
      const state = {
        hasVideo: !!this.currentVideo,
        paused: this.currentVideo ? this.currentVideo.paused : true,
        currentTime: this.currentVideo ? Math.round(this.currentVideo.currentTime) : 0,
        duration: this.currentVideo && isFinite(this.currentVideo.duration) ? Math.round(this.currentVideo.duration) : 0,
        realPlayedSeconds: Math.round(this._getCappedRealPlayedSeconds()),
        resourceInfo: this.currentResourceInfo,
        ...extra
      };
      this.onStateChangeCallback(state);
    }
  }

  start() {
    this._scanAndBindVideo();

    if (!this.observer && typeof document !== 'undefined') {
      this.observer = new MutationObserver(() => {
        this._scanAndBindVideo();
      });
      this.observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('visibilitychange', () => {
        if (document.hidden && this.currentVideo && !this.currentVideo.paused) {
          this._emitEvent('heartbeat', { reason: 'visibility_hidden' });
        }
      });
      window.addEventListener('popstate', () => this._scanAndBindVideo());
      window.addEventListener('hashchange', () => this._scanAndBindVideo());
      window.addEventListener('beforeunload', () => {
        if (this.currentVideo) {
          this._emitEvent('paused', { reason: 'page_unload' });
        }
      });
    }

    console.log('[VideoProgressMonitor] 视频进度监控探针已就绪');
  }

  _scanAndBindVideo() {
    if (!SmartEduAdapter.isStudentSelfStudyPage()) {
      return;
    }

    const video = document.querySelector('video');
    if (!video) return;

    const resIdInfo = SmartEduAdapter.extractResourceIdentifiers();
    const effectiveSrc = (video.currentSrc || video.src || '') + '#' + (resIdInfo.resourceId || '');

    if (this.currentVideo === video && this.currentVideoSrc === effectiveSrc) {
      return;
    }

    if (this.currentVideo) {
      this._unbindEvents(this.currentVideo);
      this._emitEvent('paused', { reason: 'switch_video' });
    }

    this.currentVideo = video;
    this.currentVideoSrc = effectiveSrc;
    this.sessionId = this._generateUUID();
    this.lastPosition = video.currentTime || 0;
    this.realPlayedDuration = 0;
    this.watchedSecondBuckets.clear();
    this.hasTriggeredStarted = false;
    this.hasTriggeredCompleted = false;
    this.hasTriggeredEnded = false;
    this.currentResourceInfo = this._collectResourceMetadata();

    this._bindEvents(video);
    this._startHeartbeat();
    this._notifyState({ event: 'video_attached' });
    console.log('[VideoProgressMonitor] 成功捕获并挂载 HTML5 <video> 实例');
  }

  private _collectResourceMetadata() {
    const idInfo = SmartEduAdapter.extractResourceIdentifiers();
    const courseContext = SmartEduAdapter.extractCourseContext();
    return {
      resourceId: idInfo.resourceId || 'unknown_res',
      idType: idInfo.idType,
      tm_id: idInfo.tm_id || idInfo.teachingmaterialId || '',
      title: courseContext.title || document.title,
      subject: courseContext.subject,
      grade: courseContext.grade,
      textbookVersion: courseContext.textbookVersion,
      chapterTitle: courseContext.chapterTitle,
      breadcrumb: courseContext.breadcrumb,
      url: window.location.href
    };
  }

  private _bindEvents(video: HTMLVideoElement) {
    this.boundHandlers = {
      play: () => {
        this._notifyState({ event: 'play' });
        if (!this.hasTriggeredStarted) {
          this.hasTriggeredStarted = true;
          this._emitEvent('started');
          // 自动触发的目录同步走静默守卫：智慧平台用户变更时不弹窗、零写入拒绝
          catalogSync.syncCurrentLessonCatalog({ guardMode: 'silent' }).catch(() => {});
        } else {
          this._emitEvent('resumed');
        }
      },
      pause: () => {
        this._notifyState({ event: 'pause' });
        if (!video.ended) {
          this._emitEvent('paused');
        }
      },
      timeupdate: () => {
        const cur = video.currentTime;
        const delta = cur - this.lastPosition;
        // 暂停态下拖动进度条同样会触发 timeupdate，scrub 行为不计入有效学习
        if (delta > 0 && delta <= 3.5 && !video.paused) {
          // 【2026-10-22 修复】旧实现：每次跨入新整秒只累加一个 timeupdate 间隔的 delta(≈0.25s)，
          // 导致 1x 倍速下「真实有效学习」仅为真实时间轴的 ~25%（实测：进度 349s 仅记 93s）。
          // 正确语义：登记本段播放覆盖到的每个整秒，去重后的桶总数即净有效观看秒数；
          // 回看/重播同一秒不重复计数（保留防刷语义），拖拽跳过的秒不会被登记。
          const from = Math.floor(Math.max(0, this.lastPosition));
          const to = Math.floor(cur);
          for (let s = from; s <= to; s++) {
            if (!this.watchedSecondBuckets.has(s)) {
              this.watchedSecondBuckets.set(s, 1);
            }
          }
          this.realPlayedDuration = this.watchedSecondBuckets.size;
        }
        this.lastPosition = cur;

        const dur = video.duration;
        if (dur > 0 && !this.hasTriggeredCompleted) {
          const config = storage.getConfig();
          const threshold = config.minCompletionRate || 0.90;
          const cappedPlayed = this._getCappedRealPlayedSeconds();
          if (cappedPlayed / dur >= threshold) {
            this.hasTriggeredCompleted = true;
            this._emitEvent('completed');
          }
        }
        this._notifyState();
      },
      ended: () => {
        this._notifyState({ event: 'ended' });
        if (!this.hasTriggeredEnded) {
          this.hasTriggeredEnded = true;
          this._emitEvent('ended');
        }
      }
    };

    Object.entries(this.boundHandlers).forEach(([ev, fn]) => {
      video.addEventListener(ev, fn);
    });
  }

  private _unbindEvents(video: HTMLVideoElement) {
    Object.entries(this.boundHandlers).forEach(([ev, fn]) => {
      video.removeEventListener(ev, fn);
    });
    this.boundHandlers = {};
  }

  private _startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.currentVideo && !this.currentVideo.paused) {
        this._emitEvent('heartbeat');
      }
    }, 120000);
  }

  private _emitEvent(type: string, extra: Record<string, any> = {}) {
    if (!this.currentVideo) return;
    const pos = this.currentVideo.currentTime || 0;
    const dur = isFinite(this.currentVideo.duration) ? this.currentVideo.duration : 0;
    const cappedPlayed = this._getCappedRealPlayedSeconds();

    const payload = {
      event: {
        type,
        session_id: this.sessionId,
        position_seconds: Math.round(pos * 10) / 10,
        duration_seconds: Math.round(dur * 10) / 10,
        real_played_seconds: Math.round(cappedPlayed * 10) / 10,
        completion_rate: dur > 0 ? Math.min(1, Math.round((cappedPlayed / dur) * 1000) / 1000) : 0,
        timestamp: new Date().toISOString(),
        ...extra
      },
      resource: this.currentResourceInfo || this._collectResourceMetadata()
    };

    uploader.report(payload);
  }
}

export const videoMonitor = new VideoProgressMonitor();

if (typeof window !== 'undefined') {
  (window as any).SmartEduVideoMonitor = videoMonitor;
}
