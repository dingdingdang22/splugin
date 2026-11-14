/**
 * wrong-question-probe.ts - 错题 / 习题提取调度器（TypeScript / ESM）
 *
 * 职责：
 * 1. 仅在错题本 / 习题库 / 练习页面启动；
 * 2. 应对 SPA：监听 hashchange / popstate / 点击 / history 包装 / DOM 变化，重复探测直到稳定；
 * 3. 把探测报告同时输出到面板与控制台诊断句柄；
 * 4. 同一份提取结果做签名去重，仅变化时才刷新面板与日志，避免刷屏；
 * 5. 检测到题目后自动驱动编排器（错题本走 run()，习题库走 runExerciseExtraction()）。
 *
 * 合规边界：本文件【不构造鉴权请求、不上传、不读取平台凭证】；
 *   上传由编排器在用户显式点击或后台静默任务中执行，且走 dofee 自己的 JWT。
 *
 * ── 由 Tampermonkey 脚本迁移到 WXT / MV3 content script 的兼容性调整 ──
 *
 * 【差异 1】旧脚本所有模块挂在 window 上（SmartEduWrongAdapter / SmartEduWrongSync /
 *          SmartEduWrongPanel），运行时靠全局查找；本插件是 ESM 模块，改为静态 import，
 *          模块缺失在编译期就会暴露，不会等到页面里才发现「适配层未加载」。
 *
 * 【差异 2】旧脚本跑在页面主世界（unsafeWindow），能直接读到页面 window 上的
 *          __SMARTEDU_WRONG_SNIFFER__；本插件 probe 跑在 MV3 **隔离世界**，
 *          与页面不共享 JS 属性，window.__SMARTEDU_WRONG_SNIFFER__ 恒为 undefined。
 *          改为：优先尝试直连（同一世界时才可能命中）→ 回落读主世界嗅探器写下的
 *          DOM 属性镜像（data-smartedu-sniffer / data-smartedu-wrong）。
 *          隔离世界与主世界仅共享 DOM，这是唯一可靠的单向通道。
 *
 * 【差异 3】同理，window.__SMARTEDU_WRONG__ 在页面控制台里也访问不到。
 *          因此额外把一份轻量快照镜像到 documentElement 的 dataset，
 *          页面控制台可执行：JSON.parse(document.documentElement.dataset.smarteduProbe)
 *
 * 【差异 4】旧脚本用 console.warn 输出注意事项，会被 Chrome 扩展管理页误报为
 *          「插件错误」；本文件统一改用 console.log + 样式，保持原注释里的结论。
 */

import { WrongQuestionAdapter } from '../adapters/wrong-question-adapter';
import { wrongQuestionSync } from './wrong-question-sync';
import { wrongQuestionPanel } from '../ui/wrong-question-panel';
import { questionSource } from '../core/question-source';
import { storage } from '../core/storage';

/** 探测报告（结构与 WrongQuestionAdapter.probePage() 返回值一致） */
export interface ProbeReport {
  url: string;
  mode: string;
  isWrongPage: boolean;
  isExercisePage: boolean;
  pageTitle: string;
  subject: string | null;
  grade: number | null;
  totalCandidateBlocks: number;
  candidateIds: string[];
  questions: any[];
  warnings: string[];
  sampledText?: string;
}

const TAG = '[智慧试题探针]';

export class WrongQuestionProbe {
  private timer: any = null;
  private lastSig = '';
  private attempts = 0;
  private maxAttempts = 12; // 最多轮询 12 次（约 18s）等待题目渲染
  private observer: MutationObserver | null = null;
  private routeBound = false;
  private apiBound = false;
  private loginWatcherStarted = false;
  started = false;

  /**
   * 启动探针。
   *
   * 与旧版的关键差异：旧版在「不是错题页」时直接 return，导致用户从别处 SPA
   * 跳转到错题页后探针永不启动（必须整页刷新）。这里改为：路由钩子**永远注册**，
   * 只有「轮询」才受页面判定约束 —— 这是新插件「提取 0 题」的成因之一。
   */
  start(): void {
    // ① 路由与导航监听（无论当前是否为试题页都注册，覆盖 SPA 后进入的场景）
    this._bindRouteHooks();

    // ② 主世界嗅探器广播监听
    this._bindApiBroadcast();

    // ③ 全站登录态守护（方案 C）：智慧平台任意页面检测到凭证即自动扫描上传一次。
    //    节奏由 sync 侧的「accountKey + 本地日期」闸门控制，重复登录/刷新/多标签页
    //    都不会重复扫描。注意写库操作不可逆，
    //    如需退回「自动提取、显式上传」，可注释掉这一行。
    this.startSilentLoginWatcher();

    if (!WrongQuestionAdapter.isWrongQuestionPage()) {
      return;
    }

    if (this.started) {
      this._reset();
      return;
    }
    this.started = true;

    console.log('%c' + TAG + ' 已在试题/练习页面启动（只读自动静默提取模式）',
      'background:#0f766e;color:#fff;padding:4px 8px;border-radius:4px;');
    this._poll();

    // ④ DOM 变化（题目异步渲染 / 懒加载 / 翻页）触发节流探测
    this._bindObserver();
  }

  // ─────────────────────────────────────────────────────────────
  // 事件绑定
  // ─────────────────────────────────────────────────────────────

  private _bindRouteHooks(): void {
    if (this.routeBound) return;
    this.routeBound = true;

    try {
      window.addEventListener('hashchange', () => this._onNavigation());
      window.addEventListener('popstate', () => this._onNavigation());
      // 接收主世界 sniffer.content.ts 拦截 history.pushState/replaceState 后派发的跨世界事件
      window.addEventListener('smartedu-route-change', () => {
        setTimeout(() => this._onNavigation(), 300);
      });

      // 点击后 900ms 再判定：覆盖「点学科 → 列表异步重绘」的窗口
      document.addEventListener('click', () => {
        setTimeout(() => {
          if (WrongQuestionAdapter.isWrongQuestionPage()) this._poll();
        }, 900);
      }, true);
    } catch (e) {
      console.log(TAG + ' 绑定路由钩子失败:', e);
    }
  }

  private _bindApiBroadcast(): void {
    if (this.apiBound) return;
    this.apiBound = true;

    window.addEventListener('message', (ev: MessageEvent) => {
      const d: any = ev && ev.data;
      if (!d || d.__smarteduWrong !== 'api' || !d.capture) return;

      const c = d.capture;
      console.log('%c[错题API嗅探] 命中 ' + c.method + ' ' + c.url + '（' + c.size + ' bytes）',
        'background:#0ea5e9;color:#fff;padding:2px 6px;border-radius:4px;');
      try { console.log(String(c.body || '').slice(0, 3000)); } catch (e) { /* ignore */ }

      // 自动触发后台静默增量提取与上传
      setTimeout(() => this._autoRunOnApi(), 300);
    });
  }

  private _bindObserver(): void {
    if (this.observer) return;
    try {
      this.observer = new MutationObserver(() => this._pollThrottled());
      this.observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });
    } catch (e) { /* ignore */ }
  }

  /**
   * 嗅探到错题/习题接口后自动跑一轮提取与静默上传。
   *
   * 清单非空时走错题本链路（run 默认自动静默上传）；
   * 清单为空但当前是习题/练习页时，走习题链路（runExerciseExtraction 默认自动静默上传）。
   */
  private async _autoRunOnApi(): Promise<void> {
    try {
      await storage.ensureHydrated();
      const cfg = storage.getConfig();
      const sniffer = this._getSniffer();
      const wq = sniffer && typeof sniffer.wrongQuestions === 'function'
        ? sniffer.wrongQuestions()
        : null;

      if (wq && wq.count > 0) {
        if (cfg.syncWrongBook === true) {
          try {
            if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.runtime.sendMessage) {
              const p = chrome.runtime.sendMessage({ type: 'SMARTEDU_WRONG_DETECTED', data: wq });
              if (p && typeof p.catch === 'function') p.catch(() => {});
            }
          } catch (e) { /* 后台不可达不影响页面流程 */ }

          if (!wrongQuestionSync.running) {
            const snap = await wrongQuestionSync.run({ withAnswer: true, waitMs: 2500, autoUpload: true, silentGuard: true });
            wrongQuestionPanel.applyRunResult(snap);
          }
        } else {
          console.log(TAG + ' 「同步错题本」开关未开启，已跳过自动提取与同步');
        }
        return;
      }

      // 清单为空：仅当当前是「我的习题」页且开启对应开关时，走习题链路（ID 来自 DOM / URL）
      const mode = WrongQuestionAdapter.detectPageMode();
      const isEx = mode === WrongQuestionAdapter.PAGE_MODES.MY_EXERCISES;
      if (isEx && cfg.syncMyExercises === true && !wrongQuestionSync.exerciseRunning) {
        const ids = WrongQuestionAdapter.collectExerciseIds().map((x: any) => x.id);
        if (ids.length) {
          const results = await wrongQuestionSync.runExerciseExtraction({
            ids,
            autoUpload: true,
            onProgress: (snap: any) => wrongQuestionPanel.updateExercise({
              mode,
              isExercisePage: true,
              candidateIds: ids
            }, snap)
          });
          console.log('%c[智慧习题探针] ✅ 自动提取与静默上传已触发，共解析 ' + results.length + ' 题',
            'background:#16a34a;color:#fff;padding:4px 8px;border-radius:4px;');
        }
      } else if (isEx && cfg.syncMyExercises !== true) {
        console.log('[智慧习题探针] 「同步我的习题」开关未开启，已跳过自动提取与同步');
      }
    } catch (e: any) {
      console.log(TAG + ' 自动提取处理完成（已记录日志）:', e && e.message ? e.message : String(e));
    }
  }

  private _onNavigation(): void {
    if (WrongQuestionAdapter.isWrongQuestionPage()) {
      if (!this.started) {
        this.started = true;
        console.log('%c' + TAG + ' 动态感知进入试题相关页面，自动激活探针',
          'background:#0f766e;color:#fff;padding:4px 8px;border-radius:4px;');
      }
      this._reset();
    }
  }

  private _reset(): void {
    this.attempts = 0;
    this.lastSig = '';
    setTimeout(() => this._poll(), 400);
  }

  private _pollThrottled(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.attempts = 0; // DOM 变化重置尝试计数，确保新题目能被捕获
      this._poll();
    }, 600);
  }

  // ─────────────────────────────────────────────────────────────
  // 主轮询
  // ─────────────────────────────────────────────────────────────

  private _poll(): void {
    if (!WrongQuestionAdapter.isWrongQuestionPage()) return;

    let report: ProbeReport;
    try {
      report = WrongQuestionAdapter.probePage() as ProbeReport;
    } catch (e: any) {
      console.log(TAG + ' 探测异常:', e && e.message ? e.message : String(e));
      return;
    }

    const sig = this._signature(report);

    // 1. 我的习题模式：走自动化提取流水线
    if (report.isExercisePage) {
      void this._handleExerciseMode(report, sig);
      return;
    }

    // 2. 错题本模式：走自动化静默提取与同步流水线
    if (report.mode === WrongQuestionAdapter.PAGE_MODES.WRONG_BOOK) {
      void this._handleWrongBookMode(report, sig);
      return;
    }

    if (sig === this.lastSig) {
      // 结果未变，但仍在等待渲染阶段时继续轮询
      if (this.attempts < this.maxAttempts && report.questions.length === 0) {
        this.attempts++;
        setTimeout(() => this._poll(), 1500);
      }
      return;
    }

    this.lastSig = sig;
    this.attempts = 0;

    wrongQuestionPanel.update(report);

    // 输出 1：对象形式（可展开查看）
    console.log(TAG + ' 探测到题目 ' + report.questions.length + ' 道', report);
    // 输出 2：单行 JSON 字符串（便于直接复制贴回，不依赖世界句柄）
    try {
      console.log('%c' + TAG + ' 完整报告 JSON（请复制整行贴回）:\n' + JSON.stringify(report),
        'color:#b45309');
    } catch (e: any) {
      console.log(TAG + ' JSON 序列化失败:', e && e.message ? e.message : String(e));
    }

    // 候选块 <= 1 时追加结构诊断，用于校准真实页面选择器
    if (report.questions.length <= 1 && typeof (WrongQuestionAdapter as any).diagnoseStructure === 'function') {
      try {
        const diag = (WrongQuestionAdapter as any).diagnoseStructure();
        console.log(TAG + ' 结构诊断（用于校准选择器，请一并贴回）:', diag);
        try {
          console.log('%c' + TAG + ' 结构诊断 JSON:\n' + JSON.stringify(diag), 'color:#b45309');
        } catch (e) { /* ignore */ }
      } catch (e: any) {
        console.log(TAG + ' 结构诊断信息:', e && e.message ? e.message : String(e));
      }
    }

    if (report.warnings.length) {
      // 使用普通日志而非 console.warn，避免 Chrome MV3 扩展管理页将其误报为插件致命错误
      console.log('%c' + TAG + ' 注意事项: ' + report.warnings.join('；'), 'color:#b45309;');
    }

    const apiCount = this._captures().length;
    if (apiCount > 0) {
      console.log(TAG + ' 已嗅探到 ' + apiCount + ' 条疑似错题接口响应，'
        + '执行 __SMARTEDU_WRONG__.api() 或读取 document.documentElement.dataset.smarteduProbe 查看');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 分模式流水线
  // ─────────────────────────────────────────────────────────────

  /**
   * 错题本模式自动化流水线：自动检测错题、自动后台提取并静默上传入库。
   * 【纯只读、无任何 click 侵入，支持页面翻页与章节切换自适应对账】
   */
  private async _handleWrongBookMode(report: ProbeReport, sig: string): Promise<void> {
    const hasCand = (report.candidateIds && report.candidateIds.length > 0)
      || (report.questions && report.questions.length > 0);

    if (!hasCand) {
      if (this.attempts < this.maxAttempts) {
        this.attempts++;
        setTimeout(() => this._poll(), 1500);
      }
      wrongQuestionPanel.update(report);
      return;
    }

    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.attempts = 0;

    wrongQuestionPanel.update(report);

    await storage.ensureHydrated();
    const cfg = storage.getConfig();
    if (cfg.syncWrongBook !== true) {
      console.log(TAG + ' 「同步错题本」开关未开启，已跳过自动提取与同步');
      return;
    }

    console.log('%c' + TAG + ' 检测到错题本题目，自动启动后台静默提取与同步流水线…',
      'background:#b45309;color:#fff;padding:4px 8px;border-radius:4px;');

    if (!wrongQuestionSync.running && typeof wrongQuestionSync.run === 'function') {
      try {
        const snap = await wrongQuestionSync.run({ withAnswer: true, waitMs: 2500, autoUpload: true, silentGuard: true });
        wrongQuestionPanel.applyRunResult(snap);
        console.log('%c' + TAG + ' ✅ 错题自动提取与静默同步完成！',
          'background:#16a34a;color:#fff;padding:4px 8px;border-radius:4px;');
      } catch (e: any) {
        console.log(TAG + ' 自动提取处理完成（已记录日志）:', e && e.message ? e.message : String(e));
      }
    }
  }

  /**
   * 我的习题模式自动化流水线：自动嗅探 ID、自动触发 CDN 拉取解析、流式更新面板。
   * 【纯只读、无任何 click 侵入，绝不触发路由跳转】
   */
  private async _handleExerciseMode(report: ProbeReport, sig: string): Promise<void> {
    // 通过跨世界 postMessage 桥向主世界嗅探器补齐 ID
    // （解决 MV3 隔离世界看不到页面 __reactFiber$ 属性、拦不到页面 fetch 的问题）
    if (typeof (WrongQuestionAdapter as any).collectExerciseIdsFromBridge === 'function') {
      try {
        const bridgeList: any[] = await (WrongQuestionAdapter as any).collectExerciseIdsFromBridge(350);
        if (Array.isArray(bridgeList) && bridgeList.length > 0) {
          const seen = new Set(report.candidateIds.map((x: any) => String(x).toLowerCase()));
          for (const item of bridgeList) {
            const bid = item && item.id ? String(item.id).toLowerCase() : '';
            if (bid && !seen.has(bid)) {
              seen.add(bid);
              report.candidateIds.push(bid);
            }
          }
          report.totalCandidateBlocks = report.candidateIds.length;
          sig = this._signature(report);
        }
      } catch (e) { /* 桥超时不影响主流程 */ }
    }

    // 题目尚未渲染且轮询未达上限：安静轮询等待（纯只读，绝不主动点击页面按钮）
    if (report.candidateIds.length === 0) {
      if (this.attempts < this.maxAttempts) {
        this.attempts++;
        setTimeout(() => this._poll(), 1500);
      }
      wrongQuestionPanel.update(report);
      return;
    }

    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.attempts = 0;

    wrongQuestionPanel.update(report);

    await storage.ensureHydrated();
    const cfg = storage.getConfig();
    if (cfg.syncMyExercises !== true) {
      console.log('[智慧习题探针] 「同步我的习题」开关未开启，已跳过自动提取与同步');
      return;
    }

    console.log('%c[智慧习题探针] 自动检测到 ' + report.candidateIds.length + ' 道习题，启动自动解析流水线…',
      'background:#0f766e;color:#fff;padding:4px 8px;border-radius:4px;');

    if (typeof wrongQuestionSync.runExerciseExtraction === 'function') {
      try {
        const results = await wrongQuestionSync.runExerciseExtraction({
          ids: report.candidateIds,
          autoUpload: true,
          onProgress: (snap: any) => wrongQuestionPanel.updateExercise(report, snap)
        });
        wrongQuestionPanel.updateExercise(report, wrongQuestionSync.snapshot());
        console.log('%c[智慧习题探针] ✅ 自动提取完成！已解析 ' + results.length + ' 题，可直接在面板导出或入库',
          'background:#16a34a;color:#fff;padding:4px 8px;border-radius:4px;');
      } catch (e: any) {
        console.log('[智慧习题探针] 自动提取异常: ' + (e && e.message ? e.message : String(e)));
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 签名 / 跨世界读取
  // ─────────────────────────────────────────────────────────────

  /**
   * 生成去重签名：仅用于判断「题目集合与页面元数据是否变化」，不用于上传幂等。
   */
  private _signature(report: ProbeReport): string {
    try {
      const metaSig = typeof (WrongQuestionAdapter as any).getMetaSignature === 'function'
        ? (WrongQuestionAdapter as any).getMetaSignature()
        : '';

      if (report.isExercisePage) {
        return 'EXERCISE#' + (report.candidateIds || []).slice().sort().join(',') + '#' + metaSig;
      }

      const keys = (report.questions || []).map((q: any) =>
        (q.source_question_id || '') + '|' + (q.content || '').slice(0, 30) + '|' + (q.correct_answer || '')
      );
      const candKeys = (report.candidateIds || []).slice().sort().join(',');
      return report.subject + '#' + report.grade + '#' + report.totalCandidateBlocks + '#'
        + candKeys + '#' + keys.join('^') + '#' + metaSig;
    } catch (e) {
      return String(Date.now());
    }
  }

  /**
   * 取主世界嗅探器句柄。
   *
   * 隔离世界与页面不共享 JS 属性，直连在 MV3 下几乎必然失败，
   * 因此真正生效的是 DOM 属性镜像分支（嗅探器每次 syncDomBridge 都会刷新）。
   */
  private _getSniffer(): any {
    try {
      const w: any = window as any;
      if (w.__SMARTEDU_WRONG_SNIFFER__) return w.__SMARTEDU_WRONG_SNIFFER__;
    } catch (e) { /* ignore */ }

    try {
      const el = document.documentElement;
      if (el.getAttribute('data-smartedu-sniffer') !== 'ready') return null;
      const raw = el.getAttribute('data-smartedu-wrong');
      const list = raw ? JSON.parse(raw) : [];
      const questions = Array.isArray(list) ? list : (list && list.questions) || [];
      return {
        _via: 'dom',
        captures: [],
        wrongQuestions: () => ({
          teachingmaterial_id: (list && list.teachingmaterial_id) || null,
          count: questions.length,
          total: questions.length,
          questions,
          sources: (list && list.sources) || []
        })
      };
    } catch (e) {
      return null;
    }
  }

  /** 嗅探器已捕获的接口响应（只读，隔离世界下为空数组，全量走消息桥） */
  private _captures(): any[] {
    const s = this._getSniffer();
    if (s && Array.isArray(s.captures)) return s.captures;
    return [];
  }

  // ─────────────────────────────────────────────────────────────
  // 控制台诊断句柄
  // ─────────────────────────────────────────────────────────────

  /** 暴露控制台诊断句柄（模块加载时自动调用） */
  exposeHandle(): void {
    const handle = {
      version: '1.0.0-probe',
      isWrongPage: () => WrongQuestionAdapter.isWrongQuestionPage(),
      report: () => WrongQuestionAdapter.probePage(),
      diagnose: () => (WrongQuestionAdapter as any).diagnoseStructure(),
      /** 读取主世界嗅探器捕获的错题接口响应（隔离世界下为空，改用 DOM 镜像） */
      api: () => this._captures(),
      /** 隔离世界可用的 DOM 镜像快照 */
      snapshot: () => {
        try {
          const raw = document.documentElement.getAttribute('data-smartedu-wrong');
          return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
      },
      resetPos: () => wrongQuestionPanel.resetPosition(),
      rerun: () => { this.lastSig = ''; this._poll(); },
      mode: () => WrongQuestionAdapter.detectPageMode(),
      getExercises: () => wrongQuestionSync.exerciseResults,
      exportExercises: (fmt: 'json' | 'md' | 'html') => wrongQuestionSync.exportExercises(fmt),
      autoExtract: () => { this.lastSig = ''; this._poll(); },
      silentSync: (opts: any) => wrongQuestionSync.runSilentAutoSync(opts || {}),

      /** 每日扫描入口：受「accountKey + 本地日期」闸门约束，一天只跑一次 */
      dailyScan: (opts: any) => wrongQuestionSync.runDailyScan(opts || {}),
      /** 该账号今天是否已扫描过 */
      scannedToday: (accountKey?: string) => wrongQuestionSync.hasScannedToday(accountKey || 'anonymous'),
      /** 清掉当日水位，用于排障时强制重跑 */
      clearScanMark: (accountKey?: string) => wrongQuestionSync.clearScanMark(accountKey || 'anonymous'),

      /**
       * 双树映射防线自检 —— 不依赖真机即可确认防线是否生效。
       *
       * 对「当前已提取结果」跑一遍 assertNoTreeMapping，返回：
       *   { checked, clean, groups: [{ label, count, clean, stripped }] }
       * clean === false 即说明上游仍产出了 textbook_node_id / chapter_path /
       * topic_names / mapping_source / mapping_score / status 等映射字段，需要回溯
       * parseSingleQuestion / mapQuestion / buildDofeePayload*。
       *
       * 注意：断言会 delete 命中字段，因此这里先深拷贝再检测，
       * 绝不影响内存里已提取的结果。
       */
      auditTreeMapping: () => {
        const out: any = { checked: 0, clean: true, groups: [] as any[] };
        const targets: Array<[string, any]> = [
          ['wrong_book', wrongQuestionSync.results],
          ['exercise', wrongQuestionSync.exerciseResults]
        ];

        for (const [label, list] of targets) {
          if (!Array.isArray(list) || !list.length) continue;
          let cloned: any = null;
          try { cloned = JSON.parse(JSON.stringify(list)); } catch (e) { continue; }
          out.checked += list.length;
          try {
            const r = questionSource._internals.assertNoTreeMapping(cloned, `audit/${label}`);
            if (!r.clean) out.clean = false;
            out.groups.push({ label, count: list.length, clean: r.clean, stripped: r.stripped });
          } catch (e: any) {
            out.groups.push({
              label, count: list.length, clean: false,
              stripped: [], error: (e && e.message) ? e.message : String(e)
            });
            out.clean = false;
          }
        }

        return out;
      }
    };

    try {
      (window as any).__SMARTEDU_WRONG__ = handle;
    } catch (e) { /* ignore */ }

    // 页面控制台能读到的等价出口（见文件头【差异 3】）
    try {
      if (document.documentElement) {
        document.documentElement.setAttribute('data-smartedu-probe-handle', 'ready');
      }
    } catch (e) { /* ignore */ }

    console.log('%c' + TAG + ' 控制台可用 __SMARTEDU_WRONG__.report() / .diagnose() 重新探测'
      + '（页面控制台请用 JSON.parse(document.documentElement.dataset.smarteduProbe)）',
      'color:#b45309;font-weight:bold;');
  }

  /** 配置开关变更时立即刷新当前页面探针状态 */
  onSyncConfigChanged(): void {
    if (!WrongQuestionAdapter.isWrongQuestionPage()) return;
    this.lastSig = '';
    this.attempts = 0;
    this._poll();
  }

  /**
   * 全站登录态监听与后台静默同步触发器：
   * 当开启「同步错题本」或「同步我的习题」且检测到智慧平台登录凭证时，
   * 触发后台静默对账同步；两项均关闭时不触发。
   */
  startSilentLoginWatcher(): void {
    if (this.loginWatcherStarted) return;
    this.loginWatcherStarted = true;

    const checkAndRun = async () => {
      try {
        await storage.ensureHydrated();
        const cfg = storage.getConfig();
        if (cfg.syncWrongBook !== true && cfg.syncMyExercises !== true) {
          return;
        }
        const auth = questionSource.extractUcAuthFromStorage();
        if (auth && auth.access_token) {
          void wrongQuestionSync.runSilentAutoSync({ ucAuth: auth, trigger: 'login_detected' });
        }
      } catch (e) { /* ignore */ }
    };

    setTimeout(() => { void checkAndRun(); }, 1200);
    // 【修复：登录晚于脚本注入时漏触发】旧版只在加载后 1.2s 检查一次：
    // 用户在页面停留期间才登录智慧平台（SPA 登录跳转不刷新页面）就永远赶不上这一班。
    // 改为 60s 周期巡检；幂等由 runSilentAutoSync 的「accountKey + 本地日期」每日闸门
    // 与题目级增量去重兜底，重复调用不会重复上传。
    setInterval(() => { void checkAndRun(); }, 60000);
  }
}

export const wrongQuestionProbe = new WrongQuestionProbe();

if (typeof window !== 'undefined') {
  (window as any).SmartEduWrongProbe = wrongQuestionProbe;
  (window as any).__SMARTEDU_WRONG_PROBE__ = wrongQuestionProbe;
  wrongQuestionProbe.exposeHandle();
}
