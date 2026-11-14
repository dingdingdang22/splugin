/**
 * question-source.ts —— 智慧平台题库内容源客户端 (TypeScript / ESM)
 * 
 * 核心设计：
 * - 错题 ID 列表：被动嗅探/平台鉴权接口
 * - 题库分片数据：公开 CDN (part_*.json)
 * - 标准答案与解析：题包 ZIP (item.json, Range 读取)
 * - 严守双树映射防线：严格保证原生平台形态，不执行双树映射
 * - 难易度归一化为中文五级（易/较易/中/较难/难）
 */

export const FILE_ORIGINS = [
  'https://bdcs-file-1.ykt.cbern.com.cn',
  'https://bdcs-file-2.ykt.cbern.com.cn'
];
export const PKG_ORIGIN = 'https://r1-ndr.ykt.cbern.com.cn';
export const TRANSCODE_ORIGIN = 'https://r1-ndr.ykt.cbern.com.cn';

export const TAG_DIM = {
  subject: 'zxxxk',
  grade: 'zxxnj',
  stage: 'zxxxd',
  textbook: 'zxxbb',
  volume: 'zxxcc',
  questionType: '$R',
  difficulty: '5036342744'
};

export const SUBJECT_MAP: Record<string, string> = {
  '数学': 'Mathematics', '语文': 'Chinese', '英语': 'English',
  '物理': 'Physics', '化学': 'Chemistry', '生物': 'Biology',
  '历史': 'History', '地理': 'Geography',
  '道德与法治': 'Politics', '思想政治': 'Politics', '政治': 'Politics'
};

export const GRADE_MAP: Record<string, number> = {
  '一年级': 1, '二年级': 2, '三年级': 3, '四年级': 4, '五年级': 5, '六年级': 6,
  '七年级': 7, '八年级': 8, '九年级': 9,
  '高一': 10, '高二': 11, '高三': 12
};

export const DIFFICULTY_MAP: Record<string, string> = {
  '非常简单': '易', '极易': '易', '容易': '易', '简单': '易', '易': '易', '很易': '易', 'easy': '易',
  '较易': '较易', '偏易': '较易', '稍易': '较易',
  '适中': '中', '中等': '中', '一般': '中', '普通': '中', '中': '中', 'medium': '中',
  '偏难': '较难', '较难': '较难', '稍难': '较难',
  '困难': '难', '非常困难': '难', '极难': '难', '难': '难', '很难': '难', 'hard': '难'
};

export function normalizeDifficulty(raw?: any): string {
  if (!raw) return '中';
  const s = String(raw).trim();
  if (DIFFICULTY_MAP[s]) return DIFFICULTY_MAP[s];
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

export const TYPE_MAP: Record<string, string> = {
  '单选题': 'single_choice', '单项选择题': 'single_choice',
  '多选题': 'multi_choice', '多项选择题': 'multi_choice', '不定项选择题': 'multi_choice', '双选题': 'multi_choice',
  '判断题': 'true_false', '判断题（对错）': 'true_false',
  '填空题': 'fill_blank', '有序填空题': 'fill_blank',
  '问答题': 'essay', '解答题': 'essay', '简答题': 'essay', '材料分析题': 'essay', '材料题': 'essay', '综合题': 'essay', '实验题': 'essay', '实验探究题': 'essay',
  '计算题': 'calculation', '作图题': 'drawing'
};

const TYPE_DIMS = ['$R', '$M'];
const TYPE_NOISE = /(分类|批改|评测资源|试题|主客观|自动|手工)/;

const TREE_MAPPING_FORBIDDEN_FIELDS = [
  'textbook_node_id',
  'chapter_path',
  'topic_names',
  'mapping_source',
  'mapping_score',
  'status'
];

export function assertNoTreeMapping(payload: any, label?: string): { stripped: string[]; clean: boolean } {
  const stripped: string[] = [];
  const tag = label || 'payload';
  const scan = (obj: any, path: string) => {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      if (TREE_MAPPING_FORBIDDEN_FIELDS.indexOf(k) >= 0 && v !== undefined && v !== null) {
        stripped.push(path + k);
        delete obj[k];
      } else if (Array.isArray(v)) {
        v.forEach((it, i) => { scan(it, path + k + '[' + i + '].'); });
      } else if (v && typeof v === 'object') {
        scan(v, path + k + '.');
      }
    });
  };
  scan(payload, tag + '.');
  if (stripped.length) {
    console.warn('[双树映射闸] ' + tag + ' 检出并剥离 ' + stripped.length +
      ' 个映射字段：' + stripped.join(', ') +
      '（导出链路严禁双树映射，已按平台原生形态放行）');
  }
  return { stripped, clean: stripped.length === 0 };
}

export function pickQuestionType(q: any): string | null {
  const tags = q.tag_list || [];
  for (let d = 0; d < TYPE_DIMS.length; d++) {
    const hit = tags.find((t: any) => t.tag_dimension_id === TYPE_DIMS[d] && TYPE_MAP[t.tag_name]);
    if (hit) return hit.tag_name;
  }
  const cand = tags.find((t: any) => (t.tag_dimension_id === '$R' || t.tag_dimension_id === '$M') && !TYPE_NOISE.test(t.tag_name));
  return cand ? cand.tag_name : null;
}

const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function tagOf(q: any, dim: string): string | null {
  const t = (q.tag_list || []).find((x: any) => x.tag_dimension_id === dim);
  return t ? t.tag_name : null;
}

export function resolveRefs(html?: string | null): string {
  if (!html) return '';
  return String(html)
    .replace(/\$\{ref-path\}/g, PKG_ORIGIN)
    .replace(/\$\{ref-transcode-path\}/g, TRANSCODE_ORIGIN);
}

const ENTITY_MAP: Record<string, string> = {
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
  times: '×', divide: '÷', plusmn: '±', deg: '°',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', equiv: '≡',
  sim: '∼', perp: '⊥', ang: '∠', infin: '∞', radic: '√',
  lt: '<', gt: '>', amp: '&'
};

function decodeEntitiesAndBlanks(s?: string | null): string {
  return String(s || '')
    .replace(/&([a-zA-Z]+);/g, (full, name) => Object.prototype.hasOwnProperty.call(ENTITY_MAP, name) ? ENTITY_MAP[name] : full)
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      if (code >= 0x200b && code <= 0x200f) return '';
      if (code === 160) return ' ';
      return code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      if (code >= 0x200b && code <= 0x200f) return '';
      if (code === 0xa0) return ' ';
      return code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/\\\(([\s\S]*?)\\\)/g, (full, inner) => {
      if (/^\s*(?:[\u2000-\u200a\u3000]+|_{2,})\s*$/.test(inner)) return '____';
      if (/^\s*(?:[\u2000-\u200a\u3000]+|_{2,})/.test(inner)) {
        return '____\\(' + inner.replace(/^\s*(?:[\u2000-\u200a\u3000]+|_{2,})\s*/, '') + '\\)';
      }
      if (/(?:[\u2000-\u200a\u3000]+|_{2,})\s*$/.test(inner)) {
        return '\\(' + inner.replace(/\s*(?:[\u2000-\u200a\u3000]+|_{2,})\s*$/, '') + '\\)____';
      }
      if (/[\u2000-\u200a\u3000]+/.test(inner)) {
        return '\\(' + inner.replace(/[\u2000-\u200a\u3000]+/g, ' \\quad ') + '\\)';
      }
      return full;
    })
    .replace(/[\u2000-\u200a]{2,}/g, '____');
}

export function isTemplatePlaceholderImg(rawSrc?: string | null): boolean {
  return /\/edu\/questions\/image\.png(\?|$)/i.test(String(rawSrc || ''));
}

export function stripHtml(html?: string | null): string {
  if (!html) return '';
  const imgs: string[] = [];
  const stripped = String(html)
    .replace(/<img[^>]*>/gi, (tag) => {
      const srcM = /src=["']([^"']*)["']/i.exec(tag);
      const raw = srcM ? srcM[1] : '';
      if (!raw || isTemplatePlaceholderImg(raw)) return '';
      imgs.push(resolveRefs(tag));
      return '\u0000IMG' + (imgs.length - 1) + '\u0000';
    })
    .replace(/<textentryinteraction[^>]*>\s*<\/textentryinteraction>/gi, '____')
    .replace(/<\/?latex[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<\/?[a-zA-Z!][^>]*>/g, '');

  return decodeEntitiesAndBlanks(stripped)
    .replace(/[\u200b-\u200f\ufeff\u00a0]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\u0000IMG(\d+)\u0000/g, (_, i) => imgs[Number(i)] || '');
}

export function pickStemSource(q: any): string {
  const descRaw = String((q && q.description) || '');
  const titleRaw = String((q && q.title) || '');
  if (!descRaw) return titleRaw;
  if (!titleRaw) return descRaw;
  return stripHtml(descRaw).length >= stripHtml(titleRaw).length ? descRaw : titleRaw;
}

export function stripLatexDelims(s?: string | null): string {
  return String(s == null ? '' : s)
    .replace(/\\\(/g, '')
    .replace(/\\\)/g, '')
    .replace(/\\left|\\right/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function collectImages(q: any): { images: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  const html = String((q && q.description) || '');
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    if (isTemplatePlaceholderImg(raw)) { dropped.push(raw); continue; }
    kept.push(resolveRefs(raw));
  }
  return { images: Array.from(new Set(kept)), dropped: Array.from(new Set(dropped)) };
}

export function extractKnowledge(q: any) {
  const marks = (q.knowledge_marks || []).map((k: any) => ({
    code: k.code || null,
    name: k.name || null,
    path_name: k.path_name || null,
    abilities: (k.abilities || []).map((a: any) => a.name),
    accomplishments: (k.accomplishments || []).map((a: any) => a.name)
  }));
  const cp = q.custom_properties || {};
  const raw = Array.isArray(cp.qb_knowledge_points) ? cp.qb_knowledge_points : [];
  const declared = raw.map((s: any) => String(s).replace(/\s+/g, '')).filter(Boolean);
  return { marks, declared };
}

export function resolveZipUrl(q: any): string | null {
  const cp = q.custom_properties || {};
  const packing = cp.sys_packing_result || {};
  const raw = packing.result || '';
  const m = /cs_path:(.+\.zip)\s*$/i.exec(raw.trim());
  if (!m) return null;
  return m[1].replace('${ref-path}', PKG_ORIGIN);
}

export const ZipRemote = {
  async readCentralDirectory(total: number, readRange: (start: number, end: number) => Promise<Uint8Array>) {
    const tailLen = Math.min(total, 65536 + 22);
    const tail = await readRange(total - tailLen, total - 1);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('EOCD 未找到：该对象可能不是 ZIP');
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    let cd: Uint8Array;
    const inTail = cdOffset - (total - tailLen);
    if (inTail >= 0 && cdSize <= tail.length - inTail) {
      cd = tail.subarray(inTail, inTail + cdSize);
    } else {
      cd = await readRange(cdOffset, cdOffset + cdSize - 1);
    }
    const entries: any[] = [];
    let p = 0;
    while (p + 46 <= cd.length) {
      const dv2 = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
      if (dv2.getUint32(p, true) !== CEN_SIG) break;
      const method = dv2.getUint16(p + 10, true);
      const compSize = dv2.getUint32(p + 20, true);
      const uncompSize = dv2.getUint32(p + 24, true);
      const nameLen = dv2.getUint16(p + 28, true);
      const extraLen = dv2.getUint16(p + 30, true);
      const cmtLen = dv2.getUint16(p + 32, true);
      const locOff = dv2.getUint32(p + 42, true);
      let name = '';
      for (let i = 0; i < nameLen; i++) name += String.fromCharCode(cd[p + 46 + i]);
      try { name = decodeURIComponent(escape(name)); } catch (e) {}
      entries.push({ name, method, compSize, uncompSize, locOff });
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return { count, entries };
  },

  async inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const piped = new Blob([bytes as any]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(piped).arrayBuffer());
    }
    throw new Error('当前环境缺少 DecompressionStream，无法解压 deflate-raw');
  },

  async extractEntry(url: string, wantName: string, readRange: (start: number, end: number) => Promise<Uint8Array>, total: number) {
    if (!total) throw new Error('需要 ZIP 总长度');
    const cd = await this.readCentralDirectory(total, readRange);
    const entry = cd.entries.find((e: any) => e.name === wantName)
      || cd.entries.find((e: any) => e.name.slice(-wantName.length - 1) === '/' + wantName);
    if (!entry) {
      throw new Error('ZIP 内未找到条目 ' + wantName);
    }
    const lh = await readRange(entry.locOff, entry.locOff + 29);
    const dv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
    if (dv.getUint32(0, true) !== LOC_SIG) throw new Error('local file header 签名不匹配');
    const fnameLen = dv.getUint16(26, true);
    const extraLen = dv.getUint16(28, true);
    const dataStart = entry.locOff + 30 + fnameLen + extraLen;
    const raw = await readRange(dataStart, dataStart + entry.compSize - 1);
    const bytes = entry.method === 8 ? await this.inflateRaw(raw) : raw;
    return { bytes, entry, total };
  }
};

export class QuestionSourceClient {
  VERSION = '1.0.0';
  FILE_ORIGINS = FILE_ORIGINS;
  PKG_ORIGIN = PKG_ORIGIN;
  TAG_DIM = TAG_DIM;
  resolveZipUrl = resolveZipUrl;
  MAPS = { SUBJECT_MAP, GRADE_MAP, DIFFICULTY_MAP, TYPE_MAP };

  _internals = {
    assertNoTreeMapping,
    stripHtml,
    stripLatexDelims,
    resolveRefs,
    pickStemSource,
    pickQuestionType,
    extractKnowledge,
    resolveZipUrl,
    tagOf,
    ZipRemote,
    TREE_MAPPING_FORBIDDEN_FIELDS
  };

  /** 允许注入自定义 Range 读取器（便于测试 / 走后台代理） */
  _readRangeImpl: any = null;

  setRangeReader(fn: any) {
    this._readRangeImpl = fn;
  }

  /**
   * 默认 Range 读取器：带 Range 头取字节区间。
   *
   * 兼容 206（标准分段）与 200（CDN 忽略 Range 直接给全量）：后者自行截取，
   * 否则 `bdcs-file` 部分边缘节点会把 ZIP 尾部读错，表现为「EOCD 未找到」。
   *
   * `credentials: 'omit'` 是合规要求：取的是公开 CDN 静态资源，不该带任何平台会话凭据。
   */
  makeFetchRangeReader(fetchImpl?: any) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!doFetch) throw new Error('环境无 fetch');
    return async (url: string, start: number, end: number, signal?: AbortSignal) => {
      const res = await doFetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        credentials: 'omit',
        signal
      });
      if (res.status === 206) return new Uint8Array(await res.arrayBuffer());
      if (res.status === 200) {
        const all = new Uint8Array(await res.arrayBuffer());
        return all.subarray(start, end + 1);
      }
      throw new Error(`HTTP ${res.status} Range 请求失败`);
    };
  }

  async httpJson(url: string, init?: any): Promise<any> {
    const doFetch = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null;
    if (!doFetch) throw new Error('环境无 fetch');
    const res = await doFetch(url, Object.assign({ credentials: 'omit' }, init || {}));
    if (!res.ok) throw new Error('HTTP ' + res.status + ' @ ' + url);
    return res.json();
  }

  /** 拉取某教材的题目分片清单（parts.json，双 CDN 轮询） */
  async fetchManifest(tmId: string): Promise<string[]> {
    let lastErr: any = null;
    for (let i = 0; i < FILE_ORIGINS.length; i++) {
      const url = `${FILE_ORIGINS[i]}/zxx/ndrs/questions/teachingmaterials/${tmId}/resources/parts.json`;
      try {
        const parts = await this.httpJson(url);
        if (Array.isArray(parts)) return parts;
        lastErr = new Error('parts.json 非数组');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('parts.json 获取失败');
  }

  /** 拉取单个分片 */
  async fetchPart(url: string): Promise<any[]> {
    const arr = await this.httpJson(url);
    return Array.isArray(arr) ? arr : [];
  }

  /**
   * 拉取整本教材题目并建索引（同一教材只建一次，由调用方缓存）。
   * 错题本链路依赖它把「只有 ID 的错题清单」补全为完整题目。
   */
  async buildIndex(tmId: string, opts: { onProgress?: (p: any) => void } = {}) {
    const parts = await this.fetchManifest(tmId);
    const index = new Map<string, any>();
    let total = 0;
    for (let i = 0; i < parts.length; i++) {
      const arr = await this.fetchPart(parts[i]);
      for (let j = 0; j < arr.length; j++) {
        const q = arr[j];
        if (q && q.id) index.set(q.id, q);
      }
      total += arr.length;
      if (opts.onProgress) opts.onProgress({ phase: 'part', done: i + 1, all: parts.length, questions: index.size });
    }
    return { index, parts: parts.length, total };
  }

  async fetchTotalLength(url: string): Promise<number> {
    const head = await fetch(url, { method: 'HEAD', credentials: 'omit' });
    const cl = head.headers.get('content-length');
    if (cl && parseInt(cl, 10) > 0) return parseInt(cl, 10);
    const probe = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'omit' });
    const cr = probe.headers.get('content-range');
    if (cr) {
      const m = /\/(\d+)$/.exec(cr);
      if (m) return parseInt(m[1], 10);
    }
    throw new Error('无法通过 HEAD/Range 探测文件总长度: ' + url);
  }

  /**
   * ④ 从题包 ZIP 中取出 item.json（标准答案 / 解析）。
   *
   * 只按需读取中央目录 + 目标条目，实测传输量约为整包的 0.3%~3%。
   * 返回值上挂 `__transfer` 统计（total/fetched/ratio），供同步编排器汇总带宽指标。
   */
  async fetchItemJson(zipUrl: string, opts: { total?: number; signal?: AbortSignal } = {}): Promise<any> {
    const total = opts.total || await this.fetchTotalLength(zipUrl);
    let fetched = 0;
    const baseReader = this._readRangeImpl || this.makeFetchRangeReader();
    const reader = async (start: number, end: number) => {
      const buf = await baseReader(zipUrl, start, end, opts.signal);
      fetched += buf.length;
      return buf;
    };
    const extracted = await ZipRemote.extractEntry(zipUrl, 'item.json', reader, total);
    const text = new TextDecoder('utf-8').decode(extracted.bytes);
    const json = JSON.parse(text);
    json.__transfer = { total, fetched, ratio: total ? fetched / total : 0 };
    return json;
  }

  mapQuestion(q: any, wrongMeta: any = {}) {
    const cp = q.custom_properties || {};
    const subCn = tagOf(q, TAG_DIM.subject);
    const gradeCn = tagOf(q, TAG_DIM.grade);
    const typeCn = pickQuestionType(q);
    const diffCn = tagOf(q, TAG_DIM.difficulty);
    const kb = extractKnowledge(q);
    const imgInfo = collectImages(q);

    const payload: any = {
      source: 'smartedu',
      source_question_id: q.id,
      source_question_no: cp.qb_question_no || null,
      container_id: q.container_id || null,
      teachingmaterial_id: (q.teachmeterial_ids || [])[0] || wrongMeta.teachingmaterial_id || null,

      subject: (subCn && SUBJECT_MAP[subCn]) || subCn || null,
      subject_cn: subCn || null,
      grade: (gradeCn && GRADE_MAP[gradeCn]) || null,
      grade_cn: gradeCn || null,
      stage_cn: tagOf(q, TAG_DIM.stage) || null,
      textbook_cn: tagOf(q, TAG_DIM.textbook) || null,
      volume_cn: tagOf(q, TAG_DIM.volume) || null,

      question_type: (typeCn && TYPE_MAP[typeCn]) || null,
      question_type_cn: typeCn || null,
      difficulty: normalizeDifficulty(diffCn),
      difficulty_cn: normalizeDifficulty(diffCn),

      // ⚠️ 不能用 title：它是平台的 200 字符截断摘要（题干会断在 `<latex class="m`）。
      // 完整题干在 description —— 见 pickStemSource 的说明。
      content: stripHtml(pickStemSource(q)),
      content_html: resolveRefs(pickStemSource(q)),
      content_description_html: resolveRefs(q.description || ''),
      content_title_html: resolveRefs(q.title || ''),
      images: imgInfo.images,
      // 留痕：被丢弃的模板占位图（不静默丢，便于事后核查判据是否误伤）
      images_dropped: imgInfo.dropped,

      unit_name: cp.qb_unit_name || null,
      case_name: cp.qb_case_name || null,
      chapter_paths: q.chapter_paths || [],
      chapter_title: (q.chapter_paths && q.chapter_paths[0]) || null,

      knowledge_points: kb.declared.length ? kb.declared : kb.marks.map((m: any) => m.name).filter(Boolean),
      knowledge_marks: kb.marks,
      knowledge_path_name: kb.marks.length ? kb.marks[0].path_name : null,
      abilities: Array.from(new Set(kb.marks.reduce((acc: any[], m: any) => acc.concat(m.abilities), []))),
      accomplishments: Array.from(new Set(kb.marks.reduce((acc: any[], m: any) => acc.concat(m.accomplishments), []))),

      // 错题元信息
      wrong_times: wrongMeta.error_times != null ? wrongMeta.error_times : null,
      answered_times: wrongMeta.times != null ? wrongMeta.times : null,
      wrong_at: wrongMeta.problem_time || null,
      error_times: wrongMeta.error_times != null ? wrongMeta.error_times : 1,
      times: wrongMeta.times != null ? wrongMeta.times : 1,
      problem_time: wrongMeta.problem_time || new Date().toISOString(),

      correct_answer: null,
      answer_plain: null,
      answer_detail: [],
      options: [],
      analysis: null,
      analysis_video_url: null,
      analysis_video_title: null,

      // 入库约束：不执行双树映射，保持平台原生知识点
      skip_tree_mapping: true,
      tree_mapping: false,

      source_url: wrongMeta.source_url || null,
      category: 'wrong_book',
      record_type: 'wrong_question',
      is_wrong: true,
      is_mistake: true,
      target: 'wrong_book'
    };

    assertNoTreeMapping(payload, 'mapQuestion');
    return payload;
  }

  mapAnswer(itemJson: any) {
    if (!itemJson) return null;
    const responses = itemJson.responses || [];
    const corrects = responses.map((r: any) => {
      const raw = (r.corrects || []).map((c: any) => String(c));
      return {
        identifier: r.identifier,
        cardinality: r.cardinality || null,
        corrects: raw.map(c => stripHtml(c)),
        corrects_plain: raw.map(c => stripLatexDelims(stripHtml(c))),
        corrects_html: raw.map(c => resolveRefs(c))
      };
    });

    let answerText = '';
    let answerPlain = '';
    if (corrects.length === 1) {
      if (corrects[0].corrects.length > 1) {
        answerText = corrects[0].corrects.join(', ');
        answerPlain = corrects[0].corrects_plain.join(', ');
      } else {
        answerText = corrects[0].corrects.join(', ');
        answerPlain = corrects[0].corrects_plain.join(', ');
      }
    } else if (corrects.length > 1) {
      // 多小问：已有「（1）」「1.」前缀的不再重复编号
      answerText = corrects.map((c: any, i: number) => {
        const ansStr = c.corrects.join('\n');
        const prefix = (/^\s*[\(（][1-9一二三四五][\)）]/.test(ansStr) || /^\s*[1-9]\./.test(ansStr)) ? '' : `(${i + 1}) `;
        return prefix + ansStr;
      }).join('\n\n');
      answerPlain = corrects.map((c: any, i: number) => {
        const ansStr = c.corrects_plain.join('\n');
        const prefix = (/^\s*[\(（][1-9一二三四五][\)）]/.test(ansStr) || /^\s*[1-9]\./.test(ansStr)) ? '' : `(${i + 1}) `;
        return prefix + ansStr;
      }).join('\n\n');
    }

    const feedbacks = (itemJson.feedbacks || []).map((f: any) => {
      const html = resolveRefs(f.content || '');
      const videoMatch = /<video[^>]+src=["']([^"']+)["']/i.exec(html);
      const titleMatch = /title=["']([^"']+)["']/i.exec(html);
      return {
        identifier: f.identifier,
        show_hide: f.show_hide || null,
        content_html: html,
        video_url: videoMatch ? videoMatch[1] : null,
        video_title: titleMatch ? titleMatch[1] : null
      };
    });
    const answerFb = feedbacks.find((f: any) => f.identifier === 'showAnswer') || null;

    // 解析只认文字：平台讲题视频是 AES-128 加密 m3u8，本轮不接入。
    // showAnswer 反馈里混着的 <video>/<img> 剥掉后剩下的才是可为 dofee solution 使用的文字解析。
    const answerFbHtml = answerFb ? String(answerFb.content_html || '') : '';
    const analysisText = answerFbHtml
      ? stripHtml(answerFbHtml.replace(/<video[\s\S]*?<\/video>/gi, '').replace(/<img[\s\S]*?>/gi, ''))
      : '';

    // 主观题在 responses 里可能没有标准答案，用文字解析兜底，避免被服务端卡空
    if (!answerText && analysisText) {
      answerText = analysisText;
      answerPlain = stripLatexDelims(analysisText);
    }

    const items = (itemJson.items || []).map((it: any) => {
      const rawChoices = (it.choices && it.choices.length) ? it.choices : (it.options || []);
      const normalized = rawChoices.map((c: any, i: number) => {
        const t = c.text || c.content || '';
        return {
          label: c.identifier || String.fromCharCode(65 + i),
          text: stripHtml(t),
          html: resolveRefs(t),
          correct: !!c.correct
        };
      });
      return {
        type: it.type || null,
        response_identifier: it.response_identifier || null,
        prompt: it.prompt || null,
        choices: it.choices || [],
        options: it.options || [],
        additional_answer: it.additional_answer || null,
        normalized_options: normalized
      };
    });
    const options = items.reduce((acc: any[], it: any) => acc.concat(it.normalized_options), []);

    return {
      responses,
      corrects,
      correct_answer: answerText,
      answer_plain: answerPlain,
      options,
      feedbacks,
      analysis_text: analysisText,
      analysis_video_url: answerFb ? answerFb.video_url : null,
      analysis_video_title: answerFb ? answerFb.video_title : null,
      items,
      has_choice_options: options.length > 0
    };
  }

  buildDofeePayload(question: any, wrongMeta: any, itemJson: any) {
    const base = this.mapQuestion(question, wrongMeta);
    const ans = this.mapAnswer(itemJson);

    // item.json 的 items[].prompt 才是「带真实图片路径 + 多小问结构」的权威题干。
    // part_*.json 的 description 里配图被服务端替换成了 444 字节占位白图（/edu/questions/image.png），
    // 因此只要题包里有 prompt，就以题包为准重建题干（这是配图不显示问题的根因修复）。
    if (itemJson && Array.isArray(itemJson.items) && itemJson.items.length) {
      const promptItems = itemJson.items.filter((it: any) => it && typeof it.prompt === 'string' && it.prompt.trim().length > 0);
      if (promptItems.length > 0) {
        let fullPromptHtml = '';
        let fullPromptText = '';
        if (promptItems.length === 1) {
          fullPromptHtml = promptItems[0].prompt;
          fullPromptText = stripHtml(promptItems[0].prompt);
        } else {
          let sharedHtml = '';
          let sharedText = '';
          const subHtmlList: string[] = [];
          const subTextList: string[] = [];
          let subCount = 0;
          for (let idx = 0; idx < promptItems.length; idx++) {
            const it = promptItems[idx];
            const pRaw = it.prompt.trim();
            const pText = stripHtml(pRaw);
            // 材料题：第一段（type=data，或小问数 > 2）视为公共材料
            const isShared = (idx === 0 && (it.type === 'data' || promptItems.length > 2));
            if (isShared) {
              sharedHtml = pRaw;
              sharedText = pText;
            } else {
              subCount++;
              const hasLabel = /^[\(（][1-9一二三四五][\)）]|^[1-9][\.\、]/.test(pText);
              const label = hasLabel ? '' : ('（' + subCount + '）');
              subTextList.push(label + pText);
              subHtmlList.push(label ? ('<div><p><span>' + label + '</span>' + resolveRefs(pRaw).replace(/^<div><p[^>]*>/i, '')) : resolveRefs(pRaw));
            }
          }
          fullPromptText = sharedText ? (sharedText + '\n\n' + subTextList.join('\n')) : subTextList.join('\n');
          fullPromptHtml = sharedHtml ? (sharedHtml + '\n' + subHtmlList.join('\n')) : subHtmlList.join('\n');
        }

        const promptImgs: string[] = [];
        const promptDropped: string[] = [];
        const re = /<img[^>]+src=["']([^"']+)["']/gi;
        let m;
        while ((m = re.exec(fullPromptHtml))) {
          const raw = m[1];
          if (isTemplatePlaceholderImg(raw)) promptDropped.push(raw);
          else promptImgs.push(resolveRefs(raw));
        }

        if (promptImgs.length > 0 || fullPromptText.length >= (base.content || '').length) {
          base.content = fullPromptText;
          base.content_html = resolveRefs(fullPromptHtml);
          base.images = Array.from(new Set(promptImgs));
          if (promptDropped.length > 0) {
            base.images_dropped = Array.from(new Set((base.images_dropped || []).concat(promptDropped)));
          }
          base.extract_method = base.extract_method || {};
          base.extract_method.content = 'zip-range/item.json(prompt)';
        }
      }
    }

    if (ans) {
      base.correct_answer = ans.correct_answer;
      base.answer_plain = ans.answer_plain;
      base.answer_detail = ans.corrects;
      base.options = ans.options;
      base.analysis = ans.analysis_text || null;
      base.analysis_video_url = ans.analysis_video_url;
      base.analysis_video_title = ans.analysis_video_title;
    }

    // 答案与题型安全兜底：保证错题 100% 能入库，绝不被服务端按空字段跳过
    if (!base.correct_answer) {
      if (base.analysis) {
        base.correct_answer = base.analysis;
        base.answer_plain = base.analysis;
      } else {
        base.correct_answer = '暂无标准答案';
        base.answer_plain = '暂无标准答案';
      }
    }
    if (!base.question_type) {
      base.question_type = (base.options && base.options.length) ? 'choice' : 'essay';
    }
    base.has_answer = !!(ans && ans.correct_answer);

    const contentMethod = (base.extract_method && base.extract_method.content) || 'cdnsrc/part_*.json';
    base.extract_method = {
      content: contentMethod,
      meta: 'cdnsrc/tag_list',
      knowledge: 'cdnsrc/knowledge_marks',
      answer: ans ? 'zip-range/item.json' : '未获取',
      analysis: (ans && ans.analysis_text) ? 'item.json/feedbacks(文字)' : '平台未提供文字解析',
      video: '本轮不接入（AES-128 m3u8）',
      options: (ans && ans.has_choice_options) ? 'item.json' : '题目未提供选项节点'
    };

    assertNoTreeMapping(base, 'buildDofeePayload');
    return base;
  }

  /** 单题元数据 CDN */
  NDR_DETAILS_URL = 'https://s-file-2.ykt.cbern.com.cn/zxx/ndrs/questions/resources/details/{qid}.json';
  /** 单题题包 item.json（公开 CDN，无需 Range） */
  ITEM_JSON_URL = PKG_ORIGIN + '/edu_product/esp/questions/{qid}.pkg/item.json';
  /** doc-center 个人网盘副本的回退路径（部分「我的习题」条目只有副本可用） */
  DOC_FALLBACK_ITEM_URL = 'https://cdncs.ykt.cbern.com.cn/v0.1/static/ndr_2d0_9ee3cd/esp/questions/{qid}.pkg/item.json';

  /**
   * 单题公开 CDN 获取（四条降级链，缺一不可 —— 这是「习题库大量题目提不出来」的根因修复）：
   *
   *   ① `api_static/questions/{qid}/data.json`          完整内容（老路，部分题 403）
   *   ② `api_static/questions/{container}_{qid}/data.json` 403 时用 details.container_id 重试（实测 200）
   *   ③ `details.ti_items[].ti_storages` 里的带版本号题包路径（如 `@3.pkg/item.json`）
   *   ④ `cdncs` 个人副本兜底（doc-center 个人网盘 ID 场景）
   *
   * 若 data.json 全线失败但拿到了 item.json，就用 item.json 合成 content —— 否则题干会退化成空。
   */
  async fetchSingleQuestion(qid: string, withItem = true) {
    const errors: any[] = [];
    const sources: any = {};
    let data: any = null;

    const fetchJson = async (url: string) => {
      const resp = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    };

    // ① 完整内容（老路 data.json，双 CDN 轮询）
    for (let i = 0; i < FILE_ORIGINS.length; i++) {
      if (data) break;
      const url = `${FILE_ORIGINS[i]}/zxx/api_static/questions/${qid}/data.json`;
      sources.data_json = url;
      try {
        data = await fetchJson(url);
      } catch (e: any) {
        errors.push({ stage: 'data', url, error: e.message });
      }
    }

    // ② 元数据 details.json
    const durl = this.NDR_DETAILS_URL.replace('{qid}', qid);
    sources.details_json = durl;
    let details: any = null;
    try {
      details = await fetchJson(durl);
    } catch (e: any) {
      errors.push({ stage: 'details', url: durl, error: e.message });
    }

    // ②-b 裸 data.json 403 且 details 给了 container_id → 走 {container_id}_{qid}
    if (!data && details && details.container_id) {
      const cidUrl = `${FILE_ORIGINS[0]}/zxx/api_static/questions/${details.container_id}_${qid}/data.json`;
      try {
        data = await fetchJson(cidUrl);
        if (data) sources.data_json = cidUrl;
      } catch (e: any) {
        errors.push({ stage: 'data-container', url: cidUrl, error: e.message });
      }
    }

    // ③ item.json：优先 details.ti_items 里的带版本号路径
    let loc = resolveRefs((data && data.content ? data.content.location : '') || '');
    if (withItem !== false && !loc && details) {
      const tis = details.ti_items || [];
      for (let t = 0; t < tis.length && !loc; t++) {
        const stores = tis[t].ti_storages || [];
        for (let s = 0; s < stores.length; s++) {
          if (typeof stores[s] === 'string' && stores[s].indexOf('item.json') >= 0) { loc = stores[s]; break; }
        }
      }
    }
    if (withItem !== false && !loc) loc = this.ITEM_JSON_URL.replace('{qid}', qid);

    let item: any = null;
    if (withItem !== false && loc) {
      sources.item_json = loc;
      try {
        item = await fetchJson(loc);
      } catch (e: any) {
        // ④ 个人副本兜底
        const docFallbackUrl = this.DOC_FALLBACK_ITEM_URL.replace('{qid}', qid);
        try {
          item = await fetchJson(docFallbackUrl);
          if (item) sources.item_json = docFallbackUrl;
        } catch (e2: any) {
          errors.push({ stage: 'item', url: loc, error: e.message });
        }
      }
    }

    if (!data && !item) errors.unshift({ stage: 'data', error: 'data.json 与 item.json 均获取失败' });

    // data.json 失败时用 item.json 合成主内容（否则题干/选项全空）
    if (!data && item) {
      const root = (item && item.content) || item || {};
      const synth = Object.assign({}, root);
      if (!synth.description) {
        const its = synth.items || [];
        for (let m = 0; m < its.length; m++) {
          if (its[m] && its[m].prompt) { synth.description = its[m].prompt; break; }
          if (its[m] && its[m].content) { synth.description = its[m].content; break; }
        }
        if (!synth.description && synth.prompt) synth.description = synth.prompt;
        if (!synth.description && synth.title) synth.description = synth.title;
      }
      data = {
        id: qid,
        container_id: (details && details.container_id) || synth.container_id || null,
        content: synth
      };
      sources.main_source = 'item.json（data.json 403，myexercise 习题链路）';
    }

    return { id: qid, data, details, item, sources, errors };
  }

  /**
   * 解析单题为 QTI 完整结构化对象。
   *
   * @param extraMeta 来自页面 DOM / Fiber 的试题元数据（知识点、难易度、更新时间、主讲人、解析、答案），
   *                  用于补齐公开 CDN 缺失或只有视频解析的字段。
   */
  parseSingleQuestion(qid: string, data: any, details: any, item: any, sources: any, errors: any[], extraMeta?: any) {
    const content = (data && data.content) || {};
    const itemContent = (item && item.content) || item || {};

    // 单题解析用的去标签：与 stripHtml 不同，这里连图片节点也一并剥离（图片单独收集留痕）
    const stripHtmlText = (raw: any): string => {
      if (!raw) return '';
      let s = String(raw);
      s = s.replace(/<img[^>]*>/gi, '');
      s = s.replace(/<textentryinteraction[^>]*>\s*<\/textentryinteraction>/gi, '____');
      s = s.replace(/<\/?latex[^>]*>/gi, '');
      s = s.replace(/<br\s*\/?>/gi, '\n');
      s = s.replace(/<\/?(p|div|li|tr|h[1-6])>/gi, '\n');
      s = s.replace(/<\/?[a-zA-Z!][^>]*>/g, '');
      s = decodeEntitiesAndBlanks(s);
      s = s.replace(/[\u200b-\u200f\ufeff\xad]/g, '');
      s = s.replace(/[ \t\u00a0]+/g, ' ');
      s = s.replace(/\n[ \t]+/g, '\n');
      s = s.replace(/\n{3,}/g, '\n\n');
      return s.trim();
    };

    const pickStem = (c: any): string => {
      const desc = (c && c.description) || (c && c.prompt) || '';
      const title = (c && c.title) || '';
      if (!desc) return title;
      if (!title) return desc;
      return stripHtmlText(desc).length >= stripHtmlText(title).length ? desc : title;
    };

    // 题干：data.json 与 item.json 取更长者（题包 prompt 才带真实配图）
    let stemHtml = pickStem(content);
    if (item) {
      const stemItem = pickStem(itemContent);
      if (stemItem && stripHtmlText(stemItem).length > stripHtmlText(stemHtml).length) stemHtml = stemItem;
    }
    stemHtml = resolveRefs(stemHtml);
    const stemText = stripHtmlText(stemHtml);

    // 选项与题型
    const choices: any[] = [];
    let qtype = 'other';
    let multiple = false;
    const items = content.items || (item && item.items) || [];
    for (let i = 0; i < items.length; i++) {
      const t = String(items[i].type || '').toLowerCase();
      const chs = items[i].choices || items[i].options || [];
      if (t === 'choice' || t === 'single_choice' || t === 'multiple_choice' || (t === '' && chs.length > 0)) {
        multiple = !!items[i].multiple || t === 'multiple_choice';
        qtype = multiple ? 'multiple_choice' : 'single_choice';
        for (let j = 0; j < chs.length; j++) {
          const label = chs[j].identifier || String.fromCharCode(65 + j);
          const text = resolveRefs(chs[j].text || chs[j].content || '');
          if (label || text) choices.push({ label, text, text_plain: stripHtmlText(text), correct: !!chs[j].correct });
        }
      } else if ((t === 'textentry' || t === 'fill_blank') && qtype === 'other') {
        qtype = 'fill_blank';
      } else if ((t === 'extendedtext' || t === 'text' || t === 'essay' || t === 'short_answer') && qtype === 'other') {
        qtype = 'essay';
      }
    }
    // 根级选项兜底
    if (choices.length === 0 && (content.choices || (item && item.choices))) {
      const rootChs = content.choices || (item && item.choices) || [];
      qtype = 'single_choice';
      for (let r = 0; r < rootChs.length; r++) {
        const rLbl = rootChs[r].identifier || String.fromCharCode(65 + r);
        const rTxt = resolveRefs(rootChs[r].text || rootChs[r].content || '');
        choices.push({ label: rLbl, text: rTxt, text_plain: stripHtmlText(rTxt), correct: !!rootChs[r].correct });
      }
    }

    // 标准答案（多条降级：responses → 选项 correct → 根级 answer 字段）
    const answers: string[] = [];
    let nResp = 0;
    const resps = content.responses || (item && (item.responses || (item.content && item.content.responses))) || [];
    for (let k = 0; k < resps.length; k++) {
      let got = false;
      const cs = resps[k].corrects || resps[k].answers || [];
      for (let n = 0; n < cs.length; n++) {
        const val = (typeof cs[n] === 'object' && cs[n] !== null) ? (cs[n].value || cs[n].text || '') : cs[n];
        const a = String(val).indexOf('<') >= 0 ? stripHtmlText(val) : String(val);
        if (a) { answers.push(a.trim()); got = true; }
      }
      if (got) nResp++;
    }
    if (answers.length === 0) {
      choices.forEach(c => { if (c.correct && c.label) answers.push(c.label); });
    }
    if (answers.length === 0) {
      const directAns = content.correct_answer || content.answer || (item && (item.correct_answer || item.answer));
      if (directAns) answers.push(String(directAns).trim());
    }

    let nBlanks = 0;
    for (let b = 0; b < items.length; b++) {
      if (String(items[b].type || '').toLowerCase() === 'textentry') nBlanks++;
    }
    if (qtype === 'fill_blank') nBlanks = Math.max(nBlanks, nResp);

    // 解析：feedbacks[showAnswer] → answer_steps（分步详解 + 内嵌【知识点】标注）
    let analysisHtml = '';
    const fbs = content.feedbacks || [];
    for (let f = 0; f < fbs.length; f++) {
      if (String(fbs[f].identifier || '') === 'showAnswer') { analysisHtml = fbs[f].content || ''; break; }
    }
    if (!analysisHtml && item) {
      const ifbs = itemContent.feedbacks || [];
      for (let f2 = 0; f2 < ifbs.length; f2++) {
        if (String(ifbs[f2].identifier || '') === 'showAnswer') { analysisHtml = ifbs[f2].content || ''; break; }
      }
    }
    analysisHtml = resolveRefs(analysisHtml);
    const analysisVideos: string[] = [];
    const vRe = /(https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/gi;
    let vm;
    while ((vm = vRe.exec(analysisHtml))) analysisVideos.push(vm[1]);
    let analysisText = stripHtmlText(analysisHtml);

    const stepKps: string[] = [];
    if (!analysisText) {
      const steps = content.answer_steps || itemContent.answer_steps || (item && item.answer_steps) || [];
      if (Array.isArray(steps) && steps.length > 0) {
        const stepLines: string[] = [];
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si] || {};
          const hint = stripHtmlText(st.hint || '');
          let body = stripHtmlText(st.content || '');
          const kpMatch = /【知识点】\s*([^\n【]+)/.exec(body);
          if (kpMatch && kpMatch[1]) stepKps.push(kpMatch[1].trim());
          body = body
            .replace(/【(?:ID|难度|标注状态|知识点)】[^\n]*/g, '')
            .replace(/\n{2,}/g, '\n')
            .trim();
          if (hint || body) {
            stepLines.push((steps.length > 1 ? `步骤${si + 1}${hint ? '（' + hint + '）' : ''}：` : (hint ? `${hint}：` : '')) + body);
          }
        }
        if (stepLines.length > 0) analysisText = stepLines.join('\n');
      }
    }
    let analysisKind = (analysisVideos.length && !analysisText) ? 'video' : (analysisText ? 'text' : 'none');

    // 题干图片（丢弃模板占位图但留痕）
    const keptImgs: string[] = [];
    const droppedImgs: string[] = [];
    const imgRe = /<img[^>]*>/gi;
    let imMatch;
    while ((imMatch = imgRe.exec(String(stemHtml || '')))) {
      const sm = /src=["']([^"']*)["']/i.exec(imMatch[0]);
      const raw = sm ? sm[1] : '';
      if (!raw || isTemplatePlaceholderImg(raw)) { droppedImgs.push(raw); continue; }
      const u = resolveRefs(raw);
      if (keptImgs.indexOf(u) < 0) keptImgs.push(u);
    }

    // 元数据
    const meta: any = {
      subject: null, grade: null, stage: null, textbook: null, volume: null,
      difficulty: null, difficulty_raw: null, knowledge_points: [], unit: null,
      unit_no: null, case_name: null, year: null, teacher: null, nature: null,
      update_time: null
    };
    if (details) {
      const cp = details.custom_properties || {};
      meta.knowledge_points = (cp.qb_knowledge_points || []).slice();
      meta.unit = cp.qb_unit_name || null;
      meta.unit_no = cp.qb_unit || null;
      meta.case_name = cp.qb_case_name || null;
      meta.year = cp.qb_year || null;
      meta.teacher = cp.qb_teacher_name || null;
      const tags: any = {};
      const tl = details.tag_list || [];
      for (let t = 0; t < tl.length; t++) {
        if (tl[t].tag_dimension_id) tags[tl[t].tag_dimension_id] = tl[t].tag_name;
      }
      meta.subject = tags[TAG_DIM.subject] || null;
      meta.grade = tags[TAG_DIM.grade] || null;
      meta.stage = tags[TAG_DIM.stage] || null;
      meta.textbook = tags[TAG_DIM.textbook] || null;
      meta.volume = tags[TAG_DIM.volume] || null;
      meta.difficulty_raw = tags[TAG_DIM.difficulty] || null;
      meta.difficulty = normalizeDifficulty(meta.difficulty_raw);
    }
    if (meta.knowledge_points.length === 0 && stepKps.length > 0) meta.knowledge_points = stepKps;

    // 融合页面 DOM / Fiber 元数据（CDN 拿不到的知识点、难度、主讲人全靠这一步）
    if (extraMeta && typeof extraMeta === 'object') {
      if (Array.isArray(extraMeta.knowledge_points) && extraMeta.knowledge_points.length > 0) {
        meta.knowledge_points = Array.from(new Set((meta.knowledge_points || []).concat(extraMeta.knowledge_points)));
      }
      if (extraMeta.difficulty || extraMeta.difficulty_raw) {
        meta.difficulty = normalizeDifficulty(extraMeta.difficulty || extraMeta.difficulty_raw);
        meta.difficulty_raw = extraMeta.difficulty_raw || extraMeta.difficulty;
      }
      if (extraMeta.update_time) meta.update_time = extraMeta.update_time;
      if (extraMeta.teacher && !meta.teacher) meta.teacher = extraMeta.teacher;
      if (extraMeta.analysis_text && (!analysisText || analysisKind === 'video')) {
        analysisText = extraMeta.analysis_text;
        analysisKind = 'text';
      }
      if (extraMeta.correct_answer && answers.length === 0) answers.push(extraMeta.correct_answer);
    }

    return {
      id: qid,
      container_id: (data && data.container_id) || (content && content.container_id) || null,
      q_type: qtype,
      stem: stemHtml,
      stem_text: stemText,
      choices,
      n_blanks: nBlanks,
      answers,
      answer_text: answers.join('；'),
      analysis: analysisHtml,
      analysis_text: analysisText,
      analysis_kind: analysisKind,
      analysis_videos: analysisVideos,
      images: keptImgs,
      images_dropped: droppedImgs,
      meta,
      sources: sources || {},
      errors: errors || [],
      exported_at: new Date().toISOString()
    };
  }

  /** 把解析后的单题对象转换为符合 dofee 题库导入协议的 payload */
  buildDofeePayloadFromSingle(sq: any, extra: any = {}) {
    const m = sq.meta || {};
    const subjectCn = m.subject || extra.subject_cn || null;
    const gradeCn = m.grade || extra.grade_cn || null;
    const payload: any = {
      source: extra.source || 'smartedu_my_questions',
      source_question_id: sq.id,
      source_question_no: null,
      container_id: sq.container_id || null,
      teachingmaterial_id: extra.teachingmaterial_id || null,

      subject: extra.subject || (subjectCn && SUBJECT_MAP[subjectCn]) || subjectCn || null,
      subject_cn: subjectCn,
      grade: extra.grade || (gradeCn && GRADE_MAP[gradeCn]) || null,
      grade_cn: gradeCn,
      stage_cn: m.stage || null,
      textbook_cn: m.textbook || null,
      volume_cn: m.volume || null,

      question_type: sq.q_type || 'essay',
      question_type_cn: sq.q_type || null,
      difficulty: normalizeDifficulty(m.difficulty || m.difficulty_raw),
      difficulty_cn: normalizeDifficulty(m.difficulty || m.difficulty_raw),
      difficulty_raw: m.difficulty_raw || null,

      knowledge_points: m.knowledge_points || [],
      unit_name: m.unit || extra.unit_name || null,
      case_name: m.case_name || extra.case_name || null,
      chapter_title: m.unit || extra.chapter_title || null,
      domain: m.unit || extra.chapter_title || extra.unit_name || (m.knowledge_points && m.knowledge_points[0]) || null,
      chapter_paths: m.unit ? [m.unit] : [],

      content: sq.stem_text || '',
      content_html: sq.stem || '',
      images: sq.images || [],
      images_dropped: sq.images_dropped || [],

      correct_answer: sq.answer_text || '暂无标准答案',
      answer_plain: sq.answer_text || '暂无标准答案',
      answer_detail: sq.answers || [],
      options: (sq.choices || []).map((c: any) => ({
        label: c.label,
        text: c.text_plain != null ? c.text_plain : c.text,
        html: c.text,
        correct: !!c.correct || (Array.isArray(sq.answers) && sq.answers.indexOf(c.label) >= 0)
      })),
      analysis: sq.analysis_text || null,
      analysis_video_url: (sq.analysis_videos && sq.analysis_videos[0]) || null,
      has_answer: !!(sq.answers && sq.answers.length > 0),

      source_url: extra.source_url || (typeof window !== 'undefined' ? window.location.href : null),
      problem_time: extra.problem_time || new Date().toISOString(),
      update_time: m.update_time || null,
      teacher: m.teacher || null,

      // 入库约束：不执行双树映射，保持平台原生知识点
      skip_tree_mapping: true,
      tree_mapping: false,

      // 试题分类与类型：仅支持「错题本 (wrong_book)」与「我的习题 (my_exercises)」
      category: (extra.is_wrong === true || extra.category === 'wrong_book') ? 'wrong_book' : (extra.category || 'exercise'),
      record_type: (extra.is_wrong === true || extra.record_type === 'wrong_question') ? 'wrong_question' : (extra.record_type || 'exercise'),
      is_wrong: extra.is_wrong === true,
      is_mistake: extra.is_wrong === true,
      target: extra.is_wrong === true ? 'wrong_book' : (extra.target || 'my_exercises')
    };

    if (extra.error_times != null) payload.error_times = extra.error_times;
    if (extra.times != null) payload.times = extra.times;

    assertNoTreeMapping(payload, 'buildDofeePayloadFromSingle');
    return payload;
  }

  // -------------------------------------------------------------
  // 导出（JSON / Markdown / HTML）—— 面板与 my-questions-export 共用
  // -------------------------------------------------------------

  buildJson(questions: any[]): string {
    return JSON.stringify({
      tool: 'smartedu-monitor (unified question probe)',
      source: '国家中小学智慧教育平台 basic.smartedu.cn 习题库（公开 CDN 链路）',
      exported_at: new Date().toISOString(),
      count: questions.length,
      questions
    }, null, 2);
  }

  buildMarkdown(questions: any[]): string {
    const L: string[] = [];
    L.push('# 智慧教育平台试题导出（试题 + 答案解析）', '');
    L.push('- 导出时间：' + new Date().toLocaleString('zh-CN'));
    L.push('- 题目数量：' + questions.length);
    L.push('- 数据来源：basic.smartedu.cn 习题库公开 CDN 链路', '');
    L.push('---', '');
    questions.forEach((q, i) => {
      const m = q.meta || {};
      const bits: string[] = [];
      if (m.subject) bits.push(m.subject);
      if (m.grade) bits.push(m.grade);
      if (m.difficulty) bits.push(m.difficulty);
      L.push('## ' + (i + 1) + '. ' + (bits.length ? '[' + bits.join(' · ') + '] ' : '') + q.id, '');
      L.push(q.stem_text || '（题干缺失）', '');
      if (q.choices && q.choices.length) {
        L.push('**选项：**', '');
        q.choices.forEach((c: any) => L.push('- ' + c.label + '. ' + (c.text_plain || '')));
        L.push('');
      }
      if (q.n_blanks) L.push('（本题共 ' + q.n_blanks + ' 个空）', '');
      L.push('**答案：** ' + (q.answer_text || '（未提供）'), '');
      if (q.analysis_kind === 'text') {
        L.push('**解析：**', '', q.analysis_text, '');
      } else if (q.analysis_kind === 'video') {
        L.push('**解析：** 平台讲解视频（m3u8）：');
        (q.analysis_videos || []).forEach((v: string) => L.push('- ' + v));
        L.push('');
      }
      if (q.images && q.images.length) {
        L.push('**配图：**');
        q.images.forEach((im: string) => L.push('- ' + im));
        L.push('');
      }
      const metaBits: string[] = [];
      if (m.difficulty_raw || m.difficulty) metaBits.push('难易度：' + (m.difficulty_raw || m.difficulty));
      if (m.knowledge_points && m.knowledge_points.length) metaBits.push('知识点：' + m.knowledge_points.join('、'));
      if (m.update_time) metaBits.push('更新时间：' + m.update_time);
      if (m.teacher) metaBits.push('主讲人：' + m.teacher);
      if (m.unit) metaBits.push('章节：' + m.unit);
      if (metaBits.length) L.push('> ' + metaBits.join(' ｜ '), '');
      L.push('---', '');
    });
    return L.join('\n');
  }

  buildHtml(questions: any[]): string {
    const esc = (s: any) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cards = questions.map((q, i) => {
      const m = q.meta || {};
      const tags: string[] = [];
      if (m.subject) tags.push('<span>' + esc(m.subject) + '</span>');
      if (m.grade) tags.push('<span>' + esc(m.grade) + '</span>');
      if (m.difficulty_raw || m.difficulty) tags.push('<span class="tag-diff">' + esc(m.difficulty_raw || m.difficulty) + '</span>');
      if (m.knowledge_points && m.knowledge_points.length) tags.push('<span class="tag-kp">知识点：' + esc(m.knowledge_points.join('、')) + '</span>');
      const stem = (q.stem || '<p>（题干缺失）</p>').replace(/<\/?latex[^>]*>/gi, '');
      let choicesHtml = '';
      if (q.choices && q.choices.length) {
        choicesHtml = '<div class="choices">' + q.choices.map((c: any) => '<div><b>' + esc(c.label) + '.</b> ' + String(c.text || '').replace(/<\/?latex[^>]*>/gi, '') + '</div>').join('') + '</div>';
      }
      let ana = '';
      if (q.analysis_kind === 'text') {
        ana = '<div class="ana"><span class="label">解析：</span>' + String(q.analysis || '').replace(/<\/?latex[^>]*>/gi, '') + '</div>';
      }
      const infoItems: string[] = [];
      if (m.knowledge_points && m.knowledge_points.length) infoItems.push('<b>知识点：</b>' + esc(m.knowledge_points.join('、')));
      if (m.difficulty_raw || m.difficulty) infoItems.push('<b>难易度：</b>' + esc(m.difficulty_raw || m.difficulty));
      if (m.update_time) infoItems.push('<b>更新时间：</b>' + esc(m.update_time));
      if (m.teacher) infoItems.push('<b>主讲人：</b>' + esc(m.teacher));
      const infoHtml = infoItems.length ? '<div class="info-bar">' + infoItems.join(' <span class="sep">｜</span> ') + '</div>' : '';
      return '<div class="q"><h2><span class="no">' + (i + 1) + '.</span> ' + esc(q.id) + ' <span class="tags">' + tags.join('') + '</span></h2>' +
        '<div class="stem">' + stem + '</div>' + choicesHtml +
        '<div class="ans"><span class="label">答案：</span><span class="val">' + esc(q.answer_text || '（未提供）') + '</span></div>' +
        ana + infoHtml + '</div>';
    }).join('\n');
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>智慧教育平台习题导出</title>' +
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">' +
      '<style>body{padding:24px;font:15px/1.75 sans-serif;background:#f8fafc;color:#1e293b}.q{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:16px}.tags span{background:#eff6ff;color:#1d4ed8;padding:2px 8px;border-radius:6px;font-size:12px;margin-right:6px}.tags .tag-diff{background:#fef3c7;color:#b45309;font-weight:600}.tags .tag-kp{background:#ecfdf5;color:#047857}.ans{margin-top:10px;font-weight:600;color:#16a34a}.ana{margin-top:6px;color:#d97706}.info-bar{margin-top:10px;padding-top:8px;border-top:1px dashed #e2e8f0;font-size:13px;color:#64748b}.info-bar .sep{color:#cbd5e1;margin:0 4px}</style></head><body>' +
      '<h1>智慧教育平台习题库导出（' + questions.length + ' 题）</h1>' + cards + '</body></html>';
  }

  // -------------------------------------------------------------
  // 智慧平台登录态（只读）与鉴权签名
  // -------------------------------------------------------------

  DEFAULT_SDP_APP_ID = 'e5649925-441d-4a53-b525-51a2f1c4e0a8';

  /**
   * 从 localStorage 或传入字典中提取智慧平台登录凭证 (ND_UC_AUTH)。
   * 只读，不写入、不转发到 dofee。
   */
  extractUcAuthFromStorage(store?: any) {
    try {
      const st: any = store || (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!st) return null;

      const parseCandidate = (raw: any, key: string) => {
        if (!raw) return null;
        let parsed: any = raw;
        if (typeof raw === 'string') {
          try { parsed = JSON.parse(raw); } catch (e) { return null; }
        }
        let val = parsed;
        if (val && typeof val.value === 'string') {
          try { val = JSON.parse(val.value); } catch (e) { val = parsed; }
        }
        if (val && val.value && typeof val.value === 'object') val = val.value;
        if (val && val.access_token) {
          return {
            access_token: String(val.access_token).trim(),
            mac_key: String(val.mac_key || '').trim(),
            user_id: String(val.user_id || '').trim(),
            sdp_app_id: String(key.replace('ND_UC_AUTH-', '').split('&')[0] || this.DEFAULT_SDP_APP_ID).trim()
          };
        }
        return null;
      };

      if (st.access_token && typeof st.access_token === 'string') {
        return {
          access_token: String(st.access_token).trim(),
          mac_key: String(st.mac_key || '').trim(),
          user_id: String(st.user_id || '').trim(),
          sdp_app_id: String(st.sdp_app_id || this.DEFAULT_SDP_APP_ID).trim()
        };
      }

      if (typeof st.length === 'number' && typeof st.key === 'function') {
        for (let i = 0; i < st.length; i++) {
          const k = st.key(i);
          if (k && k.indexOf('ND_UC_AUTH') === 0) {
            const hit = parseCandidate(st.getItem(k), k);
            if (hit) return hit;
          }
        }
        for (let j = 0; j < st.length; j++) {
          const k2 = st.key(j);
          if (k2 && /token|auth|session/i.test(k2) && k2 !== 'SMARTEDU_MONITOR_CONFIG') {
            const hit2 = parseCandidate(st.getItem(k2), k2);
            if (hit2) return hit2;
          }
        }
      } else if (typeof st === 'object') {
        const keys = Object.keys(st);
        for (let m = 0; m < keys.length; m++) {
          const km = keys[m];
          if (/ND_UC_AUTH|token|auth/i.test(km) && km !== 'dofeeConfig') {
            const hit3 = parseCandidate(st[km], km);
            if (hit3) return hit3;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  /**
   * 构造 UC 4 行标准 MAC 签名头（Web Crypto HMAC-SHA256）。
   * signContent = `${nonce}\n${METHOD}\n${pathAndQuery}\n${hostname}\n`
   */
  async buildUcMacAuthHeader(method: string, fullUrl: string, ucAuth: any): Promise<string | null> {
    if (!ucAuth || !ucAuth.access_token) return null;
    const token = String(ucAuth.access_token).trim();
    const macKey = String(ucAuth.mac_key || '').trim();
    if (!macKey) return `MAC id="${token}",nonce="0",mac="0"`;
    try {
      const u = new URL(fullUrl);
      const pathAndQuery = u.pathname + (u.search || '');
      const hostname = u.hostname;
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let rand = '';
      for (let i = 0; i < 8; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
      const nonce = Date.now() + ':' + rand;
      const signContent = `${nonce}\n${String(method || 'GET').toUpperCase()}\n${pathAndQuery}\n${hostname}\n`;

      const cryptoObj: any = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto : null;
      if (cryptoObj && typeof TextEncoder !== 'undefined') {
        const enc = new TextEncoder();
        const key = await cryptoObj.subtle.importKey('raw', enc.encode(macKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sigBuf = await cryptoObj.subtle.sign('HMAC', key, enc.encode(signContent));
        const bytes = new Uint8Array(sigBuf);
        let bin = '';
        for (let b = 0; b < bytes.length; b++) bin += String.fromCharCode(bytes[b]);
        const mac = typeof btoa === 'function' ? btoa(bin) : '';
        if (mac) return `MAC id="${token}",nonce="${nonce}",mac="${mac}"`;
      }
    } catch (e) {}
    return `MAC id="${token}",nonce="0",mac="0"`;
  }

  /**
   * 拉取「我的习题库（myQuestions）」全量题目列表（doc-center query_category，逐页遍历）。
   * 用于「无需打开习题库页面也能后台提取」的场景。
   */
  async fetchExerciseLibraryIds(ucAuth?: any, opts: { limit?: number; maxPages?: number } = {}) {
    const auth = ucAuth || this.extractUcAuthFromStorage();
    if (!auth || !auth.access_token) return [];

    const targetLimit = Number(opts.limit) > 0 ? Number(opts.limit) : 0;
    const pageSize = (targetLimit > 0 && targetLimit < 100) ? targetLimit : 100;
    const maxPages = Number(opts.maxPages) > 0 ? Number(opts.maxPages) : 100;

    const out: any[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let pageIndex = 0;
    let hasMore = true;

    while (hasMore && pageIndex < maxPages) {
      pageIndex++;
      const currentLimit = (targetLimit > 0 && (out.length + pageSize > targetLimit)) ? (targetLimit - out.length) : pageSize;
      if (currentLimit <= 0) break;

      const qs = [
        '$limit=' + encodeURIComponent(`(${offset},${currentLimit})`),
        '$orderby=' + encodeURIComponent('create_time desc'),
        'scope=file', 'core_type=', 'parent_id=', 'res_type=questions', 'words=', 'tags=',
        'chapter_paths=', 'teaching_materials=', 'knowledge_ids='
      ].join('&');
      const url = `https://doc-center.ykt.eduyun.cn/v1.0/c/search/action/query_category?${qs}`;

      try {
        const authHeader = await this.buildUcMacAuthHeader('GET', url, auth);
        if (!authHeader) break;
        const resp = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': authHeader,
            'sdp-app-id': auth.sdp_app_id || this.DEFAULT_SDP_APP_ID,
            'client_platform': 'web',
            'sdp-biz-type': 'ykt'
          }
        });
        if (!resp.ok) break;
        const data = await resp.json();
        const items = (data && Array.isArray(data.items)) ? data.items : [];
        if (items.length === 0) break;

        for (let i = 0; i < items.length; i++) {
          const it = items[i] || {};
          // 优先 source_document_id：规避 doc-center 个人网盘副本 identifier 403
          const qid = String(it.source_document_id || it.identifier || it.id || '').trim().toLowerCase();
          if (!qid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(qid) || seen.has(qid)) continue;
          seen.add(qid);
          const gt = it.global_title || {};
          out.push({ id: qid, container_id: it.source_container_id || it.container_id || null, title: gt['zh-CN'] || gt['en-US'] || it.title || '' });
          if (targetLimit > 0 && out.length >= targetLimit) { hasMore = false; break; }
        }

        offset += items.length;
        const totalCount = typeof data.total === 'number' ? data.total : (data.count || -1);
        if (totalCount >= 0 && offset >= totalCount) hasMore = false;
        else if (items.length < currentLimit) hasMore = false;
      } catch (e) {
        break;
      }
    }

    return out;
  }

  /** 自动发现用户最近使用 / 有错题的教材 ID（tmId） */
  async discoverUserTeachingMaterialIds(ucAuth?: any, knownIds: string[] = [], opts: { fetchImpl?: any } = {}) {
    const auth = ucAuth || this.extractUcAuthFromStorage();
    const tmSet = new Set<string>();
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const addTm = (id: any) => {
      if (!id || typeof id !== 'string') return;
      const s = id.trim().toLowerCase();
      if (UUID_RE.test(s) && s !== this.DEFAULT_SDP_APP_ID) tmSet.add(s);
    };

    if (Array.isArray(knownIds)) knownIds.forEach(addTm);
    if (!auth || !auth.access_token) return Array.from(tmSet);

    const doFetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!doFetch) return Array.from(tmSet);
    const appId = auth.sdp_app_id || this.DEFAULT_SDP_APP_ID;

    // 1. 错题本最近访问的教材
    try {
      const lastUrl = `https://e-exercise-study-reord-api.ykt.eduyun.cn/v1/study_records/${appId}/user_teachingmaterials_wrong_questions_last`;
      const h1 = await this.buildUcMacAuthHeader('GET', lastUrl, auth);
      const r1 = await doFetch(lastUrl, { method: 'GET', headers: { 'Accept': 'application/json', 'Authorization': h1 || '', 'sdp-app-id': appId } });
      if (r1 && r1.ok) {
        const d1 = await r1.json();
        let ext1 = (d1 && d1.ext_info) || d1;
        if (typeof ext1 === 'string') { try { ext1 = JSON.parse(ext1); } catch (e) {} }
        if (ext1 && ext1.teachingmaterial_id) addTm(ext1.teachingmaterial_id);
      }
    } catch (e) {}

    // 2. 章节选择历史
    try {
      // ==================================================================
      // v1.13.2 修：study_details 按 sdp-biz-type 业务域过滤数据。
      // 用错题域 'myQuestions' 会返回 HTTP 200 + 空 items（看似成功实为错域），
      // 导致教材发现长期静默返回空集合（2026-10-26 探针取证：同账号 ykt 得 8 条、
      // myQuestions 得 0 条）。改为优先 'ykt'，仍保留 myQuestions 兜底试一次。
      // ==================================================================
      const sdUrl = 'https://x-study-record-api.ykt.eduyun.cn/v1/study_details';
      let items: any[] = [];
      for (const bizType of ['ykt', 'myQuestions']) {
        try {
          const h2 = await this.buildUcMacAuthHeader('GET', sdUrl, auth);
          const r2 = await doFetch(sdUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'Authorization': h2 || '', 'sdp-app-id': appId, 'sdp-biz-type': bizType }
          });
          if (r2 && r2.ok) {
            const d2 = await r2.json();
            const got = (d2 && Array.isArray(d2.items)) ? d2.items : [];
            if (got.length > 0) { items = got; break; }
          }
        } catch (e) {}
      }
      {
        for (let j = 0; j < items.length; j++) {
          let ext2 = items[j] && items[j].ext_info;
          if (typeof ext2 === 'string') { try { ext2 = JSON.parse(ext2); } catch (e) {} }
          if (ext2 && ext2.chapter && ext2.chapter.tree_id) addTm(ext2.chapter.tree_id);
          if (ext2 && ext2.teachingmaterial_id) addTm(ext2.teachingmaterial_id);
          // v1.13.2 补：实测（探针 2026-10-26，8 条本人记录）tm_id 一律落在
          // ext_info.additional_params.teachingmaterial_id，顶层字段并不存在，
          // 只读顶层会让教材发现长期静默为空。
          const ap2 = ext2 && ext2.additional_params;
          if (ap2 && ap2.teachingmaterial_id) addTm(ap2.teachingmaterial_id);
        }
      }
    } catch (e) {}

    return Array.from(tmSet);
  }

  /** 拉取指定教材下的错题记录（无鉴权时返回空，由页面嗅探器链路兜底） */
  async fetchWrongQuestionsByTmWithAuth(tmId: string, ucAuth?: any, opts: { fetchImpl?: any } = {}) {
    if (!tmId) return [];
    const doFetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!doFetch) return [];

    const auth = ucAuth || this.extractUcAuthFromStorage();
    const url = `https://e-exercise-study-reord-api.ykt.eduyun.cn/v1/study_records/${tmId}/user_teachingmaterials_wrong_questions`;
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (auth && auth.access_token) {
      const authHeader = await this.buildUcMacAuthHeader('GET', url, auth);
      if (authHeader) headers['Authorization'] = authHeader;
      headers['sdp-app-id'] = auth.sdp_app_id || this.DEFAULT_SDP_APP_ID;
    }

    try {
      const resp = await doFetch(url, { method: 'GET', headers });
      if (!resp || !resp.ok) return [];
      const data = await resp.json();
      let ext = data && data.ext_info;
      if (typeof ext === 'string') {
        try { ext = JSON.parse(ext); } catch (e) { return []; }
      }
      if (!ext || !Array.isArray(ext.wrong_questions)) return [];
      return ext.wrong_questions;
    } catch (e) {
      return [];
    }
  }
}

export const questionSource = new QuestionSourceClient();

if (typeof window !== 'undefined') {
  (window as any).SmartEduQuestionSource = questionSource;
}
