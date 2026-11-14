/**
 * import-user-guard.ts - 智慧平台用户一致性守卫（导入链路横切安全件）
 *
 * 【核心约束】
 * 在导入 dofee2 前比对「当前登录的智慧平台用户」与「上次导入时记录的用户信息」：
 * 1. 用户发生变更 → 立即拒绝导入并警告，必须明确确认后方可继续；
 * 2. 确认信息必须包含变更前后的用户名，并提示「继续操作可能破坏已有记录」；
 * 3. 检测逻辑覆盖**所有导入入口**（错题/习题导入 upload、教材目录导入、
 *    未来学习记录导入、心跳上报），不得有旁路；
 * 4. **取消确认时完全中止导入且不产生任何写入**（不写 dofee2、不写水位、
 *    不更新本守卫的基线记录——取消路径零写入）。
 *
 * 【为什么需要】
 * 插件的 dofee JWT 与智慧平台 ND_UC_AUTH 是两套独立登录态。同一浏览器上
 * 换智慧平台账号（如家庭成员换人登录）而 dofee 未换时，新账号的错题/学习
 * 数据会静默写入原 dofee 账户——串号污染。本守卫在一切写入动作之前强制对账。
 *
 * 【双模式】
 * - interactive（手动入口：面板「立即同步」等）：变更时弹确认框，取消即中止；
 * - silent（自动入口：runSilentAutoSync / runDailyScan / 目录自动同步 / 心跳）：
 *   变更时**静默拒绝**（无弹窗可确认）并返回 USER_CHANGED_ABORTED，零写入；
 *   待用户下次走手动入口时由 interactive 弹窗收口确认。
 *   自动流永远不「自作主张」替用户确认——红线。
 *
 * 【基线语义】
 * baseline = 上次成功通过对守卫检查、实际进行 dofee 写入时的智慧平台用户。
 * 仅在「通过对齐检查后的继续路径」上写入/更新；取消路径绝不写。
 *
 * 【绑定锚点（2026-10-26 追加）】
 * 服务端存在 dofee 账户 ↔ 智慧平台 user_id 绑定（core/smartedu-binding.ts）时，
 * 绑定即权威锚点：当前智慧平台用户与绑定不一致 -> **两种模式一律硬拒绝**
 * （reason='BINDING_MISMATCH'，弹窗确认也不放行——换人请走密码解绑/重绑）。
 * 未绑定或查询失败（'unknown'）时回落本地基线既有流程，不放大故障。
 */

import { smarteduBinding, type SmarteduBinding } from './smartedu-binding';
import { storage } from './storage';

export interface SmarteduIdentity {
  user_id: string;
  display_name: string;
}

export interface GuardBaseline {
  user_id: string;
  display_name: string;
  recorded_at: string;
  last_write_at: string;
}

export interface UserSwitchPrompt {
  action: string;
  previous: GuardBaseline;
  current: SmarteduIdentity;
}

export type GuardResult =
  | { ok: true; changed: boolean; baseline: GuardBaseline }
  | { ok: false; aborted: true; reason: 'USER_CHANGED_ABORTED'; previous: GuardBaseline; current: SmarteduIdentity; message: string }
  | { ok: false; aborted: true; reason: 'NO_SMARTEDU_LOGIN'; message: string }
  | { ok: false; aborted: true; reason: 'BINDING_MISMATCH'; bound: SmarteduBinding; current: SmarteduIdentity; message: string };

const BASELINE_KEY = 'SMARTEDU_IMPORT_GUARD_USER';

/** 展示名候选字段（ND_UC_AUTH / 用户信息 JSON 里按序找第一个非空值） */
const NAME_FIELDS = ['truename', 'real_name', 'realName', 'nick_name', 'nickName', 'user_name', 'userName', 'username', 'name', 'account'];

function pickDisplayName(obj: any): string {
  if (!obj || typeof obj !== 'object') return '';
  for (const f of NAME_FIELDS) {
    const v = obj[f];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && String(v).trim()) return String(v).trim();
  }
  return '';
}

function parseMaybeJson(raw: any): any {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  return null;
}

/**
 * 只读提取当前智慧平台登录身份（ND_UC_AUTH），尽力取展示名，取不到回退
 * 「用户<user_id>」。不写入、不转发 token——只拿身份标识。
 */
export function readSmarteduIdentity(store?: any): SmarteduIdentity | null {
  try {
    const st: any = store || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!st) return null;

    // 1. ND_UC_AUTH → user_id（主标识）+ 展示名（尽力）
    let userId = '';
    let displayName = '';
    const tryAuthValue = (raw: any) => {
      const parsed = parseMaybeJson(raw);
      if (!parsed) return;
      let val = parsed;
      if (val && typeof val.value === 'string') {
        try { val = JSON.parse(val.value); } catch (e) { /* 保持 */ }
      }
      if (val && val.value && typeof val.value === 'object') val = val.value;
      if (val && (val.access_token || val.user_id)) {
        if (!userId && val.user_id) userId = String(val.user_id).trim();
        if (!displayName) displayName = pickDisplayName(val);
      }
    };

    if (typeof st.length === 'number' && typeof st.key === 'function') {
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (k && k.indexOf('ND_UC_AUTH') === 0) tryAuthValue(st.getItem(k));
      }
    } else if (typeof st === 'object') {
      for (const km of Object.keys(st)) {
        if (km.indexOf('ND_UC_AUTH') === 0) tryAuthValue(st[km]);
      }
    }
    if (!userId) return null;

    // 2. 补展示名：扫用户信息类 key（user_info / ND_USER / userInfo ...）
    if (!displayName) {
      const scanKeys: string[] = [];
      if (typeof st.length === 'number' && typeof st.key === 'function') {
        for (let i = 0; i < st.length; i++) {
          const k = st.key(i);
          if (k && /user_?info|userinfo|nd_user|current_?user|login_?user/i.test(k)) scanKeys.push(k);
        }
      } else if (typeof st === 'object') {
        for (const km of Object.keys(st)) {
          if (/user_?info|userinfo|nd_user|current_?user|login_?user/i.test(km)) scanKeys.push(km);
        }
      }
      for (const k of scanKeys) {
        const parsed = parseMaybeJson(typeof st.getItem === 'function' ? st.getItem(k) : st[k]);
        if (parsed) {
          const candidate = pickDisplayName(parsed) || pickDisplayName(parsed.value) || pickDisplayName(parsed.data);
          if (candidate) { displayName = candidate; break; }
        }
      }
    }

    return {
      user_id: userId,
      display_name: displayName || `用户${userId}`
    };
  } catch (e) {
    return null;
  }
}

async function readBaseline(): Promise<GuardBaseline | null> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const res: any = await new Promise((resolve) => {
        try { chrome.storage.local.get([BASELINE_KEY], (r: any) => resolve(r || {})); } catch (e) { resolve({}); }
      });
      const parsed = parseMaybeJson(res && res[BASELINE_KEY]);
      if (parsed && parsed.user_id) return parsed as GuardBaseline;
    }
  } catch (e) {}
  try {
    if (typeof localStorage !== 'undefined') {
      const parsed = parseMaybeJson(localStorage.getItem(BASELINE_KEY));
      if (parsed && parsed.user_id) return parsed as GuardBaseline;
    }
  } catch (e) {}
  return null;
}

/** 仅在「继续路径」调用——取消路径禁止调用（守卫内已保证） */
async function writeBaseline(b: GuardBaseline): Promise<void> {
  const payload = JSON.stringify(b);
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ [BASELINE_KEY]: b });
    }
  } catch (e) {}
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(BASELINE_KEY, payload);
  } catch (e) {}
}

export function buildSwitchPromptText(p: UserSwitchPrompt): string {
  return [
    '⚠️ 智慧平台登录用户已变更，导入已暂时中止！',
    '',
    `上次导入用户：${p.previous.display_name}（ID ${p.previous.user_id}）`,
    `当前登录用户：${p.current.display_name}（ID ${p.current.user_id}）`,
    '',
    `即将执行：${p.action}`,
    '',
    '【风险提示】继续操作可能破坏已有记录：',
    '新用户的数据将写入原 dofee 账户，与历史记录混淆，',
    '或覆盖/污染原有进度、错题与学习记录的归属。',
    '',
    '确定要以「当前登录用户」继续导入吗？'
  ].join('\n');
}

let customConfirmUserSwitch: ((p: UserSwitchPrompt) => Promise<boolean>) | null = null;

/**
 * 注册自定义用户切换确认处理器（用于 Popup 等无网页模态框场景接管确认交互）。
 * 传入 null 恢复默认网页模态框。
 */
export function setConfirmUserSwitchHandler(
  handler: ((p: UserSwitchPrompt) => Promise<boolean>) | null
): void {
  customConfirmUserSwitch = handler;
}

/**
 * 默认确认框：优先 DOM 模态框（带变更前后用户名 + 破坏性风险提示 + 明确双按钮），
 * 无 DOM 时退 window.confirm，两者皆无 → 返回 false（不能确认即中止，安全侧默认）。
 */
export async function defaultConfirmUserSwitch(p: UserSwitchPrompt): Promise<boolean> {
  const text = buildSwitchPromptText(p);

  // 无确认能力的上下文（如纯后台）：不能确认 → 视为取消（零写入中止）
  if (typeof document === 'undefined' || !document.body) {
    try {
      if (typeof confirm === 'function') return confirm(text);
    } catch (e) {}
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'smartedu-import-guard-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483646',
      'background:rgba(0,0,0,0.55)', 'display:flex', 'align-items:center',
      'justify-content:center', 'font-family:system-ui,-apple-system,sans-serif'
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
      'background:#fff', 'color:#1a1a1a', 'max-width:460px', 'width:90%',
      'border-radius:10px', 'padding:20px 22px', 'box-shadow:0 8px 32px rgba(0,0,0,0.35)',
      'line-height:1.65', 'font-size:14px'
    ].join(';');

    const lines = text.split('\n');
    const title = document.createElement('div');
    title.textContent = lines[0];
    title.style.cssText = 'font-size:16px;font-weight:700;color:#b91c1c;margin-bottom:10px';
    box.appendChild(title);

    const oldUser = document.createElement('div');
    oldUser.textContent = lines[2];
    oldUser.style.cssText = 'background:#f3f4f6;border-radius:6px;padding:6px 10px;margin:4px 0';
    box.appendChild(oldUser);

    const newUser = document.createElement('div');
    newUser.textContent = lines[3];
    newUser.style.cssText = 'background:#fef3c7;border-radius:6px;padding:6px 10px;margin:4px 0';
    box.appendChild(newUser);

    const rest = document.createElement('div');
    rest.textContent = lines.slice(5).join('\n');
    rest.style.cssText = 'margin-top:10px;white-space:pre-wrap;color:#374151';
    box.appendChild(rest);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:16px';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消导入';
    cancelBtn.style.cssText = [
      'padding:8px 18px', 'border-radius:6px', 'border:1px solid #d1d5db',
      'background:#fff', 'cursor:pointer', 'font-size:14px'
    ].join(';');

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '继续导入（有风险）';
    confirmBtn.style.cssText = [
      'padding:8px 18px', 'border-radius:6px', 'border:1px solid #b91c1c',
      'background:#b91c1c', 'color:#fff', 'cursor:pointer', 'font-size:14px'
    ].join(';');

    const done = (result: boolean) => {
      try { document.body.removeChild(overlay); } catch (e) {}
      resolve(result);
    };
    cancelBtn.addEventListener('click', () => done(false));
    confirmBtn.addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    // Esc = 取消（零写入中止）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); done(false); }
      if (e.key === 'Enter') { document.removeEventListener('keydown', onKey); done(false); } // Enter 走安全侧=取消
    };
    document.addEventListener('keydown', onKey);

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    cancelBtn.focus();
  });
}

/**
 * 导入前置守卫——所有导入入口必须在**任何写入之前**调用。
 *
 * @param opts.action        人类可读的导入动作名（进确认文案）
 * @param opts.mode          interactive=弹窗确认；silent=自动流静默拒绝
 * @param opts.confirmFn     注入式确认框（测试/定制 UI 用），默认 defaultConfirmUserSwitch
 *
 * 返回 ok=true → 放行（changed=true 表示已确认用户变更并刷新基线）；
 * 返回 ok=false → 调用方必须**立即中止**，不得有任何写入。
 */
export async function ensureImportUserConsistent(opts: {
  action: string;
  mode?: 'interactive' | 'silent';
  confirmFn?: (p: UserSwitchPrompt) => Promise<boolean>;
} = { action: '导入' }): Promise<GuardResult> {
  const mode = opts.mode === 'silent' ? 'silent' : 'interactive';
  const current = readSmarteduIdentity();
  if (!current) {
    return {
      ok: false,
      aborted: true,
      reason: 'NO_SMARTEDU_LOGIN',
      message: '未检测到智慧平台登录态（ND_UC_AUTH），导入已中止，未产生任何写入'
    };
  }

  // ── 1. 多用户绑定槽位自动匹配与激活 ──
  const { activeSlot } = storage.activateSlotBySmarteduUserId(current.user_id);
  const boundSlots = storage.getBoundAccounts();

  // 若存在已绑槽位，但当前智慧平台登录用户不在任何槽位中 -> 硬拒绝，零写入
  if (boundSlots.length > 0 && !activeSlot) {
    const boundListText = boundSlots
      .map((s, idx) => `  槽位 #${idx + 1}: ${s.smarteduDisplayName || '用户' + s.smarteduUserId} ↔ dofee2 [${s.dofeeUsername}]`)
      .join('\n');
    const message = [
      '⛔ 当前智慧平台登录用户尚未绑定到任何 dofee2 账户，导入已完全中止（未产生任何写入）！',
      '',
      `当前登录用户：${current.display_name}（ID ${current.user_id}）`,
      '',
      `已绑定的 ${boundSlots.length} 个槽位：`,
      boundListText,
      '',
      '为防止数据混淆与串号写入，未绑定账号无法执行同步。',
      '如需同步该用户，请在监控面板将当前智慧平台账号绑定至空闲槽位。'
    ].join('\n');
    console.warn('[ImportUserGuard][多槽位匹配] ' + message);
    return {
      ok: false,
      aborted: true,
      reason: 'BINDING_MISMATCH',
      bound: {
        username: boundSlots[0].dofeeUsername,
        smartedu_user_id: boundSlots[0].smarteduUserId,
        smartedu_display_name: boundSlots[0].smarteduDisplayName,
        bound_at: boundSlots[0].boundAt,
        updated_at: boundSlots[0].boundAt
      },
      current,
      message
    };
  }

  // 若成功命中激活槽位：验证服务端绑定锚点
  if (activeSlot) {
    const consistency = await smarteduBinding.checkConsistency(current.user_id, activeSlot.dofeeUsername);
    if (consistency.state === 'mismatch' && consistency.binding) {
      const bound = consistency.binding;
      const message = [
        '⛔ 当前智慧平台用户与 dofee2 账户服务端绑定不一致，导入已完全中止（未产生任何写入）！',
        '',
        `dofee2 账户：${activeSlot.dofeeUsername}`,
        `服务端绑定用户：${bound.smartedu_display_name || '用户' + bound.smartedu_user_id}（ID ${bound.smartedu_user_id}）`,
        `当前登录用户：${current.display_name}（ID ${current.user_id}）`,
        '',
        '绑定关系是导入的权威锚点，如需更换请先在面板解绑。'
      ].join('\n');
      console.warn('[ImportUserGuard][绑定锚点] ' + message);
      return {
        ok: false,
        aborted: true,
        reason: 'BINDING_MISMATCH',
        bound,
        current,
        message
      };
    }

    // 槽位匹配且绑定一致 -> 刷新基线并放行（多用户轮流登录无感放行，无需弹窗确认）
    const previous = await readBaseline();
    const baseline: GuardBaseline = {
      user_id: current.user_id,
      display_name: current.display_name,
      recorded_at: previous?.recorded_at || new Date().toISOString(),
      last_write_at: new Date().toISOString()
    };
    await writeBaseline(baseline);
    return { ok: true, changed: previous?.user_id !== current.user_id, baseline };
  }

  // ── 2. 若未配置任何槽位（boundSlots.length === 0），回落到既有本地基线流程 ──
  const consistency = await smarteduBinding.checkConsistency(current.user_id);
  if (consistency.state === 'mismatch' && consistency.binding) {
    const bound = consistency.binding;
    const message = [
      '⛔ 当前智慧平台用户与已绑定账号不一致，导入已完全中止（未产生任何写入）！',
      '',
      `已绑定用户：${bound.smartedu_display_name || '用户' + bound.smartedu_user_id}（ID ${bound.smartedu_user_id}）`,
      `当前登录用户：${current.display_name}（ID ${current.user_id}）`,
      '',
      '绑定关系是导入的权威锚点，用户变更无法通过确认放行。',
      '如需更换，请先在面板「智慧平台账号绑定」中验证 dofee 密码解绑，再重新绑定。'
    ].join('\n');
    console.warn('[ImportUserGuard][绑定锚点] ' + message);
    return {
      ok: false,
      aborted: true,
      reason: 'BINDING_MISMATCH',
      bound,
      current,
      message
    };
  }

  const previous = await readBaseline();

  // 首次导入：无历史基线可比 → 记录当前用户为基线后放行（继续路径，允许写）
  if (!previous) {
    const baseline: GuardBaseline = {
      user_id: current.user_id,
      display_name: current.display_name,
      recorded_at: new Date().toISOString(),
      last_write_at: new Date().toISOString()
    };
    await writeBaseline(baseline);
    return { ok: true, changed: false, baseline };
  }

  // 同一用户：放行（继续路径）。last_write_at 刷新做 1 小时节流——
  // 心跳等高频入口每秒都过守卫，不能每次都写存储。
  if (previous.user_id === current.user_id) {
    const displayChanged = !!(current.display_name && current.display_name !== previous.display_name);
    const lastWriteMs = Date.parse(previous.last_write_at || '') || 0;
    const stale = Date.now() - lastWriteMs > 60 * 60 * 1000;
    if (displayChanged || stale) {
      const baseline: GuardBaseline = {
        ...previous,
        display_name: current.display_name || previous.display_name,
        last_write_at: new Date().toISOString()
      };
      await writeBaseline(baseline);
    }
    return {
      ok: true,
      changed: false,
      baseline: {
        ...previous,
        display_name: current.display_name || previous.display_name
      }
    };
  }

  // ── 用户已变更：拒绝导入 ────────────────────────────────────────────
  const prompt: UserSwitchPrompt = { action: opts.action, previous, current };
  const message = buildSwitchPromptText(prompt);

  if (mode === 'silent') {
    // 自动流没有「用户明确确认」的通道 → 一律拒绝，零写入（含不刷基线）
    console.warn('[ImportUserGuard] 智慧平台用户已变更，自动导入已静默拒绝（零写入）。'
      + `上次=${previous.display_name}(${previous.user_id}) → 当前=${current.display_name}(${current.user_id})。`
      + '请通过手动「同步」入口确认后再继续。');
    return {
      ok: false,
      aborted: true,
      reason: 'USER_CHANGED_ABORTED',
      previous,
      current,
      message
    };
  }

  const confirmFn = opts.confirmFn || customConfirmUserSwitch || defaultConfirmUserSwitch;
  const confirmed = await confirmFn(prompt);
  if (!confirmed) {
    // ★ 取消路径：完全中止，零写入——不写 dofee、不写水位、不更新基线
    return {
      ok: false,
      aborted: true,
      reason: 'USER_CHANGED_ABORTED',
      previous,
      current,
      message: '已取消：智慧平台用户变更未确认，导入完全中止，未产生任何写入'
    };
  }

  // 明确确认后：刷新基线为当前用户，放行（这是「确认后方可继续」的继续路径）
  const baseline: GuardBaseline = {
    user_id: current.user_id,
    display_name: current.display_name,
    recorded_at: new Date().toISOString(),
    last_write_at: new Date().toISOString()
  };
  await writeBaseline(baseline);
  return { ok: true, changed: true, baseline };
}

/** 测试/诊断用：读取当前基线（只读） */
export async function getGuardBaseline(): Promise<GuardBaseline | null> {
  return readBaseline();
}

/**
 * 守卫中止原因 -> 用户可读错误信息（各导入入口统一文案，勿再各自拼三元表达式）。
 */
export function describeGuardAbort(reason: string): string {
  if (reason === 'NO_SMARTEDU_LOGIN') {
    return '未检测到智慧平台登录态，导入已中止（未产生任何写入）';
  }
  if (reason === 'BINDING_MISMATCH') {
    return '当前智慧平台用户与已绑定账号不一致，导入已完全中止（未产生任何写入）。请先验证密码解绑后重新绑定';
  }
  return '智慧平台登录用户已变更且未获确认，导入已完全中止（未产生任何写入）';
}
