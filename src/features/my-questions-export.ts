/**
 * my-questions-export.ts - 智慧教育平台「习题库」导出工具 (TypeScript / ESM)
 */

import { questionSource } from '../core/question-source';

export class MyQuestionsExport {
  async exportCurrentQuestions(format: 'json' | 'markdown' | 'html', ids: string[]) {
    const list: any[] = [];
    for (const id of ids) {
      try {
        const pack = await questionSource.fetchSingleQuestion(id, true);
        const parsed = questionSource.parseSingleQuestion(id, pack.data, pack.details, pack.item, pack.sources, pack.errors);
        list.push(parsed);
      } catch (e) {}
    }

    if (format === 'json') {
      return (questionSource as any).buildJson ? (questionSource as any).buildJson(list) : JSON.stringify(list, null, 2);
    }
    if (format === 'markdown') {
      return (questionSource as any).buildMarkdown ? (questionSource as any).buildMarkdown(list) : '';
    }
    if (format === 'html') {
      return (questionSource as any).buildHtml ? (questionSource as any).buildHtml(list) : '';
    }
    return '';
  }
}

export const myQuestionsExport = new MyQuestionsExport();

if (typeof window !== 'undefined') {
  (window as any).SmartEduMyQuestionsExport = myQuestionsExport;
}
