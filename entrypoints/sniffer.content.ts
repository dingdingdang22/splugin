/**
 * sniffer.content.ts - 错题/习题接口被动嗅探器 (WXT Content Script / MAIN World)
 *
 * 运行在页面主世界 (world: 'MAIN')，在 document_start 尽早拦截 fetch 与 XHR。
 *
 * ── 为什么必须是 MAIN world ──────────────────────────────────────────────
 * MV3 隔离世界与主世界共享 DOM，但**不共享 JS 属性**：页面 React 挂在 DOM 节点上的
 * `__reactFiber$xxx` 在隔离世界里取不到，页面自己的 fetch 也拦不住。
 * 因此所有「能拿到原始数据」的动作都必须在这里完成，再把**紧凑结果**过桥。
 *
 * ── 通道设计（三条，按代价从低到高）─────────────────────────────────────
 * 1) DOM 属性镜像：`<html data-smartedu-qids="[...]">` / `data-smartedu-metas` /
 *    `data-smartedu-wrong` —— 隔离世界可 0ms 同步读取，是最廉价的通道；
 * 2) postMessage 问答桥：`__smarteduWrongQuery = 'questionIds' | 'wrongQuestions'`
 *    → 应答 `__smarteduWrongAnswer`，用于需要「现算」的场景（如 Fiber 深挖）；
 * 3) 捕获事件广播：`__smarteduWrong: 'api'`，供隔离世界感知接口命中时序。
 *
 * ── 与旧版 (smartedu-monitor/wrong-question-sniffer.js) 的行为对齐点 ──────
 * - 错题清单位于 `study_records/{tmId}/user_teachingmaterials_wrong_questions`
 *   响应的 `ext_info.wrong_questions`，**必须先解析完整 body 再截断存档**；
 *   旧版本曾把截断后的文本当 JSON 解析，大响应会静默失败 —— 本次已修正；
 * - 题目 ID 候选 = 已捕获响应体 + URL 参数 + performance 资源 + React Fiber 四路；
 * - 元数据（知识点/难易度/更新时间/主讲人）随 ID 一起镜像到 `data-smartedu-metas`。
 *
 * ── 合规红线（不可越）──────────────────────────────────────────────────
 * - 只「记录」页面自己已经发起并收到的响应，不改写请求、不伪造参数、不重放；
 * - 不构造任何需要鉴权的请求；不读取、不转发 Cookie / access_token / x-nd-auth / mac_key；
 * - 采集内容只落在本机 DOM 属性与内存，不上传。
 *
 * ── 性能约束（本文件最容易拖慢页面的地方）───────────────────────────────
 * - 捕获环形缓冲 40 条；单条体最多 200000 字符，超过 150000 只留 400 字符头部摘要；
 * - 候选抽取是**增量**的：每条捕获只扫描一次（`_scanned` 标记），不像旧版每次全量重扫；
 * - Fiber 扫描有 dirty 闸 + 时间闸（≥2s）+ 预算上限（起点 120 / 访问 12000 / 深度 5），
 *   且只由「桥请求」或「节流的候选刷新」触发，绝不在每条响应回调里直接跑。
 */

import { defineContentScript } from 'wxt/sandbox';
import { APP_VERSION, DISPLAY_VERSION } from '../src/core/version';

export default defineContentScript({
  matches: [
    'https://basic.smartedu.cn/*',
    'https://*.smartedu.cn/*',
    'https://*.eduyun.cn/*',
    'https://*.cbern.com.cn/*'
  ],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const W: any = typeof window !== 'undefined' ? window : globalThis;
    if (!W || W.__SMARTEDU_WRONG_SNIFFER__) return;

    /** 单条响应体存档上限（字符） */
    const BODY_LIMIT = 200000;
    /** 超过此长度只留头部摘要，防止挤爆缓冲 */
    const LARGE_BODY_THRESHOLD = 150000;
    const LARGE_BODY_LIMIT = 400;
    /** 捕获环形缓冲条数 */
    const MAX_CAPTURES = 40;
    /** 候选刷新节流间隔（接口密集命中时合并成一次） */
    const CANDIDATE_REFRESH_MS = 1200;
    /** Fiber 扫描最小间隔 */
    const FIBER_MIN_INTERVAL_MS = 2000;
    /** Fiber 扫描预算 */
    const FIBER_START_BUDGET = 120;
    const FIBER_VISIT_BUDGET = 12000;

    const URL_KEY = /(wrong|question|paper|judge|exam|mistake|error|onlineJudge|myPaper|query_category|doc-center|api_static\/questions|ndrs\/questions|esp\/questions|user_teachingmaterials|study_records|parts\.json|part_\d+\.json|data_version|trees\/[0-9a-f-]+\.json|teachingmaterials\/[0-9a-f-]+|search\/query|ndr-gateway|c\/document\/exists)/i;
    const WRONG_RECORD_KEY = /user_teachingmaterials_wrong_questions/i;
    const TM_URL_RE = /(?:trees\/|teachingmaterials\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
    const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    /** 题库标准五档难度归一化（易 / 较易 / 中 / 较难 / 难） */
    const DIFFICULTY_MAP_CN: Record<string, string> = {
      '非常简单': '易', '极易': '易', '容易': '易', '简单': '易', '易': '易', '很易': '易', 'easy': '易',
      '较易': '较易', '偏易': '较易', '稍易': '较易',
      '适中': '中', '中等': '中', '一般': '中', '普通': '中', '中': '中', 'medium': '中',
      '偏难': '较难', '较难': '较难', '稍难': '较难',
      '困难': '难', '非常困难': '难', '极难': '难', '难': '难', '很难': '难', 'hard': '难'
    };

    const state: any = {
      version: `${APP_VERSION}-sniffer`,
      displayVersion: DISPLAY_VERSION,
      startedAt: Date.now(),
      captures: [] as any[],
      lastTextbookId: null as string | null,
      /** 题目元数据（知识点/难易度/更新时间/主讲人），键为小写 UUID */
      exerciseMetas: {} as Record<string, any>,
      /** 题目 ID 候选去重表，键为小写 UUID */
      candidateIds: {} as Record<string, any>,
      wrong: {
        teachingmaterial_id: null as string | null,
        byQuestionId: {} as Record<string, any>,
        sources: [] as any[]
      },
      /** 内部调度标记（不对桥暴露语义，仅用于节流） */
      _lastCandidateRefreshAt: 0,
      _lastFiberScanAt: 0,
      _fiberDirty: true,
      _refreshTimer: 0 as any,
      _totalScanned: 0
    };
    W.__SMARTEDU_WRONG_SNIFFER__ = state;

    // ───────────────────────────────────────────────────────────────
    // 工具
    // ───────────────────────────────────────────────────────────────
    function normalizeDifficultyCn(raw: any): string {
      if (!raw) return '中';
      const s = String(raw).trim();
      if (DIFFICULTY_MAP_CN[s]) return DIFFICULTY_MAP_CN[s];
      if (/(?:极难|非常困难|困难|很难|特难|难)/.test(s)) return '难';
      if (/(?:偏难|较难|稍难)/.test(s)) return '较难';
      if (/(?:适中|中等|一般|普通|中)/.test(s)) return '中';
      if (/(?:较易|偏易|稍易)/.test(s)) return '较易';
      if (/(?:极易|非常简单|容易|简单|很易|易)/.test(s)) return '易';
      const stars = (s.match(/[★☆]/g) || []).length;
      if (stars >= 5) return '难';
      if (stars === 4) return '较难';
      if (stars === 3) return '中';
      if (stars === 2) return '较易';
      if (stars === 1) return '易';
      return '中';
    }

    function wrongCount(): number {
      return Object.keys(state.wrong.byQuestionId).length;
    }

    function setAttr(name: string, value: string) {
      try {
        const root = W.document && W.document.documentElement;
        if (root) root.setAttribute(name, value);
      } catch (e) { /* ignore */ }
    }

    /**
     * 同步状态镜像到 DOM 根节点（MV3 跨世界 0ms 同步通道）。
     * 隔离世界读不到主世界 window 属性，只能读属性 —— 这是唯一的零延迟通道。
     */
    function syncDomBridge() {
      try {
        setAttr('data-smartedu-sniffer', 'ready');
        setAttr('data-smartedu-sniffer-version', String(state.version));
        setAttr('data-smartedu-sniffer-captures', String(state.captures.length));
        setAttr('data-smartedu-wrong-count', String(wrongCount()));
        const wq = {
          teachingmaterial_id: state.wrong.teachingmaterial_id,
          count: wrongCount(),
          questions: Object.keys(state.wrong.byQuestionId).map((k) => state.wrong.byQuestionId[k]),
          sources: state.wrong.sources
        };
        // 只镜像最近 100 条，避免属性值过大拖慢 DOM 序列化；全量走消息桥
        const trimmed = Object.assign({}, wq, { questions: wq.questions.slice(0, 100) });
        setAttr('data-smartedu-wrong', JSON.stringify(trimmed));
      } catch (e) { /* ignore */ }
    }

    /**
     * 从 study_records 错题接口响应中抽取错题清单。
     * 只解析页面已经收到的响应，不构造请求。
     */
    function ingestWrongRecords(url: string, fullText: string) {
      try {
        if (!WRONG_RECORD_KEY.test(String(url)) || !fullText) return;
        const data = JSON.parse(fullText);
        let ext = data && data.ext_info;
        if (typeof ext === 'string') {
          try { ext = JSON.parse(ext); } catch (e) { return; }
        }
        if (!ext || typeof ext !== 'object') return;

        const tmId = ext.teachingmaterial_id || data.scope_id || null;
        if (tmId) {
          state.wrong.teachingmaterial_id = tmId;
          state.lastTextbookId = tmId;
        }

        const list = Array.isArray(ext.wrong_questions) ? ext.wrong_questions : [];
        let added = 0;
        for (let i = 0; i < list.length; i++) {
          const w = list[i];
          if (!w || !w.question_id) continue;
          const qid = String(w.question_id).toLowerCase();
          const rec = {
            question_id: qid,
            container_id: w.container_id || null,
            error_times: w.error_times != null ? w.error_times : (w.times || 1),
            times: w.times != null ? w.times : null,
            problem_time: w.problem_time || null,
            teachingmaterial_id: tmId || null,
            seen_from: String(url)
          };
          const prev = state.wrong.byQuestionId[qid];
          if (!prev) {
            state.wrong.byQuestionId[qid] = rec;
            state.candidateIds[qid] = { id: qid, seen_from: 'wrong_record', t: Date.now() };
            added++;
          } else {
            if ((rec.error_times || 0) > (prev.error_times || 0)) prev.error_times = rec.error_times;
            if (rec.problem_time && (!prev.problem_time || rec.problem_time > prev.problem_time)) {
              prev.problem_time = rec.problem_time;
            }
          }
        }
        state.wrong.sources.push({ url: String(url), inResponse: list.length, added, t: Date.now() });
        if (added > 0 || list.length > 0) {
          console.log(
            `%c[错题API嗅探] 解析错题接口：本响应 ${list.length} 条，累计去重 ${wrongCount()} 条`,
            'background:#16a34a;color:#fff;padding:2px 6px;border-radius:3px;'
          );
        }
      } catch (e) {
        // 静默：解析失败不影响页面
      }
    }

    // ───────────────────────────────────────────────────────────────
    // 题目 ID 候选抽取
    // ───────────────────────────────────────────────────────────────

    /** URL 里直接内嵌的题目 ID（含 ids= 批量存在性检查） */
    const URL_QID_PATTERNS = [
      /\/api_static\/questions\/(?:[^/?#]+_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/data\.json/gi,
      /\/ndrs\/questions\/resources\/details\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json/gi,
      /\/edu_product\/esp\/questions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:@\d+)?\.pkg\//gi,
      /\/e-question-bank-web\.[^/]+\/questions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
      /[?&](?:question|resource)[_-]?id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi
    ];

    function extractUrlQids(url: string, onHit: (id: string) => void) {
      if (!url || typeof url !== 'string') return;
      // 个人网盘副本路径 /ndr_2d0_ 下的 UUID 是网盘记录 ID，不是题库原始 ID，必须排除
      if (url.indexOf('/ndr_2d0_') >= 0) return;
      for (let p = 0; p < URL_QID_PATTERNS.length; p++) {
        const re = URL_QID_PATTERNS[p];
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(url))) onHit(m[1].toLowerCase());
      }
      const idsMatch = /[?&]ids=([0-9a-f-,]{36,})/i.exec(url);
      if (idsMatch && idsMatch[1]) {
        const parts = idsMatch[1].split(',');
        for (let i = 0; i < parts.length; i++) {
          const trimmed = parts[i] ? parts[i].trim() : '';
          if (trimmed && UUID_ONLY.test(trimmed)) onHit(trimmed.toLowerCase());
        }
      }
    }

    function recordFiberMeta(qid: string, obj: any) {
      if (!qid || !UUID_ONLY.test(qid) || !obj || typeof obj !== 'object') return;
      const norm = qid.toLowerCase();
      const meta = state.exerciseMetas[norm] || {
        knowledge_points: [],
        difficulty: null,
        difficulty_raw: null,
        update_time: null,
        teacher: null
      };
      const kps = obj.knowledgePoints || obj.knowledge_points || obj.knowledgeMarks || obj.qb_knowledge_points;
      if (Array.isArray(kps) && kps.length > 0) {
        const arr = kps.map((x: any) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
        meta.knowledge_points = Array.from(new Set(meta.knowledge_points.concat(arr)));
      } else if (typeof kps === 'string' && kps.trim()) {
        const arr = kps.split(/[、，,；;]+/).map((s: string) => s.trim()).filter(Boolean);
        meta.knowledge_points = Array.from(new Set(meta.knowledge_points.concat(arr)));
      }
      const diff = obj.difficulty || obj.difficulty_raw || obj.facilityValue || obj.facility_value;
      if (typeof diff === 'string' && diff.trim()) {
        meta.difficulty_raw = diff.trim();
        meta.difficulty = normalizeDifficultyCn(diff);
      }
      if (obj.updateTime || obj.update_time) meta.update_time = obj.updateTime || obj.update_time;
      if (obj.teacherName || obj.teacher_name || obj.teacher) {
        meta.teacher = obj.teacherName || obj.teacher_name || obj.teacher;
      }
      if (meta.knowledge_points.length > 0 || meta.difficulty) {
        state.exerciseMetas[norm] = meta;
      }
    }

    /**
     * 在主世界扫描 React Fiber（含 <micro-app> 子应用与向上 return 祖先遍历）。
     *
     * 为什么必须在主世界：MV3 隔离世界访问不到 DOM 节点上的 `__reactFiber$` 属性。
     * 为什么要有预算：Fiber 树是环形结构，无预算深挖会直接冻死主线程。
     */
    function scanMainWorldFiber(onHit: (id: string, from: string) => void) {
      try {
        const doc = W.document;
        if (!doc) return;
        const starts: any[] = [];
        const seenStarts = new Set();
        const pushFiberFromEl = (el: any) => {
          if (!el || starts.length >= FIBER_START_BUDGET) return;
          let ks: string[];
          try { ks = Object.keys(el); } catch (e) { return; }
          for (let i = 0; i < ks.length; i++) {
            const k = ks[i];
            if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0 || k.indexOf('__reactContainer$') === 0) {
              const f = el[k];
              if (f && !seenStarts.has(f)) {
                seenStarts.add(f);
                starts.push(f);
              }
            }
          }
        };

        // 1. 优先定位习题卡片与 micro-app 宿主节点
        const cardEls = doc.querySelectorAll('[class*="exercises-item"], [class*="paper-container"], [class*="player_container"], [class*="chapter-exercise"], micro-app, micro-app-body, [class*="question"]');
        for (let c = 0; c < cardEls.length && starts.length < 60; c++) pushFiberFromEl(cardEls[c]);

        // 2. 回收含有卡片特征文本的节点（应对 class 名随机化）
        if (starts.length < FIBER_START_BUDGET) {
          const allEls = doc.querySelectorAll('div, span, a, button');
          const limit = Math.min(allEls.length, 1200);
          for (let a = 0; a < limit && starts.length < FIBER_START_BUDGET; a++) {
            const txt = (allEls[a].textContent || '').slice(0, 160);
            if (/show answer|AI解析|题目解析|正确答案|移出试题篮|找相似题|facility|ExamBasket|难易度|知识点|单选|多选|填空|解答/i.test(txt)) {
              pushFiberFromEl(allEls[a]);
            }
          }
        }

        const seenFibers = new Set();
        const seenObjs = new Set();
        let visited = 0;

        const scanObj = (o: any, depth: number) => {
          if (!o || typeof o !== 'object' || depth > 5 || visited > FIBER_VISIT_BUDGET) return;
          if (seenObjs.has(o)) return;
          seenObjs.add(o);

          if (Array.isArray(o)) {
            for (let i = 0; i < Math.min(o.length, 50); i++) scanObj(o[i], depth + 1);
            return;
          }

          // source_document_id 优先：规避 doc-center 个人副本 identifier
          if (typeof o.source_document_id === 'string' && UUID_ONLY.test(o.source_document_id)) {
            onHit(o.source_document_id.toLowerCase(), 'fiber:source_document_id');
            recordFiberMeta(o.source_document_id, o);
            return;
          }
          const isQuestionVo = !!(o.qt_info || o.answer_steps || o.paper_question_type || o.questionType ||
            o.questionTag || o.res_type === 'questions' || o.resource_type_code === 'questions' ||
            o.original_sub_type === 'questions');
          if (isQuestionVo) {
            const cand = o.source_document_id || o.question_id || o.resourceId || o.id || o.identifier;
            if (typeof cand === 'string' && UUID_ONLY.test(cand)) {
              onHit(cand.toLowerCase(), 'fiber:questionVo');
              recordFiberMeta(cand, o);
            }
          }

          for (const k in o) {
            if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
            if (k === 'GlobalWindow' || k === 'window' || k === 'document' || k === '_reactInternals' || k === 'ownerDocument') continue;
            try {
              const v = o[k];
              if (typeof v === 'string') {
                if (v.length === 36 && UUID_ONLY.test(v)) {
                  if (/^(?:source_document_id|question_id|questionId|resource_id|resourceId)$/i.test(k)) {
                    onHit(v.toLowerCase(), 'fiber:' + k);
                    recordFiberMeta(v, o);
                  }
                } else if (v.length > 36 && v.indexOf('/') >= 0) {
                  extractUrlQids(v, (uId) => onHit(uId, 'fiber:url'));
                }
              } else if (v && typeof v === 'object' && depth < 4) {
                if ((k === 'question' || k === 'questionData') && typeof v.id === 'string' && UUID_ONLY.test(v.id)) {
                  onHit(v.id.toLowerCase(), 'fiber:' + k + '.id');
                  recordFiberMeta(v.id, v);
                }
                scanObj(v, depth + 1);
              }
            } catch (e) { /* ignore */ }
          }
        };

        const inspectFiber = (f: any) => {
          if (!f || seenFibers.has(f) || visited > FIBER_VISIT_BUDGET) return;
          seenFibers.add(f);
          visited++;
          if (f.memoizedProps) scanObj(f.memoizedProps, 0);
          if (f.stateNode && typeof f.stateNode === 'object') {
            if (f.stateNode.questionData) scanObj(f.stateNode.questionData, 0);
            if (f.stateNode.props) scanObj(f.stateNode.props, 0);
          }
          let s = f.memoizedState;
          let hop = 0;
          while (s && typeof s === 'object' && hop++ < 25) {
            if (s.memoizedState && typeof s.memoizedState === 'object') scanObj(s.memoizedState, 0);
            s = s.next;
          }
        };

        const walkDown = (f: any, d: number) => {
          if (!f || d > 60 || visited > FIBER_VISIT_BUDGET) return;
          inspectFiber(f);
          if (f.child) walkDown(f.child, d + 1);
          if (f.sibling) walkDown(f.sibling, d + 1);
        };

        for (let i = 0; i < starts.length; i++) {
          // 先向上走 return 链（从 DOM 叶子直达 ExercisesItem / QuestionPlayer）
          let anc = starts[i];
          for (let up = 0; anc && up < 25; up++) {
            inspectFiber(anc);
            anc = anc.return;
          }
          walkDown(starts[i], 0);
        }
      } catch (e) { /* ignore */ }
    }

    function addCandidate(id: string, seenFrom: string, t?: number) {
      if (!id || !UUID_ONLY.test(id)) return;
      const norm = id.toLowerCase();
      if (!state.candidateIds[norm]) {
        state.candidateIds[norm] = { id: norm, seen_from: seenFrom || 'main', t: t || Date.now() };
      }
    }

    /**
     * 抽取「题目 ID 候选」——供习题库导出与错题自适应降级使用。
     *
     * 为什么在主世界抽成紧凑数组再过桥：captures 里可能有数十万字符，
     * 走 postMessage 结构化克隆两个数量级更贵。
     *
     * @param forceFiber 强制跑一次 Fiber 扫描（忽略 dirty 闸，但仍受时间闸约束）
     */
    /** 判断当前页面是否为仅保留的「错题本」或「我的习题」页面 */
    function isSupportedQuestionPage(): boolean {
      try {
        const href = String(location.href || '').toLowerCase();
        const combined = String((location.pathname || '') + (location.hash || '')).toLowerCase();
        if (combined.includes('mywrongquestions')) return true;
        if (combined.includes('/mypaper') && /(wrong|mistake)/i.test(href)) return true;
        if (combined.includes('myquestions')) return true;
        if (/[?&#](?:tab|page|view|type)=myquestions(?:&|$)/i.test(href)) return true;
        return false;
      } catch (e) {
        return false;
      }
    }

    function questionIdCandidates(forceFiber?: boolean) {
      if (!isSupportedQuestionPage()) {
        return { count: 0, ids: [], metas: state.exerciseMetas };
      }
      // 1. 增量扫描未处理过的捕获（旧版每次全量重扫，是明显的重复计算）
      const KEY_RE = /"(?:source_document_id|question_id|questionId|resource_id|resourceId)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;
      const ID_IN_SEARCH_RE = /"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;
      for (let i = 0; i < state.captures.length; i++) {
        const cap = state.captures[i];
        if (cap._scanned) continue;
        cap._scanned = true;
        state._totalScanned++;
        const body = String(cap.body || '');
        const url = String(cap.url || '');
        let m;
        KEY_RE.lastIndex = 0;
        while ((m = KEY_RE.exec(body))) addCandidate(m[1], url, cap.t);
        if (/questions|tm_sync|search\/query|query_category/i.test(url) || /resource_type_code["']\s*:\s*["']questions/i.test(body)) {
          ID_IN_SEARCH_RE.lastIndex = 0;
          let mId;
          while ((mId = ID_IN_SEARCH_RE.exec(body))) {
            // 该 UUID 是平台固定的分类节点 ID，不是题目
            if (mId[1] !== '2373f050-d82b-4656-a3bf-4a8fc1a16d78') addCandidate(mId[1], url + ':search_item', cap.t);
          }
        }
        extractUrlQids(url, (uId) => addCandidate(uId, url, cap.t));
      }

      // 2. performance 资源记录（覆盖 QuestionPlayer 发起的 data.json / details.json / item.json）
      try {
        if (W.performance && typeof W.performance.getEntriesByType === 'function') {
          const entries = W.performance.getEntriesByType('resource') || [];
          for (let j = 0; j < entries.length; j++) {
            const rUrl = entries[j] && entries[j].name;
            extractUrlQids(rUrl, (uId) => addCandidate(uId, 'perf', Date.now()));
          }
        }
      } catch (e) { /* ignore */ }

      // 3. 主世界 React Fiber 扫描（Fiber 树随渲染变化，需 dirty 闸 + 时间闸双重约束）
      const now = Date.now();
      const fiberDue = (now - state._lastFiberScanAt) >= FIBER_MIN_INTERVAL_MS;
      if (fiberDue && (forceFiber || state._fiberDirty || Object.keys(state.candidateIds).length === 0)) {
        state._lastFiberScanAt = now;
        state._fiberDirty = false;
        scanMainWorldFiber((id, from) => addCandidate(id, from, Date.now()));
      }

      const arr = Object.keys(state.candidateIds).map((k) => state.candidateIds[k]);

      // 4. 镜像到 DOM 根节点（供隔离世界 0ms 读取）
      try {
        if (W.document && W.document.documentElement && arr.length > 0) {
          setAttr('data-smartedu-qids', JSON.stringify(arr.map((x: any) => x.id)));
          if (state.exerciseMetas && Object.keys(state.exerciseMetas).length > 0) {
            setAttr('data-smartedu-metas', JSON.stringify(state.exerciseMetas));
          }
        }
      } catch (e) { /* ignore */ }

      return { count: arr.length, ids: arr, metas: state.exerciseMetas };
    }

    /**
     * 节流的候选刷新：接口密集命中时合并成一次，避免每条响应都跑 Fiber 扫描。
     * 仅在「近期确有针对题目的响应」时才需要重算。
     */
    function scheduleCandidateRefresh() {
      if (!isSupportedQuestionPage()) return;
      const now = Date.now();
      const wait = Math.max(0, CANDIDATE_REFRESH_MS - (now - state._lastCandidateRefreshAt));
      if (state._refreshTimer) return;
      state._refreshTimer = W.setTimeout(() => {
        state._refreshTimer = 0;
        state._lastCandidateRefreshAt = Date.now();
        try { questionIdCandidates(false); } catch (e) { /* ignore */ }
        try { syncDomBridge(); } catch (e) { /* ignore */ }
      }, wait);
    }

    /**
     * 记录一条命中的响应。
     * @param fullText 完整响应体（解析必须用完整的，存档才用截断的）
     */
    function recordCapture(url: string, method: string, fullText: string) {
      try {
        if (!url || !URL_KEY.test(String(url))) return;
        const full = fullText || '';
        const isLarge = full.length > LARGE_BODY_THRESHOLD;
        const cap = {
          t: Date.now(),
          method: (method || 'GET').toUpperCase(),
          url: String(url),
          size: full.length,
          truncated: isLarge,
          body: isLarge
            ? full.slice(0, LARGE_BODY_LIMIT) + '…[truncated ' + (full.length - LARGE_BODY_LIMIT) + ' chars]'
            : full.slice(0, BODY_LIMIT),
          _scanned: false
        };
        state.captures.push(cap);
        if (state.captures.length > MAX_CAPTURES) state.captures.shift();

        // 被动记录最近访问的教材 ID（供自主学习目录同步兜底使用）
        const tmMatch = String(url).match(TM_URL_RE);
        if (tmMatch && tmMatch[1]) state.lastTextbookId = tmMatch[1];

        // 结构化解析必须使用完整 body（截断后的 JSON 解析必然失败）
        const isWrongRecordApi = WRONG_RECORD_KEY.test(String(url));
        if (isWrongRecordApi) ingestWrongRecords(url, full);

        const supportedPage = isSupportedQuestionPage();
        syncDomBridge();
        // 仅在「错题本 / 我的习题」页面才触发题目候选刷新与消息派发
        if (supportedPage && /query_category|api_static\/questions|ndrs\/questions|esp\/questions|search\/query|user_teachingmaterials/i.test(String(url))) {
          scheduleCandidateRefresh();
        }

        if (supportedPage || isWrongRecordApi) {
          try {
            W.postMessage({ __smarteduWrong: 'api', capture: cap }, '*');
          } catch (e) { /* ignore */ }
        }

        try {
          console.log(
            `%c[错题API嗅探] ${cap.method} ${cap.url} (${cap.size} bytes)`,
            'color:#0ea5e9;font-weight:bold'
          );
        } catch (e) { /* ignore */ }
      } catch (e) { /* ignore */ }
    }

    // ───────────────────────────────────────────────────────────────
    // 世界钩子：fetch / XHR
    // ───────────────────────────────────────────────────────────────
    try {
      const origFetch = W.fetch;
      if (typeof origFetch === 'function' && !origFetch.__smarteduPatched) {
        const patched = function (this: any, input: any, init: any) {
          let url = '';
          try {
            url = typeof input === 'string' ? input : (input && input.url) || '';
          } catch (e) { /* ignore */ }
          const method = (init && init.method) || (input && input.method) || 'GET';
          const p = origFetch.apply(this, arguments as any);
          try {
            if (p && typeof p.then === 'function') {
              p.then((resp: any) => {
                try {
                  if (url && URL_KEY.test(url) && resp && typeof resp.clone === 'function') {
                    resp.clone().text()
                      .then((txt: string) => recordCapture(url, method, txt))
                      .catch(() => {});
                  }
                } catch (e) { /* ignore */ }
              }).catch(() => {});
            }
          } catch (e) { /* ignore */ }
          return p;
        };
        patched.__smarteduPatched = true;
        W.fetch = patched;
      }
    } catch (e) { /* ignore */ }

    try {
      const OrigXHR = W.XMLHttpRequest;
      if (OrigXHR && OrigXHR.prototype && !OrigXHR.prototype.__smarteduPatched) {
        const origOpen = OrigXHR.prototype.open;
        const origSend = OrigXHR.prototype.send;

        OrigXHR.prototype.open = function (method: string, url: string) {
          try {
            (this as any).__smarteduUrl = url;
            (this as any).__smarteduMethod = method;
          } catch (e) { /* ignore */ }
          return origOpen.apply(this, arguments as any);
        };

        OrigXHR.prototype.send = function () {
          const xhr: any = this;
          const url = xhr.__smarteduUrl;
          const method = xhr.__smarteduMethod || 'GET';
          if (url && URL_KEY.test(url)) {
            xhr.addEventListener('load', function () {
              try {
                let txt = '';
                const rt = xhr.responseType;
                if (!rt || rt === 'text') {
                  txt = xhr.responseText || '';
                } else if (rt === 'json') {
                  txt = (xhr.response && typeof xhr.response === 'object')
                    ? JSON.stringify(xhr.response)
                    : String(xhr.response || '');
                }
                recordCapture(url, method, txt);
              } catch (e) { /* ignore */ }
            });
          }
          return origSend.apply(this, arguments as any);
        };
        OrigXHR.prototype.__smarteduPatched = true;
      }
    } catch (e) { /* ignore */ }

    // ───────────────────────────────────────────────────────────────
    // 对外句柄
    // ───────────────────────────────────────────────────────────────
    state.wrongQuestions = function () {
      return {
        teachingmaterial_id: state.wrong.teachingmaterial_id,
        count: wrongCount(),
        questions: Object.keys(state.wrong.byQuestionId).map((k) => state.wrong.byQuestionId[k]),
        sources: state.wrong.sources
      };
    };

    state.find = function (keyword: string) {
      const k = String(keyword || '').toLowerCase();
      return state.captures.filter((c: any) => String(c.url).toLowerCase().indexOf(k) >= 0);
    };

    state.questionIdCandidates = questionIdCandidates;

    // ───────────────────────────────────────────────────────────────
    // 跨世界问答桥（隔离世界的 window 不共享属性，只能 postMessage）
    // ───────────────────────────────────────────────────────────────
    try {
      W.addEventListener('message', function (ev: MessageEvent) {
        let d: any = null;
        try { d = ev && ev.data; } catch (e) { return; }
        if (!d || typeof d !== 'object' || !d.__smarteduWrongQuery) return;

        if (d.__smarteduWrongQuery === 'wrongQuestions') {
          let payload: any = null;
          try { payload = state.wrongQuestions(); } catch (e) { payload = null; }
          try { W.postMessage({ __smarteduWrongAnswer: d.reqId, ok: !!payload, data: payload }, '*'); } catch (e) { /* ignore */ }
          return;
        }

        if (d.__smarteduWrongQuery === 'questionIds') {
          let payload: any = null;
          try { payload = questionIdCandidates(true); } catch (e) { payload = null; }
          try { W.postMessage({ __smarteduWrongAnswer: d.reqId, ok: !!payload, data: payload }, '*'); } catch (e) { /* ignore */ }
        }
      });
      state.bridgeReady = true;
    } catch (e) {
      state.bridgeReady = false;
    }

    // ───────────────────────────────────────────────────────────────
    // 主世界 SPA 路由跳转钩子（派发跨世界 DOM 事件 smartedu-route-change）
    // 为什么必须在 MAIN world 挂载：页面 SPA 调用的是主世界 window.history，
    // 隔离世界重写 history.pushState 无法拦截主世界的程序化路由跳转。
    // ───────────────────────────────────────────────────────────────
    const clearStaleQuestionBridge = () => {
      try {
        if (!isSupportedQuestionPage()) {
          state.candidateIds = Object.create(null);
          state._fiberDirty = false;
          if (W.document && W.document.documentElement) {
            W.document.documentElement.removeAttribute('data-smartedu-qids');
            W.document.documentElement.removeAttribute('data-smartedu-metas');
          }
        }
      } catch (e) { /* ignore */ }
    };

    try {
      const H: any = W.history;
      if (H && !H.__smarteduRoutePatched) {
        const origPush = H.pushState;
        if (typeof origPush === 'function') {
          H.pushState = function () {
            const ret = origPush.apply(this, arguments as any);
            clearStaleQuestionBridge();
            try { W.dispatchEvent(new Event('smartedu-route-change')); } catch (e) { /* ignore */ }
            return ret;
          };
        }
        const origReplace = H.replaceState;
        if (typeof origReplace === 'function') {
          H.replaceState = function () {
            const ret = origReplace.apply(this, arguments as any);
            clearStaleQuestionBridge();
            try { W.dispatchEvent(new Event('smartedu-route-change')); } catch (e) { /* ignore */ }
            return ret;
          };
        }
        W.addEventListener('hashchange', clearStaleQuestionBridge);
        W.addEventListener('popstate', clearStaleQuestionBridge);
        H.__smarteduRoutePatched = true;
      }
    } catch (e) { /* ignore */ }

    // ───────────────────────────────────────────────────────────────
    // Fiber dirty 闸：仅在「错题本 / 我的习题」页面才标记重扫，其余页面不触发
    // ───────────────────────────────────────────────────────────────
    try {
      const mo = new MutationObserver(() => {
        if (isSupportedQuestionPage()) {
          state._fiberDirty = true;
        }
      });
      mo.observe(W.document, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }

    syncDomBridge();

    try {
      console.log(
        `%c[错题API嗅探] 已注入主世界 v${state.version}（控制台可执行 __SMARTEDU_WRONG_SNIFFER__.wrongQuestions() 取错题 ID 清单）`,
        'background:#0ea5e9;color:#fff;padding:3px 8px;border-radius:4px;'
      );
    } catch (e) { /* ignore */ }
  }
});
