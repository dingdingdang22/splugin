/**
 * storage.ts - 本地队列与配置持久化模块 (TypeScript / ESM)
 * 
 * 职责：
 * 1. 管理插件运行配置（dofee API 地址、用户 JWT、采样心跳间隔、启用开关）；
 * 2. 维护离线暂存队列（Outbox Queue），支持断网暂存与幂等防重；
 * 3. 采用 chrome.storage / localStorage 隔离存储，不污染页面全局对象。
 */

export const MAX_BOUND_ACCOUNTS = 3;

export interface AccountSlot {
  dofeeUsername: string;
  dofeeJwtToken: string;
  dofeeRefreshToken: string;
  smarteduUserId: string;
  smarteduDisplayName: string;
  boundAt: string;
}

export interface MonitorConfig {
  enabled: boolean;
  dofeeApiBase: string;
  dofeeUsername: string;
  dofeeJwtToken: string;
  dofeeRefreshToken: string;
  boundAccounts?: AccountSlot[];
  activeSmarteduUserId?: string;
  heartbeatIntervalSeconds: number;
  minCompletionRate: number;
  debugLog: boolean;
  /** 是否开启「错题本」同步（默认关闭） */
  syncWrongBook: boolean;
  /** 是否开启「我的习题」同步（默认关闭） */
  syncMyExercises: boolean;
  /** 配置最近一次主动写入的时间戳（用于防止后台标签页旧心跳回写覆盖 Popup 新配置） */
  configUpdatedAt?: number;
}

export interface QueueItem {
  id: string;
  payload: any;
  retryCount: number;
  createdAt: number;
  username?: string;
  smarteduUserId?: string;
}

export interface SyncedCatalogMeta {
  username: string;
  tmId: string;
  syncedAt?: number;
  [key: string]: any;
}

const STORAGE_KEYS = {
  CONFIG: 'SMARTEDU_MONITOR_CONFIG',
  QUEUE: 'SMARTEDU_MONITOR_OUTBOX_QUEUE',
  SENT_RECORD: 'SMARTEDU_MONITOR_SENT_BUCKETS',
  SYNCED_CATALOGS: 'SMARTEDU_MONITOR_SYNCED_CATALOGS'
};

const DEFAULT_CONFIG: MonitorConfig = {
  enabled: true,
  dofeeApiBase: '',
  dofeeUsername: '',
  dofeeJwtToken: '',
  dofeeRefreshToken: '',
  boundAccounts: [],
  activeSmarteduUserId: '',
  heartbeatIntervalSeconds: 120,
  minCompletionRate: 0.90,
  debugLog: true,
  syncWrongBook: false,
  syncMyExercises: false
};

export class MonitorStorage {
  private _config: MonitorConfig | null = null;
  private _queue: QueueItem[] | null = null;
  private _isHydrated = false;
  private _hydrationPromise: Promise<MonitorConfig> | null = null;
  private _configListeners: Array<(cfg: MonitorConfig) => void> = [];

  constructor() {
    this._initHydration();
  }

  onConfigChange(cb: (cfg: MonitorConfig) => void): () => void {
    this._configListeners.push(cb);
    return () => {
      this._configListeners = this._configListeners.filter((fn) => fn !== cb);
    };
  }

  private _notifyConfigChange() {
    if (!this._config) return;
    for (const cb of this._configListeners) {
      try { cb(this._config); } catch (e) {}
    }
  }

  /**
   * 确保完成从 chrome.storage.local（扩展专用独立持久区）的异步水合注入。
   * 彻底解决页面刷新瞬间由于异步读取尚未返回而误判未登录、或用空配置覆写后台的竞态 Bug。
   */
  ensureHydrated(): Promise<MonitorConfig> {
    if (this._isHydrated && this._config) {
      return Promise.resolve(this._config);
    }
    if (!this._hydrationPromise) {
      this._hydrationPromise = new Promise((resolve) => {
        const check = () => {
          if (this._isHydrated && this._config) {
            resolve(this._config);
          } else {
            setTimeout(check, 20);
          }
        };
        check();
      });
    }
    return this._hydrationPromise;
  }

  isHydrated(): boolean {
    return this._isHydrated;
  }

  /**
   * 鉴权持久化自愈机制：
   * 解决电脑重启/浏览器清理网站缓存后，Content Script 内存与 localStorage 被清空导致的鉴权丢失。
   * 异步从 chrome.storage.local（扩展专用独立持久区）逆向回填鉴权配置至内存与 localStorage。
   */
  private _initHydration() {
    this.getConfig();

    this._hydrationPromise = new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['SMARTEDU_BACKGROUND_CONFIG', STORAGE_KEYS.SYNCED_CATALOGS], (res) => {
          const bgCfg = res && res['SMARTEDU_BACKGROUND_CONFIG'];
          if (bgCfg && typeof bgCfg === 'object') {
            const safeBg = Object.assign({}, bgCfg);
            if (!safeBg._explicitLogout && this._config?.dofeeJwtToken && !safeBg.dofeeJwtToken) {
              delete safeBg.dofeeJwtToken;
            }
            if (!safeBg._explicitLogout && this._config?.dofeeRefreshToken && !safeBg.dofeeRefreshToken) {
              delete safeBg.dofeeRefreshToken;
            }
            const prevJson = JSON.stringify(this._config || {});
            this._config = Object.assign({}, DEFAULT_CONFIG, this._config, safeBg);
            this._config.syncWrongBook = this._config.syncWrongBook === true;
            this._config.syncMyExercises = this._config.syncMyExercises === true;
            if (JSON.stringify(this._config) !== prevJson) {
              this._setRaw(STORAGE_KEYS.CONFIG, JSON.stringify(this._config));
              if (bgCfg.dofeeJwtToken || bgCfg.dofeeRefreshToken) {
                console.log('[MonitorStorage] ✅ 电脑重启自愈成功：已从 chrome.storage.local 回填鉴权 Token');
              }
            }
          }

          const bgCatalogs = res && res[STORAGE_KEYS.SYNCED_CATALOGS];
          if (bgCatalogs && typeof bgCatalogs === 'object') {
            const localRaw = this._getRaw(STORAGE_KEYS.SYNCED_CATALOGS);
            const localMap = localRaw ? JSON.parse(localRaw) : {};
            const merged = Object.assign({}, bgCatalogs, localMap);
            this._setRaw(STORAGE_KEYS.SYNCED_CATALOGS, JSON.stringify(merged));
            console.log('[MonitorStorage] ✅ 电脑重启自愈成功：已从 chrome.storage.local 回填已同步教材缓存');
          }

          this._isHydrated = true;
          this._notifyConfigChange();
          resolve(this.getConfig());
        });

        // 监听跨进程配置更新（如 Background 自动续签了新 Token，或多标签页同步了教材）
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName === 'local') {
            if (changes['SMARTEDU_BACKGROUND_CONFIG']) {
              const newBgCfg = changes['SMARTEDU_BACKGROUND_CONFIG'].newValue;
              if (newBgCfg) {
                // 如果新配置为空对象，且当前已有有效 Token，防止非预期冲刷
                if (!newBgCfg.dofeeJwtToken && this._config?.dofeeJwtToken && !newBgCfg._explicitLogout) {
                  console.warn('[MonitorStorage] 拦截到非显式登出的空配置广播，跳过凭据覆写');
                  return;
                }
                this._config = Object.assign({}, DEFAULT_CONFIG, this._config, newBgCfg);
                this._config.syncWrongBook = this._config.syncWrongBook === true;
                this._config.syncMyExercises = this._config.syncMyExercises === true;
                this._setRaw(STORAGE_KEYS.CONFIG, JSON.stringify(this._config));
                this._notifyConfigChange();
                console.log('[MonitorStorage] 🔄 监听到后台/其他页面更新配置，已对齐最新状态');
              }
            }
            if (changes[STORAGE_KEYS.SYNCED_CATALOGS]) {
              const newCatalogs = changes[STORAGE_KEYS.SYNCED_CATALOGS].newValue;
              if (newCatalogs) {
                const localRaw = this._getRaw(STORAGE_KEYS.SYNCED_CATALOGS);
                const localMap = localRaw ? JSON.parse(localRaw) : {};
                const merged = Object.assign({}, localMap, newCatalogs);
                this._setRaw(STORAGE_KEYS.SYNCED_CATALOGS, JSON.stringify(merged));
              }
            }
          }
        });
      } else {
        this._isHydrated = true;
        resolve(this.getConfig());
      }
    });
  }

  getConfig(): MonitorConfig {
    if (this._config) {
      if (!Array.isArray(this._config.boundAccounts)) {
        this._config.boundAccounts = [];
      }
      return this._config;
    }
    try {
      const raw = this._getRaw(STORAGE_KEYS.CONFIG);
      this._config = raw ? Object.assign({}, DEFAULT_CONFIG, JSON.parse(raw)) : Object.assign({}, DEFAULT_CONFIG);
      this._config.syncWrongBook = this._config.syncWrongBook === true;
      this._config.syncMyExercises = this._config.syncMyExercises === true;
      if (!Array.isArray(this._config.boundAccounts)) {
        this._config.boundAccounts = [];
      }
      if (this._config.heartbeatIntervalSeconds === 12) {
        this._config.heartbeatIntervalSeconds = 120;
        this.saveConfig({ heartbeatIntervalSeconds: 120 });
      }
      this._migrateSingleAccountToSlots();
    } catch (e) {
      console.warn('[MonitorStorage] 解析配置失败，使用默认配置:', e);
      this._config = Object.assign({}, DEFAULT_CONFIG);
    }
    return this._config!;
  }

  /**
   * 自动迁移：若已有旧版本单账户登录凭据且尚未建立槽位，尝试平滑迁移至第 1 个槽位
   */
  private _migrateSingleAccountToSlots() {
    if (!this._config) return;
    if (!Array.isArray(this._config.boundAccounts)) {
      this._config.boundAccounts = [];
    }
    if (this._config.boundAccounts.length === 0 && this._config.dofeeUsername && (this._config.dofeeJwtToken || this._config.dofeeRefreshToken)) {
      let smarteduUserId = '';
      let smarteduDisplayName = '';
      try {
        const cacheRaw = this._getRaw('SMARTEDU_BINDING_STATUS_CACHE');
        if (cacheRaw) {
          const cache = JSON.parse(cacheRaw);
          if (cache && cache.binding && cache.binding.username === this._config.dofeeUsername && cache.binding.smartedu_user_id) {
            smarteduUserId = String(cache.binding.smartedu_user_id).trim();
            smarteduDisplayName = String(cache.binding.smartedu_display_name || '').trim();
          }
        }
      } catch (e) {}

      if (!smarteduUserId) {
        try {
          const baseRaw = this._getRaw('SMARTEDU_IMPORT_GUARD_USER');
          if (baseRaw) {
            const b = JSON.parse(baseRaw);
            if (b && b.user_id) {
              smarteduUserId = String(b.user_id).trim();
              smarteduDisplayName = String(b.display_name || '').trim();
            }
          }
        } catch (e) {}
      }

      if (smarteduUserId) {
        const initialSlot: AccountSlot = {
          dofeeUsername: this._config.dofeeUsername,
          dofeeJwtToken: this._config.dofeeJwtToken,
          dofeeRefreshToken: this._config.dofeeRefreshToken,
          smarteduUserId,
          smarteduDisplayName,
          boundAt: new Date().toISOString()
        };
        this._config.boundAccounts.push(initialSlot);
        this._config.activeSmarteduUserId = smarteduUserId;
        this._setRaw(STORAGE_KEYS.CONFIG, JSON.stringify(this._config));
        try {
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ 'SMARTEDU_BACKGROUND_CONFIG': this._config });
          }
        } catch (e) {}
        console.log(`[MonitorStorage] ✅ 成功将已有单账户 [${this._config.dofeeUsername}] 平滑迁移至多用户槽位 1`);
      }
    }
  }

  /**
   * 获取当前全部已绑定的账户槽位（最多 3 组）
   */
  getBoundAccounts(): AccountSlot[] {
    const cfg = this.getConfig();
    return Array.isArray(cfg.boundAccounts) ? cfg.boundAccounts.slice(0, MAX_BOUND_ACCOUNTS) : [];
  }

  /**
   * 保存或更新一个绑定槽位（严格执行 1:1 双向唯一性校验）
   */
  saveBoundSlot(slot: AccountSlot): { success: boolean; error?: string; config: MonitorConfig } {
    const dofeeUsername = String(slot.dofeeUsername || '').trim();
    const smarteduUserId = String(slot.smarteduUserId || '').trim();
    const token = String(slot.dofeeJwtToken || '').trim();
    const refreshToken = String(slot.dofeeRefreshToken || '').trim();
    const displayName = String(slot.smarteduDisplayName || '').trim();

    if (!dofeeUsername) {
      return { success: false, error: 'dofee2 用户名不能为空', config: this.getConfig() };
    }
    if (!smarteduUserId) {
      return { success: false, error: '智慧平台用户 ID 不能为空', config: this.getConfig() };
    }
    if (!token && !refreshToken) {
      return { success: false, error: '缺少有效登录凭证 Token', config: this.getConfig() };
    }

    const cfg = this.getConfig();
    const slots = Array.isArray(cfg.boundAccounts) ? [...cfg.boundAccounts] : [];

    // 1. 唯一性校验：该 smarteduUserId 是否已被其他 dofeeUsername 占用
    const occupiedSmartedu = slots.find(
      (s) => s.smarteduUserId === smarteduUserId && s.dofeeUsername !== dofeeUsername
    );
    if (occupiedSmartedu) {
      return {
        success: false,
        error: `该智慧平台用户已被 dofee2 账户 [${occupiedSmartedu.dofeeUsername}] 绑定，禁止一对多`,
        config: cfg
      };
    }

    // 2. 唯一性校验：该 dofeeUsername 是否已被其他 smarteduUserId 占用
    const occupiedDofee = slots.find(
      (s) => s.dofeeUsername === dofeeUsername && s.smarteduUserId !== smarteduUserId
    );
    if (occupiedDofee) {
      return {
        success: false,
        error: `dofee2 账户 [${dofeeUsername}] 已绑定智慧用户 [${occupiedDofee.smarteduDisplayName || occupiedDofee.smarteduUserId}]，禁止多对一`,
        config: cfg
      };
    }

    // 3. 槽位数检查（如果是新增）
    const existingIndex = slots.findIndex(
      (s) => s.dofeeUsername === dofeeUsername && s.smarteduUserId === smarteduUserId
    );
    if (existingIndex < 0 && slots.length >= MAX_BOUND_ACCOUNTS) {
      return {
        success: false,
        error: `已达到最大绑定上限（最多 ${MAX_BOUND_ACCOUNTS} 个账户），请先解绑闲置账户`,
        config: cfg
      };
    }

    const newSlot: AccountSlot = {
      dofeeUsername,
      dofeeJwtToken: token,
      dofeeRefreshToken: refreshToken,
      smarteduUserId,
      smarteduDisplayName: displayName || (existingIndex >= 0 ? slots[existingIndex].smarteduDisplayName : ''),
      boundAt: existingIndex >= 0 ? slots[existingIndex].boundAt : new Date().toISOString()
    };

    if (existingIndex >= 0) {
      slots[existingIndex] = newSlot;
    } else {
      slots.push(newSlot);
    }

    // 若当前活跃用户匹配，或者当前无激活账户，则立即更新顶层激活投影
    const shouldActivate = !cfg.dofeeUsername || cfg.activeSmarteduUserId === smarteduUserId || cfg.dofeeUsername === dofeeUsername;
    const partial: Partial<MonitorConfig> = {
      boundAccounts: slots
    };
    if (shouldActivate) {
      partial.dofeeUsername = dofeeUsername;
      partial.dofeeJwtToken = token;
      partial.dofeeRefreshToken = refreshToken;
      partial.activeSmarteduUserId = smarteduUserId;
    }

    const saved = this.saveConfig(partial);
    console.log(`[MonitorStorage] 🔗 成功保存绑定槽位 [${dofeeUsername}] ↔ [${smarteduUserId}] (当前总槽位: ${slots.length})`);
    return { success: true, config: saved };
  }

  /**
   * 解除并移除指定 dofee2 账户的绑定槽位
   */
  removeBoundSlot(dofeeUsername: string): { success: boolean; removedSlot?: AccountSlot; config: MonitorConfig } {
    const targetUser = String(dofeeUsername || '').trim();
    if (!targetUser) {
      return { success: false, config: this.getConfig() };
    }

    const cfg = this.getConfig();
    const slots = Array.isArray(cfg.boundAccounts) ? [...cfg.boundAccounts] : [];
    const idx = slots.findIndex((s) => s.dofeeUsername === targetUser);
    if (idx < 0) {
      return { success: false, config: cfg };
    }

    const [removed] = slots.splice(idx, 1);
    const partial: Partial<MonitorConfig> = {
      boundAccounts: slots
    };

    // 若移除的是当前激活账户，将顶层投影置空
    let isExplicitLogout = false;
    if (cfg.dofeeUsername === targetUser) {
      partial.dofeeUsername = '';
      partial.dofeeJwtToken = '';
      partial.dofeeRefreshToken = '';
      partial.activeSmarteduUserId = '';
      (partial as any)._explicitLogout = true;
      isExplicitLogout = true;
    }

    const saved = this.saveConfig(partial, isExplicitLogout);
    console.log(`[MonitorStorage] 🔓 已解除槽位 [${targetUser}] (剩余槽位: ${slots.length})`);
    return { success: true, removedSlot: removed, config: saved };
  }

  /**
   * 根据当前检测到的智慧平台用户 ID，自动识别并激活对应的槽位
   */
  activateSlotBySmarteduUserId(smarteduUserId: string | null): { changed: boolean; activeSlot: AccountSlot | null } {
    const uid = String(smarteduUserId || '').trim();
    const cfg = this.getConfig();
    const slots = this.getBoundAccounts();

    // 1. 若当前未提供有效智慧用户 ID，或槽位中无匹配：挂起激活态
    if (!uid) {
      if (!cfg.dofeeUsername && !cfg.dofeeJwtToken) {
        return { changed: false, activeSlot: null };
      }
      this.saveConfig({
        dofeeUsername: '',
        dofeeJwtToken: '',
        dofeeRefreshToken: '',
        activeSmarteduUserId: '',
        _explicitLogout: true
      }, true);
      console.log('[MonitorStorage] ⏸️ 智慧平台未登录，已挂起 dofee2 同步活跃态');
      return { changed: true, activeSlot: null };
    }

    const matchedSlot = slots.find((s) => s.smarteduUserId === uid);
    if (!matchedSlot) {
      // 当前登录的智慧平台用户不在任何已绑槽位中，必须挂起同步凭证以杜绝串号写入！
      if (!cfg.dofeeUsername && !cfg.dofeeJwtToken) {
        return { changed: false, activeSlot: null };
      }
      this.saveConfig({
        dofeeUsername: '',
        dofeeJwtToken: '',
        dofeeRefreshToken: '',
        activeSmarteduUserId: '',
        _explicitLogout: true
      }, true);
      console.warn(`[MonitorStorage] 🛡️ 智慧平台用户 [${uid}] 未绑定任何 dofee2 槽位，已自动挂起同步`);
      return { changed: true, activeSlot: null };
    }

    // 2. 命中槽位：检查是否已经是当前激活
    if (
      cfg.dofeeUsername === matchedSlot.dofeeUsername &&
      cfg.dofeeJwtToken === matchedSlot.dofeeJwtToken &&
      cfg.activeSmarteduUserId === matchedSlot.smarteduUserId
    ) {
      return { changed: false, activeSlot: matchedSlot };
    }

    // 3. 执行激活切换
    this.saveConfig({
      dofeeUsername: matchedSlot.dofeeUsername,
      dofeeJwtToken: matchedSlot.dofeeJwtToken,
      dofeeRefreshToken: matchedSlot.dofeeRefreshToken,
      activeSmarteduUserId: matchedSlot.smarteduUserId
    });
    console.log(`[MonitorStorage] ⚡ 自动激活匹配槽位：智慧用户 [${matchedSlot.smarteduDisplayName || uid}] ↔ dofee2 [${matchedSlot.dofeeUsername}]`);
    return { changed: true, activeSlot: matchedSlot };
  }

  /**
   * 当 Token 续约更新时，同步更新 boundAccounts 对应槽位的 Token
   */
  updateSlotTokens(dofeeUsername: string, token: string, refreshToken?: string) {
    if (!dofeeUsername || !token) return;
    const cfg = this.getConfig();
    const slots = Array.isArray(cfg.boundAccounts) ? [...cfg.boundAccounts] : [];
    const idx = slots.findIndex((s) => s.dofeeUsername === dofeeUsername);
    if (idx >= 0) {
      slots[idx] = {
        ...slots[idx],
        dofeeJwtToken: token,
        dofeeRefreshToken: refreshToken || slots[idx].dofeeRefreshToken
      };
      this.saveConfig({ boundAccounts: slots });
    }
  }

  /**
   * 保存配置（带防清空保护）
   * 
   * 核心防线：
   * 除非 isExplicitLogout 为 true，否则禁止用空串抹除已有的有效 dofeeJwtToken / dofeeRefreshToken。
   * 这彻底杜绝了"心跳采集空配置"或"页面未水合完成时保存默认配置"将后台已有凭证冲刷掉的惨案。
   */
  saveConfig(partialConfig: Partial<MonitorConfig> & { _explicitLogout?: boolean }, isExplicitLogout = false): MonitorConfig {
    if (partialConfig && partialConfig.dofeeApiBase) {
      let base = String(partialConfig.dofeeApiBase).trim();
      if (base && !/^https?:\/\//i.test(base)) {
        base = 'https://' + base;
      }
      base = base.replace(/\/+$/, '');
      partialConfig.dofeeApiBase = base;
    }

    const current = this.getConfig();
    const safePartial: Partial<MonitorConfig> = Object.assign({}, partialConfig);

    // 防清空保护（Anti-Wipe Guard）
    if (!isExplicitLogout && !partialConfig._explicitLogout) {
      if (safePartial.dofeeJwtToken === '' && current.dofeeJwtToken) {
        console.warn('[MonitorStorage] 🛡️ 触发防清空保护：拦截非注销途径的 dofeeJwtToken 抹除');
        delete safePartial.dofeeJwtToken;
      }
      if (safePartial.dofeeRefreshToken === '' && current.dofeeRefreshToken) {
        console.warn('[MonitorStorage] 🛡️ 触发防清空保护：拦截非注销途径的 dofeeRefreshToken 抹除');
        delete safePartial.dofeeRefreshToken;
      }
    }

    this._config = Object.assign({}, current, safePartial);
    this._config.syncWrongBook = this._config.syncWrongBook === true;
    this._config.syncMyExercises = this._config.syncMyExercises === true;
    this._config.configUpdatedAt = Date.now();
    this._setRaw(STORAGE_KEYS.CONFIG, JSON.stringify(this._config));

    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ 'SMARTEDU_BACKGROUND_CONFIG': this._config });
      }
    } catch (e) {}

    this._notifyConfigChange();
    return this._config;
  }

  logout(): MonitorConfig {
    console.log('[MonitorStorage] 🚪 显式退出登录，清空当前账号凭据');
    return this.saveConfig({
      dofeeUsername: '',
      dofeeJwtToken: '',
      dofeeRefreshToken: '',
      activeSmarteduUserId: '',
      _explicitLogout: true
    }, true);
  }

  getQueue(): QueueItem[] {
    if (this._queue) return this._queue;
    try {
      const raw = this._getRaw(STORAGE_KEYS.QUEUE);
      this._queue = raw ? JSON.parse(raw) : [];
    } catch (e) {
      this._queue = [];
    }
    return this._queue!;
  }

  enqueue(eventItem: any, username?: string, smarteduUserId?: string) {
    const queue = this.getQueue();
    if (queue.length > 150) {
      queue.shift();
    }
    const cfg = this.getConfig();
    queue.push({
      id: eventItem.id || 'evt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      payload: eventItem,
      retryCount: 0,
      createdAt: Date.now(),
      username: username || cfg.dofeeUsername || '',
      smarteduUserId: smarteduUserId || cfg.activeSmarteduUserId || ''
    });
    this._saveQueue();
  }

  dequeue(eventId: string) {
    const queue = this.getQueue();
    this._queue = queue.filter(item => item.id !== eventId);
    this._saveQueue();
  }

  clearQueue() {
    this._queue = [];
    this._saveQueue();
  }

  isBucketReported(resourceId: string, positionBucket: number, username?: string): boolean {
    const user = username || this.getConfig().dofeeUsername || 'anon';
    const key = `${user}:${resourceId}_${positionBucket}`;
    try {
      const raw = this._getRaw(STORAGE_KEYS.SENT_RECORD);
      const set = raw ? JSON.parse(raw) : {};
      return !!set[key];
    } catch (e) {
      return false;
    }
  }

  markBucketReported(resourceId: string, positionBucket: number, username?: string) {
    const user = username || this.getConfig().dofeeUsername || 'anon';
    const key = `${user}:${resourceId}_${positionBucket}`;
    try {
      const raw = this._getRaw(STORAGE_KEYS.SENT_RECORD);
      let set = raw ? JSON.parse(raw) : {};
      set[key] = Date.now();
      const now = Date.now();
      const cleaned: Record<string, number> = {};
      for (const [k, ts] of Object.entries(set)) {
        if (now - (ts as number) < 2 * 3600 * 1000) {
          cleaned[k] = ts as number;
        }
      }
      this._setRaw(STORAGE_KEYS.SENT_RECORD, JSON.stringify(cleaned));
    } catch (e) {}
  }

  getSyncedCatalog(username: string, tmId: string): SyncedCatalogMeta | null {
    if (!tmId) return null;
    const key = `${username || 'anon'}:${tmId}`;
    try {
      const raw = this._getRaw(STORAGE_KEYS.SYNCED_CATALOGS);
      const map = raw ? JSON.parse(raw) : {};
      return map[key] || null;
    } catch (e) {
      return null;
    }
  }

  markCatalogSynced(username: string, tmId: string, meta: Record<string, any> = {}): SyncedCatalogMeta | null {
    if (!tmId) return null;
    const key = `${username || 'anon'}:${tmId}`;
    try {
      const raw = this._getRaw(STORAGE_KEYS.SYNCED_CATALOGS);
      const map = raw ? JSON.parse(raw) : {};
      const record = Object.assign({
        username: username || 'anon',
        tmId,
        syncedAt: Date.now()
      }, meta);
      map[key] = record;
      map.__last = record;
      this._setRaw(STORAGE_KEYS.SYNCED_CATALOGS, JSON.stringify(map));

      // 双写持久化至 chrome.storage.local，抵御页面缓存清理
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ [STORAGE_KEYS.SYNCED_CATALOGS]: map });
        }
      } catch (e) {}

      return record;
    } catch (e) {
      return null;
    }
  }

  getLastSyncedCatalog(username?: string): SyncedCatalogMeta | null {
    try {
      const raw = this._getRaw(STORAGE_KEYS.SYNCED_CATALOGS);
      const map = raw ? JSON.parse(raw) : {};
      if (map.__last && (!username || map.__last.username === username)) {
        return map.__last;
      }
      const entries = Object.entries(map)
        .filter(([k, v]) => k !== '__last' && v && (!username || (v as any).username === username))
        .map(([, v]) => v as SyncedCatalogMeta)
        .sort((a, b) => (b.syncedAt || 0) - (a.syncedAt || 0));
      return entries[0] || null;
    } catch (e) {
      return null;
    }
  }

  clearSyncedCatalogs() {
    this._setRaw(STORAGE_KEYS.SYNCED_CATALOGS, JSON.stringify({}));
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove([STORAGE_KEYS.SYNCED_CATALOGS]);
      }
    } catch (e) {}
  }

  private _saveQueue() {
    this._setRaw(STORAGE_KEYS.QUEUE, JSON.stringify(this._queue || []));
  }

  private _getRaw(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  private _setRaw(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn('[MonitorStorage] 写入存储失败:', e);
    }
  }
}

export const storage = new MonitorStorage();

// 挂载到全局，保留与控制台和历史脚本的兼容
if (typeof window !== 'undefined') {
  (window as any).SmartEduStorage = storage;
}
