// @ts-check
/**
 * Vitest 配置文件
 *
 * 用 @cloudflare/vitest-pool-workers 把单测跑在真实的 workerd 运行时里，
 * 这样 KV / fetch / crypto.subtle 等 Cloudflare 平台 API 不需要 mock 即可工作。
 *
 * 用法：
 *   npm test          # 跑一次（CI）
 *   npm run test:watch # watch 模式
 */
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  // 让 vite 把 .html 当作文本字符串 import（与 wrangler 生产环境的 text loader 行为一致）
  assetsInclude: ['**/*.html'],
  test: {
    include: ['tests/**/*.test.js'],
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: '2024-09-23',
          compatibilityFlags: ['nodejs_compat'],
          kvNamespaces: ['SUBSCRIPTIONS_KV']
        },
        // 让生产环境用的 .html 文本 import 在测试中也能工作
        wrangler: {
          configPath: './wrangler.toml'
        }
      }
    }
  }
});
