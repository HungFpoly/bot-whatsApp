import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { config } from "./config";
import { analyzeMessage, analyzeImage } from "./ai";
import { logDeletedMessage } from "./deleted-message-log";

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
  messagesToDelete: WAMessage[];
  shouldWarn: boolean;
}

interface RecentMessage {
  text: string;
  timestamp: number;
  message: WAMessage;
  deleted: boolean;
}

const recentMessagesBySender = new Map<string, RecentMessage[]>();
// Track whether we already sent a warning to this sender in the current window
const spamWarnedSenders = new Set<string>();

function normalizeForSpamCheck(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getBigrams(text: string): Set<string> {
  const compact = text.replace(/\s+/g, " ");
  const bigrams = new Set<string>();
  for (let i = 0; i < compact.length - 1; i++) {
    bigrams.add(compact.slice(i, i + 2));
  }
  return bigrams;
}

function areSubstantiallySimilar(first: string, second: string): boolean {
  if (first === second) return true;

  // Avoid treating different very short chat replies as equivalent.
  if (first.length < 12 || second.length < 12) return false;

  const firstBigrams = getBigrams(first);
  const secondBigrams = getBigrams(second);
  if (firstBigrams.size === 0 || secondBigrams.size === 0) return false;

  let overlap = 0;
  for (const bigram of firstBigrams) {
    if (secondBigrams.has(bigram)) overlap++;
  }

  const diceSimilarity =
    (2 * overlap) / (firstBigrams.size + secondBigrams.size);
  return diceSimilarity >= 0.9;
}

function simplifyTrustedGoogleUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/gi, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      const hostname = url.hostname.toLowerCase();
      if (hostname === "share.google") {
        return "[Google shared link]";
      }

      const isGoogleSearch =
        (hostname === "google.com" || hostname === "www.google.com") &&
        url.pathname === "/search";

      if (!isGoogleSearch) return rawUrl;

      const query = url.searchParams.get("q")?.trim();
      return query
        ? `[Google Search query: ${query}]`
        : "[Google Search link]";
    } catch {
      return rawUrl;
    }
  });
}

/**
 * Records the message and checks whether the sender is spamming.
 * - Flood: keep the first 5 messages, delete from the 6th onward.
 * - Duplicate: keep the first occurrence, delete every repeat.
 * Returns keysToDelete and whether a warning should be sent.
 */
function checkSpam(
  groupJid: string,
  senderId: string,
  text: string,
  message: WAMessage
): SpamResult {
  const now = Date.now();
  const normalized = normalizeForSpamCheck(text);

  const senderKey = `${groupJid}:${senderId}`;
  const history = recentMessagesBySender.get(senderKey) || [];

  // Drop entries outside the time window
  const recent = history.filter((m) => now - m.timestamp < SPAM_WINDOW_MS);

  // Add current message
  const current: RecentMessage = { text: normalized, timestamp: now, message, deleted: false };
  recent.push(current);
  recentMessagesBySender.set(senderKey, recent);

  const duplicates = recent.filter((m) =>
    areSubstantiallySimilar(m.text, normalized)
  );
  const isDuplicateSpam = duplicates.length >= SPAM_DUPLICATE_THRESHOLD;
  // Flood: 6th message onward (keep first SPAM_FLOOD_THRESHOLD = 5)
  const isFlood = recent.length > SPAM_FLOOD_THRESHOLD;

  if (!isFlood && !isDuplicateSpam) {
    return { messagesToDelete: [], shouldWarn: false };
  }

  // Flood: only delete messages beyond the first 5
  // Duplicate: keep first occurrence, delete repeats
  const toDelete = isFlood ? recent.slice(SPAM_FLOOD_THRESHOLD) : duplicates.slice(1);
  const messages: WAMessage[] = [];
  for (const m of toDelete) {
    if (!m.deleted) {
      m.deleted = true;
      messages.push(m.message);
    }
  }

  // Send warning only once per spam window per sender
  const shouldWarn = messages.length > 0 && !spamWarnedSenders.has(senderId);
  if (shouldWarn) spamWarnedSenders.add(senderId);

  return { messagesToDelete: messages, shouldWarn };
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

  // Debug: Log message type to help diagnose
  console.log(`[MOD] Message from ${senderId}, types:`, Object.keys(m));

  // Step 0.5: Quiet hours reminder (send once per sender per quiet window)
  checkQuietHoursReset();
  if (isQuietHours() && !quietHoursRemindedSenders.has(senderId)) {
    quietHoursRemindedSenders.add(senderId);
    console.log(`[MOD] Quiet hours reminder sent to ${senderId}`);
    await sock.sendMessage(groupJid, {
      text: config.quietHours.reminderMessage,
    });
  }

  // --- Sticker moderation (auto-delete all stickers) ---
  const isSticker = !!(m.stickerMessage || m.lottieStickerMessage);
  if (isSticker) {
    console.log(`[MOD] ⚠️ Sticker detected from ${senderId} - Auto-deleting`);
    await deleteMessage(sock, groupJid, msg, "Stickers are not allowed in this group");
    return;
  }

  // --- Image / Video moderation (with caption check) ---
  const isImage = !!m.imageMessage;
  const isVideo = !!m.videoMessage;
  
  if (isImage || isVideo) {
    // First, check caption text (if exists)
    const caption = getMessageText(msg);
    if (caption && caption.length >= config.bot.minMessageLength) {
      const moderationCaption = simplifyTrustedGoogleUrls(caption);
      // AI analysis for caption text
      const textResult = await analyzeMessage(moderationCaption);
      if (textResult.isToxic && textResult.confidence >= 0.7) {
        console.log(
          `[MOD] AI flagged caption (${textResult.confidence}): "${caption.substring(0, 50)}..." - Reason: ${textResult.reason}`
        );
        await deleteMessage(sock, groupJid, msg, textResult.reason);
        return;
      }
    }
    
    // Then, analyze the image/video itself
    await moderateMedia(sock, groupJid, msg, isImage ? "image" : "video");
    return;
  }

  const text = getMessageText(msg);
  if (!text) return;
  const moderationText = simplifyTrustedGoogleUrls(text);

  // Step 0: Spam check (duplicate messages / flooding), free & instant.
  const { messagesToDelete, shouldWarn } = checkSpam(groupJid, senderId, text, msg);
  if (messagesToDelete.length > 0) {
    console.log(
      `[MOD] Spam detected from ${senderId}: "${text.substring(0, 50)}..." (deleting ${messagesToDelete.length} message(s))`
    );
    for (const spamMessage of messagesToDelete) {
      await deleteMessage(sock, groupJid, spamMessage, "Spam / repeated messages");
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

  // AI analysis handles profanity and insults in context, so reports, warnings,
  // quotations, and permitted identity/festival references are not auto-deleted.
  const result = await analyzeMessage(moderationText);

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

    const caption = simplifyTrustedGoogleUrls(getMessageText(msg));
    const result = await analyzeImage(base64, mimeType, caption);

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
  await deleteMessageByKey(sock, groupJid, msg, reason);
}

async function deleteMessageByKey(
  sock: WASocket,
  groupJid: string,
  msg: WAMessage,
  reason: string
): Promise<void> {
  try {
    const key = msg.key;
    // For LID groups, use the real phone number (participantAlt) for deletion
    // participantAlt is not in the official type but exists at runtime
    const deleteKey = {
      remoteJid: key.remoteJid,
      fromMe: key.fromMe,
      id: key.id,
      participant: (key as any).participantAlt || key.participant,
    };

    const deletionNotice =
      config.bot.violationAction === "delete_and_warn"
        ? `⚠️ ${config.bot.warningMessage}\nReason: ${reason}`
        : `⚠️ This message is being removed.\nReason: ${reason}`;

    await sock.sendMessage(groupJid, {
      delete: deleteKey,
    });

    console.log(`[MOD] ✅ Message deleted. Reason: ${reason}`);

    // Keep the reply associated with the deleted message without copying the
    // prohibited content into WhatsApp's persistent quoted-message preview.
    const sanitizedQuotedMessage: WAMessage = {
      ...msg,
      message: { conversation: "[Deleted message]" },
    };
    try {
      await sock.sendMessage(
        groupJid,
        { text: deletionNotice },
        { quoted: sanitizedQuotedMessage }
      );
    } catch (replyError) {
      console.error("[MOD] Failed to reply with deletion reason:", replyError);
    }

    await logDeletedMessage(msg, reason);
  } catch (error) {
    console.error("[MOD] ❌ Failed to delete message:", error);
  }
}
