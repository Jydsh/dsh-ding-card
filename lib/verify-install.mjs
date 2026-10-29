/**
 * dsh-ding-card 安装后校验（prepare 钩子）
 *
 * 插件为纯 JavaScript（ESM），无 TypeScript/编译步骤，`prepare` 只做完整性校验：
 * 确认入口文件存在、版本可读，并打印安装成功信息。
 * 该脚本在 `pnpm install` / `npm install`（含从 GitHub 源码安装）后自动执行，
 * 被 pnpm 安全策略拦截时仅跳过校验，不影响插件运行。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const entry = join(root, 'index.js');
if (!existsSync(entry)) {
  throw new Error(`dsh-ding-card 安装校验失败：缺少入口文件 ${entry}`);
}
const pkg = JSON.parse(readFileSync(join(root, '..', 'package.json'), 'utf8'));
console.log(`[dsh-ding-card] 安装校验通过 v${pkg.version}（入口 OK，纯 JS 无构建产物）`);
