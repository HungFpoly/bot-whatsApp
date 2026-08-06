import type { WASocket, WAMessage, proto } from "@whiskeysockets/baileys";
import { config } from "./config";
import { analyzeMessage } from "./ai";

// ---- Spam detection ----
// Tracks recent message history per sender to detect flooding /
// repeated duplicate messages (e.g. "spam spam spam" x5 in a row).
const SPAM_WINDOW_MS = 15_000; // look back window
const SPAM_DUPLICATE_THRESHOLD = 2; // same/similar text repeated N+ times
const SPAM_FLOOD_THRESHOLD = 5; // any messages sent N+ times regardless of content

interface RecentMessage {
  text: string;
  timestamp: number;
  key: proto.IMessageKey;
  deleted: boolean;
}

const recentMessagesBySender = new Map<string, RecentMessage[]>();

function normalizeForSpamCheck(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Records the message and checks whether the sender is spamming
 * (duplicate content or flooding) within the recent time window.
 * Returns the list of message keys that should be deleted (the
 * current message plus any earlier ones in the same spam burst that
 * haven't been deleted yet), or an empty array if not spam.
 */
function checkSpam(
  senderId: string,
  text: string,
  key: proto.IMessageKey
): proto.IMessageKey[] {
  const now = Date.now();
  const normalized = normalizeForSpamCheck(text);

  const history = recentMessagesBySender.get(senderId) || [];

  // Drop entries outside the time window
  const recent = history.filter((m) => now - m.timestamp < SPAM_WINDOW_MS);

  // Add current message
  const current: RecentMessage = { text: normalized, timestamp: now, key, deleted: false };
  recent.push(current);
  recentMessagesBySender.set(senderId, recent);

  const isFlood = recent.length >= SPAM_FLOOD_THRESHOLD;
  const duplicates = recent.filter((m) => m.text === normalized);
  const isDuplicateSpam = duplicates.length >= SPAM_DUPLICATE_THRESHOLD;

  if (!isFlood && !isDuplicateSpam) {
    return [];
  }

  // Once flagged as spam:
  // - Flood: delete the whole recent burst (content varies, no "original" to keep).
  // - Duplicate: keep the very first occurrence, delete every repeat after it.
  const toDelete = isFlood ? recent : duplicates.slice(1);
  const keys: proto.IMessageKey[] = [];
  for (const m of toDelete) {
    if (!m.deleted) {
      m.deleted = true;
      keys.push(m.key);
    }
  }
  return keys;
}

// Bad words / abbreviations list (expand as needed)
// Matched with word boundaries to avoid false positives (e.g. "class" won't match "ass")
const BAD_WORDS: string[] = [
  // English profanity
  "fuck",
  "fck",
  "f\\*ck",
  "shit",
  "sh\\*t",
  "asshole",
  "a-hole",
  "ahole",
  "bitch",
  "bastard",
  "dick",
  "pussy",
  "cunt",
  "wtf",
  "stfu",
  "gtfo",
  // Insults
  "idiot",
  "stupid",
  "dumb",
  "moron",
  "retard",
  "trash",
  "rubbish",
  "loser",
  // Slurs / hate speech
  "nigger",
  "faggot",
  "gay", // blocked per client request, regardless of context
  // Chinese profanity (common WhatsApp/chat abbreviations)
  "他妈的",
  "卧槽",
  "妈的",
  "tmd",
  "nmsl",
  "cnm",
  // Hokkien / Singlish vulgar abbreviations (common in Singapore group chats)
  "knn",
  "kns",
  "ccb",
  "cb",
  "lj",
  "diao",
  "lanjiao",
  "chee bye",
  "kanina",
  "kaninabuchowchibai",
  "dou ma",
  "douma",
  // Phrases specifically requested to be blocked
  "without prejudice",
];

function containsBadWords(text: string): boolean {
  const lowerText = text.toLowerCase();
  return BAD_WORDS.some((word) => {
    // For CJK words, substring match is fine (no word boundaries in Chinese)
    if (/[\u4e00-\u9fff]/.test(word)) {
      return lowerText.includes(word);
    }
    // For latin words, use word boundary to avoid matching inside other words
    const regex = new RegExp(`\\b${word}\\b`, "i");
    return regex.test(lowerText);
  });
}

/**
 * Extract plain text body from a Baileys message
 */
export function getMessageText(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  );
}

export async function moderateMessage(
  sock: WASocket,
  groupJid: string,
  msg: WAMessage
): Promise<void> {
  const text = getMessageText(msg);
  if (!text) return;

  const senderId = msg.key.participant || msg.key.remoteJid || "unknown";

  // Step 0: Spam check (duplicate messages / flooding), free & instant.
  // Runs even for short messages (e.g. "ok" x20) since flooding is spam
  // regardless of content length.
  const spamKeys = checkSpam(senderId, text, msg.key);
  if (spamKeys.length > 0) {
    console.log(
      `[MOD] Spam detected from ${senderId}: "${text.substring(0, 50)}..." (deleting ${spamKeys.length} message(s))`
    );
    for (const key of spamKeys) {
      await deleteMessageByKey(sock, groupJid, key, "Spam / repeated messages");
    }
    return;
  }

  // Skip short messages for content moderation (like "ok", "thanks", emojis)
  if (text.length < config.bot.minMessageLength) {
    return;
  }

  // Step 1: Quick check with bad words list (free, instant)
  if (containsBadWords(text)) {
    console.log(`[MOD] Bad word detected: "${text.substring(0, 50)}..."`);
    await deleteMessage(sock, groupJid, msg, "Contains prohibited words");
    return;
  }

  // Step 2: AI analysis for context-based toxicity
  const result = await analyzeMessage(text);

  if (result.isToxic && result.confidence >= 0.7) {
    console.log(
      `[MOD] AI flagged message (${result.confidence}): "${text.substring(
        0,
        50
      )}..." - Reason: ${result.reason}`
    );
    await deleteMessage(sock, groupJid, msg, result.reason);
  }
}

async function deleteMessage(
  sock: WASocket,
  groupJid: string,
  msg: WAMessage,
  reason: string
): Promise<void> {
  await deleteMessageByKey(sock, groupJid, msg.key, reason);
}

async function deleteMessageByKey(
  sock: WASocket,
  groupJid: string,
  key: proto.IMessageKey,
  reason: string
): Promise<void> {
  try {
    // Baileys: delete any message in a group as admin by sending a
    // revoke protocol message referencing the original message key.
    await sock.sendMessage(groupJid, {
      delete: key,
    });

    console.log(`[MOD] ✅ Deleted message. Reason: ${reason}`);

    if (config.bot.violationAction === "delete_and_warn") {
      await sock.sendMessage(groupJid, {
        text: `⚠️ ${config.bot.warningMessage}`,
      });
    }
  } catch (error) {
    console.error("[MOD] Failed to delete message:", error);
  }
}
