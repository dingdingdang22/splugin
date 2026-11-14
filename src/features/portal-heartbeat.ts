/**
 * portal-heartbeat.ts - 智慧教育主页心跳与登录状态探针 (TypeScript / ESM)
 *
 * 安全原则：
 * - 仅在页面本地检测智慧平台登录状态（user_id）与已知教材 ID，不向 Service Worker 传输或持久化
 *   平台的 access_token / mac_key 或其它 localStorage 令牌；
 * - 仅将插件自身的 dofeeConfig 同步至后台用于 dofee 鉴权续签。
 */

import { readSmarteduIdentity } from '../core/import-user-guard';
import { storage } from '../core/storage';

const HEARTBEAT_INTERVAL = 30000;
let lastLoggedUserId = '';
let initialSyncTriggered = false;
let heartbeatIntervalId: any = null;

function handleContextInvalidated() {
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
  const W: any = typeof window !== 'undefined' ? window : globalThis;
  if (W && W.SmartEduDiagnostic && typeof W.SmartEduDiagnostic.setUpdateReady === 'function') {
    W.SmartEduDiagnostic.setUpdateReady('最新版');
  }
}

function checkLoginStatus(userId: string): boolean {
  if (userId) return true;
  try {
    const userEl = document.querySelector('.user-info, .header-user, .user-name, [class*="user"], [class*="avatar"]');
    if (userEl && ((userEl as HTMLElement).innerText || userEl.textContent || '').trim() && !/登录|注册/.test((userEl as HTMLElement).innerText || userEl.textContent || '')) return true;
  } catch (e) {}
  return false;
}

export function collectPortalContext() {
  const authTokens: Record<string, any> = {};
  const teachingMaterialIds = new Set<string>();
  const identity = readSmarteduIdentity();
  const userId = identity?.user_id || '';

  // 联动多用户槽位自动识别激活
  storage.activateSlotBySmarteduUserId(userId || null);

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const val = localStorage.getItem(key);
      if (!val) continue;

      if (key === 'SMARTEDU_MONITOR_CONFIG' && !storage.isHydrated()) {
        try { authTokens.dofeeConfig = JSON.parse(val); } catch (e) {}
      }

      if (/teachingmaterial|tmId|course|book|CHAPTER_SELECTED|SYNCED_CATALOGS/i.test(key) || /teachingmaterial_id|tree_id/i.test(val)) {
        const matches = val.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
        if (matches) {
          matches.forEach(id => teachingMaterialIds.add(id));
        }
      }
    }
  } catch (e) {}

  const liveCfg = storage.getConfig();
  if (storage.isHydrated() && liveCfg && (liveCfg.dofeeJwtToken || liveCfg.dofeeRefreshToken)) {
    authTokens.dofeeConfig = { ...liveCfg, _fromHeartbeat: true };
  } else if (authTokens.dofeeConfig) {
    authTokens.dofeeConfig = { ...authTokens.dofeeConfig, _fromHeartbeat: true };
  }

  try {
    const urlMatches = location.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    if (urlMatches) {
      urlMatches.forEach(id => teachingMaterialIds.add(id));
    }
  } catch (e) {}

  const isLoggedIn = checkLoginStatus(userId);
  const currentUserId = userId || (isLoggedIn ? 'logged_in_user' : '');
  const justLoggedIn = isLoggedIn && (!initialSyncTriggered || (currentUserId && currentUserId !== lastLoggedUserId));

  if (justLoggedIn) {
    initialSyncTriggered = true;
    if (currentUserId) lastLoggedUserId = currentUserId;
  }

  return {
    url: location.href,
    title: document.title,
    isLoggedIn,
    justLoggedIn,
    authTokens,
    teachingMaterialIds: Array.from(teachingMaterialIds),
    timestamp: Date.now()
  };
}

export function sendPortalHeartbeat() {
  const ctx = collectPortalContext();

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id || !chrome.runtime.sendMessage) {
    handleContextInvalidated();
    return;
  }

  try {
    chrome.runtime.sendMessage({
      type: 'SMARTEDU_HEARTBEAT',
      data: ctx
    }, () => {
      const lastErr = chrome.runtime?.lastError;
      if (lastErr && (lastErr.message?.includes('invalidated') || lastErr.message?.includes('context'))) {
        handleContextInvalidated();
      }
    });
  } catch (e: any) {
    if (e?.message?.includes('invalidated') || e?.message?.includes('context')) {
      handleContextInvalidated();
    }
  }
}

export function initPortalHeartbeat() {
  setTimeout(sendPortalHeartbeat, 1500);
  if (!heartbeatIntervalId) {
    heartbeatIntervalId = setInterval(sendPortalHeartbeat, HEARTBEAT_INTERVAL);
  }

  try {
    if (typeof window !== 'undefined') {
      const onRoute = () => setTimeout(sendPortalHeartbeat, 300);
      window.addEventListener('popstate', onRoute);
      window.addEventListener('hashchange', onRoute);
      window.addEventListener('smartedu-route-change', onRoute);
    }
  } catch (e) {}

  try {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('storage', (ev) => {
        if (ev && ev.key && /ND_UC_AUTH|SMARTEDU_MONITOR_CONFIG/i.test(ev.key)) {
          initialSyncTriggered = false;
          const curId = readSmarteduIdentity()?.user_id || null;
          storage.activateSlotBySmarteduUserId(curId);
          setTimeout(sendPortalHeartbeat, 500);
        }
      });
    }
  } catch (e) {}
}
