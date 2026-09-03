// @ts-check
/**
 * 文件系统 KV 存储 —— 替代 Cloudflare KV Namespace
 *
 * 设计：
 * - 所有键值对保存在单个 JSON 文件里（默认 /data/kv.json）
 * - 启动时一次性加载到内存 Map，运行期读写都在内存中（单进程，无并发问题）
 * - 写操作通过 debounce（100ms）异步落盘，避免高频写时 I/O 瓶颈
 * - 支持 expirationTtl：到期条目在读取 / 列举时惰性清理
 * - API 与 Cloudflare KVNamespace 完全兼容：
 *     get(key, {type}) / put(key, value, {expirationTtl}) / delete(key) / list({prefix, cursor, limit})
 *
 * 数据格式（kv.json）：
 *   { "key1": { "value": "...", "expiresAt": null }, "key2": { "value": "...", "expiresAt": 1700000000000 } }
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LIMIT = 1000;

class FileKVNamespace {
  /**
   * @param {string} filePath KV 数据文件的绝对路径
   */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Map<string, {value: string, expiresAt: number|null}>} */
    this.store = new Map();
    this.loaded = false;
    this.saveTimer = null;
    this.savePromise = null;
  }

  // ─────────────────────────────────────────────
  // 内部：加载 / 落盘
  // ─────────────────────────────────────────────

  async _load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v.value === 'string') {
            this.store.set(k, { value: v.value, expiresAt: v.expiresAt ?? null });
          }
        }
      }
      console.log(`[KV-FS] 已加载 ${this.store.size} 条数据: ${this.filePath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[KV-FS] 加载失败，将以空存储启动:', err.message);
      }
    }
  }

  _scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this._saveNow().catch((err) => {
        console.error('[KV-FS] 落盘失败:', err);
      });
    }, 100);
  }

  async _saveNow() {
    const obj = {};
    for (const [k, v] of this.store) {
      obj[k] = v;
    }
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(obj), 'utf8');
    await fs.rename(tmp, this.filePath);
  }

  /**
   * 强制立即落盘（进程退出前调用）。
   */
  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this._saveNow();
  }

  // ─────────────────────────────────────────────
  // 内部：TTL
  // ─────────────────────────────────────────────

  _isExpired(entry) {
    return !!entry && entry.expiresAt != null && Date.now() > entry.expiresAt;
  }

  // ─────────────────────────────────────────────
  // 公开 API（与 Cloudflare KVNamespace 一致）
  // ─────────────────────────────────────────────

  /**
   * 读取一个键。
   * @param {string} key
   * @param {{ type?: 'text'|'json' }} [options]
   * @returns {Promise<string|object|null>}
   */
  async get(key, options) {
    await this._load();
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this._isExpired(entry)) {
      this.store.delete(key);
      this._scheduleSave();
      return null;
    }
    if (options && options.type === 'json') {
      try {
        return JSON.parse(entry.value);
      } catch {
        return null;
      }
    }
    return entry.value;
  }

  /**
   * 写入一个键。
   * @param {string} key
   * @param {string} value
   * @param {{ expirationTtl?: number }} [options] TTL（秒）
   */
  async put(key, value, options) {
    await this._load();
    const expiresAt =
      options && options.expirationTtl
        ? Date.now() + options.expirationTtl * 1000
        : null;
    this.store.set(key, { value: String(value), expiresAt });
    this._scheduleSave();
  }

  /**
   * 删除一个键。
   * @param {string} key
   */
  async delete(key) {
    await this._load();
    if (this.store.has(key)) {
      this.store.delete(key);
      this._scheduleSave();
    }
  }

  /**
   * 列举键（按字典序升序）。
   * @param {{ prefix?: string, limit?: number, cursor?: string }} [options]
   * @returns {Promise<{ keys: Array<{name: string}>, list_complete: boolean, cursor?: string }>}
   */
  async list(options = {}) {
    await this._load();
    const prefix = options.prefix || '';
    const limit = Math.min(1000, Math.max(1, options.limit || DEFAULT_LIMIT));

    // 收集未过期且匹配前缀的键
    const names = [];
    for (const [name, entry] of this.store) {
      if (this._isExpired(entry)) continue;
      if (prefix && !name.startsWith(prefix)) continue;
      names.push(name);
    }
    names.sort((a, b) => a.localeCompare(b));

    // 游标分页
    let startIdx = 0;
    if (options.cursor) {
      startIdx = names.findIndex((n) => n > options.cursor);
      if (startIdx < 0) startIdx = names.length;
    }
    const page = names.slice(startIdx, startIdx + limit);
    const list_complete = startIdx + limit >= names.length;

    return {
      keys: page.map((name) => ({ name })),
      list_complete,
      cursor: list_complete ? undefined : page[page.length - 1]
    };
  }
}

export { FileKVNamespace };
