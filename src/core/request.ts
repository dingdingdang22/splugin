/**
 * request.ts - 跨环境网络通信封装 (TypeScript / ESM)
 * 
 * 核心机制：
 * 1. 在 MV3 扩展环境下，Content Script 受宿主网页（如智慧教育平台 basic.smartedu.cn）的 CORS 与 CSP (connect-src) 严格限制；
 * 2. 优先通过 chrome.runtime.sendMessage 将网络请求委托给 Background Service Worker (BG_HTTP_REQUEST)，
 *    享受 manifest 中 host_permissions 声明的完全免 CORS / 免 CSP 网络直通特权；
 * 3. 当处于非扩展环境（或 Service Worker 响应超时）时，安全降级为原生 fetch。
 */

import { authManager } from './auth';

export interface HttpResponse {
  ok: boolean;
  status: number;
  responseText: string;
  error?: string;
}

export interface AuthRequestOptions {
  forceRefresh?: boolean;
  skipAutoRefresh?: boolean;
}

export function sendHttpRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  data?: any
): Promise<HttpResponse> {
  const body = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : undefined;

  return new Promise((resolve) => {
    // 1. 优先通过 Background Service Worker 发送
    if (
      typeof chrome !== 'undefined' &&
      chrome.runtime &&
      chrome.runtime.id &&
      typeof chrome.runtime.sendMessage === 'function'
    ) {
      let isSettled = false;
      const timeoutTimer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          fallbackFetch();
        }
      }, 15000);

      try {
        chrome.runtime.sendMessage(
          {
            type: 'BG_HTTP_REQUEST',
            method,
            url,
            headers,
            data: body,
          },
          (resp) => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timeoutTimer);

            if (chrome.runtime.lastError || !resp) {
              fallbackFetch();
            } else if (!resp.ok && resp.status === 0) {
              fallbackFetch();
            } else {
              resolve({
                ok: resp.status >= 200 && resp.status < 300,
                status: resp.status,
                responseText: resp.responseText || '',
                error: resp.status >= 400 ? `HTTP ${resp.status}` : undefined,
              });
            }
          }
        );
        return;
      } catch (e) {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutTimer);
          fallbackFetch();
        }
        return;
      }
    }

    // 2. 降级原生 fetch
    fallbackFetch();

    function fallbackFetch() {
      fetch(url, { method, headers, body })
        .then(async (res) => {
          const text = await res.text();
          resolve({
            ok: res.ok,
            status: res.status,
            responseText: text,
            error: res.ok ? undefined : `HTTP ${res.status}`,
          });
        })
        .catch((err: any) => {
          resolve({
            ok: false,
            status: 0,
            responseText: '',
            error: err.message || '网络请求失败',
          });
        });
    }
  });
}

export async function fetchJson<T = any>(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ ok: boolean; data: T | null; status: number; error?: string }> {
  const res = await sendHttpRequest('GET', url, headers);
  if (!res.ok) {
    return { ok: false, data: null, status: res.status, error: res.error || `HTTP ${res.status}` };
  }
  try {
    const data = JSON.parse(res.responseText);
    return { ok: true, data, status: res.status };
  } catch (err: any) {
    return { ok: false, data: null, status: res.status, error: 'JSON 解析失败: ' + err.message };
  }
}

/**
 * 带有全自动身份认证与无感续约重试的高层网络请求网关
 * 
 * 核心机制：
 * 1. 发起请求前：主动探测 JWT 有效期，临界过期提前静默续期；
 * 2. 自动注入 Authorization Bearer 与 X-Dofee-Client 标头；
 * 3. 遇到 401/403 被动拦截：进入 AuthManager 互斥锁排队续期，续约成功后自动无感重发；
 * 4. 彻底解决多业务模块并发请求竞争踩踏与鉴权重复实现问题。
 */
export async function sendAuthHttpRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  data?: any,
  options?: AuthRequestOptions
): Promise<HttpResponse> {
  const token = await authManager.ensureValidToken(options?.forceRefresh);
  const authHeaders = Object.assign(
    {
      'X-Dofee-Client': 'smartedu-monitor',
    },
    headers
  );

  if (token) {
    authHeaders['Authorization'] = `Bearer ${token}`;
  }

  let res = await sendHttpRequest(method, url, authHeaders, data);

  if ((res.status === 401 || res.status === 403) && !options?.skipAutoRefresh) {
    console.log(`[sendAuthHttpRequest] 拦截到 ${res.status} 鉴权失效，尝试自动续签并重试...`);
    const newToken = await authManager.handleUnauthorized(token || '');
    if (newToken && newToken !== token) {
      authHeaders['Authorization'] = `Bearer ${newToken}`;
      console.log('[sendAuthHttpRequest] ✅ 凭证刷新成功，自动重试原请求...');
      res = await sendHttpRequest(method, url, authHeaders, data);
    }
  }

  return res;
}

export async function fetchAuthJson<T = any>(
  url: string,
  headers: Record<string, string> = {},
  options?: AuthRequestOptions
): Promise<{ ok: boolean; data: T | null; status: number; error?: string }> {
  const res = await sendAuthHttpRequest('GET', url, headers, undefined, options);
  if (!res.ok) {
    return { ok: false, data: null, status: res.status, error: res.error || `HTTP ${res.status}` };
  }
  try {
    const data = JSON.parse(res.responseText);
    return { ok: true, data, status: res.status };
  } catch (err: any) {
    return { ok: false, data: null, status: res.status, error: 'JSON 解析失败: ' + err.message };
  }
}
