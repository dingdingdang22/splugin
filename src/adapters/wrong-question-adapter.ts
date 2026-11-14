/**
 * wrong-question-adapter.ts - 智慧平台「我的错题」与「习题库」页面适配层 (TypeScript / ESM)
 *
 * 本文件是**唯一允许出现站点选择器**的地方：站点改版只改这里，其余模块零改动。
 * 选择器一律使用语义类名（`exercises-item` / `paper-container`），
 * 严禁使用 Vue scoped 哈希（`data-v-xxxx`）、React `__jsx` 或构建期随机类名 —— 每次构建都会变。
 *
 * ── ID 采集的多路设计（按「代价从低到高」排序，命中即短路）─────────────────
 *  0) `<html data-smartedu-qids>`     主世界镜像属性，0ms，最廉价
 *  1) performance 资源记录             覆盖 QuestionPlayer 实际拉过的 data/details/item.json
 *  2) DOM 属性（question-id / data-*） 卡片自带 ID 时最可靠
 *  3) iframe src / 当前页 URL 参数      单题练习页与内嵌播放器场景
 *  4) 跨世界消息桥（异步）              主世界 captures + React Fiber 抽取的紧凑结果
 *  5) 隔离世界 Fiber 深挖（opt-in）     MV3 下通常取不到 `__reactFiber$`，默认关闭
 *  6) 文档 HTML 正则（兜底）            仅在以上全空时执行，且有 TTL 缓存与长度上限
 *
 * 性能红线：`documentElement.innerHTML` 是整页字符串（可达数 MB），
 * 旧实现每 600ms 全量正则扫一遍，是主线程卡顿的主要来源。
 * 现改为「兜底通道 + 4s TTL + 1.2MB 截断」，正常页面根本不会走到。
 */

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QID_PARAM_RE = /(?:question[_-]?id|resource[_-]?id)=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** URL 里内嵌题目 ID 的判据（习题库/题包/CDN 三种典型形态） */
const URL_QID_PATTERNS = [
  /\/api_static\/questions\/(?:[^/?#]+_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/data\.json/gi,
  /\/ndrs\/questions\/resources\/details\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json/gi,
  /\/edu_product\/esp\/questions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:@\d+)?\.pkg\//gi,
  /\/e-question-bank-web\.[^/]+\/questions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
  /[?&](?:question|resource)[_-]?id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi
];

/** 文档 HTML 兜底扫描的缓存与上限 */
const HTML_SCAN_TTL_MS = 4000;
const HTML_SCAN_MAX_CHARS = 1_200_000;

/** 元数据收集的 DOM 预算（页面卡片可能上千个，必须设上限） */
const META_CARD_BUDGET = 120;
const META_PANEL_BUDGET = 40;
const META_CACHE_TTL_MS = 1500;

const DIFFICULTY_MAP: Record<string, string> = {
  '非常简单': '易', '极易': '易', '容易': '易', '简单': '易', '易': '易', '很易': '易', 'easy': '易',
  '较易': '较易', '偏易': '较易', '稍易': '较易',
  '适中': '中', '中等': '中', '一般': '中', '普通': '中', '中': '中', 'medium': '中',
  '偏难': '较难', '较难': '较难', '稍难': '较难',
  '困难': '难', '非常困难': '难', '极难': '难', '难': '难', '很难': '难', 'hard': '难'
};

export const WrongQuestionAdapter = {
  PAGE_PATH: '/myPaper/onlineJudge/myWrongQuestions',
  EXERCISE_PATH: '/myPaper/onlineJudge/myQuestions',

  PAGE_MODES: {
    WRONG_BOOK: 'wrong_book',
    MY_EXERCISES: 'my_exercises',
    OTHER: 'other'
  },

  /** HTML 兜底扫描缓存 */
  _htmlScanCache: { at: 0, ids: [] as string[] },
  /** 元数据缓存（同一批次的 20 道题不应重复解析同一份 DOM） */
  _metaCache: { at: 0, map: null as any },

  /**
   * 精准检测当前页面所属模式。
   * 仅匹配「我的错题本」（/myPaper/onlineJudge/myWrongQuestions）与
   * 「我的习题」（/myPaper/onlineJudge/myQuestions），其余所有试题/练习/作业页一律不探测。
   */
  detectPageMode(loc?: Location): string {
    const l = loc || (typeof window !== 'undefined' ? window.location : ({} as Location));
    const path = (l.pathname || '').toLowerCase();
    const search = (l.search || '').toLowerCase();
    const hash = (l.hash || '').toLowerCase();
    const route = path + hash;
    const full = path + search + hash;

    // 1. 我的错题本
    if (
      route.includes('mywrongquestions') ||
      (path.includes('/mypaper') && (route.includes('wrong') || route.includes('mistake')))
    ) {
      return this.PAGE_MODES.WRONG_BOOK;
    }

    // 2. 我的习题
    if (route.includes('myquestions') || /[?&#](?:tab|page|view|type)=myquestions(?:&|$)/i.test(full)) {
      return this.PAGE_MODES.MY_EXERCISES;
    }

    return this.PAGE_MODES.OTHER;
  },

  /** 取元素文本：浏览器优先 innerText（尊重渲染换行），退化 textContent */
  _text(el?: Element | null): string {
    if (!el) return '';
    if (typeof (el as HTMLElement).innerText === 'string' && (el as HTMLElement).innerText.trim()) {
      return (el as HTMLElement).innerText;
    }
    return el.textContent || '';
  },

  /** 将块内文本按「可视行」拆分（jsdom 下按块级元素补换行） */
  _lines(block: Element): string[] {
    const raw = (block as HTMLElement).innerText;
    if (typeof raw === 'string' && raw.trim()) {
      return raw.split('\n').map(s => s.trim()).filter(Boolean);
    }
    const lines: string[] = [];
    const BLOCK_TAGS = /^(DIV|P|LI|BR|TR|SECTION|ARTICLE|HEADER|FOOTER|H1|H2|H3|H4|H5|H6|DD|DT|SPAN)$/;
    const push = (txt?: string | null) => {
      const t = (txt || '').replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
    };
    const walk = (node: Node) => {
      node.childNodes.forEach(child => {
        if (child.nodeType === 3) {
          push(child.nodeValue);
        } else if (child.nodeType === 1) {
          if ((child as HTMLElement).tagName === 'BR') {
            lines.push('');
          } else {
            walk(child);
            if (BLOCK_TAGS.test((child as HTMLElement).tagName)) lines.push('');
          }
        }
      });
    };
    try { walk(block); } catch (e) {}
    return lines.map(s => s.trim()).filter(Boolean);
  },

  isWrongQuestionPage(loc?: Location): boolean {
    const mode = this.detectPageMode(loc);
    return mode === this.PAGE_MODES.WRONG_BOOK || mode === this.PAGE_MODES.MY_EXERCISES;
  },

  // ─────────────────────────────────────────────────────────────
  // 题干/元数据提取
  // ─────────────────────────────────────────────────────────────

  extractStemHintFromDom(el?: Element | null): string {
    if (!el) return '';
    const stemSel = el.querySelector('[class*="stem"], [class*="title"], [class*="question-title"], [class*="q-title"], [class*="content"]');
    let raw = stemSel ? this._text(stemSel) : '';
    if (!raw || raw.length < 5) raw = this._text(el);
    return this.cleanStemZh(raw);
  },

  cleanStemZh(s?: string | null): string {
    if (!s) return '';
    let t = String(s)
      .replace(/<[^>]+>/g, '')
      .split(/(?:\n\s*[A-Da-d][\.\s、]|\n\s*步骤|\n\s*参考答案|\n\s*习题信息|\n\s*facility|\n\s*知识点|\n\s*AI解析|\n\s*show answer)/i)[0]
      .trim();
    t = t.replace(/^[0-9一二三四五六七八九十\.\、\,\s\(\)\（\）]+/g, '');
    t = t.replace(/^(?:题目解析|试题解析|单选题|多选题|问答题|填空题|解答题|判断题|单选|多选|问答|填空|解答|判断)[\、\.\s]*/g, '');
    return t.replace(/[^\u4e00-\u9fa5]/g, '');
  },

  matchStemZh(a?: string | null, b?: string | null): boolean {
    const ca = this.cleanStemZh(a);
    const cb = this.cleanStemZh(b);
    if (!ca || !cb) return false;
    if (ca === cb) return true;
    const l = Math.min(ca.length, cb.length, 6);
    if (l < 4) return false;
    const subA = ca.slice(0, l);
    const subB = cb.slice(0, l);
    return ca.includes(subB) || cb.includes(subA);
  },

  /**
   * 从 DOM 容器中提取【习题信息】结构化元数据：
   * 知识点 / 难易度 / 更新时间 / 主讲人 / 文字解析 / 参考答案。
   */
  extractExerciseInfoFromDom(node?: Element | Document | null) {
    if (!node) return null;
    const text = (this._text(node as Element) || '').replace(/\r/g, '');
    if (!text) return null;

    const res: any = {
      knowledge_points: [],
      difficulty: null,
      difficulty_raw: null,
      update_time: null,
      teacher: null,
      analysis_text: null,
      correct_answer: null
    };

    // 1. 知识点：兼容「知识点：X」「【知识点】X」「考点：X」，并截断混入的按钮文案
    const kpMatch = /(?:知识点|【知识点】|考点|对应考点|标签)\s*[：:]?\s*(?:[ \t]*\n[ \t]*)?([^\n\r<]+)/i.exec(text);
    if (kpMatch && kpMatch[1]) {
      let rawKp = kpMatch[1].trim();
      rawKp = rawKp.replace(/(?:AI解析|show answer|remove|ExamBasket|难易度|难度|facility|更新时间|主讲人|[0-9]+[．\.]|from)[\s\S]*/i, '').trim();
      rawKp = rawKp.replace(/[。；;，,\.]+$/, '').trim();
      if (rawKp && !/^(?:暂无|无|-|--)$/.test(rawKp)) {
        const parts = rawKp.split(/[、，,；;\s]+/).map(s => s.trim()).filter(s => s && s.length > 0 && !/^(?:暂无|无|-)$/.test(s));
        if (parts.length > 0) res.knowledge_points = parts;
      }
    }

    // 2. 难易度：兼容「难易度：困难」「facility value：非常简单」
    const diffMatch = /(?:难易度|难度|facility\s*value)\s*[：:]\s*(?:[ \t]*\n[ \t]*)?([^\n\r<]+)/i.exec(text);
    if (diffMatch && diffMatch[1]) {
      let rawDiff = diffMatch[1].trim();
      rawDiff = rawDiff.split(/\s+|from|知识点/i)[0].trim();
      if (rawDiff && !/^(?:暂无|无|-)$/.test(rawDiff)) {
        res.difficulty_raw = rawDiff;
      }
    }
    // 星级补充（难易度★★★★）
    if (!res.difficulty_raw) {
      const starMatch = /难易度\s*([★☆]+)/i.exec(text);
      if (starMatch && starMatch[1]) {
        const starCount = (starMatch[1].match(/★/g) || []).length;
        if (starCount >= 4) res.difficulty_raw = '困难';
        else if (starCount === 3) res.difficulty_raw = '适中';
        else if (starCount === 2) res.difficulty_raw = '简单';
        else if (starCount === 1) res.difficulty_raw = '非常简单';
      }
    }
    if (res.difficulty_raw) {
      const s = res.difficulty_raw.trim();
      if (DIFFICULTY_MAP[s]) res.difficulty = DIFFICULTY_MAP[s];
      else if (/(?:极难|非常困难|困难|很难|特难|难)/.test(s)) res.difficulty = '难';
      else if (/(?:偏难|较难|稍难)/.test(s)) res.difficulty = '较难';
      else if (/(?:适中|中等|一般|普通|中)/.test(s)) res.difficulty = '中';
      else if (/(?:较易|偏易|稍易)/.test(s)) res.difficulty = '较易';
      else if (/(?:极易|非常简单|容易|简单|很易|易)/.test(s)) res.difficulty = '易';
      else res.difficulty = '中';
    }

    // 3. 更新时间
    const timeMatch = /更新时间\s*[：:]\s*(?:[ \t]*\n[ \t]*)?([0-9\/\-:\s]{10,20})/i.exec(text);
    if (timeMatch && timeMatch[1]) res.update_time = timeMatch[1].trim();

    // 4. 主讲人
    const teacherMatch = /主讲人\s*[：:]\s*(?:[ \t]*\n[ \t]*)?([^\n\r<]+)/i.exec(text);
    if (teacherMatch && teacherMatch[1]) res.teacher = teacherMatch[1].split(/\s+|查看/)[0].trim();

    // 5. 文字解析
    const anaMatch = /(?:[|｜]?\s*解析[：:\s]+)([\s\S]*?)(?=[|｜]?\s*正确答案|[|｜]?\s*习题信息|$)/i.exec(text);
    if (anaMatch && anaMatch[1]) {
      const at = anaMatch[1].trim();
      if (at.length > 5) res.analysis_text = at;
    }

    // 6. 正确答案
    const ansMatch = /(?:[|｜]?\s*正确答案[：:\s]*)([^\n\r<]+)/i.exec(text);
    if (ansMatch && ansMatch[1]) {
      const at = ansMatch[1].trim();
      if (at) res.correct_answer = at;
    }

    return res;
  },

  /**
   * 收集全页面试题元数据映射表与特征仓储。
   *
   * 聚合四类来源：
   *   1. 主世界镜像的 `data-smartedu-metas`（0ms 跨世界通道）；
   *   2. 页面中的试题卡片（题干文本 + facility/知识点，支持题干模糊配对与序号配对）；
   *   3. 试题解析抽屉 / AI 答疑弹窗里的【习题信息】区块；
   *   4. （隔离世界尽力而为）React Fiber props。
   *
   * 性能：卡片扫描有数量预算 + 文本长度上限，同一批次的重复调用走 1.5s TTL 缓存。
   */
  collectExerciseMetas() {
    const metaMap: any = new Map();
    if (typeof document === 'undefined') return metaMap;

    const now = Date.now();
    if (this._metaCache.map && now - this._metaCache.at < META_CACHE_TTL_MS) {
      return this._metaCache.map;
    }

    const cardEntries: any[] = [];
    const drawerEntries: any[] = [];
    let globalAnalysisInfo: any = null;

    const setMeta = (id: string, info: any) => {
      if (!id || typeof id !== 'string' || !info) return;
      const s = id.trim().toLowerCase();
      if (s.length !== 36 && s !== '__current_analysis__') return;
      if (s !== '__current_analysis__' && !UUID_ONLY.test(s)) return;

      const prev = metaMap.get(s) || {
        knowledge_points: [],
        difficulty: null,
        difficulty_raw: null,
        update_time: null,
        teacher: null,
        analysis_text: null,
        correct_answer: null
      };

      if (Array.isArray(info.knowledge_points) && info.knowledge_points.length > 0) {
        prev.knowledge_points = Array.from(new Set(prev.knowledge_points.concat(info.knowledge_points)));
      }
      if (info.difficulty && !prev.difficulty) {
        prev.difficulty = info.difficulty;
        prev.difficulty_raw = info.difficulty_raw;
      }
      if (!prev.difficulty_raw && info.difficulty_raw) prev.difficulty_raw = info.difficulty_raw;
      if (info.update_time && !prev.update_time) prev.update_time = info.update_time;
      if (info.teacher && !prev.teacher) prev.teacher = info.teacher;
      if (info.analysis_text && !prev.analysis_text) prev.analysis_text = info.analysis_text;
      if (info.correct_answer && !prev.correct_answer) prev.correct_answer = info.correct_answer;
      metaMap.set(s, prev);
    };

    // 0. 主世界镜像的元数据
    try {
      if (document.documentElement) {
        const rawM = document.documentElement.getAttribute('data-smartedu-metas');
        if (rawM) {
          const obj = JSON.parse(rawM);
          for (const k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) setMeta(k, obj[k]);
          }
        }
      }
    } catch (e) {}

    // 1. 试题卡片扫描（DOM 无 qid 属性时也记录题干，供模糊配对）
    try {
      const cardEls = document.querySelectorAll('[class*="exercises-item"], [class*="paper-container"], [class*="player_container"], [class*="chapter-exercise"], micro-app, [class*="card"], [class*="item"], [class*="question"]');
      let cardIdx = 0;
      const limit = Math.min(cardEls.length, META_CARD_BUDGET);
      for (let i = 0; i < limit; i++) {
        const card: any = cardEls[i];
        let qid = card.getAttribute('question-id') || card.getAttribute('data-question-id') || card.getAttribute('data-resource-id') || card.getAttribute('data-id');
        if (!qid) {
          const ifr = card.querySelector('iframe');
          if (ifr) {
            const m = /\/questions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(ifr.getAttribute('src') || ifr.src || '');
            if (m) qid = m[1];
          }
        }
        const rawText = this._text(card);
        // 超大容器（整页 wrapper）跳过，避免正则跑在几万字文本上
        if (rawText.length > 4000) continue;
        const info = this.extractExerciseInfoFromDom(card);
        const stemHint = this.extractStemHintFromDom(card);
        if (info && (info.knowledge_points.length > 0 || info.difficulty)) {
          if (qid) setMeta(qid, info);
          cardEntries.push({ index: cardIdx, qid: qid || null, stemHint, info });
          cardIdx++;
        } else if (stemHint && stemHint.length >= 4) {
          cardEntries.push({ index: cardIdx, qid: qid || null, stemHint, info: null });
          cardIdx++;
        }
      }
    } catch (e) {}

    // 2. 解析抽屉 / 详情区域（Exercise Analysis / AI 答疑弹窗）
    try {
      const analysisPanels = document.querySelectorAll('[class*="analysis"], [class*="detail"], [class*="drawer"], [class*="modal"], [class*="dialog"], [class*="right"], [class*="pad"]');
      const limit = Math.min(analysisPanels.length, META_PANEL_BUDGET);
      for (let i = 0; i < limit; i++) {
        const p: any = analysisPanels[i];
        const txt = this._text(p);
        if (!/(?:习题信息|exercise analysis|题目解析|参考答案)/i.test(txt)) continue;
        if (txt.length > 8000) continue;
        const info = this.extractExerciseInfoFromDom(p);
        const stemHint = this.extractStemHintFromDom(p);
        let pQid = p.getAttribute('question-id') || p.getAttribute('data-question-id') || p.getAttribute('data-resource-id');
        if (!pQid) {
          const ifr = p.querySelector('iframe');
          if (ifr) {
            const m = /\/questions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(ifr.getAttribute('src') || ifr.src || '');
            if (m) pQid = m[1];
          }
        }
        if (info && (info.knowledge_points.length > 0 || info.difficulty)) {
          if (pQid) setMeta(pQid, info);
          drawerEntries.push({ stemHint, info, qid: pQid || null });
          globalAnalysisInfo = info;
        }
      }

      // 局部容器没抓到则扫一次 body（仅当页面确实出现「习题信息」字样）
      if (!globalAnalysisInfo && document.body) {
        const bodyTxt = this._text(document.body);
        if (/习题信息/i.test(bodyTxt)) {
          globalAnalysisInfo = this.extractExerciseInfoFromDom(document.body);
          const globalStem = this.extractStemHintFromDom(document.body);
          if (globalAnalysisInfo) drawerEntries.push({ stemHint: globalStem, info: globalAnalysisInfo, qid: null });
        }
      }
    } catch (e) {}

    // 3. 隔离世界 Fiber 尽力而为（MV3 下通常取不到，失败即静默）
    try {
      const starts: any[] = [];
      const seenStarts = new Set();
      const allEls = document.querySelectorAll('[class*="question"], [class*="item"], [class*="card"]');
      for (let i = 0; i < allEls.length && starts.length < 40; i++) {
        const el: any = allEls[i];
        let ks: string[];
        try { ks = Object.keys(el); } catch (e) { continue; }
        for (let j = 0; j < ks.length; j++) {
          if (ks[j].indexOf('__reactFiber$') === 0) {
            const f = el[ks[j]];
            if (f && !seenStarts.has(f)) { seenStarts.add(f); starts.push(f); }
          }
        }
      }

      if (starts.length > 0) {
        const seenObjs = new Set();
        let visited = 0;
        const scanFiberObj = (o: any, depth: number) => {
          if (!o || typeof o !== 'object' || depth > 4 || visited > 3000) return;
          if (seenObjs.has(o)) return;
          seenObjs.add(o);
          visited++;
          const qid = o.source_document_id || o.question_id || o.resourceId || (o.question && o.question.id) || (o.questionData && o.questionData.id) || o.id;
          if (typeof qid === 'string' && UUID_ONLY.test(qid)) {
            const fMeta: any = { knowledge_points: [], difficulty: null, difficulty_raw: null, update_time: null, teacher: null };
            const kps = o.knowledgePoints || o.knowledge_points || o.knowledgeMarks || o.qb_knowledge_points;
            if (Array.isArray(kps)) {
              fMeta.knowledge_points = kps.map((x: any) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
            } else if (typeof kps === 'string' && kps.trim()) {
              fMeta.knowledge_points = kps.split(/[、，,；;\s]+/).map((s: string) => s.trim()).filter(Boolean);
            }
            const diff = o.difficulty || o.difficulty_raw || o.facilityValue || o.facility_value;
            if (typeof diff === 'string' && diff.trim()) {
              fMeta.difficulty_raw = diff.trim();
              fMeta.difficulty = DIFFICULTY_MAP[fMeta.difficulty_raw] || (/(?:困难|极难|难)/.test(fMeta.difficulty_raw) ? '难' : (/(?:适中|中)/.test(fMeta.difficulty_raw) ? '中' : '易'));
            }
            if (o.updateTime || o.update_time) fMeta.update_time = o.updateTime || o.update_time;
            if (o.teacherName || o.teacher_name || o.teacher) fMeta.teacher = o.teacherName || o.teacher_name || o.teacher;
            if (fMeta.knowledge_points.length > 0 || fMeta.difficulty) setMeta(qid, fMeta);
          }
          for (const k in o) {
            if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
            if (k === 'GlobalWindow' || k === 'window' || k === 'document') continue;
            try {
              if (o[k] && typeof o[k] === 'object') scanFiberObj(o[k], depth + 1);
            } catch (e) {}
          }
        };
        starts.forEach((f: any) => {
          if (f.memoizedProps) scanFiberObj(f.memoizedProps, 0);
          if (f.stateNode && typeof f.stateNode === 'object') {
            if (f.stateNode.props) scanFiberObj(f.stateNode.props, 0);
            if (f.stateNode.questionAnalysisRightData) scanFiberObj(f.stateNode.questionAnalysisRightData, 0);
            if (f.stateNode.currentQuestionDetail) scanFiberObj(f.stateNode.currentQuestionDetail, 0);
          }
        });
      }
    } catch (e) {}

    // 4. 五级级联查找
    const self = this;
    metaMap.cardEntries = cardEntries;
    metaMap.drawerEntries = drawerEntries;
    metaMap.globalAnalysisInfo = globalAnalysisInfo;

    metaMap.findMeta = function (qid: string, stemText?: string, index?: number) {
      let result: any = null;
      const normQid = (qid && typeof qid === 'string') ? qid.trim().toLowerCase() : '';

      const mergeInfo = (target: any, source: any) => {
        if (!source) return target;
        if (!target) target = {
          knowledge_points: [],
          difficulty: null,
          difficulty_raw: null,
          update_time: null,
          teacher: null,
          analysis_text: null,
          correct_answer: null
        };
        if (Array.isArray(source.knowledge_points) && source.knowledge_points.length > 0) {
          target.knowledge_points = Array.from(new Set(target.knowledge_points.concat(source.knowledge_points)));
        }
        if (!target.difficulty && source.difficulty) {
          target.difficulty = source.difficulty;
          target.difficulty_raw = source.difficulty_raw || source.difficulty;
        }
        if (!target.difficulty_raw && source.difficulty_raw) target.difficulty_raw = source.difficulty_raw;
        if (source.update_time && !target.update_time) target.update_time = source.update_time;
        if (source.teacher && !target.teacher) target.teacher = source.teacher;
        if (source.analysis_text && !target.analysis_text) target.analysis_text = source.analysis_text;
        if (source.correct_answer && !target.correct_answer) target.correct_answer = source.correct_answer;
        return target;
      };

      // 1. 精确 ID
      if (normQid && metaMap.has(normQid)) result = mergeInfo(result, metaMap.get(normQid));

      // 2. 解析抽屉题干比对（权威度最高）
      if (stemText && drawerEntries.length > 0) {
        for (let d = 0; d < drawerEntries.length; d++) {
          const de = drawerEntries[d];
          if (de && de.stemHint && self.matchStemZh(stemText, de.stemHint)) {
            result = mergeInfo(result, de.info);
            break;
          }
        }
      }

      // 3. 列表卡片题干比对
      if (stemText && cardEntries.length > 0) {
        for (let c = 0; c < cardEntries.length; c++) {
          const ce = cardEntries[c];
          if (ce && ce.stemHint && self.matchStemZh(stemText, ce.stemHint)) {
            result = mergeInfo(result, ce.info);
            break;
          }
        }
      }

      // 4. 当前打开的抽屉兜底
      if (globalAnalysisInfo && (!result || result.knowledge_points.length === 0)) {
        let activeIndex = -1;
        try {
          const activeEl = document.querySelector('[class*="active"], [class*="selected"], [aria-selected="true"]');
          if (activeEl) {
            const allCards = document.querySelectorAll('[class*="exercises-item"], [class*="paper-container"]');
            for (let ac = 0; ac < allCards.length; ac++) {
              if (allCards[ac] === activeEl || allCards[ac].contains(activeEl)) { activeIndex = ac; break; }
            }
          }
        } catch (e) {}
        if (activeIndex >= 0 && index === activeIndex) {
          result = mergeInfo(result, globalAnalysisInfo);
        } else if (drawerEntries.length === 1 && !drawerEntries[0].stemHint) {
          result = mergeInfo(result, globalAnalysisInfo);
        }
      }

      // 5. 卡片位置索引兜底
      if (typeof index === 'number' && index >= 0 && index < cardEntries.length) {
        const ce = cardEntries[index];
        if (ce && ce.info && (!result || result.knowledge_points.length === 0)) result = mergeInfo(result, ce.info);
      }

      return result;
    };

    this._metaCache = { at: Date.now(), map: metaMap };
    return metaMap;
  },

  /** 元数据指纹：判断用户是否打开了新抽屉/加载了新卡片（用于探针去重签名） */
  getMetaSignature(): string {
    let str = '';
    try {
      if (typeof document === 'undefined') return '';
      const metas = document.querySelectorAll('[class*="exercise-info"], [class*="analysis"], [class*="tags"], [class*="item"]');
      for (let m = 0; m < Math.min(metas.length, 20); m++) {
        const t = this._text(metas[m]);
        if (t.length > 4000) continue;
        const kMatch = /(?:知识点|难易度|facility)\s*[:：]?\s*([^\n\r<]{1,40})/i.exec(t);
        if (kMatch) str += '|' + kMatch[1].trim();
      }
    } catch (e) {}
    return str;
  },

  // ─────────────────────────────────────────────────────────────
  // 题目 ID 采集
  // ─────────────────────────────────────────────────────────────

  /**
   * 文档 HTML 兜底扫描（带 TTL 缓存与长度截断）。
   * 正常页面绝不会走到这里：属性/performance/bridge 三路通常已命中。
   */
  _scanHtmlQids(): string[] {
    const now = Date.now();
    if (now - this._htmlScanCache.at < HTML_SCAN_TTL_MS) return this._htmlScanCache.ids;
    const ids: string[] = [];
    try {
      if (typeof document === 'undefined' || !document.documentElement) return ids;
      let html = document.documentElement.innerHTML || '';
      if (html.length > HTML_SCAN_MAX_CHARS) html = html.slice(0, HTML_SCAN_MAX_CHARS);
      let m;
      QID_PARAM_RE.lastIndex = 0;
      while ((m = QID_PARAM_RE.exec(html))) ids.push(m[1].toLowerCase());
    } catch (e) {}
    this._htmlScanCache = { at: now, ids };
    return ids;
  },

  /**
   * 自动化收集当前页面中的习题/试题 ID（多路聚合，命中即累加）。
   *
   * @param opts.deepFiber 是否允许隔离世界 Fiber 深挖（MV3 下通常取不到，默认关）
   */
  collectExerciseIds(opts: { deepFiber?: boolean } = {}): Array<{ id: string; from: string }> {
    const outMap = new Map<string, { id: string; from: string }>();
    const addId = (id: any, from: string) => {
      if (!id || typeof id !== 'string') return;
      const s = id.trim().toLowerCase();
      if (s.length === 36 && UUID_ONLY.test(s) && !outMap.has(s)) outMap.set(s, { id: s, from });
    };

    const extractUrlQids = (url: string, from: string) => {
      if (!url || typeof url !== 'string' || url.indexOf('/ndr_2d0_') >= 0) return;
      for (let p = 0; p < URL_QID_PATTERNS.length; p++) {
        const re = URL_QID_PATTERNS[p];
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(url))) addId(m[1], from);
      }
      const idsMatch = /[?&]ids=([0-9a-f-,]{36,})/i.exec(url);
      if (idsMatch && idsMatch[1]) {
        const parts = idsMatch[1].split(',');
        for (let i = 0; i < parts.length; i++) {
          const trimmed = parts[i] ? parts[i].trim() : '';
          if (trimmed && UUID_ONLY.test(trimmed)) addId(trimmed, from + ':ids_param');
        }
      }
    };

    // 0. 主世界镜像属性（0ms 通道）
    try {
      if (typeof document !== 'undefined' && document.documentElement) {
        const rawQids = document.documentElement.getAttribute('data-smartedu-qids');
        if (rawQids) {
          const parsed = JSON.parse(rawQids);
          if (Array.isArray(parsed)) parsed.forEach((qid: string) => addId(qid, 'main-bridge-attr'));
        }
      }
    } catch (e) {}

    // 1. performance 资源记录
    try {
      const perf = (typeof window !== 'undefined' && window.performance) || (typeof performance !== 'undefined' ? performance : null);
      if (perf && typeof perf.getEntriesByType === 'function') {
        const entries = perf.getEntriesByType('resource') || [];
        for (let i = 0; i < entries.length; i++) {
          if (entries[i] && entries[i].name) extractUrlQids(entries[i].name, 'performance');
        }
      }
    } catch (e) {}

    // 2. DOM 属性与 iframe
    try {
      if (typeof document !== 'undefined') {
        const els = document.querySelectorAll('[question-id], [data-question-id], [data-questionid], [data-resource-id], [data-resourceid]');
        for (let i = 0; i < els.length; i++) {
          const v = els[i].getAttribute('question-id') || els[i].getAttribute('data-question-id') ||
            els[i].getAttribute('data-questionid') || els[i].getAttribute('data-resource-id') ||
            els[i].getAttribute('data-resourceid');
          if (v) addId(v, 'dom');
        }
        const iframes = document.querySelectorAll('iframe');
        for (let j = 0; j < iframes.length; j++) {
          const src = iframes[j].getAttribute('src') || (iframes[j] as HTMLIFrameElement).src || '';
          const mIfr = /\/questions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(src);
          if (mIfr) addId(mIfr[1], 'iframe');
          if (src) extractUrlQids(src, 'iframe');
        }
      }
    } catch (e) {}

    // 3. 当前页 URL 参数（我的习题页面可能附带的题目 ID）
    try {
      const href = String((typeof window !== 'undefined' && window.location) ? window.location.href : '');
      extractUrlQids(href, 'url_param');
    } catch (e) {}

    // 4. 同世界嗅探器直连（Tampermonkey 场景有效；MV3 隔离世界为 undefined）
    try {
      const sniffer = (typeof window !== 'undefined' && (window as any).__SMARTEDU_WRONG_SNIFFER__) || null;
      if (sniffer && typeof sniffer.questionIdCandidates === 'function') {
        const cand = sniffer.questionIdCandidates(false);
        const list = (cand && cand.ids) || [];
        for (let c = 0; c < list.length; c++) {
          if (list[c] && list[c].id) addId(list[c].id, 'sniffer');
        }
      }
    } catch (e) {}

    // 5. 隔离世界 Fiber 深挖（默认关闭：MV3 下取不到 expando，纯属白烧 CPU）
    if (opts.deepFiber === true && outMap.size === 0) {
      try {
        const starts: any[] = [];
        const seenStarts = new Set();
        const addStart = (el: any) => {
          if (!el) return;
          let ks: string[];
          try { ks = Object.keys(el); } catch (e) { return; }
          for (let j = 0; j < ks.length; j++) {
            if (ks[j].indexOf('__reactFiber$') === 0) {
              const fiber = el[ks[j]];
              if (fiber && !seenStarts.has(fiber)) { seenStarts.add(fiber); starts.push(fiber); }
            }
          }
        };
        if (typeof document !== 'undefined') {
          const cardEls = document.querySelectorAll('[class*="exercises-item"], [class*="paper-container"], [class*="question"]');
          for (let c = 0; c < cardEls.length && starts.length < 40; c++) addStart(cardEls[c]);
        }
        const seenObjs = new Set();
        let visited = 0;
        const scanObj = (o: any, depth: number) => {
          if (!o || typeof o !== 'object' || depth > 4 || visited > 4000) return;
          if (seenObjs.has(o)) return;
          seenObjs.add(o);
          visited++;
          const qid = o.source_document_id || o.question_id || o.resourceId || (o.question && o.question.id) || (o.questionData && o.questionData.id);
          if (typeof qid === 'string' && UUID_ONLY.test(qid)) addId(qid, 'fiber');
          for (const k in o) {
            if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
            if (k === 'GlobalWindow' || k === 'window' || k === 'document') continue;
            try {
              const v = o[k];
              if (typeof v === 'string') {
                if (v.length === 36 && UUID_ONLY.test(v) && /^(?:source_document_id|question|resource|identifier|item)$/i.test(k)) addId(v, 'fiber:' + k);
              } else if (v && typeof v === 'object') {
                scanObj(v, depth + 1);
              }
            } catch (e) {}
          }
        };
        for (let s = 0; s < starts.length; s++) {
          let anc = starts[s];
          for (let up = 0; anc && up < 25; up++) {
            if (anc.memoizedProps) scanObj(anc.memoizedProps, 0);
            if (anc.stateNode && typeof anc.stateNode === 'object') {
              if (anc.stateNode.questionData) scanObj(anc.stateNode.questionData, 0);
              if (anc.stateNode.props) scanObj(anc.stateNode.props, 0);
            }
            anc = anc.return;
          }
        }
      } catch (e) {}
    }

    // 6. 文档 HTML 兜底（仅当前面全空）
    if (outMap.size === 0) {
      const htmlIds = this._scanHtmlQids();
      for (let i = 0; i < htmlIds.length; i++) addId(htmlIds[i], 'dom-html');
    }

    return Array.from(outMap.values());
  },

  /**
   * 通过跨世界 postMessage 桥向主世界嗅探器查询全部题目 ID。
   * 主世界会顺带把元数据写入 `data-smartedu-metas`，供本轮解析融合。
   */
  collectExerciseIdsFromBridge(timeoutMs = 800): Promise<Array<{ id: string; from: string }>> {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || typeof window.postMessage !== 'function') {
        return resolve([]);
      }
      let done = false;
      const finish = (list: any[]) => {
        if (!done) {
          done = true;
          resolve(list || []);
        }
      };
      const timer = setTimeout(() => finish([]), timeoutMs);
      const reqId = 'myq_bridge_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      const onMsg = (ev: MessageEvent) => {
        try {
          const d: any = ev && ev.data;
          if (!d || typeof d !== 'object' || d.__smarteduWrongAnswer !== reqId) return;
          window.removeEventListener('message', onMsg);
          clearTimeout(timer);
          const rawIds = (d.data && Array.isArray(d.data.ids)) ? d.data.ids : [];
          const out: any[] = [];
          for (let i = 0; i < rawIds.length; i++) {
            if (rawIds[i] && rawIds[i].id) {
              out.push({ id: String(rawIds[i].id).toLowerCase(), from: 'bridge:' + (rawIds[i].seen_from || 'main') });
            }
          }
          // 主世界顺带回传的元数据落到 DOM 属性（同一份缓存，避免二次过桥）
          if (d.data && d.data.metas && typeof document !== 'undefined' && document.documentElement) {
            try {
              document.documentElement.setAttribute('data-smartedu-metas', JSON.stringify(d.data.metas));
              this._metaCache = { at: 0, map: null };
            } catch (e) {}
          }
          finish(out);
        } catch (e) {}
      };
      window.addEventListener('message', onMsg);
      try {
        window.postMessage({ __smarteduWrongQuery: 'questionIds', reqId }, '*');
      } catch (e) {
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        finish([]);
      }
    });
  },

  /** 卡片只读探测（绝不触发 click，避免干扰页面路由与状态） */
  autoProbeExerciseCards(): number {
    let count = 0;
    try {
      if (typeof document === 'undefined') return 0;
      const cards = document.querySelectorAll('[class*="card"], [class*="item"], [class*="question"]');
      count = cards ? cards.length : 0;
    } catch (e) {}
    return count;
  },

  /**
   * 扫描整个页面，返回结构化探测报告（同步、只读）。
   * - 习题库 / 练习页：返回候选 ID 清单；
   * - 错题本：优先候选 ID，取不到则回退 DOM 启发式题目块。
   */
  probePage() {
    const mode = this.detectPageMode();
    const report: any = {
      url: (typeof window !== 'undefined' ? window.location.href : ''),
      mode,
      isWrongPage: mode === this.PAGE_MODES.WRONG_BOOK || mode === this.PAGE_MODES.MY_EXERCISES,
      isExercisePage: mode === this.PAGE_MODES.MY_EXERCISES,
      pageTitle: (typeof document !== 'undefined' ? document.title : ''),
      subject: null,
      grade: null,
      totalCandidateBlocks: 0,
      candidateIds: [],
      questions: [],
      warnings: [],
      sampledText: ''
    };

    if (!report.isWrongPage) {
      report.warnings.push('当前不是错题本或我的习题页面，跳过提取');
      return report;
    }

    try {
      const ctx = this._extractContext();
      report.subject = ctx.subject;
      report.grade = ctx.grade;

      const collected = this.collectExerciseIds();
      report.candidateIds = collected.map(x => x.id);

      if (report.isExercisePage) {
        report.totalCandidateBlocks = collected.length;
        if (collected.length === 0) {
          report.warnings.push('我的习题列表渲染中，暂未检测到题目 ID（将在交互或异步加载后自动就绪）');
        }
        return report;
      }

      // 错题本：优先自适应捕获的 ID
      if (collected.length > 0) {
        report.totalCandidateBlocks = collected.length;
      } else {
        const blocks = this._findCandidateBlocks();
        report.totalCandidateBlocks = blocks.length;
        if (blocks.length === 0) {
          report.warnings.push('未找到候选题目块；可能题目尚未渲染、或在 iframe / 接口异步加载中');
          report.sampledText = (typeof document !== 'undefined' && document.body) ? this._text(document.body).slice(0, 800) : '';
          return report;
        }
        for (const block of blocks) {
          try {
            report.questions.push(this._extractQuestion(block));
          } catch (e: any) {
            report.warnings.push('单个题目解析异常已跳过: ' + e.message);
          }
        }
      }
    } catch (e: any) {
      report.warnings.push('整页扫描异常: ' + e.message);
    }

    return report;
  },

  /**
   * 结构诊断（专为「选择器校准」设计）：
   * 候选块数量异常（0 或 1）时 dump 命中关键词的节点与主要容器 class。
   */
  diagnoseStructure() {
    const out: any = { keywordHits: [], topContainers: [], totalElements: 0 };
    try {
      const all = document.querySelectorAll('*');
      out.totalElements = all.length;
      const KEY = /(正确答案|标准答案|你的答案|我的答案|解析|选项|答错|错题)/;
      let count = 0;
      for (let i = 0; i < all.length && count < 40; i++) {
        const el: any = all[i];
        const cls = (el.className && typeof el.className === 'string') ? el.className : '';
        const txt = this._text(el).replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        if (KEY.test(txt) && txt.length < 300) {
          out.keywordHits.push({ tag: el.tagName.toLowerCase(), cls: cls.slice(0, 140), id: (el.id || '').slice(0, 60), len: txt.length, text: txt.slice(0, 90) });
          count++;
        }
      }
      const body = document.body;
      if (body) {
        out.topContainers.push({ tag: 'body', cls: (typeof body.className === 'string' ? body.className : '').slice(0, 140) });
        const level1 = Array.from(body.children);
        for (const c of level1.slice(0, 8)) {
          out.topContainers.push(this._describeNode(c));
          for (const g of Array.from(c.children).slice(0, 6)) out.topContainers.push(this._describeNode(g));
        }
      }
    } catch (e: any) {
      out.error = e.message;
    }
    return out;
  },

  _describeNode(el: Element) {
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : '?',
      cls: (typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : '').slice(0, 140),
      id: (el.id || '').slice(0, 60)
    };
  },

  /** 从面包屑 / URL / 页面文本尽力提取学科与年级 */
  _extractContext() {
    const subjectMap: Record<string, string> = {
      '语文': 'Chinese', '数学': 'Mathematics', '英语': 'English', '物理': 'Physics',
      '化学': 'Chemistry', '生物': 'Biology', '道德与法治': 'Politics', '思想政治': 'Politics',
      '历史': 'History', '地理': 'Geography'
    };
    const gradeMap: Record<string, number> = {
      '一年级': 1, '二年级': 2, '三年级': 3, '四年级': 4, '五年级': 5, '六年级': 6,
      '七年级': 7, '初一': 7, '八年级': 8, '初二': 8, '九年级': 9, '初三': 9,
      '高一': 10, '高二': 11, '高三': 12
    };
    let subject: string | null = null;
    let grade: number | null = null;

    try {
      const href = String((typeof window !== 'undefined' && window.location) ? window.location.href : '');
      const mSub = /[?&]subject=([a-zA-Z]+)/i.exec(href);
      if (mSub) {
        const slugMap: Record<string, string> = {
          phy: 'Physics', math: 'Mathematics', chem: 'Chemistry', chi: 'Chinese',
          eng: 'English', bio: 'Biology', his: 'History', geo: 'Geography', pol: 'Politics'
        };
        const hit = slugMap[mSub[1].toLowerCase()];
        if (hit) subject = hit;
      }
    } catch (e) {}

    try {
      const crumbs = document.querySelectorAll('.breadcrumb, [class*="breadcrumb"], [class*="tag"], [class*="filter"]');
      for (let i = 0; i < crumbs.length; i++) {
        const text = (crumbs[i].textContent || '').trim();
        if (!text || text.length > 400) continue;
        for (const cn of Object.keys(subjectMap)) {
          if (text.includes(cn)) { subject = subjectMap[cn]; break; }
        }
        for (const gt of Object.keys(gradeMap)) {
          if (text.includes(gt)) { grade = gradeMap[gt]; break; }
        }
      }
    } catch (e) {}

    if (!subject || !grade) {
      const text = this._text(document.body).slice(0, 1500);
      if (!subject) {
        for (const cn of Object.keys(subjectMap)) {
          if (text.includes(cn)) { subject = subjectMap[cn]; break; }
        }
      }
      if (!grade) {
        const m = text.match(/(七|八|九|一|二|三|四|五|六)年级|初(一|二|三)|高(一|二|三)/);
        if (m) grade = gradeMap[m[0]] || null;
      }
    }
    return { subject, grade };
  },

  /** 候选题目块：语义 class 启发 + 文本特征启发 + 去嵌套 */
  _findCandidateBlocks(): Element[] {
    const selectors = [
      '[class*="question"]', '[class*="wrong"]', '[class*="item"]',
      '[class*="card"]', '[class*="paper"]', '[class*="exam"]', '[class*="topic"]',
      '[class*="list-item"]', '[class*="q-item"]'
    ];
    const seen = new Set<Element>();
    const blocks: Element[] = [];
    for (const sel of selectors) {
      let els: NodeListOf<Element>;
      try { els = document.querySelectorAll(sel); } catch (e) { continue; }
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (seen.has(el)) continue;
        const txt = this._text(el);
        if (txt.length > 6000) continue;
        if (txt.length > 30 && /(答案|解析|选项|您的|正确|A\.|B\.|①|（\s*[A-D]\s*）|填空|解答)/.test(txt)) {
          seen.add(el);
          blocks.push(el);
        }
      }
    }
    // 去嵌套：只保留叶子题块，避免一道题被计多次
    return blocks.filter(b => !blocks.some(o => o !== b && b.contains(o)));
  },

  _extractQuestion(block: Element) {
    const q: any = {
      source_question_id: this._findQuestionId(block),
      subject: null,
      grade: null,
      question_type: this._guessType(block),
      content: this._extractStem(block),
      options: this._extractOptions(block),
      user_answer: this._extractByKeyword(block, ['你的答案', '我选', '我的答案', '所选', '你的选择']),
      correct_answer: this._extractByKeyword(block, ['正确答案', '标准答案', '正确选项', '参考答案']),
      analysis: this._extractByKeyword(block, ['解析', '考点', '详解', '名师', '错因']),
      images: this._extractImages(block),
      raw_text_sample: this._text(block).slice(0, 500)
    };
    q.extract_method = {
      source_question_id: q.source_question_id ? 'attr/url' : '未找到',
      content: q.content ? 'selector/keyword' : '未找到',
      options: q.options.length ? 'structure' : '未找到',
      user_answer: q.user_answer ? 'keyword' : '未找到',
      correct_answer: q.correct_answer ? 'keyword' : '未找到',
      analysis: q.analysis ? 'keyword' : '未找到'
    };
    return q;
  },

  _extractStem(block: Element): string | null {
    const stemSelectors = ['[class*="stem"]', '[class*="title"]', '[class*="content"]', '[class*="question-title"]', '[class*="q-title"]', 'p'];
    for (const sel of stemSelectors) {
      let el: Element | null = null;
      try { el = block.querySelector(sel); } catch (e) { continue; }
      if (el) {
        const t = ((el as HTMLElement).innerText || el.textContent || '').trim();
        if (t.length > 5) return t;
      }
    }
    const paras = this._lines(block);
    for (const p of paras) {
      if (p.length > 10 && !/(答案|解析|选项|你的|正确)/.test(p)) return p;
    }
    return null;
  },

  _extractOptions(block: Element) {
    const lines = this._lines(block);
    const optRe = /^(?:\(?\s*([A-Da-d①-⑥])\s*\)?\s*[.、．:：]?\s*)(.+)$/;
    const opts: any[] = [];
    for (const line of lines) {
      const m = line.match(optRe);
      if (m && /^[A-Da-d①-⑥]$/.test(m[1])) opts.push({ label: m[1].toUpperCase(), text: m[2].trim() });
    }
    if (opts.length > 0) return opts;

    let lis: Element[] = [];
    try { lis = Array.from(block.querySelectorAll('li')); } catch (e) {}
    for (const li of lis) {
      const t = (li.textContent || '').trim();
      if (!t) continue;
      const m = t.match(/^([A-Da-d①-⑥])[.、．:：]?\s*(.+)$/);
      if (m) opts.push({ label: m[1].toUpperCase(), text: m[2].trim() });
      else if (t.length > 1) opts.push({ label: '', text: t });
    }
    return opts;
  },

  _extractByKeyword(block: Element, keywords: string[]): string | null {
    const txt = this._text(block);
    for (const kw of keywords) {
      const re = new RegExp(kw + '\\s*[:：]?\\s*([^\\n]{1,80})');
      const m = txt.match(re);
      if (m) return m[1].trim();
    }
    return null;
  },

  _guessType(block: Element): string {
    const txt = this._text(block);
    if (/填空/.test(txt)) return 'fill_blank';
    if (/解答|作文|简述|论述/.test(txt)) return 'subjective';
    const optCount = this._extractOptions(block).length;
    if (optCount >= 5) return 'multiple_choice';
    if (optCount >= 2) return 'single_choice';
    return 'unknown';
  },

  _findQuestionId(block: Element): string | null {
    try {
      const link = block.querySelector('a[href*="questionId"], a[href*="qid"], a[href*="id="]') as HTMLAnchorElement | null;
      if (link && link.href && typeof window !== 'undefined') {
        const u = new URL(link.href, window.location.href);
        const id = u.searchParams.get('questionId') || u.searchParams.get('qid') || u.searchParams.get('id');
        if (id) return id;
      }
    } catch (e) {}
    for (const attr of ['data-id', 'data-qid', 'data-questionid', 'data-key', 'data-question-id']) {
      const v = block.getAttribute(attr);
      if (v) return v;
    }
    return null;
  },

  _extractImages(block: Element): string[] {
    const imgs: string[] = [];
    try {
      block.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original');
        if (src && !/icon|avatar|logo|blank|pixel/i.test(src)) {
          try {
            imgs.push(new URL(src, window.location.href).href);
          } catch (e) {
            imgs.push(src);
          }
        }
      });
    } catch (e) {}
    return imgs;
  }
};

if (typeof window !== 'undefined') {
  (window as any).SmartEduWrongAdapter = WrongQuestionAdapter;
}
