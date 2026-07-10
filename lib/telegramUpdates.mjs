// Shared Telegram update snapshot. The bot command poller is the sole getUpdates
// consumer; source ingestion reads channel posts from this bounded store.

const MAX_CHANNEL_MESSAGES = 500;
const channelMessages = new Map();

export function recordTelegramUpdate(update) {
  const msg = update?.channel_post || update?.edited_channel_post;
  if (!msg) return false;

  const chatId = msg.chat?.id;
  const messageId = msg.message_id;
  if (chatId == null || messageId == null) return false;

  const key = `${chatId}:${messageId}`;
  channelMessages.delete(key);
  channelMessages.set(key, {
    postId: key,
    messageId,
    text: msg.text || msg.caption || '',
    date: msg.date ? new Date(msg.date * 1000).toISOString() : null,
    editedAt: msg.edit_date ? new Date(msg.edit_date * 1000).toISOString() : null,
    chat: msg.chat?.title || msg.chat?.username || 'unknown',
    channel: msg.chat?.username || msg.chat?.title || 'unknown',
    views: msg.views || 0,
    hasMedia: Boolean(msg.photo || msg.video || msg.document || msg.animation),
  });

  while (channelMessages.size > MAX_CHANNEL_MESSAGES) {
    channelMessages.delete(channelMessages.keys().next().value);
  }
  return true;
}

export function getTelegramChannelMessages({ limit = 100 } = {}) {
  return [...channelMessages.values()]
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, Math.min(Math.max(Number(limit) || 100, 1), MAX_CHANNEL_MESSAGES))
    .map(message => ({ ...message }));
}

export function clearTelegramChannelMessages() {
  channelMessages.clear();
}
