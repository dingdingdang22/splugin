/**
 * smartedu-adapter.ts - 智慧教育平台页面适配层 (TypeScript / ESM)
 * 
 * 职责：
 * 1. 识别当前页面是否属于「课程教学 - 学生自主学习」范围；
 * 2. 从当前 URL、路由参数及 DOM 中安全提取课程 ID、课时标题、学科、年级等语义元数据；
 * 3. 集中管理所有 DOM 选择器，避免因平台构建随机类名或小版本变动导致插件大面积失效。
 */

export interface CourseContext {
  title: string;
  subject: string;
  grade: number | null;
  textbookVersion: string;
  chapterTitle: string;
  breadcrumb: string[];
}

export interface ResourceIdentifiers {
  resourceId: string | null;
  idType: string;
  tm_id: string;
  teachingmaterialId: string;
  raw: Record<string, string>;
}

export const SmartEduAdapter = {
  isStudentSelfStudyPage(loc: Location = window.location): boolean {
    const pathname = loc.pathname;
    const search = loc.search;
    const urlParams = new URLSearchParams(search);

    if (pathname.includes('/syncClassroom/classActivity')) {
      const fromPrepare = urlParams.get('fromPrepare');
      return fromPrepare === null || fromPrepare === '0';
    }

    if (pathname.includes('/syncClassroom/detail') || pathname.includes('/basicWork/detail')) {
      const fromPrepare = urlParams.get('fromPrepare');
      return fromPrepare === null || fromPrepare === '0';
    }

    if (pathname.includes('/qualityCourse')) {
      const fromPrepare = urlParams.get('fromPrepare');
      return fromPrepare === null || fromPrepare === '0';
    }

    if (pathname.includes('/syncClassroom')) {
      return true;
    }

    return false;
  },

  extractResourceIdentifiers(loc: Location = window.location): ResourceIdentifiers {
    const urlParams = new URLSearchParams(loc.search);
    const normalized: Record<string, string> = {};
    for (const [k, v] of urlParams.entries()) {
      normalized[k.toLowerCase()] = String(v || '').trim();
    }

    const courseId = normalized['courseid'] || normalized['courseld'] || normalized['lessonid'] || '';
    const resourceId = normalized['resourceid'] || normalized['contentid'] || '';
    const activityId = normalized['activityid'] || '';
    const classHourId = normalized['classhourid'] || normalized['classhourld'] || '';
    const chapterId = normalized['chapterid'] || '';
    const teachingmaterialId = normalized['teachingmaterialid'] || normalized['teachingmaterial_id'] || normalized['tmid'] || normalized['bookid'] || '';

    const isQuality = loc.pathname && loc.pathname.includes('/qualityCourse');
    let targetId: string | null = null;
    let idType = 'unknown';

    if (isQuality && courseId) {
      targetId = courseId;
      idType = 'courseId';
    } else if (resourceId) {
      targetId = resourceId;
      idType = 'resourceId';
    } else if (activityId) {
      targetId = activityId;
      idType = 'activityId';
    } else if (courseId) {
      targetId = courseId;
      idType = 'courseId';
    } else if (classHourId) {
      targetId = classHourId;
      idType = 'classHourId';
    } else {
      const defaultTag = normalized['defaulttag'] || '';
      if (defaultTag) {
        // defaultTag 属于分类层级标签路径，并非单课 resourceId，仅记录类型，不赋值给 targetId 避免产生无谓的反查请求
        idType = 'defaultTag';
      }
    }

    const raw = {
      resourceId,
      courseId,
      activityId,
      classHourId,
      chapterId,
      teachingmaterialId
    };

    return {
      resourceId: targetId || null,
      idType,
      tm_id: teachingmaterialId,
      teachingmaterialId,
      raw
    };
  },

  extractCourseContext(): CourseContext {
    const context: CourseContext = {
      title: '',
      subject: '',
      grade: null,
      textbookVersion: '',
      chapterTitle: '',
      breadcrumb: []
    };

    try {
      const activeLessonEl = document.querySelector(
        '.active .resource-title, .active .lesson-name, [class*="active"] [class*="title"], .current-lesson, [class*="selected"] [class*="name"]'
      );
      if (activeLessonEl && activeLessonEl.textContent) {
        context.title = activeLessonEl.textContent.trim();
      }

      if (!context.title) {
        const titleEl = document.querySelector('h1, .lesson-title, [class*="title-text"], .course-title, [class*="course_title"]');
        if (titleEl && titleEl.textContent) {
          context.title = titleEl.textContent.trim();
        }
      }

      if (!context.title && document.title) {
        const parts = document.title.split('-');
        if (parts.length > 0) {
          context.title = parts[0].trim();
        }
      }

      const breadcrumbElements = document.querySelectorAll(
        '.breadcrumb, .fish-breadcrumb, [class*="breadcrumb"], .catalog-info, [class*="tag-box"], [class*="meta-info"]'
      );
      for (const el of breadcrumbElements) {
        const text = el.textContent ? el.textContent.trim() : '';
        if (text && (text.includes('·') || text.includes('>') || text.includes('/'))) {
          const tags = text.split(/[·>\/]/).map(t => t.trim()).filter(Boolean);
          context.breadcrumb = tags;
          this._parseTagsIntoContext(tags, context);
          break;
        }
      }

      if (!context.subject || !context.grade) {
        this._fallbackParseFromPageText(context);
      }
    } catch (err) {
      console.warn('[SmartEduAdapter] 提取课程上下文异常:', err);
    }

    return context;
  },

  _parseTagsIntoContext(tags: string[], context: CourseContext) {
    const subjectMap: Record<string, string> = {
      '语文': 'Chinese', '数学': 'Mathematics', '英语': 'English',
      '物理': 'Physics', '化学': 'Chemistry', '生物': 'Biology',
      '道德与法治': 'Politics', '思想政治': 'Politics', '历史': 'History', '地理': 'Geography'
    };

    const gradeMap: Record<string, number> = {
      '一年级': 1, '二年级': 2, '三年级': 3, '四年级': 4, '五年级': 5, '六年级': 6,
      '七年级': 7, '初一': 7,
      '八年级': 8, '初二': 8,
      '九年级': 9, '初三': 9,
      '高一': 10, '高一年级': 10,
      '高二': 11, '高二年级': 11,
      '高三': 12, '高三年级': 12
    };

    for (const tag of tags) {
      for (const [cn, en] of Object.entries(subjectMap)) {
        if (tag.includes(cn)) {
          context.subject = en;
          break;
        }
      }
      for (const [gradeText, gradeNum] of Object.entries(gradeMap)) {
        if (tag.includes(gradeText)) {
          context.grade = gradeNum;
          break;
        }
      }
      if (tag.includes('版') || tag.includes('人教') || tag.includes('统编') || tag.includes('外研')) {
        context.textbookVersion = tag;
      }
    }
  },

  _fallbackParseFromPageText(context: CourseContext) {
    const rawText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    const pageText = rawText.substring(0, 1500);
    const subjectMap: Record<string, string> = {
      '化学': 'Chemistry', '物理': 'Physics', '英语': 'English',
      '语文': 'Chinese', '数学': 'Mathematics', '历史': 'History',
      '道德与法治': 'Politics', '生物': 'Biology'
    };
    if (!context.subject) {
      for (const [cn, en] of Object.entries(subjectMap)) {
        if (pageText.includes(cn)) {
          context.subject = en;
          break;
        }
      }
    }
    if (!context.grade) {
      const gradeRegex = /(七|八|九|一|二|三|四|五|六)年级|初(一|二|三)|高(一|二|三)/;
      const match = pageText.match(gradeRegex);
      if (match) {
        const map: Record<string, number> = {
          '一年级': 1, '二年级': 2, '三年级': 3, '四年级': 4, '五年级': 5, '六年级': 6,
          '七年级': 7, '初一': 7, '八年级': 8, '初二': 8, '九年级': 9, '初三': 9,
          '高一': 10, '高二': 11, '高三': 12
        };
        context.grade = map[match[0]] || null;
      }
    }
  }
};

if (typeof window !== 'undefined') {
  (window as any).SmartEduAdapter = SmartEduAdapter;
}
