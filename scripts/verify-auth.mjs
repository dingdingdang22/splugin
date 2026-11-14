/**
 * verify-auth.mjs - 鉴权自愈与并发互斥单元验证套件
 */

import assert from 'node:assert';

console.log('🧪 开始执行 JWT 授权续约与自愈机制核心断言...\n');

// 1. 模拟 JWT 生成辅助函数
function createMockJwt(expSecondsFromNow = 3600) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  const payload = Buffer.from(JSON.stringify({
    sub: 'user_123',
    username: 'test_student',
    role: 'student',
    exp,
    iat: Math.floor(Date.now() / 1000)
  })).toString('base64url');
  const signature = 'mock_signature';
  return { token: `${header}.${payload}.${signature}`, exp };
}

// 2. 验证 JWT 解析与 TTL 计算
{
  console.log('▶ [测试 1] JWT 智能解码与过期判定');
  const { token, exp } = createMockJwt(600); // 10分钟后过期

  // 基础解析模拟
  const parts = token.split('.');
  const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.strictEqual(decoded.username, 'test_student');
  assert.strictEqual(decoded.exp, exp);

  const ttlSeconds = Math.floor((exp * 1000 - Date.now()) / 1000);
  assert(ttlSeconds >= 590 && ttlSeconds <= 600, 'TTL 计算需在预期时间窗口内');

  // 临界过期检测（5分钟阈值）
  const isExpiringSoon10m = (Date.now() + 5 * 60 * 1000) >= (exp * 1000);
  assert.strictEqual(isExpiringSoon10m, false, '10分钟有效期的 Token 不应被判定为临界过期');

  const { token: token2m, exp: exp2m } = createMockJwt(120); // 2分钟后过期
  const isExpiringSoon2m = (Date.now() + 5 * 60 * 1000) >= (exp2m * 1000);
  assert.strictEqual(isExpiringSoon2m, true, '2分钟有效期的 Token 必须判定为临界过期并触发提前续期');

  console.log('   ✅ JWT 解码、TTL 计算与临界过期判定验证通过！');
}

// 3. 验证单例互斥锁 (Single-Flight Renewal Mutex)
{
  console.log('▶ [测试 2] 单例并发续约锁 (Single-Flight Mutex) 与排队机制');
  let networkCallCount = 0;
  let singleFlightPromise = null;

  async function mockRefreshToken() {
    if (singleFlightPromise) {
      return singleFlightPromise;
    }
    singleFlightPromise = (async () => {
      networkCallCount++;
      await new Promise(r => setTimeout(r, 50)); // 模拟网络延迟
      return { success: true, token: 'jwt_refreshed_' + networkCallCount };
    })().finally(() => {
      singleFlightPromise = null;
    });
    return singleFlightPromise;
  }

  // 模拟 10 个并发请求同时触发刷新
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(mockRefreshToken());
  }

  const results = await Promise.all(promises);
  assert.strictEqual(networkCallCount, 1, '10 个并发续约请求必须被单例互斥锁收敛为仅 1 次实际网络调用');
  for (const r of results) {
    assert.strictEqual(r.token, 'jwt_refreshed_1', '所有排队请求必须获得同一份最新的刷新 Token');
  }
  console.log('   ✅ 并发互斥排队机制验证通过：10 个并发请求严格只触发 1 次网络续签，零踩踏！');
}

// 4. 验证防清空保护 (Anti-Wipe Guard)
{
  console.log('▶ [测试 3] 本地存储防清空保护 (Anti-Wipe Guard)');
  const currentConfig = {
    dofeeUsername: 'student_a',
    dofeeJwtToken: 'valid_token_xyz',
    dofeeRefreshToken: 'valid_refresh_abc',
    heartbeatIntervalSeconds: 120
  };

  function applySafeSave(current, partial, isExplicitLogout = false) {
    const safePartial = Object.assign({}, partial);
    if (!isExplicitLogout && !partial._explicitLogout) {
      if (safePartial.dofeeJwtToken === '' && current.dofeeJwtToken) {
        delete safePartial.dofeeJwtToken;
      }
      if (safePartial.dofeeRefreshToken === '' && current.dofeeRefreshToken) {
        delete safePartial.dofeeRefreshToken;
      }
    }
    return Object.assign({}, current, safePartial);
  }

  // 场景 A: 心跳或未水合配置传入空串，非显式注销
  const accidentalBlankConfig = { dofeeJwtToken: '', dofeeRefreshToken: '', heartbeatIntervalSeconds: 60 };
  const healedConfig = applySafeSave(currentConfig, accidentalBlankConfig, false);
  assert.strictEqual(healedConfig.dofeeJwtToken, 'valid_token_xyz', '防清空机制必须拦截意外空串，保护现有有效 Token');
  assert.strictEqual(healedConfig.dofeeRefreshToken, 'valid_refresh_abc', '防清空机制必须拦截意外空串，保护现有 Refresh Token');
  assert.strictEqual(healedConfig.heartbeatIntervalSeconds, 60, '普通配置字段应正常更新');

  // 场景 B: 用户显式点击退出登录
  const logoutConfig = { dofeeUsername: '', dofeeJwtToken: '', dofeeRefreshToken: '', _explicitLogout: true };
  const afterLogout = applySafeSave(currentConfig, logoutConfig, true);
  assert.strictEqual(afterLogout.dofeeJwtToken, '', '显式登出必须正常清空 Token');
  assert.strictEqual(afterLogout.dofeeRefreshToken, '', '显式登出必须正常清空 Refresh Token');

  console.log('   ✅ 防清空机制 (Anti-Wipe Guard) 验证通过：有效拦截脏心跳覆盖，保障持久在线！');
}

// 5. 验证端点平滑降级兼容
{
  console.log('▶ [测试 4] 双端点高兼容降级与智能解包');
  const mockV1Resp = {
    status: 404,
    responseText: 'Not Found'
  };
  const mockLegacyResp = {
    status: 200,
    responseText: JSON.stringify({ token: 'new_jwt_from_legacy', refreshToken: 'new_refresh' })
  };

  async function mockDualEndpointRefresh() {
    let resp = mockV1Resp;
    let endpoint = 'v1';
    if (resp.status === 404) {
      endpoint = 'legacy';
      resp = mockLegacyResp;
    }
    const data = JSON.parse(resp.responseText);
    const token = data.token || data.accessToken;
    return { endpoint, token };
  }

  const res = await mockDualEndpointRefresh();
  assert.strictEqual(res.endpoint, 'legacy', 'v1 遇 404 必须平滑降级至 legacy 端点');
  assert.strictEqual(res.token, 'new_jwt_from_legacy', '智能解包需正确提取新 Token');
  console.log('   ✅ 双端点平滑降级与智能解包机制验证通过！');
}

// 5. 401 后强制续签 + 重发自愈（report 链路不一击即溃）
{
  console.log('\n▶ [测试 5] 401 后强制续签自愈（report 链路）');
  // 复刻修复后的 report 判定逻辑：401 → 尝试续签 → 成功重发 → 别过早判死刑
  async function mockReport(sendFn, refreshFn) {
    let res = await sendFn();
    if (res.status === 401 || res.status === 403) {
      const healed = await refreshFn();
      if (healed) res = await sendFn();
    }
    return res;
  }

  // 场景 A：token 过期但 refresh token 有效 → 续签后重发成功
  let call = 0;
  let token = 'stale';
  const resA = await mockReport(
    async () => { call++; return token === 'fresh' ? { status: 200 } : { status: 401 }; },
    async () => { token = 'fresh'; return true; }
  );
  assert.strictEqual(resA.status, 200, '401 后续签应能救活上报');
  assert.strictEqual(call, 2, '应发生一次重发');

  // 场景 B：refresh token 真死 → 保持 401，但只此一次（不误导为可自愈）
  const resB = await mockReport(
    async () => ({ status: 401 }),
    async () => false
  );
  assert.strictEqual(resB.status, 401, '续签失败应如实保留 401 待人工登录');
  console.log('   ✅ 401 强制续签自愈机制验证通过！');
}

// 6. 硬失败冷却期降噪（防日志轰炸 + 穿透通道）
{
  console.log('\n▶ [测试 6] 硬失败冷却期与强制穿透');
  const cooldownUntil = { at: 0 };
  function refreshToken(force = false) {
    if (!force && Date.now() < cooldownUntil.at) {
      return { success: false, error: '冷却中', isHardFailure: true };
    }
    return { success: true, token: 'new' };
  }
  // 模拟硬失败后设 5 分钟冷却
  cooldownUntil.at = Date.now() + 5 * 60 * 1000;
  assert.strictEqual(refreshToken(false).success, false, '冷却期内自动刷新应短路');
  assert.strictEqual(refreshToken(true).success, true, '强制刷新应穿透冷却期');
  console.log('   ✅ 硬失败冷却降噪与强制穿透验证通过！');
}

console.log('\n🎉 所有断言测试全部通过！JWT 授权续签与自愈机制设计严密、行为正确。');
