/**
 * ============================================================
 * 学习记录同步（study-record-sync）v1.13.4
 * 智慧平台 study_details（本人只读 API）→ dofee2 records/import（方案 A 专用端点）
 *
 * 【v1.13.2 根因修复（2026-10-26 实测反馈 → 探针取证）】
 * 现象：学员确实学完 2 门课程，同步却报「平台学习记录为空（total=0）」。
 * 取证：同账号、同端点，页面探针 v2 拿 `total=8`（含 national_lesson「电荷」），插件拿 0——
 *   → 唯一差异是请求头 `sdp-biz-type`：探针用 **'ykt'**（与 question-source.ts:1436 同，已验证通道），
 *     本模块误用了错题域的 **'myQuestions'**（question-source.ts:1504 错题/教材发现冗余场景的值），
 *     平台按业务域过滤数据 → 通用学习明细被过滤成空集，**HTTP 200 + total=0**，看似「成功」实为错域空集。
 * 修复：①默认 biz-type 改 'ykt'；②新增双业务域自适应协商（ykt→myQuestions，各试「带 page/limit」与「无参」两种形态），
 *      首个有数据者胜出并把「用了哪个组合」写进报告，杜绝下次再次盲信单一取值；
 *      ③【完成态语义，2026-10-27 抓包实证修订，覆盖 10-26 的旧推断】
 *         - `ext_info.resource_progress` = **子资源级观看状态**：`1`=观看中，`2`=**该子资源已看完**
 *           （实证：01:11 写 {子A:1} → 01:24 写 {子A:2}，与 60 秒一次的位置心跳同步推进）
 *         - **父级 progress/status 由客户端自己写**（实测 `POST /v1/study_details` body 直接带 status），
 *           **并非服务端侧按阈值换算**；是否写 2 取决于客户端是否判「资源内全部子资源都看完」；
 *         - GET 响应**不含 `resource_count`**（总数只在请求侧重见过），所以**只读 GET 无法判定父级完成**
 *           ← 这正是 10-26 那次「5 条 resource_progress=2 但顶层 0/1」的根因：那些是多子资源，
 *           只看完其中之一。故：完成态仍只认顶层 `progress>=100 || status===2`，
 *           **严禁**用 resource_progress 派生；更严禁反过来把它当成「平台漏判」。
 *      ④ 由此也解释了观感差异：「上次看到」= progress 触达；「未完成」= 该包/该课时尚有子资源未看完。
 * ============================================================
 *
 * 依据 docs/learning-record-sync-implementation-spec.md（及 v1.14.1 自动同步升级）：
 *  - 支持轻量级自动静默同步（页面加载 + 登录变更触发 autoSync，走 silent 守卫）与面板手动触发（dry_run 预览 → 正式同步 → 完成报告）；
 *  - 增量为主（客户端游标 smartedu_study_sync_cursor，整批成功才推进）+ full_reconcile 全量对账；
 *  - 合并语义单调（服务端铁律：completed 不可逆 / watched_seconds MAX / completed_at 保首个）；
 *  - 幂等双保险：批内 (tm_id, resource_id) 去重 + 服务端 batch_id 重放；
 *  - 失败重试：每块 3 次、800ms×2ⁿ 退避（封顶 ~6s）；401/403 走 sendAuthHttpRequest
 *    自动续签自愈；仍失败进离线队列，下次同步自动冲刷；
 *  - 全部导入入口过 import-user-guard（手动入口为 interactive 模式，autoSync 为 silent 模式）。
 *
 * 成绩域不落库（拍板①）；秒级时长不在本链路（归 PC 心跳）。
 */

import { questionSource } from '../core/question-source';
import { storage } from '../core/storage';
import { catalogSync } from './catalog-sync';
import { sendHttpRequest, sendAuthHttpRequest } from '../core/request';
import { ensureImportUserConsistent, describeGuardAbort, readSmarteduIdentity } from '../core/import-user-guard';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 智慧平台学习记录端点（P0 实测：本人 UC token + MAC 签名，分页 limit=50 生效） */
const PLATFORM_STUDY_DETAILS = 'https://x-study-record-api.ykt.eduyun.cn/v1/study_details';
/** 智慧平台播放位置端点（实证真路径：/{sub_resource_id}/{user_id}，双段路径穿透 WAF） */
const PLATFORM_LEARNING_POSITIONS = 'https://x-study-record-api.ykt.eduyun.cn/v1/resource_learning_positions';
/** dofee2 方案 A 专用导入端点（v1.7.0+ / 迁移 0030） */
const IMPORT_PATH = '/api/v2/student/external-study/records/import';

const PAGE_LIMIT = 50;
/** 业务域取值（实验证顺序）：'ykt' 为已实证可返回本人全部学习明细的通用域；'myQuestions' 为错题域兜底 */
const STUDY_BIZ_TYPES = ['ykt', 'myQuestions'];
/**
 * dofee 侧同步的是「课时」粒度，这两类必须过滤（2026-10-26 探针实测确认）：
 *  - teachingmaterials：教材入口浏览（P0 既定跳过）；
 *  - assets_document：打开教科书 PDF（实测生成 0 秒记录、resource_progress=1），
 *    混进 dofee 会变成「永远 0% 的假课时」。
 * 其余（national_lesson / elite_lesson / knowledge_micro_lesson 等）一律视为课时。
 */
const NON_LESSON_RESOURCE_TYPES = new Set(['teachingmaterials', 'assets_document']);
const MAX_PAGES = 40; // 40×50=2000 条上限保护（实测全量 130 条量级）
const UPLOAD_CHUNK = 200;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 800;

const CURSOR_KEY = 'smartedu_study_sync_cursor';
const QUEUE_KEY = 'smartedu_study_sync_offline_queue';

export interface StudySyncCursor {
  max_platform_updated_at: string;
  last_batch_id: string;
  last_synced_at: string;
  first_full_done: boolean;
}

export interface StudySyncReport {
  ok: boolean;
  phase: 'health' | 'dry_run' | 'sync' | 'flush';
  batch_id: string;
  started_at: string;
  finished_at: string;
  mode: string;
  first_full: boolean;
  fetched_total: number;
  parsed_ok: number;
  sent: number;
  upserted: number;
  unchanged: number;
  completed_flipped: number;
  skipped: Array<{ resource_id: string; tm_id?: string; reason: string }>;
  errors: any[];
  warnings: string[];
  side_effects: any;
  summary: any;
  cursor_advanced: boolean;
  offline_queued: number;
  replayed: boolean;
  error: string;
}

export interface HealthCheckResult {
  ok: boolean;
  smartedu_login: boolean;
  dofee_login: boolean;
  platform_reachable: boolean;
  platform_total: number | null;
  /** 体检实际查询的智慧平台身份（v1.13.1 新增：total=0 时用于肉眼核对「查的是谁」） */
  platform_identity: { user_id: string; display_name: string } | null;
  /** 业务域协商结果（v1.13.2 新增：sdp-biz-type 错会返回 200 空集，必须把「用的哪个域」摆到台面上） */
  access: { biz_type: string; url_shape: string; tried: string[] } | null;
  endpoint_ready: boolean;
  problems: string[];
}

function todayKey(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function newBatchId(): string {
  return 'scan-' + todayKey() + '-' + Date.now().toString(36);
}

function emptyReport(phase: StudySyncReport['phase'], batchId: string, startedAt: string): StudySyncReport {
  return {
    ok: false,
    phase,
    batch_id: batchId,
    started_at: startedAt,
    finished_at: '',
    mode: 'incremental',
    first_full: false,
    fetched_total: 0,
    parsed_ok: 0,
    sent: 0,
    upserted: 0,
    unchanged: 0,
    completed_flipped: 0,
    skipped: [],
    errors: [],
    warnings: [],
    side_effects: {},
    summary: {},
    cursor_advanced: false,
    offline_queued: 0,
    replayed: false,
    error: '',
  };
}

class StudyRecordSync {
  private _inflight = false;
  /** 最近一次自动同步触发时间戳（30秒冷却窗） */
  private _lastAutoSyncAt = 0;
  /** 本次会话协商出的业务域（v1.13.2：默认 'ykt'，探测失败回落到错题域再协商） */
  private _accessBizType: string = STUDY_BIZ_TYPES[0];
  private _accessWithParams: boolean = true;
  lastReport: StudySyncReport | null = null;

  /** 单例锁：连点同步时第二次直接挡掉（沿用错题同步模式） */
  isBusy(): boolean {
    return this._inflight;
  }

  // ────────────────────────────────────────────────
  // 存储：游标 + 离线队列（按 dofee2 账号分桶隔离）
  // ────────────────────────────────────────────────

  private _cursorKey(username?: string): string {
    const u = username || storage.getConfig().dofeeUsername || 'default';
    return `${CURSOR_KEY}:${u}`;
  }

  private _queueKey(username?: string): string {
    const u = username || storage.getConfig().dofeeUsername || 'default';
    return `${QUEUE_KEY}:${u}`;
  }

  async getCursor(username?: string): Promise<StudySyncCursor | null> {
    const key = this._cursorKey(username);
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return await new Promise((resolve) => {
          chrome.storage.local.get([key, CURSOR_KEY], (res: any) => {
            resolve(res?.[key] || res?.[CURSOR_KEY] || null);
          });
        });
      }
    } catch (e) {}
    return null;
  }

  private async _setCursor(cursor: StudySyncCursor, username?: string): Promise<void> {
    const key = this._cursorKey(username);
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await new Promise<void>((resolve) => {
          chrome.storage.local.set({ [key]: cursor }, () => resolve());
        });
      }
    } catch (e) {}
  }

  async getOfflineQueue(username?: string): Promise<any[]> {
    const key = this._queueKey(username);
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const res: any = await new Promise((resolve) => {
          chrome.storage.local.get([key, QUEUE_KEY], (r: any) => resolve(r));
        });
        return Array.isArray(res?.[key]) ? res[key] : (Array.isArray(res?.[QUEUE_KEY]) ? res[QUEUE_KEY] : []);
      }
    } catch (e) {}
    return [];
  }

  private async _setOfflineQueue(queue: any[], username?: string): Promise<void> {
    const key = this._queueKey(username);
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await new Promise<void>((resolve) => {
          chrome.storage.local.set({ [key]: queue }, () => resolve());
        });
      }
    } catch (e) {}
  }

  // ────────────────────────────────────────────────
  // 步骤 1：一键体检
  // ────────────────────────────────────────────────

  async healthCheck(): Promise<HealthCheckResult> {
    const problems: string[] = [];

    const ucAuth = questionSource.extractUcAuthFromStorage();
    const smarteduLogin = Boolean(ucAuth && ucAuth.access_token);
    if (!smarteduLogin) problems.push('未检测到智慧平台登录态（ND_UC_AUTH），请先登录 basic.smartedu.cn');

    const config = await storage.ensureHydrated();
    const dofeeLogin = Boolean(config.dofeeJwtToken || config.dofeeRefreshToken);
    if (!dofeeLogin) problems.push('未登录 dofee，请先在面板登录后再同步');

    // 探针（v1.13.2 起为业务域协商）区分「未登录 401 / 错域空集 total=0 / 通」
    let platformReachable = false;
    let platformTotal: number | null = null;
    let platformAccess: HealthCheckResult['access'] = null;
    let platformIdentity: { user_id: string; display_name: string } | null = null;
    if (smarteduLogin) {
      const identity = readSmarteduIdentity();
      platformIdentity = identity
        ? { user_id: String(identity.user_id || '').trim(), display_name: String(identity.display_name || '').trim() }
        : null;
      const who = platformIdentity
        ? `${platformIdentity.display_name || '（无展示名）'}（ID: ${platformIdentity.user_id || '未知'}）`
        : '（身份解析失败）';

      // v1.13.2：业务域协商取代单次探针——错域会返回 200 空集，必须逐个试并留痕
      const access = await this._negotiateAccess();
      this._accessBizType = access.bizType;
      this._accessWithParams = access.withParams;
      platformAccess = {
        biz_type: access.bizType,
        url_shape: access.withParams ? 'page/limit' : '无参',
        tried: access.tried,
      };

      if (access.ok) {
        platformReachable = true;
        platformTotal = access.total ?? null;
      } else {
        platformTotal = 0;
        problems.push(
          `平台学习记录为空或不可达（查询身份 ${who}）。已试业务域组合：${access.tried.join('、')}。` +
          `若确认同账号已学习，请在 basic.smartedu.cn Console 跑 docs/p0-probe/study-record-probe-v2.js 复核原始返回`
        );
      }
    }

    // dofee2 端点就绪探测（旧版 dofee2 无该端点时明确报「请更新 dofee2」，不静默失败）
    let endpointReady = false;
    if (dofeeLogin) {
      const base = String(config.dofeeApiBase || '').trim().replace(/\/+$/, '');
      if (base) {
        const res = await sendAuthHttpRequest('POST', base + IMPORT_PATH, { 'Content-Type': 'application/json' }, { batch_id: 'probe-' + Date.now().toString(36), items: [] });
        // 端点存在时：400 EMPTY_ITEMS；404 = 未部署；401 = token 问题但端点在
        endpointReady = res.status !== 404 && res.status !== 0;
        if (res.status === 404) {
          problems.push('dofee2 尚未部署学习记录导入端点（404），请先部署 dofee2 v1.7.0+（迁移 0030）');
        }
      } else {
        problems.push('未配置 dofee API 地址');
      }
    }

    return {
      ok: problems.length === 0,
      smartedu_login: smarteduLogin,
      dofee_login: dofeeLogin,
      platform_reachable: platformReachable,
      platform_total: platformTotal,
      platform_identity: platformIdentity,
      access: platformAccess,
      endpoint_ready: endpointReady,
      problems,
    };
  }

  // ────────────────────────────────────────────────
  // 平台侧：分页拉取 + ext_info 解析
  // ────────────────────────────────────────────────

  /**
   * 智慧平台通用 GET 请求（标准 UC MAC 签名，SW 通道免 CORS）
   */
  private async _getPlatformApi(url: string, bizType: string): Promise<{ ok: boolean; status: number; data: any }> {
    const ucAuth = questionSource.extractUcAuthFromStorage();
    if (!ucAuth || !ucAuth.access_token) return { ok: false, status: 401, data: null };

    const macHeader = await questionSource.buildUcMacAuthHeader('GET', url, ucAuth);
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Authorization': macHeader || '',
      'sdp-app-id': ucAuth.sdp_app_id || questionSource.DEFAULT_SDP_APP_ID,
      'sdp-biz-type': bizType,
    };
    try {
      const res = await sendHttpRequest('GET', url, headers);
      if (!res.ok || res.status < 200 || res.status >= 300) {
        return { ok: false, status: res.status, data: null };
      }
      const data = JSON.parse(res.responseText || '{}');
      return { ok: true, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: null };
    }
  }

  /**
   * 方案 A 专用：为单个子资源拉取平台记录的真实播放秒数
   * 端点：GET https://x-study-record-api.ykt.eduyun.cn/v1/resource_learning_positions/{subResourceId}/{userId}
   * （实证：两段式真路径穿透 WAF，返回 {"position": number}）
   */
  private async _fetchLearningPosition(subResourceId: string): Promise<number | null> {
    const ucAuth = questionSource.extractUcAuthFromStorage();
    const userId = String(ucAuth?.user_id || '').trim();
    if (!subResourceId || !userId) return null;

    const url = `${PLATFORM_LEARNING_POSITIONS}/${encodeURIComponent(subResourceId)}/${encodeURIComponent(userId)}`;
    const r = await this._getPlatformApi(url, this._accessBizType);
    if (r.ok && r.data && typeof r.data.position === 'number') {
      return Math.max(0, Math.round(r.data.position));
    }
    return null;
  }

  /**
   * 方案 A 专用：并发富化待同步条目的真实播放秒数（受控并发 3，单条容错降级）
   */
  private async _enrichPositions(items: any[]): Promise<{ enrichedCount: number; maxSec: number }> {
    const targets = items.filter((x) => x && x.sub_resource_id);
    if (targets.length === 0) return { enrichedCount: 0, maxSec: 0 };

    let enrichedCount = 0;
    let maxSec = 0;
    const concurrency = 3;
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const item = targets[idx++];
        try {
          const pos = await this._fetchLearningPosition(item.sub_resource_id);
          if (typeof pos === 'number' && pos >= 0) {
            item.watched_seconds = pos;
            enrichedCount++;
            if (pos > maxSec) maxSec = pos;
          }
        } catch (e) {
          // 降级保持 watched_seconds 默认值
        }
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker());
    await Promise.all(workers);
    return { enrichedCount, maxSec };
  }

  /**
   * study_details 单次 GET（读完 specifics）。
   * @param url 完整 URL（带或不带 page/limit）
   * @param bizType sdp-biz-type 取值（'ykt' 实证通用域；'myQuestions' 为错题域兜底）
   */
  private async _getStudyDetails(url: string, bizType: string): Promise<{ ok: boolean; status: number; total: number | null; items: any[] }> {
    const r = await this._getPlatformApi(url, bizType);
    if (!r.ok || !r.data) return { ok: false, status: r.status, total: null, items: [] };
    const items = Array.isArray(r.data.items) ? r.data.items : [];
    const total = typeof r.data.total === 'number' ? r.data.total : null;
    return { ok: true, status: r.status, total, items };
  }

  /**
   * 业务域自适应协商（v1.13.2）：错域查询会返回 HTTP 200 + total=0 的「看似成功」空集，
   * 单一取值盲信极易再次踩坑，因此按 业务域 × URL 形态 逐一试探，首个有数据者胜出，
   * 并把胜出组合写进报告供事后复核。
   */
  private async _negotiateAccess(): Promise<{
    ok: boolean;
    bizType: string;
    withParams: boolean;
    total: number | null;
    tried: string[];
    status: number;
  }> {
    const tried: string[] = [];
    let lastStatus = 0;
    for (const bizType of STUDY_BIZ_TYPES) {
      for (const withParams of [true, false]) {
        const url = withParams ? `${PLATFORM_STUDY_DETAILS}?page=1&limit=${PAGE_LIMIT}` : PLATFORM_STUDY_DETAILS;
        const r = await this._getStudyDetails(url, bizType);
        tried.push(`${bizType}${withParams ? '+page/limit' : '+无参'}(${r.ok ? `total=${r.total ?? '?'}` : `status=${r.status}`})`);
        if (r.ok && ((typeof r.total === 'number' ? r.total : 0) > 0 || r.items.length > 0)) {
          return { ok: true, bizType, withParams, total: r.total, tried, status: r.status };
        }
        if (r.status) lastStatus = r.status;
      }
    }
    return { ok: false, bizType: STUDY_BIZ_TYPES[0], withParams: true, total: 0, tried, status: lastStatus };
  }

  private async _fetchStudyDetailsPage(page: number, limit: number): Promise<{ ok: boolean; status: number; total: number | null; items: any[] }> {
    const url = this._accessWithParams === false
      ? PLATFORM_STUDY_DETAILS
      : `${PLATFORM_STUDY_DETAILS}?page=${encodeURIComponent(String(page))}&limit=${encodeURIComponent(String(limit))}`;
    return this._getStudyDetails(url, this._accessBizType);
  }

  /**
   * 逐页取满全量（实测 130 条量级，limit=50 生效；不依赖服务端时间过滤参数——
   * 增量判定放客户端游标）。
   */
  async fetchAllRecords(): Promise<{ ok: boolean; total: number; items: any[]; error: string }> {
    const all: any[] = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await this._fetchStudyDetailsPage(page, PAGE_LIMIT);
      if (!r.ok) {
        return {
          ok: false,
          total,
          items: all,
          error: page === 1
            ? `平台接口拉取失败（status=${r.status}）`
            : `第 ${page} 页拉取失败（status=${r.status}），已取 ${all.length} 条`,
        };
      }
      total = typeof r.total === 'number' ? r.total : all.length + r.items.length;
      all.push(...r.items);
      if (r.items.length === 0) break;
      if (all.length >= total) break;
      if (r.items.length < PAGE_LIMIT) break;
    }
    return { ok: true, total, items: all, error: '' };
  }

  /**
   * ext_info 是 JSON 字符串须二次 parse；白名单提取，未知字段忽略（协议演进不炸）。
   * 返回 dofee2 导入契约 items + 本地过滤的 skipped。
   */
  parseRecords(rawItems: any[]): {
    items: any[];
    skipped: Array<{ resource_id: string; tm_id?: string; reason: string }>;
    warnings: string[];
  } {
    const items: any[] = [];
    const skipped: Array<{ resource_id: string; tm_id?: string; reason: string }> = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    const typeCounter: Record<string, number> = {};

    for (const raw of rawItems || []) {
      const it = raw || {};
      const resourceId = String(it.resource_id || '').trim();
      const resourceName = String(it.resource_name || '').trim();

      // 本地过滤：非课时记录（教材入口浏览 / 教科书 PDF），2026-10-26 实测这两类只会污染 dofee 课时表
      const resourceType = String(it.resource_type || '').trim().toLowerCase();
      typeCounter[resourceType || '(空)'] = (typeCounter[resourceType || '(空)'] || 0) + 1;
      if (NON_LESSON_RESOURCE_TYPES.has(resourceType)) {
        skipped.push({ resource_id: resourceId, reason: 'non_lesson_resource' });
        continue;
      }

      // ext_info 二次解析（白名单字段）
      let ext: any = it.ext_info;
      if (typeof ext === 'string') {
        try { ext = JSON.parse(ext); } catch (e) { ext = null; }
      }
      const addParams = (ext && typeof ext.additional_params === 'object' && ext.additional_params) || {};
      const tmId = String(addParams.teachingmaterial_id || ext?.teachingmaterial_id || '').trim();
      const chapterId = String(addParams.chapter_id || ext?.chapter?.tree_id || '').trim();

      // 提取底层子资源 ID（activity_last_learning_resource 优先，last_learning_activity 兜底）
      let subResourceId = '';
      if (ext && typeof ext.activity_last_learning_resource === 'object' && ext.activity_last_learning_resource) {
        const vals = Object.values(ext.activity_last_learning_resource);
        if (vals.length > 0 && typeof vals[0] === 'string') {
          subResourceId = String(vals[0]).trim();
        }
      }
      if (!subResourceId && ext && typeof ext.last_learning_activity === 'object' && ext.last_learning_activity) {
        subResourceId = String(ext.last_learning_activity.activity_id || '').trim();
      }

      if (!resourceId) {
        skipped.push({ resource_id: '', tm_id: tmId, reason: 'missing_resource_id' });
        continue;
      }
      if (!tmId) {
        skipped.push({ resource_id: resourceId, reason: 'missing_tm_id' });
        continue;
      }

      const dedupeKey = tmId + '||' + resourceId;
      if (seen.has(dedupeKey)) {
        skipped.push({ resource_id: resourceId, tm_id: tmId, reason: 'duplicate_in_batch' });
        continue;
      }
      seen.add(dedupeKey);

      // 【完成态判定 · 方案 A】
      // 1. 顶层 status === 2 或 progress >= 100 属官方完成态；
      // 2. 实证：微课包内只要有子资源在移动端完播，resource_progress 对应子资源即翻 2
      //    （实测链接一 1061 秒完播，resource_progress=2，但顶层卡在 1/0）；
      //    因此将「子资源完播 (rp=2)」提升为该课时的已完成态，杜绝平台顶层漏判导致的长期未核销。
      const rawStatusNum = Number(it.status);
      let mappedStatus = Number.isFinite(rawStatusNum) && rawStatusNum >= 2 ? 2 : 1;
      const resProg = (ext && typeof ext.resource_progress === 'object' && ext.resource_progress) || {};
      let isSubCompleted = false;
      if (subResourceId && Number(resProg[subResourceId]) === 2) {
        isSubCompleted = true;
      } else if (Object.values(resProg).some((v) => Number(v) === 2)) {
        isSubCompleted = true;
      }

      if (Number(it.progress) >= 100 || mappedStatus >= 2 || isSubCompleted) {
        mappedStatus = 2;
      }

      if (Number.isFinite(rawStatusNum) && rawStatusNum !== 1 && rawStatusNum !== 2) {
        warnings.push(`status 语义兜底：${resourceId} 的 status=${it.status} 非 1/2（按 >=2 completed 处理）`);
      }

      items.push({
        resource_id: resourceId,
        tm_id: tmId,
        chapter_id: chapterId,
        sub_resource_id: subResourceId,
        resource_name: resourceName,
        progress: Number(it.progress) || 0,
        status: mappedStatus,
        watched_seconds: 0,
        platform_created_at: String(it.create_time || '').trim(),
        platform_updated_at: String(it.update_time || '').trim(),
      });
    }
    if (Object.keys(typeCounter).length > 0) {
      warnings.push(
        `本批资源类型分布：${Object.entries(typeCounter).map(([k, v]) => `${k}×${v}`).join('、')}` +
        `（已过滤 teachingmaterials / assets_document，其余按课时处理）`
      );
    }
    return { items, skipped, warnings };
  }

  /** 客户端增量过滤：只送 platform_updated_at > 游标 的条目（首跑游标为空=全量） */
  private _filterIncremental(items: any[], cursor: StudySyncCursor | null): { items: any[]; firstFull: boolean } {
    if (!cursor || !cursor.max_platform_updated_at) {
      return { items, firstFull: true };
    }
    const cut = cursor.max_platform_updated_at;
    return {
      items: items.filter((x) => String(x.platform_updated_at || '') > cut),
      firstFull: false,
    };
  }

  // ────────────────────────────────────────────────
  // dofee2 侧：分块上传（dry_run / 正式）+ 重试 + 离线队列
  // ────────────────────────────────────────────────

  private async _postChunk(url: string, payload: any): Promise<{ status: number; data: any; error: string }> {
    // sendAuthHttpRequest：自动注入 Bearer + 401/403 无感续签自愈（spec 4.1 重试策略的自愈通道）
    const res = await sendAuthHttpRequest('POST', url, { 'Content-Type': 'application/json' }, payload);
    let data: any = null;
    try { data = JSON.parse(res.responseText || '{}'); } catch (e) { data = null; }
    return { status: res.status, data, error: res.error || '' };
  }

  private async _uploadChunks(opts: {
    url: string;
    batchId: string;
    chunks: any[][];
    dryRun: boolean;
    syncMode: string;
    fetchedAt: string;
  }): Promise<{
    ok: boolean;
    upserted: number;
    unchanged: number;
    completed_flipped: number;
    skipped: any[];
    errors: any[];
    warnings: string[];
    side_effects: any;
    summary: any;
    replayed: boolean;
    failedChunks: any[][];
    error: string;
  }> {
    const agg = {
      ok: true,
      upserted: 0,
      unchanged: 0,
      completed_flipped: 0,
      skipped: [] as any[],
      errors: [] as any[],
      warnings: [] as string[],
      side_effects: { plan_synced: 0, recitation_triggered: 0, textbook_not_assigned: 0, task_reordered: 0 } as any,
      summary: { textbooks_affected: 0, completed_total: 0 } as any,
      replayed: false,
      failedChunks: [] as any[][],
      error: '',
    };

    for (let ci = 0; ci < opts.chunks.length; ci++) {
      const payload = {
        batch_id: opts.batchId,
        dry_run: opts.dryRun,
        source: 'platform_study_details',
        sync_mode: opts.syncMode,
        fetched_at: opts.fetchedAt,
        items: opts.chunks[ci],
      };

      let res: { status: number; data: any; error: string } | null = null;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        res = await this._postChunk(opts.url, payload);
        if (res.status >= 200 && res.status < 300) break;
        // 4xx（除 429）不重试：契约/载荷问题重试也没用；0（网络）/5xx/429 指数退避
        const retryable = res.status === 0 || res.status >= 500 || res.status === 429;
        if (!retryable) break;
        if (attempt < MAX_RETRIES - 1) {
          await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
        }
      }

      const data = res?.data || null;
      if (!res || res.status < 200 || res.status >= 300) {
        agg.ok = false;
        const statusText = res?.status ? `HTTP ${res.status}` : '网络连接失败';
        let errMsg = (data && (data.error || data.message)) || res?.error || '请求失败';
        if (res?.status === 404) errMsg = 'dofee2 尚未部署学习记录导入端点（404），请先部署 dofee2 v1.7.0+';
        agg.error = `${statusText}：${errMsg}`;
        agg.errors.push({ chunk: ci + 1, status: res?.status || 0, message: agg.error });
        agg.failedChunks.push(opts.chunks[ci]);
        continue;
      }

      if (data?.replayed) agg.replayed = true;
      agg.upserted += Number(data.upserted || 0);
      agg.unchanged += Number(data.unchanged || 0);
      agg.completed_flipped += Number(data.completed_flipped || 0);
      if (Array.isArray(data.skipped)) agg.skipped = agg.skipped.concat(data.skipped);
      if (Array.isArray(data.errors)) agg.errors = agg.errors.concat(data.errors);
      if (Array.isArray(data.warnings)) agg.warnings = agg.warnings.concat(data.warnings);
      if (data.side_effects) {
        for (const k of Object.keys(agg.side_effects)) {
          agg.side_effects[k] += Number(data.side_effects[k] || 0);
        }
      }
      if (data.summary) {
        agg.summary.textbooks_affected = Math.max(agg.summary.textbooks_affected, Number(data.summary.textbooks_affected || 0));
        agg.summary.completed_total = Math.max(agg.summary.completed_total, Number(data.summary.completed_total || 0));
      }
    }

    return agg;
  }

  // ────────────────────────────────────────────────
  // 主流程：dry_run 预览 / 正式同步 / 离线队列冲刷
  // ────────────────────────────────────────────────

  /**
   * 轻量级自动同步入口（仅在页面加载/用户登录时静默调用）
   * 1. 30秒冷却窗拦截连续刷新；
   * 2. isBusy 单例并发互斥；
   * 3. 双端凭证前置静默检查（任一缺失直接 return，零弹窗零打扰）；
   * 4. 走 guardMode='silent'，发生用户冲突或未登录静默拒绝。
   */
  async autoSync(trigger: 'page_init' | 'login'): Promise<void> {
    if (this.isBusy()) return;
    const now = Date.now();
    if (now - this._lastAutoSyncAt < 30_000) return;

    // 前置静默检查：必须双端凭证齐备才启动自动同步
    const ucAuth = questionSource.extractUcAuthFromStorage();
    if (!ucAuth || !ucAuth.access_token) return;
    const cfg = await storage.ensureHydrated();
    if (!cfg || !cfg.dofeeJwtToken) return;

    this._lastAutoSyncAt = now;
    try {
      console.log(`[AutoSync] 触发轻量级自动学习记录同步 (来源: ${trigger})...`);
      const res = await this.runSync({
        syncMode: 'incremental',
        dryRun: false,
        guardMode: 'silent',
      });
      if (res.ok) {
        console.log(`[AutoSync] 自动学习记录同步完成: 写入 ${res.upserted} 条, 完播翻转 ${res.completed_flipped} 条`);
      } else if (res.error) {
        console.log(`[AutoSync] 自动学习记录同步跳过/未执行: ${res.error}`);
      }
    } catch (e) {
      console.warn('[AutoSync] 自动学习记录同步异常已安全捕获:', e);
    }
  }

  /**
   * 主入口（手动触发或自动调用，四步状态机的 2-4 步）。
   * @param opts.dryRun true=预览不写库
   * @param opts.syncMode incremental | full_reconcile | overwrite（overwrite 需 confirmOverwrite）
   * @param opts.overwriteConfirm 输入 'OVERWRITE' 才解锁覆盖（危险操作协议，spec 5.2）
   * @param opts.guardMode interactive=弹窗确认（默认）；silent=自动流静默拒绝不弹窗
   */
  async runSync(opts: {
    dryRun?: boolean;
    syncMode?: 'incremental' | 'full_reconcile' | 'overwrite';
    overwriteConfirm?: string;
    scopeTmId?: string;
    guardMode?: 'interactive' | 'silent';
  } = {}): Promise<StudySyncReport> {
    const startedAt = new Date().toISOString();
    const batchId = newBatchId();
    const report = emptyReport(opts.dryRun ? 'dry_run' : 'sync', batchId, startedAt);
    const dryRun = opts.dryRun === true;
    const syncMode = opts.syncMode || 'incremental';
    report.mode = syncMode;

    if (this._inflight) {
      report.error = '已有同步任务进行中，请等待完成后再发起';
      report.finished_at = new Date().toISOString();
      this.lastReport = report;
      return report;
    }
    this._inflight = true;

    try {
      // ── 横切安全件：dry_run 与正式同步均过用户一致性守卫（spec 4.5）──
      const guardRes = await ensureImportUserConsistent({
        action: dryRun ? '学习记录 dry_run 预览' : '学习记录同步导入 dofee',
        mode: opts.guardMode || 'interactive',
      });
      if (guardRes.ok === false) {
        report.error = describeGuardAbort(guardRes.reason) || guardRes.message || '导入已中止';
        report.finished_at = new Date().toISOString();
        this.lastReport = report;
        return report;
      }

      // ── 覆盖模式危险协议（spec 5.2）：确认词 + 单教材范围 ──
      if (syncMode === 'overwrite') {
        if (String(opts.overwriteConfirm || '').trim() !== 'OVERWRITE') {
          report.error = '覆盖模式是危险操作，必须输入确认词 OVERWRITE 才能执行';
          report.finished_at = new Date().toISOString();
          this.lastReport = report;
          return report;
        }
        if (!String(opts.scopeTmId || '').trim()) {
          report.error = '覆盖模式仅支持单教材范围，请指定 scope_tm_id，禁止全库覆盖';
          report.finished_at = new Date().toISOString();
          this.lastReport = report;
          return report;
        }
      }

      // ── 体检 ──
      const health = await this.healthCheck();
      if (!health.ok) {
        report.error = health.problems.join('；');
        report.finished_at = new Date().toISOString();
        this.lastReport = report;
        return report;
      }

      // ── 离线队列优先冲刷（上次失败块补传；游标不受影响）──
      const queue = await this.getOfflineQueue();
      if (queue.length > 0 && !dryRun) {
        report.phase = 'flush';
        const base = String((await storage.ensureHydrated()).dofeeApiBase || '').trim().replace(/\/+$/, '');
        const flushUrl = base + IMPORT_PATH;
        const flush = await this._uploadChunks({
          url: flushUrl,
          batchId: queue[0]?.batch_id || newBatchId(),
          chunks: [queue.map((q: any) => q.items).flat()],
          dryRun: false,
          syncMode: 'incremental',
          fetchedAt: new Date().toISOString(),
        });
        report.upserted += flush.upserted;
        report.unchanged += flush.unchanged;
        report.completed_flipped += flush.completed_flipped;
        report.skipped = report.skipped.concat(flush.skipped);
        report.errors = report.errors.concat(flush.errors);
        report.warnings = report.warnings.concat(flush.warnings);
        if (flush.ok) {
          await this._setOfflineQueue([]);
          report.warnings.push(`离线队列冲刷完成（${queue.length} 块）`);
        } else {
          report.warnings.push(`离线队列冲刷未完全成功：${flush.error}`);
        }
        report.phase = 'sync';
      }

      // ── 拉取全量 ──
      const fetched = await this.fetchAllRecords();
      report.fetched_total = fetched.items.length;
      if (!fetched.ok) {
        report.error = fetched.error || '平台学习记录拉取失败';
        report.finished_at = new Date().toISOString();
        this.lastReport = report;
        return report;
      }

      // ── 解析 + 本地过滤 ──
      const parsed = this.parseRecords(fetched.items);
      report.parsed_ok = parsed.items.length;
      report.skipped = report.skipped.concat(parsed.skipped);
      report.warnings = report.warnings.concat(parsed.warnings);

      // ── 完成态分布披露（v1.14.0 方案 A 升级）──
      //    完成态包含：① 顶层 progress>=100 或 status=2；
      //    ② 子资源完播（resource_progress[sub_id]=2 实测 1061s 完播提升）。
      const completedN = parsed.items.filter((x: any) => Number(x.progress) >= 100 || Number(x.status) === 2).length;
      report.warnings.push(
        `平台完成态分布：本批 ${parsed.items.length} 条中达完成态 ${completedN} 条` +
        `（含顶层完播与移动端子资源完播）；其余为「进行中」`
      );

      // ── 自动补齐未知教材待学目录（v1.15.0 联动）：发现新 tm_id 自动同步目录至 dofee2 ──
      const detectedTmIds = Array.from(new Set(parsed.items.map((x: any) => String(x.tm_id || '').trim()).filter(Boolean)));
      if (detectedTmIds.length > 0 && !dryRun) {
        let catalogAutoCount = 0;
        for (const tmId of detectedTmIds) {
          try {
            const sample = parsed.items.find((x: any) => x.tm_id === tmId);
            const res = await catalogSync.syncCatalogByTmId(tmId, {
              currentResourceId: sample?.resource_id || null,
              guardMode: opts.guardMode || 'silent',
            });
            if (res.success) catalogAutoCount++;
          } catch (catErr) {
            console.warn(`[StudySync] 自动同步教材 [${tmId}] 目录轻微异常:`, catErr);
          }
        }
        if (catalogAutoCount > 0) {
          report.warnings.push(`自动目录同步：成功检测并同步 ${catalogAutoCount} 本教材目录至 dofee2`);
        }
      }

      // ── 增量过滤（full_reconcile/overwrite 不过滤；首跑自动全量）──
      const cursor = await this.getCursor();
      let sendItems = parsed.items;
      let firstFull = false;
      if (syncMode === 'incremental') {
        const filtered = this._filterIncremental(parsed.items, cursor);
        sendItems = filtered.items;
        firstFull = filtered.firstFull;
      } else {
        firstFull = !cursor || !cursor.first_full_done;
      }
      report.first_full = firstFull;

      if (syncMode === 'overwrite') {
        // 单教材范围过滤（服务端还会再校验一道）
        const scope = String(opts.scopeTmId || '').trim();
        sendItems = sendItems.filter((x) => x.tm_id === scope);
      }

      if (sendItems.length === 0) {
        report.ok = true;
        report.error = '';
        report.warnings.push(
          firstFull
            ? '平台无可用学习记录条目（全部被过滤或为空）'
            : '增量无新变更（平台记录自上次同步以来无更新）'
        );
        report.finished_at = new Date().toISOString();
        this.lastReport = report;
        return report;
      }

      // ── 方案 A：并发富化移动端真实播放位置（resource_learning_positions）──
      const enrichRes = await this._enrichPositions(sendItems);
      if (enrichRes.enrichedCount > 0) {
        report.warnings.push(
          `方案 A 播放位置富化：成功提取 ${enrichRes.enrichedCount} 条真实播放秒数（最大时长 ${enrichRes.maxSec} 秒），将随记录同步写入 dofee`
        );
      }

      // ── 分块上传 ──
      const base = String((await storage.ensureHydrated()).dofeeApiBase || '').trim().replace(/\/+$/, '');
      const url = base + IMPORT_PATH;
      const chunks: any[][] = [];
      for (let i = 0; i < sendItems.length; i += UPLOAD_CHUNK) chunks.push(sendItems.slice(i, i + UPLOAD_CHUNK));

      const fetchedAt = new Date().toISOString();
      const up = await this._uploadChunks({
        url,
        batchId,
        chunks,
        dryRun,
        syncMode,
        fetchedAt,
      });

      report.sent = sendItems.length;
      report.upserted = up.upserted;
      report.unchanged = up.unchanged;
      report.completed_flipped = up.completed_flipped;
      report.skipped = report.skipped.concat(up.skipped);
      report.errors = report.errors.concat(up.errors);
      report.warnings = report.warnings.concat(up.warnings);
      report.side_effects = up.side_effects;
      report.summary = up.summary;
      report.replayed = up.replayed;

      // ── 失败块进离线队列（下次手动同步自动冲刷）──
      if (up.failedChunks.length > 0 && !dryRun) {
        const q2 = await this.getOfflineQueue();
        for (const fc of up.failedChunks) {
          q2.push({ batch_id: batchId, items: fc, queued_at: fetchedAt });
        }
        await this._setOfflineQueue(q2);
        report.offline_queued = q2.length;
      }

      // ── 游标推进：仅整批成功后（任一块失败游标不动，下次重传——安全侧）──
      if (!dryRun && up.ok) {
        let maxUpdated = cursor?.max_platform_updated_at || '';
        for (const x of sendItems) {
          const t = String(x.platform_updated_at || '');
          if (t > maxUpdated) maxUpdated = t;
        }
        await this._setCursor({
          max_platform_updated_at: maxUpdated,
          last_batch_id: batchId,
          last_synced_at: new Date().toISOString(),
          first_full_done: true,
        });
        report.cursor_advanced = true;
      }

      report.ok = up.ok;
      if (!up.ok && !report.error) report.error = up.error;
    } catch (e: any) {
      report.error = String(e?.message || e || '同步过程异常');
    } finally {
      this._inflight = false;
      report.finished_at = new Date().toISOString();
      this.lastReport = report;
    }
    return report;
  }
}

export const studyRecordSync = new StudyRecordSync();
