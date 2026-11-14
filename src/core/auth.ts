/**
 * auth.ts - 统一鉴权与自动续约自愈中枢 (TypeScript / ESM)
 * 
 * 核心设计：
 * 1. 统一凭证模型与 JWT 智能解码：提取 exp/iat，计算剩余有效期 (TTL)，实现临界窗口主动续约；
 * 2. 单例并发续约锁 (Single-Flight Renewal Mutex)：多请求并发触发 401 或临界刷新时，排队等待同一 Promise，杜绝竞争踩踏；
 * 3. 双端点高兼容降级：优先 /api/v1/auth/refresh，平滑降级至 /api/auth，兼容多种响应数据结构；
 * 4. 软硬失效分离：区分凭据硬失效（401/403/400 明确过期）与网络软故障（断网/超时/5xx），故障时绝不盲目清空凭据；
 * 5. 跨上下文自愈：结合 storage 事件与 window.online 监听，网络恢复与休眠唤醒后自动重新校验并自愈。
 */

import { storage, MonitorConfig } from './storage';
import { sendHttpRequest, HttpResponse } from './request';

export interface JwtPayload {
  exp?: number;
  iat?: number;
  sub?: string;
  username?: string;
  role?: string;
  [key: string]: any;
}

export interface RefreshResult {
  success: boolean;
  token?: string;
  refreshToken?: string;
  error?: string;
  isHardFailure?: boolean;
}

export interface AuthState {
  isLoggedIn: boolean;
  username: string;
  token: string;
  refreshToken: string;
  expiresAt: number | null;
  ttlSeconds: number | null;
  isExpiringSoon: boolean;
}

/** 业务请求临界提前续约窗口：5 分钟（毫秒） */
export const PROACTIVE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** 后台定期健康检查续约窗口：24 小时（毫秒） */
export const BACKGROUND_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

export class AuthManager {
  private _refreshPromise: Promise<RefreshResult> | null = null;
  private _authListeners: Set<(state: AuthState) => void> = new Set();
  private _networkListening = false;
  /** 硬失败后的冷却窗口：期间不再对服务端发起注定 401 的续签（防日志轰炸），但保留手动/强制通道 */
  private _hardFailCooldownUntil = 0;
  /** 最近一次续签结果快照，供诊断面板展示真实自愈状态（而非写死文案） */
  lastRefreshResult: RefreshResult | null = null;

  constructor() {
    this._initNetworkListener();
  }

  /**
   * 安全解析 JWT Payload
   */
  parseJwtPayload(token: string): JwtPayload | null {
    if (!token || typeof token !== 'string') return null;
    const parts = token.trim().split('.');
    if (parts.length !== 3) return null;

    try {
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4 !== 0) {
        b64 += '=';
      }
      const jsonStr = decodeURIComponent(
        Array.prototype.map
          .call(atob(b64), (c: string) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(jsonStr) as JwtPayload;
    } catch {
      try {
        const simple = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
        return JSON.parse(simple) as JwtPayload;
      } catch {
        return null;
      }
    }
  }

  /**
   * 计算 JWT 过期时间戳（毫秒）
   */
  getTokenExpirationMs(token: string): number | null {
    const payload = this.parseJwtPayload(token);
    if (!payload || typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  }

  /**
   * 计算 JWT 剩余有效秒数 (TTL)
   */
  getTokenTtlSeconds(token: string): number | null {
    const expMs = this.getTokenExpirationMs(token);
    if (expMs == null) return null;
    const diff = Math.floor((expMs - Date.now()) / 1000);
    return diff > 0 ? diff : 0;
  }

  /**
   * 判断 Token 是否已完全过期
   */
  isTokenExpired(token: string): boolean {
    const expMs = this.getTokenExpirationMs(token);
    if (expMs == null) return false;
    return Date.now() >= expMs;
  }

  /**
   * 判断 Token 是否处于临界过期窗口（即将失效）
   */
  isTokenExpiringSoon(token: string, marginMs = PROACTIVE_REFRESH_MARGIN_MS): boolean {
    const expMs = this.getTokenExpirationMs(token);
    if (expMs == null) return false;
    return (Date.now() + marginMs) >= expMs;
  }

  /**
   * 获取当前完整鉴权快照
   */
  getAuthState(): AuthState {
    const config = storage.getConfig();
    const token = String(config.dofeeJwtToken || '').trim();
    const refreshToken = String(config.dofeeRefreshToken || '').trim();
    const expMs = token ? this.getTokenExpirationMs(token) : null;
    const ttl = token ? this.getTokenTtlSeconds(token) : null;

    return {
      // 有 access token 或 refresh token 任一即视为"已登录"（refresh token 可静默换新 access token）
      isLoggedIn: Boolean(token || refreshToken),
      username: config.dofeeUsername || '',
      token,
      refreshToken,
      expiresAt: expMs,
      ttlSeconds: ttl,
      isExpiringSoon: token ? this.isTokenExpiringSoon(token) : false
    };
  }

  /**
   * 监听鉴权状态变更（登录、刷新、退出）
   */
  onAuthStateChange(listener: (state: AuthState) => void): () => void {
    this._authListeners.add(listener);
    return () => {
      this._authListeners.delete(listener);
    };
  }

  private _notifyAuthChange() {
    const state = this.getAuthState();
    for (const listener of this._authListeners) {
      try {
        listener(state);
      } catch (e) {
        console.warn('[AuthManager] 状态变更监听回调异常:', e);
      }
    }
  }

  /**
   * 核心方法：确保获取有效 Token（主动防护）
   * 1. 确保本地存储已完成 Hydration；
   * 2. 若 Token 临界过期且有 Refresh Token，触发单例无感静默续签；
   * 3. 若无可用凭证，返回 null。
   */
  async ensureValidToken(forceRefresh = false): Promise<string | null> {
    const config = await storage.ensureHydrated();
    const token = String(config.dofeeJwtToken || '').trim();
    const refreshToken = String(config.dofeeRefreshToken || '').trim();

    if (!token && !refreshToken) {
      return null;
    }

    // 若需要强制刷新，或 Token 已临界即将过期，且有 Refresh Token，则主动续签
    const shouldRefresh = forceRefresh || (token ? this.isTokenExpiringSoon(token) : true);
    if (shouldRefresh && refreshToken) {
      console.log(`[AuthManager] ⚡ 令牌${forceRefresh ? '强制刷新' : '临界过期检查'}，启动单例静默续签...`);
      const refreshRes = await this.refreshToken('proactive');
      if (refreshRes.success && refreshRes.token) {
        return refreshRes.token;
      }
      // 若续约因网络故障等软错误失败，且旧 Token 在物理上尚未完全过期，降级复用旧 Token
      if (!refreshRes.isHardFailure && token && !this.isTokenExpired(token)) {
        console.warn('[AuthManager] ⚠️ 续签网络异常，但当前 Token 物理上尚未过期，降级继续使用');
        return token;
      }
      return refreshRes.token || (this.isTokenExpired(token) ? null : token);
    }

    return token || null;
  }

  /**
   * 核心方法：单例互斥刷新 Refresh Token（消除并发踩踏）
   * 
   * 关键机制：
   * - 无论页面有多少个并发请求同时命中 401 或临界期，均接入同一个 _refreshPromise；
   * - 成功后原子化写回 storage，并广播状态变更；
   * - 区分硬错误与软错误，避免断网时误清空凭据。
   */
  async refreshToken(triggerSource = 'reactive', force = false): Promise<RefreshResult> {
    if (this._refreshPromise) {
      console.log(`[AuthManager] ⏳ 命中并发刷新互斥锁，等待现有续签流程完成 (触发源: ${triggerSource})...`);
      return this._refreshPromise;
    }

    // 硬失败冷却期内，自动/被动刷新直接短路（不重复打服务端）；强制刷新（手动登录前奏/显式重试）放行
    if (!force && Date.now() < this._hardFailCooldownUntil) {
      const remain = Math.ceil((this._hardFailCooldownUntil - Date.now()) / 1000);
      return {
        success: false,
        error: `Refresh Token 已被服务端判定失效（冷却中，${remain}s 后才自动重试），需重新登录`,
        isHardFailure: true
      };
    }

    this._refreshPromise = (async (): Promise<RefreshResult> => {
      const config = await storage.ensureHydrated();
      const refreshToken = String(config.dofeeRefreshToken || '').trim();
      const apiBase = String(config.dofeeApiBase || '').trim().replace(/\/+$/, '');

      if (!refreshToken) {
        return {
          success: false,
          error: '缺失 Refresh Token，无法进行自动续签',
          isHardFailure: true
        };
      }
      if (!apiBase) {
        return {
          success: false,
          error: '缺失 dofee 服务端基础地址',
          isHardFailure: false
        };
      }

      console.log(`[AuthManager] 🔄 开始向 dofee 请求续签 Token (来源: ${triggerSource})...`);

      // ── 尝试端点 1：现代 API v1 架构 (/api/v1/auth/refresh) ──────
      const v1Url = `${apiBase}/api/v1/auth/refresh`;
      let res: HttpResponse | null = null;
      let usedEndpoint = 'v1';

      try {
        res = await sendHttpRequest(
          'POST',
          v1Url,
          {
            'Content-Type': 'application/json',
            'X-Dofee-Client': 'smartedu-monitor'
          },
          { refreshToken }
        );
      } catch (e: any) {
        console.warn('[AuthManager] v1 续签端点网络请求异常:', e.message);
      }

      // ── 若 v1 返回 404 或无响应，降级尝试端点 2：Legacy 架构 (/api/auth) ──────
      if (!res || res.status === 404) {
        usedEndpoint = 'legacy';
        const legacyUrl = `${apiBase}/api/auth`;
        try {
          res = await sendHttpRequest(
            'POST',
            legacyUrl,
            {
              'Content-Type': 'application/json',
              'X-Dofee-Client': 'smartedu-monitor'
            },
            {
              action: 'refresh',
              refreshToken
            }
          );
        } catch (e: any) {
          console.warn('[AuthManager] legacy 续签端点网络请求异常:', e.message);
        }
      }

      if (!res) {
        return {
          success: false,
          error: '网络请求无响应或离线，保持当前登录凭据待网络恢复',
          isHardFailure: false
        };
      }

      if (res.ok) {
        try {
          const data = JSON.parse(res.responseText || '{}');
          const newToken = data.token || data.accessToken || data.data?.token || data.data?.accessToken;
          const nextRefreshToken = data.refreshToken || data.data?.refreshToken || refreshToken;

          if (newToken) {
            storage.saveConfig({
              dofeeJwtToken: newToken,
              dofeeRefreshToken: nextRefreshToken
            });
            if (config.dofeeUsername) {
              storage.updateSlotTokens(config.dofeeUsername, newToken, nextRefreshToken);
            }

            const expMs = this.getTokenExpirationMs(newToken);
            const expDesc = expMs ? new Date(expMs).toLocaleString() : '长期有效';
            console.log(`[AuthManager] ✅ Token 自动续签成功！[${usedEndpoint}] 新有效期至: ${expDesc}`);

            this._notifyAuthChange();

            return {
              success: true,
              token: newToken,
              refreshToken: nextRefreshToken
            };
          }
        } catch (err: any) {
          return {
            success: false,
            error: `续签响应 JSON 解析失败: ${err.message}`,
            isHardFailure: false
          };
        }
      }

      // 错误分析：区分硬性凭证失效还是临时服务端/网络错误
      const isHard = res.status === 401 || res.status === 403 || res.status === 400;
      let errMsg = `服务端返回状态 HTTP ${res.status}`;
      try {
        const errJson = JSON.parse(res.responseText || '{}');
        if (errJson.error || errJson.message) {
          errMsg = errJson.error || errJson.message;
        }
      } catch (_) {
        if (res.responseText) errMsg = res.responseText.slice(0, 150);
      }

      if (isHard) {
        console.warn(`[AuthManager] ❌ Refresh Token 已失效 (${res.status}): ${errMsg}`);
        // 服务端明确判定 refresh token 无效/过期/被撤销 → 冷却 5 分钟，期间不再自动重试
        this._hardFailCooldownUntil = Date.now() + 5 * 60 * 1000;
      } else {
        console.warn(`[AuthManager] ⚠️ 续签暂时不可用 (${res.status}): ${errMsg}，凭据已保留`);
      }

      const failResult: RefreshResult = {
        success: false,
        error: errMsg,
        isHardFailure: isHard
      };
      this.lastRefreshResult = failResult;
      return failResult;
    })().then((result) => {
      this.lastRefreshResult = result;
      return result;
    }).finally(() => {
      this._refreshPromise = null;
    });

    return this._refreshPromise;
  }

  /**
   * 401/403 异常自愈仲裁器
   *
   * 解决并发请求的"重叠 401"：
   * 若当前 storage 的 Token 已经被其他先执行完的请求刷新了，则无需重刷，直接使用新 Token；
   * 否则触发一次单例续约。
   *
   * 【关键修复】此处必须走异步 ensureHydrated()，冷启动时同步 getConfig() 可能读到尚未水合的空配置，
   * 会误判"没 token"并拿空 refreshToken 去刷新 → 被 single-flight 锁短路成 null → 静默失败。
   */
  async handleUnauthorized(usedToken: string): Promise<string | null> {
    const currentConfig = await storage.ensureHydrated();
    const currentToken = String(currentConfig.dofeeJwtToken || '').trim();

    // 检查是否有前序请求已经完成了续签，当前 Token 已经更新
    if (currentToken && currentToken !== usedToken && !this.isTokenExpired(currentToken)) {
      console.log('[AuthManager] 💡 观测到其他并发请求已完成 Token 刷新，直接复用最新凭据');
      return currentToken;
    }

    // 否则发起单例刷新
    const refreshRes = await this.refreshToken('unauthorized_intercept');
    if (refreshRes.success && refreshRes.token) {
      return refreshRes.token;
    }

    return null;
  }

  /** 冷却期剩余秒数（0 = 未在冷却），供诊断面板展示 */
  getHardFailCooldownRemainingSeconds(): number {
    return Math.max(0, Math.ceil((this._hardFailCooldownUntil - Date.now()) / 1000));
  }

  /**
   * 断网与休眠唤醒自愈监听
   */
  private _initNetworkListener() {
    if (typeof window === 'undefined' || this._networkListening) return;
    this._networkListening = true;

    window.addEventListener('online', () => {
      console.log('[AuthManager] 🌐 检测到网络恢复在线，触发凭据健康检查与自愈...');
      setTimeout(() => {
        const state = this.getAuthState();
        if (state.isLoggedIn && state.refreshToken && (state.isExpiringSoon || (state.expiresAt && state.expiresAt <= Date.now()))) {
          this.refreshToken('network_online_healing').catch(() => {});
        }
      }, 1000);
    });
  }
}

export const authManager = new AuthManager();

if (typeof window !== 'undefined') {
  (window as any).SmartEduAuthManager = authManager;
}
