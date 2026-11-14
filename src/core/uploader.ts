/**
 * uploader.ts - 数据上报与网络重试模块 (TypeScript / ESM)
 * 
 * 职责：
 * 1. 负责向 dofee 后端发送学习心跳与完成事件；
 * 2. 具备离线队列重试与指数退避机制；
 * 3. 优先委托 Background Service Worker 发起网络请求（享受 host_permissions，彻底免除 CORS 限制）；
 * 4. 派发请求状态事件至诊断面板。
 */

import { storage, MonitorStorage } from './storage';
import { authManager } from './auth';
import { ensureImportUserConsistent } from './import-user-guard';
import { sendAuthHttpRequest, sendHttpRequest } from './request';

export interface LogEvent {
  time: string;
  type: string;
  message: string;
  detail?: any;
}

export class StudyUploader {
  private isFlushing = false;
  private onLogCallback: ((log: LogEvent) => void) | null = null;
  private _preferredProgressEndpoint: 'v1' | 'legacy' | null = null;

  constructor() {
    this._startQueueFlushTimer();
  }

  private _startQueueFlushTimer() {
    if (typeof window !== 'undefined') {
      setInterval(() => {
        this.flushQueue();
      }, 30000);

      window.addEventListener('online', () => {
        this._log('info', '网络已恢复在线，自动尝试冲刷离线队列...');
        setTimeout(() => this.flushQueue(), 1500);
      });
    }
  }

  setLogListener(cb: (log: LogEvent) => void) {
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
      console.log(`[StudyUploader][${type}] ${message}`, detail || '');
    }
  }

  async report(eventPayload: any) {
    const config = await storage.ensureHydrated();

    if (!config.enabled) {
      this._log('skip', '插件处于停用状态，跳过上报');
      return;
    }

    if (!config.dofeeJwtToken && !config.dofeeRefreshToken) {
      this._log('warn', '未配置 dofee 认证凭证，事件已暂存至待发队列');
      storage.enqueue(eventPayload, config.dofeeUsername, config.activeSmarteduUserId);
      return;
    }

    // ── 【横切安全件】智慧平台用户一致性守卫（心跳上报入口，静默变体）──
    // 心跳是自动高频流，不能弹窗；智慧平台用户变更/绑定不一致时静默拒绝（不入队=零写入），
    // 待用户走手动「同步」入口弹窗确认后自动恢复。
    // 身份不可读（NO_SMARTEDU_LOGIN）不视为「用户变更」，放行以免误伤监控——
    // 导入入口对同一情形是硬中止（那里身份不可读=无法安全导入）。
    {
      const guardRes = await ensureImportUserConsistent({
        action: '学习心跳上报 dofee',
        mode: 'silent'
      });
      if (guardRes.ok === false
        && (guardRes.reason === 'USER_CHANGED_ABORTED' || guardRes.reason === 'BINDING_MISMATCH')) {
        this._log('warn', guardRes.reason === 'BINDING_MISMATCH'
          ? '当前智慧平台用户与已绑定账号不一致，心跳上报已暂停（零写入）。请验证密码解绑/重绑后恢复。'
          : '智慧平台登录用户已变更，心跳上报已暂停（零写入）。请在插件面板手动「同步」确认用户后恢复。');
        return;
      }
    }

    try {
      // 统一走带自动鉴权、主动续期与 401 排队自愈的请求网关
      let res = await this._sendHttpRequest(config, eventPayload);

      // 网关虽已尝试自愈，但极端场景（冷启动竞态/单例锁短路）下仍可能带旧 token 返回 401。
      // 这里显式再补一轮「强制续签 + 重发」，确保不会一击即溃。
      if (res.status === 401 || res.status === 403) {
        this._log('warn', `上报遇鉴权拦截 (${res.status})，启动强制续签自愈...`);
        const healed = await this.tryRefreshToken();
        if (healed) {
          const freshConfig = await storage.ensureHydrated();
          res = await this._sendHttpRequest(freshConfig, eventPayload);
        }
      }

      if (res.status >= 200 && res.status < 300) {
        this._log('success', `上报成功 [${eventPayload.event.type}]`, {
          pos: Math.round(eventPayload.event.position_seconds),
          dur: Math.round(eventPayload.event.duration_seconds),
          status: res.status
        });
        this.flushQueue();
      } else if (res.status === 401 || res.status === 403) {
        // 真正到这一步才是「续签后仍失败」= refresh token 确实被服务端否决，需人工重新登录
        this._log('error', `鉴权失败 (${res.status})：强制续签后仍被拒绝，凭据确已失效，请重新登录`, res.responseText);
        storage.enqueue(eventPayload, config.dofeeUsername, config.activeSmarteduUserId);
      } else {
        this._log('warn', `服务端返回异常状态 (${res.status})，压入离线队列`, res.responseText);
        storage.enqueue(eventPayload, config.dofeeUsername, config.activeSmarteduUserId);
      }
    } catch (err: any) {
      this._log('error', '网络异常或无法连接 dofee 服务端，压入离线队列', err.message);
      storage.enqueue(eventPayload, config.dofeeUsername, config.activeSmarteduUserId);
    }
  }

  async flushQueue() {
    if (this.isFlushing) return;
    const queue = storage.getQueue();
    if (!queue || queue.length === 0) return;

    const config = await storage.ensureHydrated();
    if (!config.dofeeJwtToken && !config.dofeeRefreshToken) return;

    this.isFlushing = true;
    const currentUsername = config.dofeeUsername;
    const batch = queue.filter(item => !item.username || item.username === currentUsername).slice(0, 5);
    if (batch.length === 0) {
      this.isFlushing = false;
      return;
    }
    this._log('info', `开始冲刷离线队列，当前账号待发: ${batch.length} 条 (总积压: ${queue.length} 条)`);

    try {
      for (const item of batch) {
        try {
          const res = await this._sendHttpRequest(config, item.payload);
          if (res.status >= 200 && res.status < 300) {
            storage.dequeue(item.id);
          } else if (res.status === 401 || res.status === 403) {
            // 鉴权硬失败暂停冲刷
            break;
          } else {
            item.retryCount = (item.retryCount || 0) + 1;
            if (item.retryCount > 8) {
              storage.dequeue(item.id);
            }
          }
        } catch (e) {
          break;
        }
      }
    } finally {
      this.isFlushing = false;
    }
  }

  async login(
    username: string,
    password: string,
    options?: { noSaveToConfig?: boolean }
  ): Promise<{ success: boolean; error?: string; username?: string; token?: string; refreshToken?: string }> {
    const config = storage.getConfig();
    const base = String(config.dofeeApiBase || '').trim().replace(/\/+$/, '');

    this._log('info', `正在向 dofee 验证登录: ${username}...`);
    try {
      let res: any = null;
      let token: string | null = null;
      let returnedUser: string | null = null;
      let refreshToken = '';

      try {
        const v1Url = `${base}/api/v1/auth/login`;
        res = await this._postJson(v1Url, { username, password });
        if (res && res.status === 200) {
          const data = JSON.parse(res.responseText || '{}');
          if (data.token || data.accessToken) {
            token = data.token || data.accessToken;
            returnedUser = (data.user && data.user.username) ? data.user.username : (data.username || username);
            refreshToken = data.refreshToken || '';
          }
        }
      } catch (e) {}

      if (!token) {
        const legacyUrl = `${base}/api/auth`;
        res = await this._postJson(legacyUrl, {
          action: 'login',
          username,
          password
        });
        if (res && res.status === 200) {
          const data = JSON.parse(res.responseText || '{}');
          if (data.token || data.accessToken) {
            token = data.token || data.accessToken;
            returnedUser = (data.user && data.user.username) ? data.user.username : (data.username || username);
            refreshToken = data.refreshToken || '';
          }
        }
      }

      if (token) {
        const resolvedUsername = returnedUser || username;
        if (!options?.noSaveToConfig) {
          storage.saveConfig({
            dofeeUsername: resolvedUsername,
            dofeeJwtToken: token,
            dofeeRefreshToken: refreshToken
          });
          const expMs = authManager.getTokenExpirationMs(token);
          const expDesc = expMs ? new Date(expMs).toLocaleString() : '长期有效';
          this._log('success', `登录成功！已为学员 [${resolvedUsername}] 生成凭证 (有效期至: ${expDesc})`);
          this.flushQueue();
        }
        return { success: true, username: resolvedUsername, token, refreshToken };
      }

      let errMsg = '登录失败';
      if (res) {
        try {
          const errObj = JSON.parse(res.responseText || '{}');
          if (errObj.code === 'SYNC_CLIENT_PARENT_FORBIDDEN') {
            errMsg = errObj.error || '家长账号禁止在学习监控插件登录，请使用学员账号';
          } else if (errObj.error) {
            errMsg = errObj.error;
          }
        } catch (_) {
          if (res.status === 404) errMsg = '登录接口不存在 (HTTP 404)，请检查 API 基础地址';
          else if (res.status === 403) errMsg = '登录被拦截 (HTTP 403)，家长账号禁止登录同步插件';
          else if (res.status) errMsg = `服务端返回状态码 HTTP ${res.status}`;
        }
      }
      this._log('error', `登录失败: ${errMsg}`);
      return { success: false, error: errMsg };
    } catch (err: any) {
      this._log('error', `登录网络异常: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async tryRefreshToken(): Promise<boolean> {
    // force=true：显式自愈/登录前奏必须穿透冷却期真正尝试一次，拿真实结论
    const res = await authManager.refreshToken('uploader_manual', true);
    if (res.success) {
      this._log('success', 'Token 自动续签成功！有效期已延长');
      return true;
    }
    if (res.isHardFailure) {
      this._log('warn', `Refresh Token 续签失败 (${res.error || '已失效'})，需重新登录`);
    } else {
      this._log('warn', `续签临时网络异常 (${res.error || '服务暂不可用'})，凭据已保留待自愈`);
    }
    return false;
  }

  private _postJson(url: string, data: any) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Dofee-Client': 'smartedu-monitor'
    };
    return sendHttpRequest('POST', url, headers, data);
  }

  private async _sendHttpRequest(config: any, payload: any) {
    const base = String(config.dofeeApiBase || '').trim().replace(/\/+$/, '');
    const headers = {
      'Content-Type': 'application/json',
      'X-Dofee-Client': 'smartedu-monitor'
    };

    const isDofee2Host = /dofee|localhost|127\.0\.0\.1/i.test(base);
    const primaryMode = this._preferredProgressEndpoint || (isDofee2Host ? 'v1' : 'legacy');

    if (primaryMode === 'legacy') {
      const legacyUrl = `${base}/api/v2/student/external-study/progress`;
      const res = await sendAuthHttpRequest('POST', legacyUrl, headers, payload);
      if (res && res.status < 400) {
        this._preferredProgressEndpoint = 'legacy';
        return res;
      }
      const v1Url = `${base}/api/v1/sync/progress`;
      const v1Res = await sendAuthHttpRequest('POST', v1Url, headers, payload);
      if (v1Res && v1Res.status < 400) {
        this._preferredProgressEndpoint = 'v1';
        return v1Res;
      }
      return res;
    }

    const v1Url = `${base}/api/v1/sync/progress`;
    try {
      const res = await sendAuthHttpRequest('POST', v1Url, headers, payload);
      if (res && res.status !== 404) {
        this._preferredProgressEndpoint = 'v1';
        return res;
      }
    } catch (e) {}

    const legacyUrl = `${base}/api/v2/student/external-study/progress`;
    const fallbackRes = await sendAuthHttpRequest('POST', legacyUrl, headers, payload);
    if (fallbackRes && fallbackRes.status < 400) {
      this._preferredProgressEndpoint = 'legacy';
    }
    return fallbackRes;
  }
}

export const uploader = new StudyUploader();

if (typeof window !== 'undefined') {
  (window as any).SmartEduUploader = uploader;
}
