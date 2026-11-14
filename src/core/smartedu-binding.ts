/**
 * smartedu-binding.ts - dofee 账户 ↔ 智慧平台 user_id 绑定客户端
 *
 * 【设计要求】
 * 1. 插件内完成 dofee 账户与智慧平台用户 ID 的绑定；
 * 2. 解绑必须验证 dofee 账户密码，验证通过方可解绑，否则拒绝；
 * 3. 绑定建立后作为导入链路的服务端权威锚点（配合 import-user-guard）。
 *
 * 【接口】（dofee2 /api/v2/student/smartedu-binding）
 *  GET                      -> 当前绑定状态
 *  POST { action:'bind',    smartedu_user_id, smartedu_display_name? }
 *  POST { action:'unbind',  password }
 *
 * 【安全】
 * - 密码只在内存中传递（POST body -> TLS），绝不落 storage、不写日志、不回显；
 * - 绑定状态做 10 分钟本地缓存，避免心跳级高频请求打服务端；
 * - 一致性检查返回 'unknown'（网络失败）时放行给本地基线守卫兜底（不放大门禁）。
 */

import { storage } from './storage';
import { sendAuthHttpRequest, sendHttpRequest } from './request';

export interface SmarteduBinding {
  username: string;
  smartedu_user_id: string;
  smartedu_display_name: string;
  bound_at: string;
  updated_at: string;
}

export interface BindingApiResult<T> {
  ok: boolean;
  data: T | null;
  status: number;
  code?: string;
  error?: string;
}

export type BindingConsistency =
  | { state: 'match'; binding: SmarteduBinding }
  | { state: 'mismatch'; binding: SmarteduBinding }
  | { state: 'unbound'; binding: null }
  | { state: 'unknown'; binding: SmarteduBinding | null };

const CACHE_KEY = 'SMARTEDU_BINDING_STATUS_CACHE';
const CACHE_TTL_MS = 10 * 60 * 1000;

interface BindingCacheItem {
  binding: SmarteduBinding | null;
  fetched_at: number;
}

type BindingCacheMap = Record<string, BindingCacheItem>;

function parseMaybeJson(raw: any): any {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  return null;
}

async function readAllCache(): Promise<BindingCacheMap> {
  let parsed: any = null;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const res: any = await new Promise((resolve) => {
        try { chrome.storage.local.get([CACHE_KEY], (r: any) => resolve(r || {})); } catch (e) { resolve({}); }
      });
      parsed = parseMaybeJson(res && res[CACHE_KEY]);
    }
  } catch (e) {}
  if (!parsed) {
    try {
      if (typeof localStorage !== 'undefined') {
        parsed = parseMaybeJson(localStorage.getItem(CACHE_KEY));
      }
    } catch (e) {}
  }
  if (!parsed || typeof parsed !== 'object') return {};

  // 兼容旧版单一缓存形态
  if ('fetched_at' in parsed && typeof parsed.fetched_at === 'number') {
    const legacyItem = parsed as BindingCacheItem;
    const legacyUser = legacyItem.binding?.username || '__legacy__';
    return { [legacyUser]: legacyItem };
  }
  return parsed as BindingCacheMap;
}

async function readCache(username: string): Promise<BindingCacheItem | null> {
  const map = await readAllCache();
  const key = username || '__current__';
  return map[key] || map['__legacy__'] || null;
}

async function writeCache(username: string, item: BindingCacheItem): Promise<void> {
  const map = await readAllCache();
  const key = username || '__current__';
  map[key] = item;

  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ [CACHE_KEY]: map });
    }
  } catch (e) {}
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CACHE_KEY, JSON.stringify(map));
    }
  } catch (e) {}
}

async function clearCache(username?: string): Promise<void> {
  if (username) {
    await writeCache(username, { binding: null, fetched_at: 0 });
  } else {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove([CACHE_KEY]);
      }
    } catch (e) {}
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(CACHE_KEY);
      }
    } catch (e) {}
  }
}

class SmarteduBindingClient {
  private _inflight: Promise<BindingApiResult<{ binding: SmarteduBinding | null }>> | null = null;

  /**
   * 查询绑定状态（带 10 分钟缓存）。
   * force=true 强制走服务端（绑定/解绑后立即刷新用）。
   * 可选传入 token 和 username（用于指定槽位查询，而不是仅当前激活账户）。
   */
  async fetchStatus(opts: { force?: boolean; token?: string; username?: string } = {}): Promise<BindingApiResult<{ binding: SmarteduBinding | null }>> {
    const config = await storage.ensureHydrated();
    const targetUser = opts.username || config.dofeeUsername || '';
    if (!opts.force) {
      const cached = await readCache(targetUser);
      if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
        return { ok: true, data: { binding: cached.binding }, status: 200 };
      }
    }

    try {
      const base = String(config.dofeeApiBase || '').trim().replace(/\/+$/, '');
      if (!base) {
        return { ok: false, data: null, status: 0, code: 'NO_API_BASE', error: '未配置 dofee API 地址' };
      }
      let res: any;
      if (opts.token) {
        res = await sendHttpRequest('GET', `${base}/api/v2/student/smartedu-binding`, {
          'Authorization': `Bearer ${opts.token}`,
          'X-Dofee-Client': 'smartedu-monitor'
        });
      } else {
        res = await sendAuthHttpRequest('GET', `${base}/api/v2/student/smartedu-binding`);
      }
      let parsed: any = null;
      try { parsed = JSON.parse(res.responseText); } catch (e) { /* 保持 null */ }

      if (res.status === 404 || (parsed && parsed.code === 'NOT_BOUND')) {
        await writeCache(targetUser, { binding: null, fetched_at: Date.now() });
        return { ok: true, data: { binding: null }, status: 200 };
      }
      if (!res.ok || !parsed || parsed.success !== true) {
        return {
          ok: false, data: null, status: res.status,
          code: parsed?.code || `HTTP_${res.status}`,
          error: parsed?.error || res.error || `HTTP ${res.status}`
        };
      }
      const binding = (parsed.binding || null) as SmarteduBinding | null;
      const actualUser = binding?.username || targetUser;
      await writeCache(actualUser, { binding, fetched_at: Date.now() });
      return { ok: true, data: { binding }, status: res.status };
    } catch (e: any) {
      return { ok: false, data: null, status: 0, code: 'NETWORK_ERROR', error: e.message || '网络异常' };
    }
  }

  /**
   * 绑定智慧平台用户到指定 dofee 账户。
   * 可选传入 token 和 username（为指定槽位执行绑定）。
   */
  async bind(
    identity: { user_id: string; display_name?: string },
    opts?: { token?: string; username?: string }
  ): Promise<BindingApiResult<{ binding: SmarteduBinding; already_bound: boolean }>> {
    const config = await storage.ensureHydrated();
    const base = String(config.dofeeApiBase || '').trim().replace(/\/+$/, '');
    if (!base) {
      return { ok: false, data: null, status: 0, code: 'NO_API_BASE', error: '未配置 dofee API 地址' };
    }
    const reqBody = {
      action: 'bind',
      smartedu_user_id: identity.user_id,
      smartedu_display_name: identity.display_name || ''
    };

    let res: any;
    if (opts?.token) {
      res = await sendHttpRequest('POST', `${base}/api/v2/student/smartedu-binding`, {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.token}`,
        'X-Dofee-Client': 'smartedu-monitor'
      }, reqBody);
    } else {
      res = await sendAuthHttpRequest('POST', `${base}/api/v2/student/smartedu-binding`, {
        'Content-Type': 'application/json'
      }, reqBody);
    }

    let parsed: any = null;
    try { parsed = JSON.parse(res.responseText); } catch (e) { /* 保持 null */ }

    if (res.ok && parsed && parsed.success === true && parsed.binding) {
      const binding = parsed.binding as SmarteduBinding;
      await writeCache(binding.username || opts?.username || config.dofeeUsername, { binding, fetched_at: Date.now() });
      return {
        ok: true,
        data: { binding, already_bound: !!parsed.already_bound },
        status: res.status
      };
    }
    return {
      ok: false, data: null, status: res.status,
      code: parsed?.code || `HTTP_${res.status}`,
      error: parsed?.error || res.error || '绑定失败'
    };
  }

  /**
   * 解绑（必须传 dofee 账户密码；密码不落任何存储）。
   * 可选传入 token 和 username（为指定槽位执行解绑）。
   */
  async unbind(
    password: string,
    opts?: { token?: string; username?: string }
  ): Promise<BindingApiResult<{ unbound: SmarteduBinding }>> {
    const config = await storage.ensureHydrated();
    const base = String(config.dofeeApiBase || '').trim().replace(/\/+$/, '');
    if (!base) {
      return { ok: false, data: null, status: 0, code: 'NO_API_BASE', error: '未配置 dofee API 地址' };
    }
    const reqBody = {
      action: 'unbind',
      password
    };

    let res: any;
    if (opts?.token) {
      res = await sendHttpRequest('POST', `${base}/api/v2/student/smartedu-binding`, {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.token}`,
        'X-Dofee-Client': 'smartedu-monitor'
      }, reqBody);
    } else {
      res = await sendAuthHttpRequest('POST', `${base}/api/v2/student/smartedu-binding`, {
        'Content-Type': 'application/json'
      }, reqBody);
    }

    let parsed: any = null;
    try { parsed = JSON.parse(res.responseText); } catch (e) { /* 保持 null */ }

    if (res.ok && parsed && parsed.success === true) {
      const targetUser = opts?.username || config.dofeeUsername;
      await clearCache(targetUser);
      return {
        ok: true,
        data: { unbound: (parsed.unbound || null) as SmarteduBinding },
        status: res.status
      };
    }
    return {
      ok: false, data: null, status: res.status,
      code: parsed?.code || `HTTP_${res.status}`,
      error: parsed?.error || res.error || '解绑失败'
    };
  }

  /**
   * 一致性检查（守卫用，缓存优先）：
   * - 'match'    绑定存在且与当前智慧平台用户一致 -> 放行；
   * - 'mismatch' 绑定存在但用户不一致 -> 守卫必须硬拒绝（弹窗确认也不放行）；
   * - 'unbound'  未绑定 -> 走本地基线守卫既有流程（兼容未绑定用户）；
   * - 'unknown'  查询失败（网络/服务端异常）-> 不放大故障，回落本地基线守卫。
   */
  async checkConsistency(currentUserId: string, username?: string): Promise<BindingConsistency> {
    const result = await this.fetchStatus({ username });
    if (!result.ok || !result.data) {
      return { state: 'unknown', binding: null };
    }
    const binding = result.data.binding;
    if (!binding) return { state: 'unbound', binding: null };
    if (binding.smartedu_user_id === currentUserId) return { state: 'match', binding };
    return { state: 'mismatch', binding };
  }
}

export const smarteduBinding = new SmarteduBindingClient();

/**
 * 解绑密码输入弹窗（DOM 模态框，密码掩码输入）。
 * 返回输入的密码字符串；取消/Esc/无 DOM 环境 -> null（调用方必须中止解绑）。
 * 密码仅返回给调用方做一次性 POST，不做任何暂存。
 */
export function promptUnbindPassword(boundName: string): Promise<string | null> {
  if (typeof document === 'undefined' || !document.body) return Promise.resolve(null);

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'smartedu-unbind-password-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'background:rgba(0,0,0,0.55)', 'display:flex', 'align-items:center',
      'justify-content:center', 'font-family:system-ui,-apple-system,sans-serif'
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
      'background:#fff', 'color:#1a1a1a', 'max-width:420px', 'width:90%',
      'border-radius:10px', 'padding:20px 22px', 'box-shadow:0 8px 32px rgba(0,0,0,0.35)',
      'line-height:1.65', 'font-size:14px'
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '🔐 解绑需要验证 dofee 账户密码';
    title.style.cssText = 'font-size:16px;font-weight:700;color:#b91c1c;margin-bottom:10px';
    box.appendChild(title);

    const desc = document.createElement('div');
    desc.textContent = `即将解除绑定：${boundName}。解绑后导入将不再受绑定保护，请输入 dofee 账户密码确认。`;
    desc.style.cssText = 'white-space:pre-wrap;color:#374151;margin-bottom:12px';
    box.appendChild(desc);

    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'dofee 账户密码';
    input.autocomplete = 'current-password';
    input.style.cssText = [
      'width:100%', 'box-sizing:border-box', 'padding:9px 12px', 'border:1px solid #d1d5db',
      'border-radius:6px', 'font-size:14px', 'margin-bottom:14px'
    ].join(';');
    box.appendChild(input);

    const errLine = document.createElement('div');
    errLine.style.cssText = 'color:#b91c1c;font-size:12px;min-height:16px;margin-bottom:8px';
    box.appendChild(errLine);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消解绑';
    cancelBtn.style.cssText = [
      'padding:8px 18px', 'border-radius:6px', 'border:1px solid #d1d5db',
      'background:#fff', 'cursor:pointer', 'font-size:14px'
    ].join(';');

    const okBtn = document.createElement('button');
    okBtn.textContent = '验证并解绑';
    okBtn.style.cssText = [
      'padding:8px 18px', 'border-radius:6px', 'border:1px solid #b91c1c',
      'background:#b91c1c', 'color:#fff', 'cursor:pointer', 'font-size:14px'
    ].join(';');

    const done = (result: string | null) => {
      try { document.body.removeChild(overlay); } catch (e) {}
      resolve(result);
    };

    const submit = () => {
      const val = input.value || '';
      if (!val.trim()) {
        errLine.textContent = '密码不能为空';
        return;
      }
      done(val); // 密码交调用方一次性使用，本弹窗不留存
    };

    cancelBtn.addEventListener('click', () => done(null));
    okBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); done(null); }
    };
    document.addEventListener('keydown', onKey);

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
  });
}
