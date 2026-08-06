import type { WASocket, WAMessage, proto } from "@whiskeysockets/baileys";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { config } from "./config";
import { analyzeMessage, analyzeImage } from "./ai";

// ---- Quiet Hours ----
// Tracks which senders already received a reminder in the current quiet-hours
// window so they only get one reminder per session (not every message).
const quietHoursRemindedSenders = new Set<string>();

function isQuietHours(): boolean {
  if (!config.quietHours.enabled) return false;
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: config.quietHours.timezone })
  );
  const hour = now.getHours();
  const { startHour, endHour } = config.quietHours;
  // e.g. 23 → 7: wraps midnight
  if (startHour > endHour) {
    return hour >= startHour || hour < endHour;
  }
  return hour >= startHour && hour < endHour;
}

// Reset reminded senders at the start of each quiet-hours window
// (i.e. when quiet hours begin again the next day)
let _lastQuietState = false;
function checkQuietHoursReset() {
  const current = isQuietHours();
  if (current && !_lastQuietState) {
    quietHoursRemindedSenders.clear();
  }
  _lastQuietState = current;
}

// ---- Spam detection ----
// Tracks recent message history per sender to detect flooding /
// repeated duplicate messages (e.g. "spam spam spam" x5 in a row).
const SPAM_WINDOW_MS = 15_000; // look back window
const SPAM_DUPLICATE_THRESHOLD = 2; // same/similar text repeated N+ times
const SPAM_FLOOD_THRESHOLD = 5; // warn + delete from the 6th message onward

interface SpamResult {
  keysToDelete: proto.IMessageKey[];
  shouldWarn: boolean;
}

interface RecentMessage {
  text: string;
  timestamp: number;
  key: proto.IMessageKey;
  deleted: boolean;
}

const recentMessagesBySender = new Map<string, RecentMessage[]>();
// Track whether we already sent a warning to this sender in the current window
const spamWarnedSenders = new Set<string>();

function normalizeForSpamCheck(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Records the message and checks whether the sender is spamming.
 * - Flood: keep the first 5 messages, delete from the 6th onward.
 * - Duplicate: keep the first occurrence, delete every repeat.
 * Returns keysToDelete and whether a warning should be sent.
 */
function checkSpam(
  senderId: string,
  text: string,
  key: proto.IMessageKey
): SpamResult {
  const now = Date.now();
  const normalized = normalizeForSpamCheck(text);

  const history = recentMessagesBySender.get(senderId) || [];

  // Drop entries outside the time window
  const recent = history.filter((m) => now - m.timestamp < SPAM_WINDOW_MS);

  // Add current message
  const current: RecentMessage = { text: normalized, timestamp: now, key, deleted: false };
  recent.push(current);
  recentMessagesBySender.set(senderId, recent);

  const duplicates = recent.filter((m) => m.text === normalized);
  const isDuplicateSpam = duplicates.length >= SPAM_DUPLICATE_THRESHOLD;
  // Flood: 6th message onward (keep first SPAM_FLOOD_THRESHOLD = 5)
  const isFlood = recent.length > SPAM_FLOOD_THRESHOLD;

  if (!isFlood && !isDuplicateSpam) {
    return { keysToDelete: [], shouldWarn: false };
  }

  // Flood: only delete messages beyond the first 5
  // Duplicate: keep first occurrence, delete repeats
  const toDelete = isFlood ? recent.slice(SPAM_FLOOD_THRESHOLD) : duplicates.slice(1);
  const keys: proto.IMessageKey[] = [];
  for (const m of toDelete) {
    if (!m.deleted) {
      m.deleted = true;
      keys.push(m.key);
    }
  }

  // Send warning only once per spam window per sender
  const shouldWarn = keys.length > 0 && !spamWarnedSenders.has(senderId);
  if (shouldWarn) spamWarnedSenders.add(senderId);

  return { keysToDelete: keys, shouldWarn };
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
  // "gay" removed as standalone ban — only flagged when used as insult via AI
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
  "handcuff",
  "handcuffs",
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
  const m = msg.message;
  if (!m) return;

  const senderId = msg.key.participant || msg.key.remoteJid || "unknown";

  // Step 0.5: Quiet hours reminder (send once per sender per quiet window)
  checkQuietHoursReset();
  if (isQuietHours() && !quietHoursRemindedSenders.has(senderId)) {
    quietHoursRemindedSenders.add(senderId);
    console.log(`[MOD] Quiet hours reminder sent to ${senderId}`);
    await sock.sendMessage(groupJid, {
      text: config.quietHours.reminderMessage,
    });
  }

  // --- Image / Video moderation ---
  const isImage = !!m.imageMessage;
  const isVideo = !!m.videoMessage;
  if (isImage || isVideo) {
    await moderateMedia(sock, groupJid, msg, isImage ? "image" : "video");
    return;
  }

  const text = getMessageText(msg);
  if (!text) return;

  // Step 0: Spam check (duplicate messages / flooding), free & instant.
  const { keysToDelete, shouldWarn } = checkSpam(senderId, text, msg.key);
  if (keysToDelete.length > 0) {
    console.log(
      `[MOD] Spam detected from ${senderId}: "${text.substring(0, 50)}..." (deleting ${keysToDelete.length} message(s))`
    );
    for (const key of keysToDelete) {
      await deleteMessageByKey(sock, groupJid, key, "Spam / repeated messages");
    }
    if (shouldWarn) {
      await sock.sendMessage(groupJid, {
        text: `⚠️ Please avoid sending repeated or excessive messages in this group.`,
      });
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

async function moderateMedia(
  sock: WASocket,
  groupJid: string,
  msg: WAMessage,
  type: "image" | "video"
): Promise<void> {
  try {
    console.log(`[MOD] Analyzing ${type} from ${msg.key.participant}...`);

    // Download the media as a buffer
    const buffer = await downloadMediaMessage(msg, "buffer", {}) as Buffer;
    const base64 = buffer.toString("base64");
    const mimeType = type === "image" ? "image/jpeg" : "image/jpeg"; // use first frame for video

    const result = await analyzeImage(base64, mimeType);

    if (result.isToxic && result.confidence >= 0.7) {
      console.log(
        `[MOD] AI flagged ${type} (${result.confidence}): Reason: ${result.reason}`
      );
      await deleteMessage(sock, groupJid, msg, result.reason);
    } else {
      console.log(`[MOD] ${type} passed moderation.`);
    }
  } catch (error) {
    console.error(`[MOD] Failed to moderate ${type}:`, error);
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
