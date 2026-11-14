/**
 * 热更新「防洗白」回归断言 —— 锁死 v1.8.7 修复的掉版本根因。
 *
 * 背景（2026-10-22 实测定位）：
 * 旧实现 registerAppliedBuild() 在每次 SW 唤醒时，只要 disk.buildId ≠ applied.buildId
 * 就直接 setAppliedBuild(disk)，把「磁盘新代码」洗成「已生效」，且不触发 chrome.runtime.reload()。
 * 结果 checkUpdate 永远 no_update，扩展永远跑旧代码，页面刷新也只注入旧 content script ——
 * 浏览器版本号永远停在旧值（用户实测 1.8.5 升不上去）。
 *
 * 修复：引入编译期 BUILD_ID 作为「运行中代码」的唯一身份，
 * 只有 disk.buildId === BUILD_ID 时才允许落库 applied；
 * checkUpdate 以 disk.buildId !== BUILD_ID 为 update_available 的主判定。
 */

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`   ✅ ${name}`);
  } else {
    failed++;
    console.log(`   ❌ ${name}${detail ? ' —— ' + detail : ''}`);
  }
}

/** 复刻修复后的核心对账逻辑（与 background.ts 同构） */
function makeUpdater({ BUILD_ID }) {
  const storage = { applied: null };
  let reloadScheduled = false;
  let reloadCount = 0;

  function registerAppliedBuild(disk) {
    if (!disk) return;
    if (disk.buildId !== BUILD_ID) return; // 严禁洗白：不落库、交由更新周期触发重载
    if (!storage.applied) {
      storage.applied = disk;
      return;
    }
    if (storage.applied.buildId !== disk.buildId) {
      storage.applied = disk;
    }
  }

  function checkUpdate(disk) {
    if (!disk) return { status: 'unsupported' };
    if (disk.buildId !== BUILD_ID) return { status: 'update_available', version: disk.version, buildId: disk.buildId };
    return { status: 'no_update', version: disk.version, buildId: disk.buildId };
  }

  function handleUpdateAvailable() {
    if (reloadScheduled) return;
    reloadScheduled = true;
    reloadCount++;
  }

  /** 复刻 runUpdateCheckCycle：仅 update_available 才排程重载 */
  function runUpdateCheckCycle(disk) {
    const res = checkUpdate(disk);
    if (res.status === 'update_available') handleUpdateAvailable(res);
    return res;
  }

  return {
    storage,
    registerAppliedBuild,
    checkUpdate,
    handleUpdateAvailable,
    runUpdateCheckCycle,
    get reloadCount() { return reloadCount; }
  };
}

console.log('🧪 开始执行热更新防洗白回归断言...\n');

// ---------- 测试 1：磁盘换新、扩展未重载 → 严禁洗白 applied ----------
console.log('▶ [测试 1] SW 唤醒登记不得洗白（v1.8.5 掉版本根因回归）');
{
  const oldCodeId = '1.8.6-1111111111111';
  const diskNew = { version: '1.8.7', buildId: '1.8.7-2222222222222' };
  const u = makeUpdater({ BUILD_ID: oldCodeId });

  u.storage.applied = { version: '1.8.6', buildId: '1.8.6-1111111111111' };
  // 模拟：SW 被闹钟唤醒，init() 调 registerAppliedBuild，而磁盘已换新
  u.registerAppliedBuild(diskNew);
  assert('registerAppliedBuild 不得把磁盘新 buildId 落库为 applied',
    u.storage.applied.buildId === oldCodeId,
    `applied 被洗成 ${u.storage.applied.buildId}`);

  const res = u.checkUpdate(diskNew);
  assert('checkUpdate 仍能识别 update_available（不被洗白蒙蔽）',
    res.status === 'update_available' && res.buildId === diskNew.buildId,
    `status=${res.status}`);

  u.runUpdateCheckCycle(diskNew);
  u.runUpdateCheckCycle(diskNew); // 双触发（init 自检 + 闹钟自检）
  assert('重复触发只排定一次重载', u.reloadCount === 1, `reloadCount=${u.reloadCount}`);
}

// ---------- 测试 2：扩展已重载（BUILD_ID 已对齐）→ 正常落库 ----------
console.log('\n▶ [测试 2] 重载后 BUILD_ID 对齐，登记与广播正常');
{
  const disk = { version: '1.8.7', buildId: '1.8.7-2222222222222' };
  const u = makeUpdater({ BUILD_ID: '1.8.7-2222222222222' });

  u.storage.applied = { version: '1.8.6', buildId: '1.8.6-1111111111111' };
  u.registerAppliedBuild(disk);
  assert('disk === BUILD_ID 时允许登记 applied（供页面刷新提示对账）',
    u.storage.applied.buildId === disk.buildId);

  const res = u.runUpdateCheckCycle(disk);
  assert('代码与磁盘一致时返回 no_update（不会无限重载循环）',
    res.status === 'no_update');
  assert('no_update 路径不触发重载', u.reloadCount === 0);
}

// ---------- 测试 3：首次安装（applied 缺失）且磁盘一致 → 建档 ----------
console.log('\n▶ [测试 3] 首次安装建档与多轮换新版连升');
{
  const idA = '1.8.7-3333333333333';
  const u = makeUpdater({ BUILD_ID: idA });
  u.registerAppliedBuild({ version: '1.8.7', buildId: idA });
  assert('applied 缺失时按当前运行构建建档', u.storage.applied.buildId === idA);

  // 连续两次换新版：1.8.7 → 1.8.8 → 1.8.9，每轮都要能检出
  let cur = makeUpdater({ BUILD_ID: idA });
  cur.storage.applied = { version: '1.8.7', buildId: idA };
  const diskB = { version: '1.8.8', buildId: '1.8.8-4444444444444' };
  cur.registerAppliedBuild(diskB);
  assert('第二轮换新同样检出、不洗白', cur.checkUpdate(diskB).status === 'update_available');

  const cur2 = makeUpdater({ BUILD_ID: '1.8.8-4444444444444' });
  cur2.storage.applied = { version: '1.8.7', buildId: idA };
  cur2.registerAppliedBuild(diskB);
  assert('第二轮重载后正常落库', cur2.storage.applied.buildId === diskB.buildId);
}

console.log(`\n${failed === 0 ? '🎉 所有防洗白回归断言通过！' : `💥 ${failed} 项断言失败`}`);
console.log(`   通过 ${passed} 项 / 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
