/**
 * ESM loader hook —— 让 Node.js 能 import .html 文件（作为文本字符串）
 *
 * Cloudflare Workers / Wrangler 内置 text loader，把 .html import 当字符串用：
 *   import loginPageHtml from './loginPage.html';   // loginPageHtml 是文件内容字符串
 *
 * Node.js 原生不支持，这里通过 load hook 拦截 .html 请求，
 * 返回 `export default "<文件内容>"` 的虚拟模块。
 *
 * 用法（通过 register-loaders.mjs 自动注册，无需手动传 --loader）：
 *   node --import ./src/server/register-loaders.mjs src/server/index.js
 */

import fs from 'node:fs/promises';

/**
 * @param {string} url
 * @param {unknown} context
 * @param {(url: string, context: unknown) => Promise<any>} nextLoad
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith('.html')) {
    let content;
    try {
      content = await fs.readFile(new URL(url), 'utf8');
    } catch (err) {
      // 交给默认 loader 报更准确的错误
      return nextLoad(url, context);
    }
    return {
      format: 'module',
      source: `export default ${JSON.stringify(content)};\n`,
      shortCircuit: true
    };
  }
  return nextLoad(url, context);
}
