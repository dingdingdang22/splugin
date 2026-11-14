/**
 * catalog-sync.ts - 智慧教育平台「学生自主学习」教材目录提取与自动同步模块 (TypeScript / ESM)
 * 
 * 核心设计：
 * 1. 契约对齐：严格遵循 dofee 服务端 /api/v2/student/external-study/catalog 契约 (v4 架构)；
 * 2. 免 CORS/CSP：所有请求优先委托 Background Service Worker (sendHttpRequest)，免疫宿主页面安全策略；
 * 3. 秒级复用 (bind_if_exists)：先探测公共表 external_catalogs 是否已存在该教材，已存在则 100ms 内秒级绑定；
 * 4. 章节树精确对齐：从公开 CDN 拉取 trees/{tmId}.json 与 parts.json，按 node_path 自动归属大章、小节与课时。
 */

import { storage } from '../core/storage';
import { SmartEduAdapter } from '../adapters/smartedu-adapter';
import { ensureImportUserConsistent, describeGuardAbort } from '../core/import-user-guard';
import { sendHttpRequest, sendAuthHttpRequest, fetchJson } from '../core/request';

const CDN_HOSTS = [
  'https://s-file-1.ykt.cbern.com.cn',
  'https://s-file-2.ykt.cbern.com.cn'
];

const SUBJECT_CN_TO_EN: Record<string, string> = {
  '语文': 'Chinese', '数学': 'Mathematics', '英语': 'English',
  '物理': 'Physics', '化学': 'Chemistry', '生物': 'Biology',
  '道德与法治': 'Politics', '思想政治': 'Politics', '政治': 'Politics',
  '历史': 'History', '地理': 'Geography', '科学': 'Science'
};

const GRADE_CN_TO_NUM: Record<string, number> = {
  '一年级': 1, '二年级': 2, '三年级': 3, '四年级': 4, '五年级': 5, '六年级': 6,
  '七年级': 7, '初一': 7, '八年级': 8, '初二': 8, '九年级': 9, '初三': 9,
  '高一': 10, '高二年级': 11, '高二': 11, '高三年级': 12, '高三': 12
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseDofeeErrorMessage(status: number, responseText: string): string {
  if (responseText.includes("exceeded D1's free tier") || responseText.includes("row read limit")) {
    return '云端 D1 数据库已达今日免费读取额度上限 (每日500万行超限，将于明日早8点自动重置)';
  }
  if (responseText.includes('D1_ERROR')) {
    return `云端数据库异常 (D1): ${responseText.slice(0, 100)}`;
  }
  if (status === 401 || status === 403) {
    return 'dofee 凭证失效或无权限，请重新登录';
  }
  if (status === 404) {
    return '服务端接口不存在 (HTTP 404)，请检查 API 地址';
  }
  try {
    const json = JSON.parse(responseText);
    if (json.error) return `HTTP ${status}: ${json.error}`;
  } catch (e) {}
  return `HTTP ${status}: ${responseText.slice(0, 120)}`;
}

export interface CatalogItemPayload {
  resource_id: string;
  title: string;
  resource_type: string;
  chapter_id: string;
  chapter_title: string;
  section_id: string;
  section_title: string;
  week_tag?: string;
  sort_order?: number;
}

export interface CatalogBookMeta {
  subject: string;
  subject_cn: string;
  grade: number | null;
  grade_cn: string;
  edition: string;
  curriculum_era: string;
  volume: string;
  title: string;
  textbook_pdf_url?: string;
}

export interface FullCatalogPayload {
  source: 'smartedu';
  teachingmaterial_id: string;
  current_resource_id: string | null;
  book_meta: CatalogBookMeta;
  items: CatalogItemPayload[];
}

export class CatalogSyncManager {
  private isSyncing = false;
  private onLogCallback: ((log: any) => void) | null = null;
  private _syncedTmIdsInSession = new Set<string>();

  setLogListener(cb: (log: any) => void) {
    this.onLogCallback = cb;
  }

  private _log(type: string, message: string, detail?: any) {
    if (this.onLogCallback) {
      this.onLogCallback({
        time: new Date().toLocaleTimeString(),
        type,
        message,
        detail
      });
    }
    const config = storage.getConfig();
    if (config.debugLog) {
      console.log(`[CatalogSync][${type}] ${message}`, detail || '');
    }
  }

  /**
   * 按教材 tmId 主动触发目录同步（支持指定课时 currentResourceId 辅助定位）
   */
  async syncCatalogByTmId(
    tmId: string,
    options: { currentResourceId?: string | null; force?: boolean; guardMode?: 'interactive' | 'silent' } = {}
  ): Promise<{ success?: boolean; skipped?: boolean; reused?: boolean; reason?: string; error?: string; catalogData?: any; lastSync?: any }> {
    if (!tmId || !UUID_RE.test(tmId)) {
      return { skipped: true, reason: 'INVALID_TM_ID' };
    }

    if (this.isSyncing) {
      this._log('skip', `已有正在进行的目录同步任务，本次跳过 [${tmId}]`);
      return { skipped: true, reason: 'ALREADY_RUNNING' };
    }

    const config = await storage.ensureHydrated();
    if (!config.enabled) {
      this._log('skip', '插件处于停用状态，跳过目录同步');
      return { skipped: true, reason: 'DISABLED' };
    }

    if (!config.dofeeJwtToken && !config.dofeeRefreshToken) {
      this._log('warn', '未配置 dofee 认证凭证，暂无法推送待学目录至服务端');
      return { skipped: true, reason: 'NO_TOKEN' };
    }

    this.isSyncing = true;
    try {
      const username = config.dofeeUsername || 'default';

      // ── 内存会话级快速判重：同会话内已处理成功的教材不重复拉取 ───────
      if (!options.force && this._syncedTmIdsInSession.has(tmId)) {
        this._log('skip', `教材 [${tmId}] 本会话已确认同步，跳过重复拉取`);
        return { skipped: true, reason: 'SESSION_DEDUP' };
      }

      const lastSync = storage.getSyncedCatalog(username, tmId);
      if (!options.force && lastSync && lastSync.syncedAt && (Date.now() - lastSync.syncedAt < 7 * 24 * 3600 * 1000)) {
        this._syncedTmIdsInSession.add(tmId);
        this._log('skip', `教材 [${lastSync.textbookTitle || tmId}] 7天内已同步过待学目录，跳过重复拉取`);
        return { skipped: true, reason: 'ALREADY_SYNCED', lastSync };
      }

      const currentResourceId = options.currentResourceId || null;

      // ── 第一阶段：尝试秒级复用服务端公共单份目录 (bind_if_exists) ─────────
      this._log('info', `正在向 dofee 检测教材 [${tmId}] 是否已存在全局公共目录...`);
      const bindRes = await this.tryBindExistingCatalog(tmId, currentResourceId);
      if (bindRes.ok && bindRes.found) {
        const bookTitle = bindRes.header?.title || lastSync?.textbookTitle || '已绑定教材';
        const totalLessons = bindRes.total_lessons || bindRes.header?.total_lessons || 0;
        storage.markCatalogSynced(username, tmId, {
          textbookTitle: bookTitle,
          totalLessons: totalLessons,
          subject: bindRes.header?.subject,
          grade: bindRes.header?.grade
        });
        this._syncedTmIdsInSession.add(tmId);
        this._log('success', `教材公共目录秒级复用成功！共 ${totalLessons} 节微课，已绑定至当前学员`);
        return {
          success: true,
          reused: true,
          catalogData: {
            tmId,
            textbookTitle: bookTitle,
            totalLessons
          }
        };
      }

      // ── 第二阶段：服务端尚未收录，从公开 CDN 完整抓取 ────────────────────
      this._log('info', `dofee 尚未收录教材 [${tmId}]，开始从智慧教育公开 CDN 拉取章节树...`);
      const catalogData = await this.fetchFullCatalogFromCdn(tmId, currentResourceId);

      this._log('info', `已成功抓取教材 [${catalogData.book_meta.title}]，包含 ${catalogData.items.length} 节微课，正在推送至 dofee...`);
      const uploadRes = await this.uploadCatalogToDofee(catalogData, { guardMode: options.guardMode });

      if (uploadRes.success) {
        storage.markCatalogSynced(username, tmId, {
          textbookTitle: catalogData.book_meta.title,
          totalLessons: catalogData.items.length,
          subject: catalogData.book_meta.subject,
          grade: catalogData.book_meta.grade || undefined
        });
        this._syncedTmIdsInSession.add(tmId);
        this._log('success', `教材待学目录全量落库成功！共建目录 ${catalogData.items.length} 节微课`);
        return {
          success: true,
          catalogData: {
            tmId,
            textbookTitle: catalogData.book_meta.title,
            totalLessons: catalogData.items.length
          }
        };
      } else {
        this._log('error', `推送教材目录至 dofee 失败: ${uploadRes.error}`);
        return { success: false, error: uploadRes.error };
      }
    } catch (err: any) {
      this._log('error', `目录同步流水线异常: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      this.isSyncing = false;
    }
  }

  async syncCurrentLessonCatalog(options: { force?: boolean; guardMode?: 'interactive' | 'silent' } = {}) {
    const idInfo = SmartEduAdapter.extractResourceIdentifiers();
    const currentResourceId = idInfo.resourceId || null;
    let tmId = idInfo.tm_id || idInfo.teachingmaterialId;

    if (!tmId && idInfo.resourceId) {
      tmId = await this.resolveTmIdFromCurrentLesson(idInfo.resourceId);
    }

    if (!tmId || !UUID_RE.test(tmId)) {
      const cfg = storage.getConfig();
      if (cfg.debugLog) {
        console.debug('[CatalogSync] 正常页面状态下未匹配到有效教材ID，静默跳过待学目录同步');
      }
      return { skipped: true, reason: 'TM_ID_NOT_FOUND' };
    }

    return this.syncCatalogByTmId(tmId, {
      currentResourceId,
      force: options.force,
      guardMode: options.guardMode
    });
  }

  /**
   * 探测并尝试复用服务端已落库的公共单份教材目录 (bind_if_exists)
   */
  async tryBindExistingCatalog(tmId: string, currentResourceId: string | null): Promise<any> {
    const config = await storage.ensureHydrated();
    const base = String(config.dofeeApiBase || '').trim().replace(/\/+$/, '');
    const url = `${base}/api/v2/student/external-study/catalog`;

    const res = await sendAuthHttpRequest(
      'POST',
      url,
      {
        'Content-Type': 'application/json'
      },
      {
        mode: 'bind_if_exists',
        teachingmaterial_id: tmId,
        current_resource_id: currentResourceId
      }
    );

    if (res.ok) {
      try {
        const json = JSON.parse(res.responseText);
        const result = json.catalog || json;
        const isFound = Boolean(
          result.found || 
          result.reused_shared_catalog || 
          result.already_bound || 
          result.header || 
          result.items ||
          json.found ||
          json.reused_shared_catalog
        );
        this._log('info', `探测服务端已存教材目录: found=${isFound}, reused=${result.reused_shared_catalog ?? json.reused_shared_catalog ?? isFound}`, {
          status: res.status,
          keys: Object.keys(result)
        });
        return {
          ok: true,
          found: isFound,
          reused_shared_catalog: Boolean(result.reused_shared_catalog ?? json.reused_shared_catalog ?? isFound),
          header: result.header || json.header,
          total_lessons: result.total_lessons || json.total_lessons || result.header?.total_lessons || (Array.isArray(result.items) ? result.items.length : 0),
          raw: json
        };
      } catch (e: any) {
        this._log('warn', `bind_if_exists 响应 JSON 解析失败: ${e.message}`, res.responseText.slice(0, 150));
        return { ok: false, found: false };
      }
    }
    const errDesc = parseDofeeErrorMessage(res.status, res.responseText);
    this._log('warn', `bind_if_exists 探测未成功 (HTTP ${res.status}): ${errDesc}`);
    return { ok: false, found: false, error: errDesc };
  }

  /**
   * 从当前课时 resourceId 反查所属教材 tmId
   */
  async resolveTmIdFromCurrentLesson(resourceId: string): Promise<string | null> {
    const urls = [
      `https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/national_lesson/resources/details/${resourceId}.json`,
      `https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/knowledge_micro_lesson_package/resources/details/${resourceId}.json`
    ];

    for (const u of urls) {
      try {
        const res = await fetchJson<any>(u);
        if (res.ok && res.data) {
          const ids = res.data.teachmeterial_ids;
          if (Array.isArray(ids) && ids.length > 0 && UUID_RE.test(ids[0])) {
            return ids[0];
          }
        }
      } catch (e) {}
    }
    return null;
  }

  /**
   * 从智慧教育公开 CDN 拉取章节树和分片并构造全量载荷
   */
  async fetchFullCatalogFromCdn(tmId: string, currentResourceId: string | null): Promise<FullCatalogPayload> {
    const treeUrl = `https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/national_lesson/trees/${tmId}.json`;
    const treeRes = await fetchJson<any[]>(treeUrl);
    if (!treeRes.ok || !Array.isArray(treeRes.data)) {
      throw new Error(`拉取教材章节树失败: ${treeRes.error || '数据格式异常'}`);
    }
    const treeNodes = treeRes.data;

    // 建立树状节点映射
    const nodeMap = new Map<string, { chapterId: string; chapterTitle: string; sectionId: string; sectionTitle: string }>();
    for (const ch of treeNodes) {
      const chId = String(ch.id || '').trim();
      const chTitle = String(ch.title || '默认章节').trim();
      nodeMap.set(chId, { chapterId: chId, chapterTitle: chTitle, sectionId: chId, sectionTitle: chTitle });

      if (Array.isArray(ch.child_nodes)) {
        for (const sec of ch.child_nodes) {
          const secId = String(sec.id || '').trim();
          const secTitle = String(sec.title || chTitle).trim();
          nodeMap.set(secId, { chapterId: chId, chapterTitle: chTitle, sectionId: secId, sectionTitle: secTitle });

          if (Array.isArray(sec.child_nodes)) {
            for (const sub of sec.child_nodes) {
              const subId = String(sub.id || '').trim();
              const subTitle = String(sub.title || secTitle).trim();
              nodeMap.set(subId, { chapterId: chId, chapterTitle: chTitle, sectionId: secId, sectionTitle: `${secTitle} - ${subTitle}` });
            }
          }
        }
      }
    }

    // 拉取课时清单分片 parts.json
    const partsUrl = `https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/national_lesson/teachingmaterials/${tmId}/resources/parts.json`;
    const partsRes = await fetchJson<string[]>(partsUrl);
    let allResources: any[] = [];
    if (partsRes.ok && Array.isArray(partsRes.data)) {
      for (const partUrl of partsRes.data) {
        const chunkRes = await fetchJson<any[]>(partUrl);
        if (chunkRes.ok && Array.isArray(chunkRes.data)) {
          allResources.push(...chunkRes.data);
        }
      }
    }

    const courseContext = SmartEduAdapter.extractCourseContext();

    // 汇总元数据
    let subjectCn = '';
    let gradeCn = courseContext.grade ? `${courseContext.grade}年级` : '';
    let edition = courseContext.textbookVersion || '';
    let volume = '';
    let curriculumEra = '';

    for (const r of allResources) {
      const tags = Array.isArray(r.tag_list) ? r.tag_list : [];
      for (const t of tags) {
        if (typeof t !== 'string') continue;
        if (['语文', '数学', '英语', '物理', '化学', '生物', '道德与法治', '思想政治', '历史', '地理', '科学'].includes(t)) {
          subjectCn = subjectCn || t;
        } else if (['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '七年级', '八年级', '九年级', '高一', '高二', '高三', '初一', '初二', '初三'].includes(t)) {
          gradeCn = gradeCn || t;
        } else if (t.includes('版') || t.includes('统编') || t.includes('人教') || t.includes('外研')) {
          edition = edition || t;
        } else if (t.includes('上册') || t.includes('下册') || t.includes('全一册') || t.includes('必修')) {
          volume = volume || t;
        } else if (t.includes('新教材') || t.includes('旧教材') || t.includes('新课标')) {
          curriculumEra = curriculumEra || t;
        }
      }
    }

    subjectCn = subjectCn || (courseContext.subject ? Object.keys(SUBJECT_CN_TO_EN).find(k => SUBJECT_CN_TO_EN[k] === courseContext.subject) || '通用' : '通用');
    const subject = SUBJECT_CN_TO_EN[subjectCn] || courseContext.subject || 'General';
    const grade = GRADE_CN_TO_NUM[gradeCn] || courseContext.grade || null;
    const title = [subjectCn, gradeCn, edition, volume].filter(Boolean).join(' · ') || courseContext.title || '智慧教育平台同步教材';

    // 格式化课时列表
    const items: CatalogItemPayload[] = [];
    const seenIds = new Set<string>();

    for (const r of allResources) {
      const resId = String(r.id || '').trim();
      if (!resId || seenIds.has(resId)) continue;
      seenIds.add(resId);

      const rawType = String(r.resource_type_code || r.custom_properties?.prom_resouce_type || 'national_lesson').trim();
      const paths: string[] = Array.isArray(r.chapter_paths) ? r.chapter_paths : [];
      let matched: { chapterId: string; chapterTitle: string; sectionId: string; sectionTitle: string } | null = null;

      for (const p of paths) {
        const segs = p.split('/');
        const leaf = segs[segs.length - 1];
        if (nodeMap.has(leaf)) {
          matched = nodeMap.get(leaf)!;
          break;
        }
        if (nodeMap.has(segs[0])) {
          matched = nodeMap.get(segs[0])!;
        }
      }

      const tags = Array.isArray(r.tag_list) ? r.tag_list : [];
      const weekTag = tags.find((t: any) => typeof t === 'string' && t.includes('周')) || '';

      items.push({
        resource_id: resId,
        title: String(r.title || `课时 ${items.length + 1}`).trim(),
        resource_type: rawType,
        chapter_id: matched?.chapterId || 'ch_0',
        chapter_title: matched?.chapterTitle || '默认章节',
        section_id: matched?.sectionId || 'sec_0',
        section_title: matched?.sectionTitle || '默认小节',
        week_tag: weekTag
      });
    }

    return {
      source: 'smartedu',
      teachingmaterial_id: tmId,
      current_resource_id: currentResourceId,
      book_meta: {
        subject,
        subject_cn: subjectCn,
        grade,
        grade_cn: gradeCn,
        edition,
        curriculum_era: curriculumEra,
        volume,
        title
      },
      items
    };
  }

  /**
   * 推送全量教材目录至 dofee 后端
   */
  async uploadCatalogToDofee(catalogData: FullCatalogPayload, opts: { guardMode?: 'interactive' | 'silent' } = {}): Promise<{ success: boolean; error?: string; aborted?: boolean; reason?: string }> {
    // ── 【横切安全件】智慧平台用户一致性守卫（目录导入入口，覆盖检查）──
    // 在任何写入/网络动作之前比对智慧平台登录用户；变更未确认即中止，零写入。
    const guardRes = await ensureImportUserConsistent({
      action: '教材目录导入 dofee',
      mode: opts.guardMode === 'silent' ? 'silent' : 'interactive'
    });
    if (guardRes.ok === false) {
      const errMsg = describeGuardAbort(guardRes.reason);
      this._log('warn', errMsg);
      return { success: false, error: errMsg, aborted: true, reason: guardRes.reason };
    }

    const config = await storage.ensureHydrated();
    const base = String(config.dofeeApiBase || '').trim().replace(/\/+$/, '');
    const url = `${base}/api/v2/student/external-study/catalog`;

    const res = await sendAuthHttpRequest(
      'POST',
      url,
      {
        'Content-Type': 'application/json'
      },
      catalogData
    );

    if (res.ok) {
      return { success: true };
    }
    const errDesc = parseDofeeErrorMessage(res.status, res.responseText);
    return { success: false, error: errDesc };
  }
}

export const catalogSync = new CatalogSyncManager();

if (typeof window !== 'undefined') {
  (window as any).SmartEduCatalogSync = catalogSync;
}
