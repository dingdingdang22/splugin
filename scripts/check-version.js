#!/usr/bin/env node
/**
 * check-version.js - 插件版本一致性校验与同步防呆工具
 * 
 * 校验规则：
 * 1. package.json 中的 "version" 字段
 * 2. src/core/version.ts 中的 export const APP_VERSION 字段
 * 两者必须严格保持完全一致，以保证构建产物、manifest、界面展示与热更提示绝不脱节！
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const pkgPath = path.join(rootDir, 'package.json');
const versionTsPath = path.join(rootDir, 'src', 'core', 'version.ts');

if (!fs.existsSync(pkgPath)) {
  console.error('[check-version] ❌ 找不到 package.json 文件');
  process.exit(1);
}

if (!fs.existsSync(versionTsPath)) {
  console.error('[check-version] ❌ 找不到 src/core/version.ts 文件');
  process.exit(1);
}

const pkgContent = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const pkgVersion = pkgContent.version;

const versionTsContent = fs.readFileSync(versionTsPath, 'utf8');
const match = versionTsContent.match(/export\s+const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/);

if (!match) {
  console.error('[check-version] ❌ 未在 src/core/version.ts 中找到 APP_VERSION 常量导出');
  process.exit(1);
}

const tsVersion = match[1];

const isSyncMode = process.argv.includes('--sync');

if (pkgVersion !== tsVersion) {
  if (isSyncMode) {
    console.log(`[check-version] ⚠️ 检测到版本不一致: package.json(${pkgVersion}) vs version.ts(${tsVersion})`);
    console.log(`[check-version] 正在以 package.json(${pkgVersion}) 为基准同步更新 src/core/version.ts...`);
    const updatedTs = versionTsContent.replace(
      /export\s+const\s+APP_VERSION\s*=\s*['"][^'"]+['"]/,
      `export const APP_VERSION = '${pkgVersion}'`
    );
    fs.writeFileSync(versionTsPath, updatedTs, 'utf8');
    console.log(`[check-version] ✅ 成功同步更新 src/core/version.ts 为 ${pkgVersion}`);
    process.exit(0);
  } else {
    console.error('======================================================================');
    console.error('❌ [版本校验失败] 插件版本号不一致！');
    console.error(`- package.json 中的版本号:  "${pkgVersion}"`);
    console.error(`- src/core/version.ts 版本号: "${tsVersion}"`);
    console.error('');
    console.error('【规范要求】：每次发布或更新版本时，必须同步更新这两处版本号！');
    console.error('可手动统一，或运行：node scripts/check-version.js --sync');
    console.error('======================================================================');
    process.exit(1);
  }
}

console.log(`[check-version] ✅ 版本号一致性核查通过！当前插件版本: v${pkgVersion}`);
