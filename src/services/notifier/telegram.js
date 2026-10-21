import { config } from '../../config.js';

const api = () => `https://api.telegram.org/bot${config.telegram.token}`;

async function call(method, body) {
  const res = await fetch(`${api()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(`telegram ${method} failed: ${data.description || res.status}`);
    err.retry_after = data.parameters?.retry_after;
    throw err;
  }
  return data.result;
}

function chunkText(text, size) {
  const chunks = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if (cur.length + line.length + 1 > size) {
      if (cur) chunks.push(cur);
      if (line.length > size) {
        for (let i = 0; i < line.length; i += size) chunks.push(line.slice(i, i + size));
        cur = '';
      } else cur = line;
    } else cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [String(text).slice(0, size)];
}

export const TelegramProvider = {
  name: 'telegram',
  async send({ text, keyboard = [], replyTo = null, chatId = null }) {
    const target = chatId || config.telegram.chatId;
    const chunks = chunkText(text, 3900);
    let last;
    for (let i = 0; i < chunks.length; i++) {
      last = await call('sendMessage', {
        chat_id: target,
        text: chunks[i],
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(i === 0 && replyTo ? { reply_to_message_id: replyTo } : {}),
        ...(i === chunks.length - 1 && keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    }
    return last;
  },
  async answerCallback(id, text, showAlert = false) {
    return call('answerCallbackQuery', { callback_query_id: id, text, show_alert: showAlert });
  },
};