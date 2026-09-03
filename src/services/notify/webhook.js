// @ts-check
/**
 * Webhook 通知渠道
 *
 * 支持自定义请求方法、Header、消息模板（{{title}} / {{content}} / {{tags}} 等）。
 */
import { ok, fail, errorMessage } from './channel.js';
import { formatLocalDate } from '../../core/time.js';

/**
 * 递归替换模板对象中的所有 {{key}} 占位符。
 * 保留原始数据类型（字符串、数字等），换行符等特殊字符不会被二次转义。
 *
 * @param {any} template   - 模板对象（已解析的 JSON）
 * @param {Record<string,any>} data  - 用于替换的数据
 * @returns {any} 替换后的新对象
 */
function applyTemplate(template, data) {
  if (typeof template === 'string') {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const val = data[key];
        return val != null ? String(val) : '';
      }
      return '';
    });
  } else if (Array.isArray(template)) {
    return template.map(item => applyTemplate(item, data));
  } else if (template && typeof template === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(template)) {
      result[key] = applyTemplate(value, data);
    }
    return result;
  } else {
    return template;
  }
}

/**
 * 将 content 字符串转换为多行显示。
 * 这是一个简化版本，适用于 "字段名: 值" 格式。
 * 如果值内部包含冒号，不会误分割。
 *
 * @param {string} content
 * @returns {string}
 */
function formatContentToLines(content) {
  if (!content || typeof content !== 'string') return content;

  // 按空格分割，但保留带空格的字段值（如备注中的内容）
  // 我们通过遍历 token，以 "字段名:" 为分隔符来组织行
  const tokens = content.split(/\s+/);
  const lines = [];
  let currentLine = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // 如果 token 以冒号结尾（英文或中文），则作为新字段的开始
    if (/[:：]$/.test(token)) {
      // 保存之前累积的行
      if (currentLine.length > 0) {
        lines.push(currentLine.join(' '));
        currentLine = [];
      }
      currentLine.push(token);
    } else {
      // 否则作为当前字段的值的一部分
      currentLine.push(token);
    }
  }
  // 保存最后一行
  if (currentLine.length > 0) {
    lines.push(currentLine.join(' '));
  }

  // 如果最终 lines 少于 2，说明没有找到任何字段分隔符，原样返回
  if (lines.length <= 1) {
    return content;
  }

  return lines.join('\n');
}

/**
 * 构造可供模板替换的变量集合。
 *
 * @param {import('./channel.js').ChannelPayload} payload
 * @param {any} config
 */
function buildTemplateData(payload, config) {
  const tagsArray = Array.isArray(payload.metadata?.tags)
    ? payload.metadata.tags
        .filter((t) => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim())
    : [];
  const tagsBlock = tagsArray.length ? tagsArray.map((t) => `- ${t}`).join('\n') : '';
  const tagsLine = tagsArray.length ? '标签：' + tagsArray.join('、') : '';
  const timestamp = formatLocalDate(new Date(), config?.TIMEZONE || 'UTC', 'datetime');
  const formattedMessage = [
    payload.title,
    payload.content,
    tagsLine,
    `发送时间：${timestamp}`
  ]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n');

  // 生成多行版本的 content，并替换换行符为 <br>（兼容钉钉 Markdown）
  const rawContentLines = formatContentToLines(payload.content);
  // 如果原始 content 没有空格分隔的字段，而是已经包含换行符，我们直接使用原始 content 并替换换行符
  const contentLines = rawContentLines.includes('\n')
    ? rawContentLines.replace(/\n/g, '<br>')
    : payload.content.replace(/\n/g, '<br>');

  return {
    title: payload.title,
    content: payload.content,
    tags: tagsBlock,
    tagsLine,
    rawTags: tagsArray,
    timestamp,
    formattedMessage,
    message: formattedMessage,
    contentLines, // 已替换换行符为 <br>，用于钉钉 Markdown
    // 扩展字段
    daysRemaining: payload.metadata?.daysRemaining ?? '',
    ruleType: payload.metadata?.ruleType ?? '',
    ruleValue: payload.metadata?.ruleValue ?? ''
  };
}

/** @type {import('./channel.js').Channel} */
export const webhookChannel = {
  name: 'webhook',

  validateConfig(config) {
    if (!config.WEBHOOK_URL) return { ok: false, error: '缺少 WEBHOOK_URL' };
    return { ok: true };
  },

  async send(payload, config) {
    const v = webhookChannel.validateConfig(config);
    if (!v.ok) return fail('webhook', v.error || '配置无效');

    let headers = { 'Content-Type': 'application/json' };
    if (config.WEBHOOK_HEADERS) {
      try {
        const customHeaders = JSON.parse(config.WEBHOOK_HEADERS);
        headers = { ...headers, ...customHeaders };
      } catch {
        console.warn('[Webhook] 自定义请求头格式错误，使用默认请求头');
      }
    }

    const data = buildTemplateData(payload, config);
    let requestBody;
    if (config.WEBHOOK_TEMPLATE) {
      try {
        const template = JSON.parse(config.WEBHOOK_TEMPLATE);
        requestBody = applyTemplate(template, data);
      } catch {
        console.warn('[Webhook] 消息模板格式错误，使用默认格式');
        requestBody = { ...data };
      }
    } else {
      requestBody = { ...data };
    }

    try {
      const r = await fetch(config.WEBHOOK_URL, {
        method: config.WEBHOOK_METHOD || 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });
      const text = await r.text().catch(() => '');
      return r.ok ? ok('webhook', text) : fail('webhook', `HTTP ${r.status}`, text);
    } catch (err) {
      return fail('webhook', errorMessage(err));
    }
  },

  async test(config) {
    return webhookChannel.send(
      { title: '订阅管理 - 测试通知', content: '这是一条 Webhook 测试通知。' },
      config
    );
  }
};

/** @deprecated 旧版兼容函数 */
export async function sendWebhookNotification(title, content, config, metadata = {}) {
  const r = await webhookChannel.send({ title, content, metadata }, config);
  if (!r.success) console.error('[Webhook]', r.error);
  return r.success;
}
