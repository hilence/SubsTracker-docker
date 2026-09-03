/**
 * Loader 注册入口 —— 配合 --import 使用
 *
 *   node --import ./src/server/register-loaders.mjs src/server/index.js
 *
 * 在任何应用模块加载之前注册 .html 文本 loader，
 * 保证 src/views/pages.js 里的 `import xxx from './xxx.html'` 正常工作。
 */

import { register } from 'node:module';

register(new URL('./html-loader.mjs', import.meta.url).href, import.meta.url);
