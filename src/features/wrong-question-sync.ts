/**
 * wrong-question-sync.ts - 错题/习题提取与同步编排器 (TypeScript / ESM)
 *
 * 把三段数据源串成一条流水线：
 *
 *   ┌─ 错题 ID 列表 ────── 登录态（由 sniffer 被动嗅探，本模块不构造需要鉴权的请求）
 *   │    study_records/{tmId}/user_teachingmaterials_wrong_questions
 *   ↓
 *   ├─ 题库内容 ─────────── 公开 CDN part_*.json（教材分片索引）
 *   │    题干 / 题型 / 难度 / 学科 / 年级 / 版本 / 册次 / 知识点 / 章节 / 图片
 *   ↓
 *   └─ 标准答案 ─────────── 公开 CDN 题包 ZIP 内 item.json（Range 抽取）
 *        responses[].corrects + feedbacks[showAnswer] 文字解析
 *
 * ── 与旧实现 (smartedu-monitor/wrong-question-sync.js) 对齐的关键行为 ──────
 * 1. `run()` 不再「0 题静默成功」：先等嗅探器/消息桥，再退化为页面自适应 ID；
 *    两条都拿不到时抛出**带 stage 的可读错误**，面板能显示到底卡在哪一环；
 * 2. 教材分片索引按 tmId 缓存，同一教材只拉一次；单题命中不了索引时自动降级走
 *    单题公开 CDN，绝不因为「缺 tmId / 跨教材」而整批失败；
 * 3. 习题库链路并发度 3 + 指数退避重试 + 结果缓存，避免重复请求与串行龟速；
 * 4. 上传按 200 条分块（与 dofee 端点 MAX_ITEMS 对齐），401/403 用 refresh token
 *    静默续签一次，5xx 指数退避；写库后回写本地增量集合，避免每次全量重传；
 * 5. `isWrongBookQuestion()` 严格分流：普通试题永不写入学员个人错题本。
 *
 * ── 行为与安全边界 ────────────────────────────────────────────────────────
 * - 页面提取阶段优先复用 sniffer 被动嗅探结果、DOM 与公开 CDN；后台全量对账（runSilentAutoSync）
 *   则在页面内使用本地登录态拉取本人错题/习题清单；
 * - 提取完成后默认自动静默上传至 dofee（受 import-user-guard 防串号守卫与双树映射闸保护），
 *   面板按钮亦支持手动触发重传。
 */

import { questionSource } from '../core/question-source';
import { storage } from '../core/storage';
import { uploader } from '../core/uploader';
import { ensureImportUserConsistent, describeGuardAbort } from '../core/import-user-guard';
import { WrongQuestionAdapter } from '../adapters/wrong-question-adapter';
import { sendHttpRequest, sendAuthHttpRequest } from '../core/request';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 本页已同步的题目 ID（localStorage，跨刷新保留；与 background 侧同名 key 对齐） */
const SYNCED_WRONG_KEY = 'SMARTEDU_SYNCED_WRONG_IDS';
const SYNCED_EXERCISE_KEY = 'SMARTEDU_SYNCED_EXERCISE_IDS';

/**
 * 当前用户实际使用的水位 key 登记表。
 *
 * 水位 key 自 2026-10-23 起按 dofee 学员分桶（`<原key>:<username>`），
 * 但后台 Service Worker 与诊断面板拿不到「当前登录学员」这一上下文，
 * 因此由本模块在上传时登记一份「当前用的是哪两个 key」，供它们定位。
 */
const SYNCED_ACTIVE_KEYS = 'SMARTEDU_SYNCED_ACTIVE_KEYS';

/**
 * 每日扫描水位前缀。
 *
 * 实际 key = `${SMARTEDU_DAILY_SCAN_PREFIX}:${accountKey}`，value = `YYYY-MM-DD`。
 * 刻意存日期值而非每天建新 key，避免 key 数量随天数无限增长；
 * 也双写 chrome.storage.local，便于页面 localStorage 被清后回补（同 SYNCED_* 策略）。
 */
const SMARTEDU_DAILY_SCAN_PREFIX = 'SMARTEDU_DAILY_SCAN';

/** 单次请求最多条数，与 dofee 端点 MAX_ITEMS 保持一致 */
const UPLOAD_CHUNK = 200;

/**
 * 本地增量集合的容量上限（超出时保留**最近**同步的这部分）。
 *
 * 为什么需要上限：这个集合与 `SMARTEDU_MONITOR_SYNCED_CATALOGS`（整棵教材目录树，
 * 体量大得多）共享同一个 localStorage 配额（通常 5–10MB）。无上限增长会在长期运行后
 * 把配额写满，届时 `setItem` 抛 QuotaExceededError，反而**连带丢失水位与目录缓存**。
 *
 * 为什么可以裁：被裁掉的只是「很久以前同步过」的题，丢了最坏结果是重传一次，
 * 由服务端 UPSERT 兜底成 `updated` 而非 `inserted`，不产生脏数据。
 * 单个 UUID 存成 `["...",...]` 约 40 字节，20000 条约 800KB，占比可控。
 */
const MAX_SYNCED_IDS = 20000;

/**
 * 本插件**依赖**的服务端能力（dofee 端点在响应里回传 impl.features）。
 * 插件更新是即时的，dofee 更新必须部署 Cloudflare Pages —— 两者节奏不同，
 * 却同时体现在同一页面上；不比对指纹就只能靠现象反推，容易误判成插件 bug。
 */
const REQUIRED_IMPL_FEATURES = ['stem-image-inline', 'full-stem-from-description', 'real-figure-not-mainbig'];

export class WrongQuestionSyncManager {
  running = false;
  phase = '';
  done = 0;
  total = 0;
  results: any[] = [];
  errors: any[] = [];
  summary: any = null;
  startedAt = 0;
  finishedAt = 0;

  /** 教材分片索引缓存：tmId -> Map<qid, question> */
  indexCache = new Map<string, Map<string, any>>();
  indexStats: any = null;

  /** 习题库链路 */
  exerciseCache = new Map<string, any>();
  exerciseResults: any[] = [];
  exerciseRunning = false;
  exercisePhase = '';
  exerciseDone = 0;
  exerciseTotal = 0;
  exerciseErrors: any[] = [];
  private _queuedExerciseIds = new Set<string>();

  /** 增量集合的内存镜像：key -> Set<归一化 qid>，避免每次反序列化整份 JSON */
  private _syncedMirror = new Map<string, Set<string>>();
  /** 每个 key 一条串行写队列，杜绝同一 key 的 union 读-改-写交错 */
  private _syncedWriteQueue = new Map<string, Promise<void>>();
  /** 已尝试过「扩展持久层 → localStorage」回填的 key（只试一次，避免每次上传读盘） */
  private _syncedHydrated = new Set<string>();

  /** 跨世界消息桥（主世界 sniffer ↔ 本模块所在世界） */
  BRIDGE_TIMEOUT = 1500;
  private _bridgeInstalled = false;
  private _bridgeWaiters: Record<string, any> = {};
  private _bridgeLast: any = null;
  _source = '';

  /** 后台静默同步状态 */
  silentSyncRunning = false;
  lastUploadResult: any = null;
  lastSilentSyncLog: any = null;

  // ─────────────────────────────────────────────────────────────
  // 快照
  // ─────────────────────────────────────────────────────────────
  getSyncOptions(): { syncWrongBook: boolean; syncMyExercises: boolean } {
    const cfg = storage.getConfig();
    return {
      syncWrongBook: cfg.syncWrongBook === true,
      syncMyExercises: cfg.syncMyExercises === true
    };
  }

  snapshot() {
    const cfg = storage.getConfig();
    return {
      running: this.running,
      phase: this.phase,
      done: this.done,
      total: this.total,
      okCount: this.results.length,
      errorCount: this.errors.length,
      // 明细必须随快照一起出去：面板要按 stage 展示失败原因。
      // 只给 errorCount 会让面板读 snap.errors.length 直接 TypeError，把真正原因整个吞掉。
      errors: this.errors.slice(),
      sniffer: this._snifferStatus(),
      summary: this.summary,
      indexStats: this.indexStats,
      elapsedMs: this.startedAt ? (this.finishedAt || Date.now()) - this.startedAt : 0,

      exerciseCount: this.exerciseResults.length,
      exerciseRunning: this.exerciseRunning,
      exercisePhase: this.exercisePhase,
      exerciseDone: this.exerciseDone,
      exerciseTotal: this.exerciseTotal,
      exerciseResults: this.exerciseResults.slice(),
      exerciseErrors: this.exerciseErrors.slice(),

      silentSyncRunning: !!this.silentSyncRunning,
      syncWrongBook: cfg.syncWrongBook === true,
      syncMyExercises: cfg.syncMyExercises === true,
      lastUploadResult: this.lastUploadResult || null,
      lastSilentSyncLog: this.lastSilentSyncLog || null
    };
  }

  private _emit() {
    try {
      const panel: any = typeof window !== 'undefined' ? (window as any).SmartEduWrongPanel : null;
      if (panel && typeof panel.setSync === 'function') panel.setSync(this.snapshot());
    } catch (e) { /* 面板缺失不影响主流程 */ }
  }

  // ─────────────────────────────────────────────────────────────
  // 本地增量集合 & 退避重试
  // ─────────────────────────────────────────────────────────────
  /**
   * 同步读取增量集合（快路径）。
   *
   * 注意：返回的是**内存镜像的引用**，调用方 `set.add(...)` 会直接改到镜像上，
   * 后续统一由 `_saveSyncedSet()` 落盘 —— 这是有意的，避免每次都要反序列化整份 JSON。
   */
  private _getSyncedSet(storageKey: string): Set<string> {
    const cached = this._syncedMirror.get(storageKey);
    if (cached) return cached;

    let set: Set<string>;
    try {
      const raw = localStorage.getItem(storageKey);
      const arr = raw ? JSON.parse(raw) : null;
      set = Array.isArray(arr) ? new Set(arr.map((x: any) => String(x).toLowerCase())) : new Set();
    } catch (e) {
      set = new Set();
    }
    this._syncedMirror.set(storageKey, set);
    return set;
  }

  /**
   * 读取增量集合，必要时先从扩展持久层回补（P1）。
   *
   * 场景：用户清站点数据 / 用无痕窗口 / 换 Chrome profile 后，页面 localStorage 没了，
   * 但 `chrome.storage.local` 里的水位还在。此前只写不读，等于双写白写 ——
   * 清一次缓存就把「增量上传」打回「全量重传」。这里补上回填，对齐
   * `storage.ts` 里 `SYNCED_CATALOGS` 的「重启自愈」做法。
   */
  private async _ensureSyncedSet(storageKey: string): Promise<Set<string>> {
    const local = this._getSyncedSet(storageKey);
    if (local.size > 0 || this._syncedHydrated.has(storageKey)) return local;
    this._syncedHydrated.add(storageKey); // 只尝试一次，避免每次上传都读盘

    const remote = await this._readSyncedRemote(storageKey);
    if (!remote || !remote.length) return local;

    const merged = new Set(local);
    for (let i = 0; i < remote.length; i++) merged.add(String(remote[i]).toLowerCase());
    this._saveSyncedSet(storageKey, merged);
    console.log(`[增量水位] 已从扩展持久层回填 ${merged.size} 条已同步记录`);
    return merged;
  }

  /** 读扩展持久层（回调式与 Promise 式都兜住；任何异常都退化成 null，绝不抛出） */
  private _readSyncedRemote(storageKey: string): Promise<any[] | null> {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return resolve(null);
        const maybe: any = chrome.storage.local.get(storageKey, (res: any) => {
          const v = res && res[storageKey];
          resolve(Array.isArray(v) ? v : null);
        });
        // MV3（Chrome 88+）不传回调时返回 Promise；两种形态都支持
        if (maybe && typeof maybe.then === 'function') {
          maybe.then((res: any) => {
            const v = res && res[storageKey];
            resolve(Array.isArray(v) ? v : null);
          }).catch(() => resolve(null));
        }
      } catch (e) {
        resolve(null);
      }
    });
  }

  /**
   * 落盘增量集合（P2：容量上限 + 扩展持久层合并写）。
   *
   * 写入顺序刻意如此：先同步写页面 localStorage（本次会话立刻可见），
   * 再异步 union 写扩展持久层（跨会话兜底）。异步部分失败不影响主流程。
   */
  private _saveSyncedSet(storageKey: string, setObj: Set<string>) {
    let arr = Array.from(setObj);
    if (arr.length > MAX_SYNCED_IDS) arr = arr.slice(arr.length - MAX_SYNCED_IDS);
    const trimmed = new Set(arr);
    this._syncedMirror.set(storageKey, trimmed);

    try {
      localStorage.setItem(storageKey, JSON.stringify(arr));
    } catch (e) {
      // 配额写满：退一步只保留最近 1/4，给目录缓存等其它 key 腾出空间。
      // 最坏结果是这些老题重传一次，由服务端 UPSERT 兜底成 updated。
      try {
        arr = arr.slice(Math.floor(arr.length * 0.75));
        this._syncedMirror.set(storageKey, new Set(arr));
        localStorage.setItem(storageKey, JSON.stringify(arr));
      } catch (e2) {}
    }

    this._queueSyncedRemoteWrite(storageKey, arr);
  }

  /**
   * 当前 dofee 学员标识（用于水位分桶与上传身份对账）。
   * 取不到时退回 'anonymous'，与每日扫描水位 `_scanKey()` 的匿名桶口径一致。
   */
  private _userKey(): string {
    try {
      const u = String(storage.getConfig().dofeeUsername || '').trim();
      return u || 'anonymous';
    } catch (e) {
      return 'anonymous';
    }
  }

  /**
   * 增量水位 key（**按用户分桶**）。
   *
   * 背景：这两个 key 原先是全局的。同一浏览器换 dofee 学员登录后，B 的题会命中
   * A 留下的水位被判为「已同步」而跳过上传。错题本通道因为走重打标签全量重传
   * （`retagWrong`）暂时没爆，但 `forceRetag: false`、以及我的习题 / 公共题库
   * 这两条走增量去重的通道会直接串号。
   *
   * 旧全局 key **不做迁移**：漏判的最坏结果是重传一次，由服务端 UPSERT 兜底；
   * 反之若把 A 的水位判给 B，那批题就永久丢失了 —— 安全侧选前者。
   */
  private _syncedKeyFor(base: string): string {
    return `${base}:${this._userKey()}`;
  }

  /** 登记当前用户实际使用的水位 key，供后台 SW 与诊断面板定位（它们没有用户上下文） */
  private _rememberSyncedKeys(): void {
    const uk = this._userKey();
    const map = {
      wrong: `${SYNCED_WRONG_KEY}:${uk}`,
      exercise: `${SYNCED_EXERCISE_KEY}:${uk}`,
    };
    try { localStorage.setItem(SYNCED_ACTIVE_KEYS, JSON.stringify(map)); } catch (e) {}
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [SYNCED_ACTIVE_KEYS]: map });
      }
    } catch (e) {}
  }

  /**
   * 异步 union 写扩展持久层，按 key 串行化。
   *
   * 为什么必须 union 而不是覆盖：多标签页各自同步了不同题目，直接 `set` 会
   * 后写覆盖先写，把另一个标签页刚记录的 ID 抹掉。串行化队列则避免同一 key
   * 的读-改-写在自身内部交错。
   */
  private _queueSyncedRemoteWrite(storageKey: string, arr: string[]) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      const prev = this._syncedWriteQueue.get(storageKey) || Promise.resolve();
      const next = prev.then(async () => {
        try {
          const remote = await this._readSyncedRemote(storageKey);
          const merged = new Set(Array.isArray(remote) ? remote.map((x: any) => String(x).toLowerCase()) : []);
          for (let i = 0; i < arr.length; i++) merged.add(arr[i]);
          let out = Array.from(merged);
          if (out.length > MAX_SYNCED_IDS) out = out.slice(out.length - MAX_SYNCED_IDS);
          await chrome.storage.local.set({ [storageKey]: out });
        } catch (e) {}
      });
      this._syncedWriteQueue.set(storageKey, next.catch(() => {}));
    } catch (e) {}
  }

  /**
   * 取出载荷里归一化后的题目 ID。
   *
   * 三处调用点此前各写各的字段组合，漏一个字段就等于该批题永久「每次都重传」。
   * 统一收口在这里。
   */
  private _payloadQid(item: any): string {
    if (!item || typeof item !== 'object') return '';
    const raw = item.source_question_id != null ? item.source_question_id
      : (item.question_id != null ? item.question_id : item.id);
    return raw != null ? String(raw).toLowerCase() : '';
  }

  // ─────────────────────────────────────────────────────────────
  // 每日扫描闸门（方案 C 的节奏控制）
  // ─────────────────────────────────────────────────────────────

  /**
   * 本地时区日期键 `YYYY-MM-DD`。
   *
   * 用浏览器本地时间而非 UTC：学员的「一天」以当地日切为准，
   * 否则东八区在 UTC 16:00 就会翻页，可能出现「当天深夜扫描记到次日」的错位。
   */
  private _todayKey(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** 账号级（按通道分桶）扫描水位 key（无 user_id 时退回匿名桶） */
  private _scanKey(accountKey: string, scope?: 'wrong_book' | 'my_exercises'): string {
    const base = `${SMARTEDU_DAILY_SCAN_PREFIX}:${accountKey || 'anonymous'}`;
    return scope ? `${base}:${scope}` : base;
  }

  /** 该账号今天是否已经扫描过（可按 wrong_book / my_exercises 单独判断） */
  hasScannedToday(accountKey: string, scope?: 'wrong_book' | 'my_exercises'): boolean {
    try {
      const today = this._todayKey();
      if (scope) {
        return localStorage.getItem(this._scanKey(accountKey, scope)) === today;
      }
      const cfg = storage.getConfig();
      const checks: boolean[] = [];
      if (cfg.syncWrongBook === true) checks.push(localStorage.getItem(this._scanKey(accountKey, 'wrong_book')) === today);
      if (cfg.syncMyExercises === true) checks.push(localStorage.getItem(this._scanKey(accountKey, 'my_exercises')) === today);
      return checks.length > 0 && checks.every(Boolean);
    } catch (e) {
      return false;
    }
  }

  /** 标记该账号对应通道今天已完成扫描（仅在无错误时调用，失败次日自动重试） */
  markScannedToday(accountKey: string, scope?: 'wrong_book' | 'my_exercises'): void {
    const date = this._todayKey();
    const key = this._scanKey(accountKey, scope);
    try {
      localStorage.setItem(key, date);
    } catch (e) {}
    this._queueSyncedRemoteWrite(key, [date]);
  }

  /** 清掉当日水位（排障时强制重跑一次） */
  clearScanMark(accountKey: string, scope?: 'wrong_book' | 'my_exercises'): void {
    const keys = scope
      ? [this._scanKey(accountKey, scope)]
      : [
          this._scanKey(accountKey),
          this._scanKey(accountKey, 'wrong_book'),
          this._scanKey(accountKey, 'my_exercises')
        ];
    for (const key of keys) {
      try { localStorage.removeItem(key); } catch (e) {}
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.remove(key);
        }
      } catch (e) {}
    }
  }

  private async _retryAsync(fn: (attempt: number) => Promise<any>, retries = 2, baseDelayMs = 600) {
    let lastErr: any = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastErr = err;
        if (attempt < retries) await sleep(baseDelayMs * Math.pow(2, attempt));
      }
    }
    throw lastErr;
  }

  // ─────────────────────────────────────────────────────────────
  // 嗅探器解析（多路：DOM 镜像 / 消息桥）
  // ─────────────────────────────────────────────────────────────

  /**
   * 解析嗅探器句柄。
   *
   * MV3 隔离世界读不到主世界 window 属性，因此这里先试直连（油猴/同世界场景），
   * 再退化到 DOM 属性镜像（`data-smartedu-sniffer` / `data-smartedu-wrong`）——
   * 后者是扩展态下真正生效的那条路。
   */
  private _resolveSniffer(): any {
    const test = (o: any) => (o && typeof o.wrongQuestions === 'function' ? o : null);
    try { const s = test((window as any).__SMARTEDU_WRONG_SNIFFER__); if (s) return s; } catch (e) {}
    try { const s = test((globalThis as any).__SMARTEDU_WRONG_SNIFFER__); if (s) return s; } catch (e) {}

    try {
      if (typeof document !== 'undefined' && document.documentElement) {
        const ready = document.documentElement.getAttribute('data-smartedu-sniffer');
        if (ready === 'ready') {
          const capturesLen = Number(document.documentElement.getAttribute('data-smartedu-sniffer-captures') || 0);
          return {
            isDomBridge: true,
            captures: { length: capturesLen },
            wrongQuestions: () => {
              try {
                const raw = document.documentElement.getAttribute('data-smartedu-wrong');
                if (raw) return JSON.parse(raw);
              } catch (e) {}
              return { teachingmaterial_id: null, count: 0, questions: [], sources: [] };
            }
          };
        }
      }
    } catch (e) {}
    return null;
  }

  /** 嗅探器可用性与捕获量（面板/错误提示用，只读） */
  private _snifferStatus() {
    const s = this._resolveSniffer();
    if (s) {
      let count = 0;
      try { count = s.wrongQuestions().count || 0; } catch (e) {}
      return {
        found: true,
        via: s.isDomBridge ? 'dom' : 'direct',
        count,
        captured: s.captures ? (s.captures.length || 0) : 0
      };
    }
    if (this._bridgeLast) return { found: true, via: 'bridge', count: this._bridgeLast.count || 0, captured: -1 };
    return { found: false, via: null, count: 0, captured: 0 };
  }

  /** 注册消息监听。模块加载即调用 —— 必须在发问之前装好，否则会漏掉应答。 */
  private _installBridge() {
    if (this._bridgeInstalled) return;
    if (typeof window === 'undefined') return;
    this._bridgeInstalled = true;
    window.addEventListener('message', (ev: MessageEvent) => {
      let d: any = null;
      try { d = ev && ev.data; } catch (e) { return; }
      if (!d || typeof d !== 'object' || !d.__smarteduWrongAnswer) return;
      const waiter = this._bridgeWaiters[d.__smarteduWrongAnswer];
      if (!waiter) return;
      delete this._bridgeWaiters[d.__smarteduWrongAnswer];
      clearTimeout(waiter.timer);
      waiter.resolve(d.ok && d.data ? d.data : null);
    }, false);
  }

  /** 向主世界问一次错题清单（超时返回 null，绝不抛出） */
  private _askBridge(timeoutMs?: number): Promise<any> {
    this._installBridge();
    return new Promise((resolve) => {
      const reqId = 'wq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        delete this._bridgeWaiters[reqId];
        resolve(null);
      }, timeoutMs || this.BRIDGE_TIMEOUT);
      this._bridgeWaiters[reqId] = { resolve, timer };
      try {
        window.postMessage({ __smarteduWrongQuery: 'wrongQuestions', reqId }, '*');
      } catch (e) {
        clearTimeout(timer);
        delete this._bridgeWaiters[reqId];
        resolve(null);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 主流程
  // ─────────────────────────────────────────────────────────────

  /**
   * 提取当前页面的错题/习题并默认自动静默同步到 dofee。
   *
   * @param options.withAnswer 是否抽题包标准答案（默认 true）
   * @param options.waitMs     等待嗅探器捕获的最长时间（默认 15000）
   * @param options.autoUpload 提取完是否立即自动静默同步（默认 true，传 false 时仅提取）
   * @param options.silentGuard 自动同步时是否使用静默用户守卫（默认 true）
   * @param options.limit      最多处理多少题（0 = 不限）
   * @param options.onProgress 进度回调
   */
  async run(options: { withAnswer?: boolean; waitMs?: number; autoUpload?: boolean; silentGuard?: boolean; limit?: number; onProgress?: (snap: any) => void } = {}) {
    if (this.running) return this.snapshot();

    this.running = true;
    this.phase = 'waiting';
    this.done = 0;
    this.total = 0;
    this.results = [];
    this.errors = [];
    this.summary = null;
    this.startedAt = Date.now();
    this.finishedAt = 0;
    this._emit();

    try {
      // ── ① 取目标清单（嗅探器 → 消息桥 → 页面自适应）──
      const wq = await this._waitForWrongList(options.waitMs != null ? options.waitMs : 15000);
      const items = (options.limit && options.limit > 0) ? wq.questions.slice(0, options.limit) : wq.questions;
      this.total = items.length;
      this.phase = 'index';
      this._emit();

      // ── ② 按教材成立索引（同一教材只拉一次）──
      const byTm = new Map<string, any[]>();
      for (let i = 0; i < items.length; i++) {
        const tm = items[i].teachingmaterial_id || wq.teachingmaterial_id;
        if (!tm) continue; // 缺 tmId 的题走单题 CDN 降级，不阻断批次
        if (!byTm.has(tm)) byTm.set(tm, []);
        byTm.get(tm)!.push(items[i]);
      }
      let answerBytesFetched = 0;
      for (const [tmId] of byTm) {
        await this._ensureIndex(tmId, (p: any) => {
          this.phase = 'index';
          this.indexStats = Object.assign({ teachingmaterial_id: tmId }, p);
          this._emit();
        });
      }

      // ── ③ 逐题组装 ──
      this.phase = 'extract';
      this._emit();

      for (let i = 0; i < items.length; i++) {
        const w = items[i];
        const tmId = w.teachingmaterial_id || wq.teachingmaterial_id || null;
        const treatAsWrong = w.is_wrong === true;
        try {
          const idx = (tmId && this.indexCache.get(tmId)) || null;
          const q = idx ? idx.get(w.question_id) : null;

          if (q && treatAsWrong) {
            // 错题本链路：题库对象 + 题包答案 → buildDofeePayload（配图与多小问以题包 prompt 为准）
            let itemJson: any = null;
            if (options.withAnswer !== false) {
              const zipUrl = questionSource.resolveZipUrl(q);
              if (zipUrl) {
                this.phase = 'answer';
                this._emit();
                try {
                  itemJson = await this._retryAsync(() => questionSource.fetchItemJson(zipUrl), 2, 600);
                  if (itemJson && itemJson.__transfer) answerBytesFetched += itemJson.__transfer.fetched;
                } catch (e: any) {
                  this.errors.push({ question_id: w.question_id, stage: 'answer', reason: '题包答案抽取失败：' + (e?.message || String(e)) });
                }
              } else {
                this.errors.push({ question_id: w.question_id, stage: 'answer', reason: '题包地址缺失（sys_packing_result 无 cs_path）' });
              }
            }

            this.results.push(questionSource.buildDofeePayload(q, {
              error_times: w.error_times,
              times: w.times,
              problem_time: w.problem_time,
              teachingmaterial_id: tmId,
              source_url: (typeof window !== 'undefined' && window.location) ? window.location.href : null
            }, itemJson));
          } else {
            // 习题库链路 / 索引未命中：单题公开 CDN 直连
            const pack = await this._retryAsync(() => questionSource.fetchSingleQuestion(w.question_id, options.withAnswer !== false), 2, 600);
            if (!pack || (!pack.data && !pack.item)) {
              const reason = (pack && pack.errors && pack.errors.length)
                ? pack.errors.map((e: any) => e.reason || e.error || '').filter(Boolean).join('; ')
                : '题目内容获取失败（data.json 与 item.json 均不可用）';
              this.errors.push({ question_id: w.question_id, stage: 'fetch', reason });
            } else {
              const parsed = questionSource.parseSingleQuestion(
                w.question_id, pack.data, pack.details, pack.item, pack.sources, pack.errors
              );
              this.results.push(questionSource.buildDofeePayloadFromSingle(parsed, {
                teachingmaterial_id: tmId,
                source_url: (typeof window !== 'undefined' && window.location) ? window.location.href : null,
                is_wrong: treatAsWrong,
                error_times: w.error_times,
                times: w.times,
                problem_time: w.problem_time
              }));
            }
          }
        } catch (e: any) {
          this.errors.push({ question_id: w.question_id, stage: 'build', reason: e?.message || String(e) });
        }
        this.done = i + 1;
        this.phase = 'extract';
        this._emit();
        if (options.onProgress) options.onProgress(this.snapshot());
      }

      // ── ④ 汇总 ──
      this.summary = this._buildSummary(this.results, this.errors);
      this.summary.answerBytesFetched = answerBytesFetched;
      this.summary.source = this._source;
      this.phase = 'done';

      // ── ⑤ 仅在「同步错题本」开启且允许自动上传时，提取完成后自动静默上传至 dofee ──
      const cfg = await storage.ensureHydrated();
      if (options.autoUpload !== false && cfg.syncWrongBook === true && this.results.length > 0) {
        this.phase = 'upload';
        this._emit();
        const up = await this.upload({
          items: this.results,
          dryRun: false,
          silentGuard: options.silentGuard !== false
        });
        this.summary.upload = {
          ok: !!up.ok,
          inserted: up.inserted || 0,
          updated: up.updated || 0,
          skipped: up.skipped || 0,
          staged: (up as any).staged || 0,
          deduped: up.deduped || 0,
          error: up.error || '',
          implVersion: up.impl_version || '',
          staleEndpoint: !!up.stale_endpoint
        };
      }
    } catch (e: any) {
      this.phase = 'error';
      this.errors.push({ stage: e?.stage || 'run', reason: e?.message || String(e) });
    } finally {
      this.running = false;
      this.finishedAt = Date.now();
      this._emit();
    }

    return this.snapshot();
  }

  /**
   * 等待并获取目标清单。
   *
   * 三路优先级：
   *   1. 直连嗅探器（同一世界时才可能有）；
   *   2. 跨世界消息桥（扩展态主通道）；
   *   3. 页面自适应 ID（DOM 属性 / performance / 卡片属性），错题本与习题库都适用。
   *
   * 全部拿不到时**必须报清楚卡在哪一环**，不能伪装成「0 题成功」——
   * 这正是本次「成功 0 题，失败 0 题」的根因。
   */
  private async _waitForWrongList(waitMs: number): Promise<any> {
    const deadline = Date.now() + waitMs;
    this.phase = 'waiting';

    let direct = this._resolveSniffer();
    let bridgeTries = 0;

    if (!direct) {
      bridgeTries++;
      const b = await this._askBridge(this.BRIDGE_TIMEOUT);
      if (b) {
        this._bridgeLast = b;
        if (b.count > 0) { this._source = 'bridge'; return b; }
      }
    } else {
      const wq0 = direct.wrongQuestions();
      if (wq0.count > 0) { this._source = 'direct'; return wq0; }
    }

    while (Date.now() < deadline) {
      this._emit();
      await sleep(400);
      if (!direct) direct = this._resolveSniffer();
      if (direct) {
        const wq = direct.wrongQuestions();
        if (wq.count > 0) { this._source = 'direct'; return wq; }
      } else {
        bridgeTries++;
        const b = await this._askBridge(this.BRIDGE_TIMEOUT);
        if (b) {
          this._bridgeLast = b;
          if (b.count > 0) { this._source = 'bridge'; return b; }
        } else if (bridgeTries >= 3) {
          break; // 两侧连续三次无人应答，别让用户干等
        }
      }
    }

    // 关键自适应降级：嗅探接口没截获，但页面里已经有题目候选 ID
    const cand = WrongQuestionAdapter.collectExerciseIds();
    if (cand && cand.length > 0) {
      const mode = WrongQuestionAdapter.detectPageMode();
      const treatAsWrong = mode === WrongQuestionAdapter.PAGE_MODES.WRONG_BOOK;
      console.log(`[错题同步] 嗅探接口未截获，自动启用页面自适应候选清单（${cand.length} 题，模式 ${mode}）`);
      this._source = 'dom_adaptive';
      return {
        teachingmaterial_id: null,
        count: cand.length,
        questions: cand.map((c: any) => ({
          question_id: c.id,
          error_times: 1,
          is_wrong: treatAsWrong,
          seen_from: 'dom_adaptive:' + c.from
        })),
        sources: ['dom_adaptive']
      };
    }

    // 完全没接通：说清楚是哪一环断了
    const captured = direct && direct.captures ? (direct.captures.length || 0) : 0;
    const reachable = !!direct || !!this._bridgeLast;
    if (!reachable) {
      const err: any = new Error(
        '错题嗅探器未接通（本侧直连与跨世界消息桥都没有响应）。'
        + '请确认扩展已启用且未报错，然后刷新一次当前页面再重试。'
      );
      err.stage = 'load';
      throw err;
    }

    // 接通了但一直没有数据 —— 查清卡在哪一段再报错
    let earlierRequest = false;
    try {
      if (typeof performance !== 'undefined' && performance.getEntriesByType) {
        const ents = performance.getEntriesByType('resource') || [];
        for (let i = 0; i < ents.length; i++) {
          if (/user_teachingmaterials_wrong_questions/.test(String(ents[i].name))) { earlierRequest = true; break; }
        }
      }
    } catch (e) {}

    const secs = Math.round(waitMs / 1000);
    const hint = earlierRequest
      ? '检测到本页确实请求过错题接口，但发生在脚本注入之前 —— 请刷新页面，刷新后立刻点「提取」。'
      : '本页尚未发起过错题接口请求 —— 请点一下错题本的筛选、翻页或「全部错题」标签，触发列表重新加载。';
    const err: any = new Error(
      `等待 ${secs} 秒仍未捕获错题接口。${hint}`
      + `（嗅探器已接通：${direct ? 'DOM 镜像，捕获 ' + captured + ' 条响应' : '经消息桥'}；错题 0 条，页面候选 ID 0 个）`
    );
    err.stage = 'waiting';
    throw err;
  }

  private async _ensureIndex(tmId: string, onProgress?: (p: any) => void) {
    if (this.indexCache.has(tmId)) return this.indexCache.get(tmId)!;
    const r = await questionSource.buildIndex(tmId, { onProgress });
    this.indexCache.set(tmId, r.index);
    this.indexStats = { teachingmaterial_id: tmId, parts: r.parts, questions: r.total };
    return r.index;
  }

  private _buildSummary(results: any[], errors: any[]) {
    const subjects: Record<string, number> = {};
    const grades: Record<string, number> = {};
    const types: Record<string, number> = {};
    let withAnswer = 0;
    let withTextAnalysis = 0;
    let withVideoArchived = 0;
    let withKnowledge = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.subject) subjects[r.subject] = (subjects[r.subject] || 0) + 1;
      if (r.grade) grades[r.grade] = (grades[r.grade] || 0) + 1;
      if (r.question_type) types[r.question_type] = (types[r.question_type] || 0) + 1;
      if (r.has_answer) withAnswer++;
      if (r.analysis) withTextAnalysis++;
      if (r.analysis_video_url) withVideoArchived++;
      if ((r.knowledge_points || []).length || (r.knowledge_marks || []).length) withKnowledge++;
    }
    return {
      total: results.length,
      withAnswer,
      withoutAnswer: results.length - withAnswer,
      withTextAnalysis,
      withVideoArchived,
      withKnowledge,
      errors: errors.length,
      subjects,
      grades,
      questionTypes: types
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 错题识别与类型校验分流层
  // ─────────────────────────────────────────────────────────────

  /**
   * 解析试题属性标识，判断是否为错题本试题。
   * true  → 允许写入学员个人错题本；
   * false → 普通试题，严格拦截错题本上报（只进公共题库）。
   */
  isWrongBookQuestion(item: any): boolean {
    if (!item || typeof item !== 'object') return false;

    // 1. 显式否定标记与非错题通道标记
    if (item.is_wrong === false || item.is_mistake === false) return false;
    if (item.target === 'question_bank_only' || item.target === 'my_exercises' || item.channel === 'question_bank_only' || item.channel === 'my_exercises') return false;
    if (item.record_type === 'exercise' || item.category === 'exercise') return false;
    if (item.source === 'smartedu_my_questions' && !item.error_times && !item.wrong_times && !item.wrong_at) return false;

    // 2. 显式肯定标记与错题类型枚举
    if (item.is_wrong === true || item.is_mistake === true) return true;
    if (item.record_type === 'wrong_question' || item.category === 'wrong_book') return true;

    // 3. 错题特征指标
    const wrongTimes = Number(item.error_times != null ? item.error_times : (item.wrong_times != null ? item.wrong_times : 0));
    if (!isNaN(wrongTimes) && wrongTimes > 0) return true;
    if (item.wrong_at || item.error_type) return true;

    // 4. 来源与上下文路径特征
    const src = String(item.source || item.source_scope || '').toLowerCase();
    if (src === 'smartedu_wrong_book' || src === 'wrong_book') return true;
    if (src === 'smartedu_my_questions' || src === 'exercise_library' || src === 'chapter_exercise') return false;

    const url = String(item.source_url || (typeof location !== 'undefined' ? location.href : '')).toLowerCase();
    if (url.includes('mywrongquestions') || url.includes('mistake') || (url.includes('wrong') && !url.includes('myquestions'))) return true;

    // 5. 兼容未打标签的旧载荷
    if (src === 'smartedu' || (item.source_question_id && !item.source)) return true;

    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // dofee 上传
  // ─────────────────────────────────────────────────────────────

  /** 比对服务端 impl 指纹 */
  private _checkImpl(impl: any) {
    const have = (impl && Array.isArray(impl.features)) ? impl.features : [];
    const known = !!(impl && impl.version);
    const missing = REQUIRED_IMPL_FEATURES.filter((f) => have.indexOf(f) === -1);
    return {
      known,
      version: known ? String(impl.version) : '未知（旧版端点，未回传版本）',
      missing,
      stale: missing.length > 0
    };
  }

  /** 带 Bearer 的 JSON POST（统一走自动鉴权与互斥续签网关） */
  private async _postJsonAuth(url: string, body: any, token?: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    const res = await sendAuthHttpRequest('POST', url, headers, body);
    return { status: res.status, responseText: res.responseText, error: res.error };
  }

  /**
   * 把本批题目同步到 dofee（仅支持「错题本 wrong_book」与「我的习题 my_exercises」两条通道）。
   *
   * 落库效果（一次完成）：
   *   ① 入题库   —— UPSERT questions（命名空间 smartedu:<uuid>）
   *   ② 错题才入个人错题库 —— 写 exam_record_items(is_correct=0)
   *
   * @param opts.dryRun  true 只回映射结果不写库（默认 false）
   * @param opts.chunk   单块条数（默认 200）
   * @param opts.target  仅支持 'wrong_book'（默认）或 'my_exercises'
   * @param opts.force   true 时跳过本地增量去重，强制全量重传（排障 / 服务端重建用）
   * @param opts.forceRetag 错题本通道默认开启「重打标签全量重传」；显式传 false 可退回增量去重
   * @param opts.silentGuard 自动流（静默上报/后台同步）传 true：用户变更时静默拒绝不弹窗；
   *                         手动入口保持默认 false → 弹确认框，取消即零写入中止
   */
  async upload(opts: { items?: any[]; dryRun?: boolean; chunk?: number; target?: string; channel?: string; apiBase?: string; token?: string; retries?: number; force?: boolean; forceRetag?: boolean; silentGuard?: boolean } = {}) {
    const dryRun = opts.dryRun === true;
    // 仅保留「错题本」与「我的习题」同步，禁止其它通道（如公共题库 question_bank_only）
    if (opts.target === 'question_bank_only' || opts.channel === 'question_bank_only') {
      const err = '已取消公共题库同步，仅保留「错题本」和「我的习题」同步功能';
      console.log('[dofee同步] 拦截已下线通道:', opts.target || opts.channel);
      return { ok: false, skipped: true, reason: 'UNSUPPORTED_CHANNEL', error: err, errors: [] as any[] };
    }

    /** 「我的习题」独立落库通道（不进个人错题本、也不走公共题库语义） */
    const isMyExercises = opts.target === 'my_exercises' || opts.channel === 'my_exercises';
    let itemsToUpload = Array.isArray(opts.items) ? opts.items : this.results;

    if (!itemsToUpload || !itemsToUpload.length) {
      return { ok: false, skipped: true, error: '还没有可上传的题目，请先点提取或等待自动提取完成', errors: [] as any[] };
    }

    // ── 【功能可选项开关守卫】──────────────────────────────────────────────────
    const hydratedCfg = await storage.ensureHydrated();
    if (!dryRun) {
      if (isMyExercises && hydratedCfg.syncMyExercises !== true) {
        const err = '「同步我的习题」当前处于关闭状态，请在右下角监控面板开启后再同步';
        console.log('[dofee同步] 跳过：' + err);
        return { ok: false, skipped: true, reason: 'MY_EXERCISES_SYNC_DISABLED', error: err, errors: [] as any[] };
      }
      if (!isMyExercises && hydratedCfg.syncWrongBook !== true) {
        const err = '「同步错题本」当前处于关闭状态，请在右下角监控面板开启后再同步';
        console.log('[dofee同步] 跳过：' + err);
        return { ok: false, skipped: true, reason: 'WRONG_BOOK_SYNC_DISABLED', error: err, errors: [] as any[] };
      }
    }

    // ── 【横切安全件】智慧平台用户一致性守卫（覆盖所有导入入口的统一门禁）──
    // 当前智慧平台登录用户若与上次导入记录不一致：手动入口弹窗确认（含变更前后
    // 用户名 + 破坏已有记录的风险提示），取消即整批中止；自动流静默拒绝。
    // ★ 本检查必须位于任何写入（水位/记账/网络）之前——取消路径零写入。
    {
      const silentMode = opts.silentGuard === true || (opts as any).silent === true;
      const guardRes = await ensureImportUserConsistent({
        action: isMyExercises ? '「我的习题」导入 dofee' : '错题导入 dofee',
        mode: silentMode ? 'silent' : 'interactive'
      });
      if (guardRes.ok === false) {
        const errMsg = describeGuardAbort(guardRes.reason);
        console.warn('[dofee同步][用户守卫] ' + errMsg);
        return {
          ok: false, aborted: true, skipped: true,
          reason: guardRes.reason,
          error: errMsg,
          errors: [] as any[]
        };
      }
      if (guardRes.changed) {
        console.log(`[dofee同步][用户守卫] 用户变更已确认，以「${guardRes.baseline.display_name}」身份继续导入`);
      }
    }

    // 【分流】只有错题本试题才允许写个人错题本；普通试题严格拦截
    // 「我的习题」走自己的通道，不参与错题本分流判定。
    if (!isMyExercises) {
      const wrongItems = itemsToUpload.filter((it) => this.isWrongBookQuestion(it));
      const regularCount = itemsToUpload.length - wrongItems.length;
      if (regularCount > 0) {
        console.log(`[试题上报分流] 校验拦截：发现 ${regularCount} 道非错题本试题，严格拦截向错题本上报动作`);
      }
      if (wrongItems.length === 0) {
        console.log('[试题上报分流] 本批次无错题本试题，严格跳过错题本上报流程');
        return {
          ok: true, skipped: true, interceptedCount: regularCount,
          message: '所有题目均为普通试题，已严格拦截向错题本上报动作，未写入学员个人错题本',
          mapped: 0, inserted: 0, updated: 0, errors: [] as any[]
        };
      }
      itemsToUpload = wrongItems;
    }

    // ── 【增量去重 · 统一出口】──────────────────────────────────────────────
    // 【上传规则】两条通道语义不同：
    // - 错题本（wrong_book）：**重打标签语义，不做本地增量去重** —— 已上传的错题
    //   只要还在平台错题本里，每次同步都要原样重传，由 dofee 服务端 UPSERT 刷新
    //   「当前学员」标签；只有用户在平台错题本移除该题后，后续清单里不再出现，
    //   服务端标签自然失效。跳过去重是需求本体，不是 bug。
    // - 我的习题（my_exercises）：已上传的题**不再重复上传**，保持本地增量去重。
    const isWrongBookChannel = !isMyExercises;
    const retagWrong = isWrongBookChannel && opts.forceRetag !== false; // 默认开启，可显式关闭
    // 水位按用户分桶
    this._rememberSyncedKeys();
    const syncedKey = this._syncedKeyFor(
      isMyExercises ? SYNCED_EXERCISE_KEY : SYNCED_WRONG_KEY
    );
    const synced = await this._ensureSyncedSet(syncedKey);
    let deduped = 0;

    if (opts.force !== true && !retagWrong) {
      const delta: any[] = [];
      for (let i = 0; i < itemsToUpload.length; i++) {
        const qid = this._payloadQid(itemsToUpload[i]);
        // 取不到 ID 的题宁可重传也绝不丢：只过滤「确认已同步」的
        if (qid && synced.has(qid)) { deduped++; continue; }
        delta.push(itemsToUpload[i]);
      }
      itemsToUpload = delta;
    }

    if (!itemsToUpload.length) {
      const msg = `本次 ${deduped} 题均已同步过，无新增内容`;
      console.log('[dofee同步] 跳过：' + msg);
      return {
        ok: true, allSynced: true, reason: 'ALL_ALREADY_SYNCED',
        dry_run: dryRun, chunks: 0, deduped,
        mapped: 0, inserted: 0, updated: 0, skipped: 0, questions_total: 0,
        impl: null, impl_version: '', stale_endpoint: false, missing_impl: [] as string[],
        warnings: [] as string[], errors: [] as any[], preview: [] as any[],
        error: '', message: msg
      };
    }

    const config = hydratedCfg;
    const apiBase = String(opts.apiBase || config.dofeeApiBase || '').replace(/\/+$/, '');
    let token = String(opts.token || config.dofeeJwtToken || '').trim();

    if (!apiBase) {
      const err = '未配置 dofee 服务地址';
      console.log('[dofee同步] 跳过：' + err);
      return { ok: false, skipped: true, reason: 'MISSING_API_BASE', error: err, errors: [{ message: err }] };
    }
    if (!token && !config.dofeeRefreshToken) {
      const err = '未登录 dofee，待登录后再同步';
      console.log('[dofee同步] 跳过：' + err);
      return { ok: false, skipped: true, reason: 'MISSING_TOKEN', error: err, errors: [{ message: err }] };
    }

    // 【分流路由】错题本走 wrong-questions/import，我的习题走 exercises/import
    const url = apiBase
      + (isMyExercises ? '/api/v2/student/exercises/import' : '/api/v2/student/wrong-questions/import');
    const chunkSize = Number(opts.chunk) > 0 ? Number(opts.chunk) : UPLOAD_CHUNK;
    const chunks: any[][] = [];
    for (let i = 0; i < itemsToUpload.length; i += chunkSize) chunks.push(itemsToUpload.slice(i, i + chunkSize));

    const agg: any = {
      ok: true, dry_run: dryRun, chunks: chunks.length,
      mapped: 0, inserted: 0, updated: 0, skipped: 0, questions_total: 0,
      deduped, staged: 0,
      /** 服务端因「学员已消灭」而跳过、未复活进错题本的题数（v5 端点） */
      mastered_skipped: 0,
      impl: null, impl_version: '', stale_endpoint: false, missing_impl: [] as string[],
      warnings: [] as string[], errors: [] as any[], preview: [] as any[], error: ''
    };

    const maxRetries = opts.retries != null ? Number(opts.retries) : 2;

    for (let ci = 0; ci < chunks.length; ci++) {
      const payloadData: any = {
        source: isMyExercises ? 'smartedu_my_exercises' : 'smartedu',
        target: isMyExercises ? 'my_exercises' : 'wrong_book',
        dry_run: dryRun,
        // 【身份对账断言】插件声明「我认为我在为谁上传」，服务端与 JWT 身份核对，
        // 不一致直接 400。落库身份恒由服务端从 JWT 取，这里只做对账、不作为身份源。
        // 拿不到用户名（未登录/配置未水合）时省略该字段，服务端按旧版兼容放行。
        username: this._userKey() === 'anonymous' ? undefined : this._userKey(),
        // 插件侧不自行构造双树映射：由 dofee2 端管理员完成映射后再落库。
        skip_tree_mapping: true,
        tree_mapping: false,
        scan_date: this._todayKey(),
        // 批次号：服务端暂存区按它追溯「哪一次扫描产生的数据」，
        // 管理员回溯或清理时不需要靠时间戳猜
        batch_id: 'scan-' + this._todayKey() + '-' + Date.now().toString(36),
        items: chunks[ci]
      };

      // 双树映射防线：整批（含 items 递归）发送前复跑断言，并留批次级日志
      const guard = questionSource._internals.assertNoTreeMapping(payloadData, 'wrong-question-sync/chunk' + (ci + 1));
      if (!guard.clean) agg.warnings.push('双树映射闸剥离 ' + guard.stripped.length + ' 个映射字段：' + guard.stripped.join(', '));

      let res: any = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const activeToken = String(storage.getConfig().dofeeJwtToken || token || '').trim();
        res = await this._postJsonAuth(url, payloadData, activeToken);

        // 401/403 → 用 refresh token 静默续签一次再重试
        if (res.status === 401 || res.status === 403) {
          try {
            const refreshed = await uploader.tryRefreshToken();
            const t2 = String(storage.getConfig().dofeeJwtToken || '').trim();
            if (refreshed && t2) {
              token = t2;
              res = await this._postJsonAuth(url, payloadData, token);
            }
          } catch (e) {}
        }

        if (res && res.status >= 200 && res.status < 300) break;
        if (attempt < maxRetries && (!res || res.status === 0 || res.status >= 500)) {
          await sleep(800 * Math.pow(2, attempt));
        } else {
          break;
        }
      }

      let data: any = null;
      try { data = JSON.parse((res && res.responseText) || '{}'); } catch (e) { data = null; }

      if (!data || !res || res.status < 200 || res.status >= 300) {
        agg.ok = false;
        const statusText = (res && res.status) ? `HTTP ${res.status}` : '网络连接失败';
        let errMsg = (data && (data.error || data.message || data.hint)) || String((res && res.responseText) || '').slice(0, 240) || '请求失败';
        if (/no column named score/i.test(errMsg)) errMsg += '（远端 dofee 待部署最新 SQL 修复）';
        agg.error = `${statusText}：${errMsg}`;
        agg.errors.push({ chunk: ci + 1, status: res ? res.status : 0, message: agg.error });
        console.log('[dofee同步] 后台同步未完成（已记录日志）:', agg.error);
        break;
      }

      agg.mapped += Number(data.mapped || 0);
      agg.inserted += Number(data.inserted || 0);
      agg.updated += Number(data.updated || 0);
      agg.skipped += Number(data.skipped || 0);
      agg.staged += Number(data.staged || 0);
      agg.mastered_skipped += Number(data.mastered_skipped || 0);
      agg.questions_total += Number(data.questions_total || 0);
      if (data.impl && !agg.impl) agg.impl = data.impl;
      if (Array.isArray(data.errors)) agg.errors = agg.errors.concat(data.errors);
      if (Array.isArray(data.preview) && agg.preview.length < 5) agg.preview = agg.preview.concat(data.preview).slice(0, 5);
    }

    const chk = this._checkImpl(agg.impl);
    agg.impl_version = chk.version;
    agg.stale_endpoint = chk.stale;
    agg.missing_impl = chk.missing;
    // v5 之前的服务端没有「已消灭防复活」守卫：插件传了身份也只会被忽略，
    // 学员已掌握的题仍会被同步刷回错题本。这里给出明确提示，避免静默失效。
    if (chk.known && /^v[1-4]$/.test(String(agg.impl.version))) {
      agg.warnings.push(
        '线上 dofee 端点仍是 ' + agg.impl.version + '，尚未支持「已消灭错题防复活」；'
        + '学员已掌握的题仍可能被同步刷回错题本。请先部署 dofee2 v1.4.0 及以上版本。'
      );
    }
    if (chk.stale) {
      agg.warnings.push(
        '线上 dofee 端点仍是旧版（' + chk.version + '），缺少：' + chk.missing.join('、')
        + '。本次写入的题目将缺少对应修复（最典型的是题干配图不会显示）。'
        + '请先把 dofee 改动部署到 Cloudflare Pages，再重新同步。'
      );
    }

    // 出口记账：与上面的出口过滤配对，形成「过滤 → 上传 → 记账」闭环。
    // 任一 chunk 失败时 agg.ok=false，此时不记账，下次会重传该批（安全侧）。
    // 注：部分调用方（静默链路）自己也记一份，Set.add 幂等，无副作用。
    if (agg.ok && !dryRun) {
      // 只有真正落库（inserted/updated > 0）才记增量水位。
      // 若本批全部只是「暂存待映射」（staged），**不**记账 ——
      // 否则映射完成后服务端本可自行入库，插件却因水位存在而不再重传，
      // 那批题就永久丢失了。次日登录会自然带上重试。
      const landed = (Number(agg.inserted) || 0) + (Number(agg.updated) || 0);
      if (landed > 0) {
        for (let i = 0; i < itemsToUpload.length; i++) {
          const qid = this._payloadQid(itemsToUpload[i]);
          if (qid) synced.add(qid);
        }
        this._saveSyncedSet(syncedKey, synced);
      }
      if (deduped > 0) {
        console.log(`[dofee同步] 本地增量去重：跳过 ${deduped} 题（已同步），实际上传 ${itemsToUpload.length} 题`);
      }
      if (agg.staged > 0) {
        console.log(`[dofee同步] ${agg.staged} 题暂存为待映射，待 dofee2 管理员完成双树映射后入库`);
      }
      if (agg.mastered_skipped > 0) {
        console.log(`[dofee同步] ${agg.mastered_skipped} 题学员已在 dofee2 消灭，服务端已拦截，未复活进错题本`);
      }
    }

    this.lastUploadResult = agg;
    this._emit();
    return agg;
  }

  // ─────────────────────────────────────────────────────────────
  // 导出
  // ─────────────────────────────────────────────────────────────

  payload(meta: any = {}) {
    return {
      source: 'smartedu',
      batch_id: meta.batch_id || ('smartedu-' + new Date().toISOString().replace(/[:.]/g, '-')),
      imported_at: new Date().toISOString(),
      summary: this.summary,
      errors: this.errors,
      items: this.results
    };
  }

  json() {
    try { return JSON.stringify(this.payload(), null, 2); } catch (e) { return '{}'; }
  }

  async copy() {
    const text = this.json();
    try {
      if (navigator && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return { ok: true, chars: text.length };
      }
    } catch (e) { /* 降级由面板写 textarea */ }
    return { ok: false, chars: text.length, text };
  }

  // ─────────────────────────────────────────────────────────────
  // 习题库自动化提取通道
  // ─────────────────────────────────────────────────────────────

  /**
   * 自动提取习题库题目（公开 CDN 直连，支持去重缓存、增量队列与翻页排队）。
   *
   * 性能要点：
   * - 并发度 3（串行在 30 题以上就明显慢；全并发又会把 CDN 打出 429）；
   * - `exerciseCache` 保证同一题不重复请求（探针会因 DOM 变化反复触发）；
   * - 页面元数据一批只收集一次，避免每题都扫一遍 DOM。
   */
  async runExerciseExtraction(opts: { ids?: string[]; withItem?: boolean; autoUpload?: boolean; onProgress?: (snap: any) => void } = {}) {
    let ids = Array.isArray(opts.ids) ? opts.ids.slice() : [];

    if (ids.length === 0) {
      if (WrongQuestionAdapter.detectPageMode() !== WrongQuestionAdapter.PAGE_MODES.MY_EXERCISES) {
        return this.exerciseResults;
      }
      let collected = WrongQuestionAdapter.collectExerciseIds();
      try {
        const bridgeIds = await WrongQuestionAdapter.collectExerciseIdsFromBridge(350);
        if (Array.isArray(bridgeIds) && bridgeIds.length > 0) collected = collected.concat(bridgeIds);
      } catch (e) {}
      if (collected.length === 0) {
        // 纯只读兜底：不点任何按钮，只等一拍再扫（懒加载常在首帧之后）
        await sleep(400);
        collected = WrongQuestionAdapter.collectExerciseIds();
      }
      ids = Array.from(new Set(collected.map((x) => x.id)));
    }

    for (const id of ids) {
      if (id) this._queuedExerciseIds.add(String(id).toLowerCase());
    }

    if (this.exerciseRunning) return this.exerciseResults;
    this.exerciseRunning = true;
    this.exercisePhase = 'collecting';
    this._emit();

    try {
      while (this._queuedExerciseIds.size > 0) {
        const currentBatchIds = Array.from(this._queuedExerciseIds);
        this._queuedExerciseIds.clear();

        const toFetch = currentBatchIds.filter((id) => !this.exerciseCache.has(id));
        this.exerciseTotal = this.exerciseResults.length + toFetch.length;
        this.exerciseDone = this.exerciseResults.length;
        this.exercisePhase = 'fetching';
        this._emit();

        if (toFetch.length === 0) {
          this.exerciseResults = Array.from(this.exerciseCache.values());
          break;
        }

        // 全页元数据一批只收一次（知识点 / 难易度 / 更新时间 / 主讲人）
        const pageMetas: any = WrongQuestionAdapter.collectExerciseMetas();

        let cursor = 0;
        const self = this;
        const worker = async () => {
          while (cursor < toFetch.length) {
            const qid = toFetch[cursor++];
            try {
              const pack = await self._retryAsync(() => questionSource.fetchSingleQuestion(qid, opts.withItem !== false), 2, 500);
              if (pack && (pack.data || pack.item)) {
                const initialStem = (pack.data && (pack.data.title || (pack.data.content && (pack.data.content.description || pack.data.content.prompt)))) || '';
                const qMeta = (pageMetas && typeof pageMetas.findMeta === 'function')
                  ? pageMetas.findMeta(qid, initialStem, cursor - 1)
                  : ((pageMetas && typeof pageMetas.get === 'function' ? pageMetas.get(qid) : null) || null);
                const parsed = questionSource.parseSingleQuestion(qid, pack.data, pack.details, pack.item, pack.sources, pack.errors, qMeta);

                // 若仍缺知识点，用 QTI 权威解析出的 stem_text 二次级联查找
                if (pageMetas && typeof pageMetas.findMeta === 'function' && (!parsed.meta.knowledge_points || parsed.meta.knowledge_points.length === 0)) {
                  const secondMeta = pageMetas.findMeta(qid, parsed.stem_text, cursor - 1);
                  if (secondMeta) {
                    if (Array.isArray(secondMeta.knowledge_points) && secondMeta.knowledge_points.length > 0) {
                      parsed.meta.knowledge_points = Array.from(new Set((parsed.meta.knowledge_points || []).concat(secondMeta.knowledge_points)));
                    }
                    if (!parsed.meta.difficulty && secondMeta.difficulty) {
                      parsed.meta.difficulty = secondMeta.difficulty;
                      parsed.meta.difficulty_raw = secondMeta.difficulty_raw || secondMeta.difficulty;
                    }
                    if (!parsed.meta.difficulty_raw && secondMeta.difficulty_raw) parsed.meta.difficulty_raw = secondMeta.difficulty_raw;
                    if (secondMeta.update_time) parsed.meta.update_time = secondMeta.update_time;
                    if (secondMeta.teacher && !parsed.meta.teacher) parsed.meta.teacher = secondMeta.teacher;
                  }
                }

                self.exerciseCache.set(qid, parsed);
              } else {
                const reason = (pack && pack.errors && pack.errors.length)
                  ? pack.errors.map((e: any) => `${e.stage || '?'}:${e.error || e.reason || ''}`).filter(Boolean).join('; ')
                  : '题目内容获取失败（data.json 与 item.json 均未取到，可能是非题目 ID 或未上 CDN）';
                self.exerciseErrors.push({ id: qid, stage: 'fetch', reason, detail: (pack && pack.errors) || [] });
              }
            } catch (err: any) {
              self.exerciseErrors.push({ id: qid, stage: 'fetch', reason: err?.message || String(err) });
            }
            self.exerciseDone++;
            self._emit();
            if (opts.onProgress) opts.onProgress(self.snapshot());
          }
        };

        const workers: Promise<void>[] = [];
        for (let w = 0; w < Math.min(3, toFetch.length); w++) workers.push(worker());
        await Promise.all(workers);

        // 缓存中的题目若本轮发现了新元数据 → 动态补充融合
        for (let u = 0; u < currentBatchIds.length; u++) {
          const uId = currentBatchIds[u];
          const cached = this.exerciseCache.get(uId);
          if (!cached || !pageMetas) continue;
          const qMeta = (typeof pageMetas.findMeta === 'function')
            ? pageMetas.findMeta(uId, cached.stem_text, u)
            : (typeof pageMetas.get === 'function' ? pageMetas.get(uId) : null);
          if (!qMeta || !cached.meta) continue;
          if (Array.isArray(qMeta.knowledge_points) && qMeta.knowledge_points.length > 0) {
            cached.meta.knowledge_points = Array.from(new Set((cached.meta.knowledge_points || []).concat(qMeta.knowledge_points)));
          }
          if (!cached.meta.difficulty && qMeta.difficulty) {
            cached.meta.difficulty = qMeta.difficulty;
            cached.meta.difficulty_raw = qMeta.difficulty_raw || qMeta.difficulty;
          }
          if (!cached.meta.difficulty_raw && qMeta.difficulty_raw) cached.meta.difficulty_raw = qMeta.difficulty_raw;
          if (qMeta.update_time) cached.meta.update_time = qMeta.update_time;
          if (qMeta.teacher && !cached.meta.teacher) cached.meta.teacher = qMeta.teacher;
          if (qMeta.analysis_text && (!cached.analysis_text || cached.analysis_kind === 'video')) {
            cached.analysis_text = qMeta.analysis_text;
            cached.analysis_kind = 'text';
          }
        }

        this.exerciseResults = Array.from(this.exerciseCache.values());

        const cfg = await storage.ensureHydrated();
        if (opts.autoUpload !== false && cfg.syncMyExercises === true && this.exerciseResults.length > 0) {
          this.dispatchMyExercisesUploadAsync(this.exerciseResults);
        }
      }
      this.exercisePhase = 'done';
    } catch (e: any) {
      this.exercisePhase = 'error';
      this.exerciseErrors.push({ stage: 'runExercise', reason: e?.message || String(e) });
    } finally {
      this.exerciseRunning = false;
      this._emit();
    }
    return this.exerciseResults;
  }

  /** 导出习题库为指定格式文本并触发下载 */
  exportExercises(format: 'json' | 'md' | 'html') {
    if (!this.exerciseResults || !this.exerciseResults.length) return false;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(0, 14);
    let name = 'smartedu_exercises_' + stamp;
    let mime = 'application/json';
    let content = '';

    if (format === 'md') {
      name += '.md';
      mime = 'text/markdown';
      content = questionSource.buildMarkdown(this.exerciseResults);
    } else if (format === 'html') {
      name += '.html';
      mime = 'text/html';
      content = questionSource.buildHtml(this.exerciseResults);
    } else {
      name += '.json';
      content = questionSource.buildJson(this.exerciseResults);
    }

    try {
      const blob = new Blob([content], { type: mime + ';charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 1000);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 把已解析的「我的习题」同步到 dofee（仅在开启「同步我的习题」时生效） */
  async uploadExercises(opts: { exercises?: any[]; dryRun?: boolean; silentGuard?: boolean } = {}) {
    const list = Array.isArray(opts.exercises) ? opts.exercises : this.exerciseResults;
    if (!list || !list.length) return { ok: false, skipped: true, error: '暂无可同步的习题数据' };

    const dofeeItems = list.map((q: any) => {
      const p = q && q.source_question_id ? q : questionSource.buildDofeePayloadFromSingle(q);
      return Object.assign({}, p, {
        is_wrong: false,
        is_mistake: false,
        target: 'my_exercises',
        record_type: 'exercise',
        category: 'exercise'
      });
    });

    // 「我的习题」独立落库：不走公共题库语义，也不进个人错题本
    const res = await this.upload(Object.assign({}, opts, {
      dryRun: opts.dryRun === true,
      target: 'my_exercises',
      channel: 'my_exercises',
      items: dofeeItems
    }));

    // 记账统一由 upload() 出口负责（只有真正落库才记，仅暂存的不记），
    // 这里不要再自己记一份，否则会把「待映射」的题误标成已同步。
    if (!res.ok && !res.error && res.errors && res.errors.length) res.error = res.errors[0].message || '同步失败';
    return res;
  }

  // ─────────────────────────────────────────────────────────────
  // 异步非阻塞静默上传（供探针自动链路使用，绝不阻塞主流程）
  // ─────────────────────────────────────────────────────────────

  /** 错题本静默上传：仅错题本试题，受「同步错题本」开关保护 */
  dispatchSilentWrongUploadAsync(items: any[], opts: any = {}) {
    if (!items || !items.length) return;
    const wrongItems = items.filter((it) => this.isWrongBookQuestion(it));
    const regularCount = items.length - wrongItems.length;
    if (regularCount > 0) {
      console.log(`[试题上报分流] 校验拦截：发现 ${regularCount} 道非错题本试题，严格拦截向错题本上报动作`);
    }
    if (wrongItems.length === 0) {
      console.log('[异步静默上报] 本批次无错题本试题，严格跳过错题本上报');
      return;
    }
    Promise.resolve().then(async () => {
      try {
        await this._executeSilentWrongUpload(wrongItems, opts);
      } catch (err: any) {
        console.log('[异步静默上报] 异步静默上报异常已捕获降级:', err?.message || String(err));
      }
    });
  }

  private async _executeSilentWrongUpload(wrongItems: any[], opts: any = {}) {
    try {
      const cfg = await storage.ensureHydrated();
      if (cfg.syncWrongBook !== true) {
        console.log('[异步静默上报] 「同步错题本」已关闭，跳过上传');
        return { ok: false, skipped: true, reason: 'WRONG_BOOK_SYNC_DISABLED' };
      }
      const apiBase = String(opts.apiBase || cfg.dofeeApiBase || '').replace(/\/+$/, '');
      const token = String(opts.token || cfg.dofeeJwtToken || '').trim();
      if (!apiBase || !token) {
        console.log('[异步静默上报] 未配置 dofee 地址或未登录，静默跳过');
        return { ok: false, skipped: true, reason: 'MISSING_DOFEE_CREDENTIALS' };
      }

      // 【上传规则】错题本通道不做本地增量过滤：已上传的错题只要还在平台错题本里，
      // 每次同步都重传以刷新服务端「学员标签」，直到用户在平台错题本移除为止。
      // 去重只属于「我的习题」通道；这里的 wrongItems 已经过 isWrongBookQuestion 分流。
      console.log(`[异步静默上报] 启动后台非阻塞上传：${wrongItems.length} 道错题（重传刷新标签）`);
      const res = await this.upload({ items: wrongItems, dryRun: false, channel: 'wrong_book', retries: 2, apiBase, token, silentGuard: true });

      // 记账统一由 upload() 出口负责，避免待映射题被误标成已同步
      if (res && res.ok) {
        const landed = ((res as any).inserted || 0) + ((res as any).updated || 0);
        console.log(`[异步静默上报] ✅ 错题本静默上报完成：重打标签 ${wrongItems.length} 道（入库 ${landed}）`);
      } else {
        console.log('[异步静默上报] 错题本上报暂未完成（已静默记录日志）:', (res && res.error) || '未知响应');
      }
      return res;
    } catch (err: any) {
      console.log('[异步静默上报] 异常已降级容错捕获:', err?.message || String(err));
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /** 「我的习题」静默同步：受「同步我的习题」开关保护，严格禁止写学员个人错题本 */
  dispatchMyExercisesUploadAsync(exerciseItems: any[], opts: any = {}) {
    if (!exerciseItems || !exerciseItems.length) return;
    if (opts.allowOffPage !== true && WrongQuestionAdapter.detectPageMode() !== WrongQuestionAdapter.PAGE_MODES.MY_EXERCISES) {
      return;
    }

    const regularItems = exerciseItems
      .filter((it) => !this.isWrongBookQuestion(it))
      .map((it) => Object.assign({}, it, {
        is_wrong: false, is_mistake: false,
        target: 'my_exercises', record_type: 'exercise', category: 'exercise'
      }));
    if (regularItems.length === 0) return;

    Promise.resolve().then(async () => {
      try {
        const cfg = await storage.ensureHydrated();
        if (cfg.syncMyExercises !== true) {
          console.log('[我的习题静默同步] 「同步我的习题」已关闭，跳过上传');
          return;
        }
        const synced = await this._ensureSyncedSet(this._syncedKeyFor(SYNCED_EXERCISE_KEY));
        const delta = regularItems.filter((q) => q && q.id && !synced.has(String(q.id).toLowerCase()));
        if (delta.length === 0) return;

        const dofeeItems = delta.map((q) => (q && q.source_question_id) ? q : questionSource.buildDofeePayloadFromSingle(q, { target: 'my_exercises' }));
        const res = await this.upload({
          items: dofeeItems, dryRun: false, silent: true, silentGuard: true,
          target: 'my_exercises', channel: 'my_exercises'
        } as any);

        // 记账统一由 upload() 出口负责，避免待映射题被误标成已同步
        if (res && res.ok) {
          console.log(`[我的习题静默同步] ✅ 成功将 ${delta.length} 道习题同步至「我的习题」（已拦截错题本写入）`);
        }
      } catch (e: any) {
        console.log('[我的习题静默同步] 异步同步异常已捕获降级:', e?.message || String(e));
      }
    });
  }

  _autoUploadWrongSilently(wrongPayloads: any[]) {
    this.dispatchSilentWrongUploadAsync(wrongPayloads);
    return Promise.resolve({ ok: true });
  }

  /**
   * 登录后全自动后台静默同步总入口（受「同步错题本」「同步我的习题」两项开关独立控制）。
   */
  async runSilentAutoSync(opts: any = {}) {
    if (this.silentSyncRunning) return { skipped: true, reason: 'ALREADY_RUNNING' };

    const cfg = await storage.ensureHydrated();
    const scope = opts.scope || 'both';
    const wantMyExercises = scope === 'both' || scope === 'exercise' || scope === 'my_exercises';
    const wantWrongBook = scope === 'both' || scope === 'wrong' || scope === 'wrong_book';
    const allowMyExercises = wantMyExercises && cfg.syncMyExercises === true;
    const allowWrongBook = wantWrongBook && cfg.syncWrongBook === true;

    if (!allowMyExercises && !allowWrongBook) {
      return { skipped: true, reason: 'SYNC_DISABLED' };
    }

    const apiBase = String(opts.apiBase || cfg.dofeeApiBase || '').replace(/\/+$/, '');
    const token = String(opts.token || cfg.dofeeJwtToken || '').trim();
    if (!apiBase || !token) return { skipped: true, reason: 'MISSING_DOFEE_CREDENTIALS' };

    const ucAuth = opts.ucAuth || questionSource.extractUcAuthFromStorage();
    const accountKey = String((ucAuth && (ucAuth.user_id || ucAuth.access_token)) || 'anonymous').slice(0, 64);

    // 【按通道分桶的每日一次闸门】同一账号同一天每条已开启通道只跑一次；
    // 若用户当日先开启 A 通道并同步完成，稍后开启 B 通道时 B 仍会立即同步一次。
    const needMyExercises = allowMyExercises && (opts.daily === false || opts.force || !this.hasScannedToday(accountKey, 'my_exercises'));
    const needWrongBook = allowWrongBook && (opts.daily === false || opts.force || !this.hasScannedToday(accountKey, 'wrong_book'));
    if (!needMyExercises && !needWrongBook) {
      console.log(`[每日扫描] 账号 ${accountKey} 已启用的同步项今日均已扫描，跳过（次日自动重新计数）`);
      return { skipped: true, reason: 'ALREADY_SCANNED_TODAY', date: this._todayKey(), accountKey };
    }

    this.silentSyncRunning = true;
    const syncLog: any = {
      startedAt: Date.now(),
      trigger: opts.trigger || 'manual',
      exercisesChecked: 0, exercisesUploaded: 0,
      wrongChecked: 0, wrongUploaded: 0,
      errors: [] as any[]
    };
    let stage1Ok = false;
    let stage2Ok = false;

    try {
      // 阶段 1：我的习题（myQuestions，仅开启「同步我的习题」时运行）
      if (needMyExercises) {
        let stage1Errors = 0;
        try {
          let exIds: string[] = [];
          if (ucAuth && ucAuth.access_token) {
            const remoteEx = await this._retryAsync(() => questionSource.fetchExerciseLibraryIds(ucAuth, { limit: opts.limit }), 2, 600);
            exIds = remoteEx.map((x: any) => x.id);
          }
          const mode = WrongQuestionAdapter.detectPageMode();
          if (mode === WrongQuestionAdapter.PAGE_MODES.MY_EXERCISES) {
            const domEx = WrongQuestionAdapter.collectExerciseIds().map((x) => x.id);
            exIds = Array.from(new Set(exIds.concat(domEx)));
          }

          syncLog.exercisesChecked = exIds.length;
          const syncedEx = await this._ensureSyncedSet(this._syncedKeyFor(SYNCED_EXERCISE_KEY));
          const deltaExIds = opts.force ? exIds : exIds.filter((id) => !syncedEx.has(String(id).toLowerCase()));

          if (deltaExIds.length > 0) {
            const parsedExList: any[] = [];
            for (let i = 0; i < deltaExIds.length; i++) {
              const qid = deltaExIds[i];
              try {
                const pack = await this._retryAsync(() => questionSource.fetchSingleQuestion(qid, true), 2, 500);
                if (pack && (pack.data || pack.item)) {
                  const parsed = questionSource.parseSingleQuestion(qid, pack.data, pack.details, pack.item, pack.sources, pack.errors);
                  this.exerciseCache.set(qid, parsed);
                  parsedExList.push(parsed);
                }
              } catch (exFetchErr: any) {
                stage1Errors++;
                syncLog.errors.push({ type: 'exercise_fetch', id: qid, message: exFetchErr?.message || String(exFetchErr) });
              }
            }
            if (parsedExList.length > 0) {
              const upRes = await this.uploadExercises({ exercises: parsedExList, dryRun: false, silentGuard: true });
              if (upRes && upRes.ok) {
                syncLog.exercisesUploaded += (upRes.inserted || 0) + (upRes.updated || 0);
                if ((upRes as any).staged > 0) {
                  syncLog.exercisesStaged = (syncLog.exercisesStaged || 0) + (upRes as any).staged;
                }
              } else if (upRes && upRes.error) {
                stage1Errors++;
                syncLog.errors.push({ type: 'exercise_upload', message: upRes.error });
              }
            }
          }
          if (stage1Errors === 0) stage1Ok = true;
        } catch (stage1Err: any) {
          syncLog.errors.push({ type: 'exercise_stage', message: stage1Err?.message || String(stage1Err) });
        }
      }

      // 阶段 2：我的错题本（myWrongQuestions，仅开启「同步错题本」时运行）
      if (needWrongBook) {
        let stage2Errors = 0;
        try {
          const knownTmIds = Array.isArray(opts.teachingMaterialIds) ? opts.teachingMaterialIds.slice() : [];
          let tmIds = knownTmIds;
          if (ucAuth && ucAuth.access_token) {
            tmIds = await questionSource.discoverUserTeachingMaterialIds(ucAuth, knownTmIds);
          }

          const wrongMap = new Map<string, any>();
          for (let t = 0; t < tmIds.length; t++) {
            const tmId = tmIds[t];
            try {
              const wList = await questionSource.fetchWrongQuestionsByTmWithAuth(tmId, ucAuth);
              for (let k = 0; k < wList.length; k++) {
                const wItem = wList[k];
                if (!wItem || !wItem.question_id) continue;
                const qid = String(wItem.question_id).toLowerCase();
                if (!wrongMap.has(qid)) wrongMap.set(qid, Object.assign({}, wItem, { question_id: qid, teachingmaterial_id: tmId }));
              }
            } catch (tmErr: any) {
              stage2Errors++;
              syncLog.errors.push({ type: 'wrong_tm_fetch', tmId, message: tmErr?.message || String(tmErr) });
            }
          }

          // 合并嗅探器已捕获的错题
          const sniffer = this._resolveSniffer();
          if (sniffer && typeof sniffer.wrongQuestions === 'function') {
            try {
              const swq = sniffer.wrongQuestions();
              const sList = (swq && Array.isArray(swq.questions)) ? swq.questions : [];
              for (let s = 0; s < sList.length; s++) {
                const sItem = sList[s];
                if (!sItem || !sItem.question_id) continue;
                const qid = String(sItem.question_id).toLowerCase();
                if (!wrongMap.has(qid)) {
                  wrongMap.set(qid, Object.assign({}, sItem, {
                    question_id: qid,
                    teachingmaterial_id: sItem.teachingmaterial_id || swq.teachingmaterial_id || null
                  }));
                }
              }
            } catch (e) {}
          }

          const allWrong = Array.from(wrongMap.values());
          syncLog.wrongChecked = allWrong.length;
          // 【上传规则 · 错题本重打标签】不做本地增量过滤
          const deltaWrong = allWrong;

          if (deltaWrong.length > 0) {
            const wrongPayloads: any[] = [];
            for (let k = 0; k < deltaWrong.length; k++) {
              const w = deltaWrong[k];
              const tmId = w.teachingmaterial_id;
              try {
                let built: any = null;
                if (tmId) {
                  try {
                    const idx = await this._ensureIndex(tmId);
                    const q = idx ? idx.get(w.question_id) : null;
                    if (q) {
                      let itemJson: any = null;
                      const zipUrl = questionSource.resolveZipUrl(q);
                      if (zipUrl) {
                        try { itemJson = await this._retryAsync(() => questionSource.fetchItemJson(zipUrl), 2, 500); } catch (e) {}
                      }
                      built = questionSource.buildDofeePayload(q, {
                        error_times: w.error_times, times: w.times, problem_time: w.problem_time,
                        teachingmaterial_id: tmId,
                        source_url: 'https://basic.smartedu.cn/myPaper/onlineJudge/myWrongQuestions'
                      }, itemJson);
                    }
                  } catch (e) {}
                }
                if (!built) {
                  const pack = await this._retryAsync(() => questionSource.fetchSingleQuestion(w.question_id, true), 2, 500);
                  if (pack && (pack.data || pack.item)) {
                    const parsed = questionSource.parseSingleQuestion(w.question_id, pack.data, pack.details, pack.item, pack.sources, pack.errors);
                    built = questionSource.buildDofeePayloadFromSingle(parsed, {
                      teachingmaterial_id: tmId || null,
                      source_url: 'https://basic.smartedu.cn/myPaper/onlineJudge/myWrongQuestions',
                      is_wrong: true, category: 'wrong_book', record_type: 'wrong_question'
                    });
                  }
                }
                if (built) wrongPayloads.push(built);
              } catch (wErr: any) {
                stage2Errors++;
                syncLog.errors.push({ type: 'wrong_extract', id: w.question_id, message: wErr?.message || String(wErr) });
              }
            }

            if (wrongPayloads.length > 0) {
              const upWrongRes = await this.upload({
                items: wrongPayloads, dryRun: false, channel: 'wrong_book', apiBase, token, silentGuard: true
              });
              if (upWrongRes && upWrongRes.ok) {
                syncLog.wrongUploaded += (upWrongRes.inserted || 0) + (upWrongRes.updated || 0);
                if ((upWrongRes as any).staged > 0) {
                  syncLog.wrongStaged = (syncLog.wrongStaged || 0) + (upWrongRes as any).staged;
                }
              } else if (upWrongRes && upWrongRes.error) {
                stage2Errors++;
                syncLog.errors.push({ type: 'wrong_upload', message: upWrongRes.error });
              }
            }
          }
          if (stage2Errors === 0) stage2Ok = true;
        } catch (stage2Err: any) {
          syncLog.errors.push({ type: 'wrong_stage', message: stage2Err?.message || String(stage2Err) });
        }
      }
    } finally {
      syncLog.finishedAt = Date.now();
      if (opts.daily !== false) {
        if (needMyExercises && stage1Ok) this.markScannedToday(accountKey, 'my_exercises');
        if (needWrongBook && stage2Ok) this.markScannedToday(accountKey, 'wrong_book');
      }
      this.silentSyncRunning = false;
      this.lastSilentSyncLog = syncLog;
      try { localStorage.setItem('SMARTEDU_LAST_SILENT_SYNC_LOG', JSON.stringify(syncLog)); } catch (e) {}
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ SMARTEDU_LAST_SILENT_SYNC_LOG: syncLog });
        }
      } catch (e) {}
      this._emit();
    }

    return syncLog;
  }

  /**
   * 方案 C 的入口：账号登录智慧平台后自动扫描上传一次。
   *
   * 幂等保证（三重）：
   *   ① `silentSyncRunning` 实例内并发锁；
   *   ② 每日闸门（accountKey + 本地日期）；
   *   ③ 上传出口的题目级增量去重（见 upload()）。
   *
   * @param opts.force 跳过每日闸门（排障用）
   * @param opts.scope 'both'(默认) | 'wrong' | 'exercise'
   */
  async runDailyScan(opts: any = {}) {
    const scope = opts.scope || 'both';
    const log = await this.runSilentAutoSync(Object.assign({}, opts, { trigger: opts.trigger || 'daily_scan' }));
    if (log && (log as any).skipped && (log as any).reason === 'ALREADY_SCANNED_TODAY') return log;

    // 阶段 2 只在需要时跑（错题为默认链路）
    if (scope === 'exercise' && !(log as any).exercisesUploaded) {
      console.log('[每日扫描] 习题阶段无新增，结束');
    }
    return log;
  }

  reset() {
    this.results = [];
    this.errors = [];
    this.summary = null;
    this.done = 0;
    this.total = 0;
    this.phase = '';
    this.exerciseResults = [];
    this.exerciseErrors = [];
    this.exerciseDone = 0;
    this.exerciseTotal = 0;
    this.exercisePhase = '';
    this._queuedExerciseIds.clear();
    this.exerciseCache.clear();
    this._emit();
  }

  /** 清掉教材索引缓存（题库更新后调用） */
  clearIndexCache() {
    this.indexCache.clear();
    this.indexStats = null;
    this._emit();
    return '索引缓存已清空';
  }
}

export const wrongQuestionSync = new WrongQuestionSyncManager();

// 模块加载即装好消息桥监听，避免错过主世界应答
try { (wrongQuestionSync as any)._installBridge(); } catch (e) {}

if (typeof window !== 'undefined') {
  (window as any).SmartEduWrongSync = wrongQuestionSync;
  (window as any).__SMARTEDU_WRONG_SYNC__ = wrongQuestionSync;
}
