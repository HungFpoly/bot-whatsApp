import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { config } from "../config";
import { analyzeMessage, analyzeImage } from "./ai-moderator";
import { logDeletedMessage, imageLoggingEnabled } from "../infrastructure/deleted-message-log";
import { getProtectedContentCategory, moderationThresholdFor } from "./content-whitelist";
import { getMessageText, simplifyTrustedGoogleUrls } from "./message-utils";
import { SpamDetector } from "./spam-detector";
import { runModerationPipeline, type ModerationRule } from "./moderation-pipeline";

export { getMessageText } from "./message-utils";

interface ModerationResult {
  isToxic: boolean;
  reason: string;
  confidence: number;
  protectedCategory: "official_laguna_park" | "estate_report" | "none";
}

interface ModerationContext {
  sock: WASocket;
  groupJid: string;
  msg: WAMessage;
  message: NonNullable<WAMessage["message"]>;
  senderId: string;
}

export interface ModerationDependencies {
  analyzeText(message: string): Promise<ModerationResult>;
  analyzeMedia(imageBase64: string, mimeType: string, caption: string): Promise<ModerationResult>;
  downloadMedia(msg: WAMessage): Promise<Buffer>;
  removeMessage(sock: WASocket, groupJid: string, msg: WAMessage, reason: string, imageBuffer?: Buffer): Promise<void>;
}

export interface ModerationSettings {
  minMessageLength: number;
}

/** Chain-of-responsibility application service with injectable external ports. */
export class ModerationService {
  private readonly spamDetector: SpamDetector;
  private readonly rules: ReadonlyArray<ModerationRule<ModerationContext>>;

  constructor(
    private readonly dependencies: ModerationDependencies,
    private readonly settings: ModerationSettings,
    policies?: { spamDetector?: SpamDetector }
  ) {
    this.spamDetector = policies?.spamDetector || new SpamDetector();
    this.rules = [
      { name: "sticker", execute: (ctx) => this.moderateSticker(ctx) },
      { name: "media", execute: (ctx) => this.moderateMedia(ctx) },
      { name: "text", execute: (ctx) => this.moderateText(ctx) },
    ];
  }

  async moderate(sock: WASocket, groupJid: string, msg: WAMessage): Promise<void> {
    if (!msg.message) return;
    const senderId = msg.key.participant || msg.key.remoteJid || "unknown";
    console.log(`[MOD] Message from ${senderId}, types:`, Object.keys(msg.message));
    await runModerationPipeline(this.rules, {
      sock,
      groupJid,
      msg,
      message: msg.message,
      senderId,
    });
  }

  private async moderateSticker(ctx: ModerationContext): Promise<boolean> {
    const isSticker = !!(ctx.message.stickerMessage || ctx.message.lottieStickerMessage);
    if (!isSticker) return false;
    console.log(`[MOD] Sticker detected from ${ctx.senderId} - Auto-deleting`);
    await this.dependencies.removeMessage(ctx.sock, ctx.groupJid, ctx.msg, "Stickers are not allowed in this group");
    return true;
  }

  private async moderateMedia(ctx: ModerationContext): Promise<boolean> {
    const isImage = !!ctx.message.imageMessage;
    const isVideo = !!ctx.message.videoMessage;
    if (!isImage && !isVideo) return false;

    const caption = getMessageText(ctx.msg);
    if (caption && caption.length >= this.settings.minMessageLength) {
      const result = await this.dependencies.analyzeText(simplifyTrustedGoogleUrls(caption));
      if (result.isToxic && result.confidence >= moderationThresholdFor(caption)) {
        console.log(`[MOD] AI flagged caption (${result.confidence}): "${caption.substring(0, 50)}..." - Reason: ${result.reason}`);
        await this.dependencies.removeMessage(ctx.sock, ctx.groupJid, ctx.msg, result.reason);
        return true;
      }
    }

    try {
      const type = isImage ? "image" : "video";
      console.log(`[MOD] Analyzing ${type} from ${ctx.msg.key.participant}...`);
      const buffer = await this.dependencies.downloadMedia(ctx.msg);
      const result = await this.dependencies.analyzeMedia(
        buffer.toString("base64"),
        "image/jpeg",
        simplifyTrustedGoogleUrls(caption)
      );
      const category = getProtectedContentCategory(caption) ||
        (result.protectedCategory !== "none" ? result.protectedCategory : null);
      const threshold = moderationThresholdFor(caption);
      if (category) {
        console.log(`[MOD] Protected ${category} media context detected; deletion threshold is ${threshold}`);
      }
      if (result.isToxic && result.confidence >= threshold) {
        console.log(`[MOD] AI flagged ${type} (${result.confidence}): Reason: ${result.reason}`);
        await this.dependencies.removeMessage(ctx.sock, ctx.groupJid, ctx.msg, result.reason, isImage ? buffer : undefined);
      } else {
        console.log(`[MOD] ${type} passed moderation.`);
      }
    } catch (error) {
      console.error("[MOD] Failed to moderate media:", error);
    }
    return true;
  }

  private async moderateText(ctx: ModerationContext): Promise<boolean> {
    const text = getMessageText(ctx.msg);
    if (!text) return true;
    const protectedCategory = getProtectedContentCategory(text);
    const spam = protectedCategory
      ? { messagesToDelete: [], shouldWarn: false }
      : this.spamDetector.check(ctx.groupJid, ctx.senderId, text, ctx.msg);

    if (spam.messagesToDelete.length > 0) {
      console.log(`[MOD] Spam detected from ${ctx.senderId}: "${text.substring(0, 50)}..." (deleting ${spam.messagesToDelete.length} message(s))`);
      for (const spamMessage of spam.messagesToDelete) {
        await this.dependencies.removeMessage(ctx.sock, ctx.groupJid, spamMessage, "Spam / repeated messages");
      }
      if (spam.shouldWarn) {
        await ctx.sock.sendMessage(ctx.groupJid, { text: "Please avoid sending repeated or excessive messages in this group." });
      }
      return true;
    }

    if (text.length < this.settings.minMessageLength) return true;
    const result = await this.dependencies.analyzeText(simplifyTrustedGoogleUrls(text));
    const threshold = moderationThresholdFor(text);
    if (protectedCategory) {
      console.log(`[MOD] Protected ${protectedCategory} context detected; deletion threshold is ${threshold}`);
    }
    if (result.isToxic && result.confidence >= threshold) {
      console.log(`[MOD] AI flagged message (${result.confidence}): "${text.substring(0, 50)}..." - Reason: ${result.reason}`);
      await this.dependencies.removeMessage(ctx.sock, ctx.groupJid, ctx.msg, result.reason);
    }
    return true;
  }
}

async function deleteMessage(
  sock: WASocket,
  groupJid: string,
  msg: WAMessage,
  reason: string,
  imageBuffer?: Buffer
): Promise<void> {
  try {
    if (msg.message?.imageMessage && imageLoggingEnabled() && !imageBuffer) {
      try {
        imageBuffer = await downloadMediaMessage(msg, "buffer", {
          options: { signal: AbortSignal.timeout(15_000) },
        }) as Buffer;
      } catch {
        console.error("[MOD] Failed to capture image before deletion; text log will still be saved");
      }
    }

    const key = msg.key;
    const deleteKey = {
      remoteJid: key.remoteJid,
      fromMe: key.fromMe,
      id: key.id,
      participant: (key as any).participantAlt || key.participant,
    };
    const notice = config.bot.violationAction === "delete_and_warn"
      ? `⚠️ ${config.bot.warningMessage}\nReason: ${reason}`
      : `⚠️ This message is being removed.\nReason: ${reason}`;

    await sock.sendMessage(groupJid, { delete: deleteKey });
    console.log(`[MOD] Message deleted. Reason: ${reason}`);
    const sanitized: WAMessage = { ...msg, message: { conversation: "[Deleted message]" } };
    try {
      await sock.sendMessage(groupJid, { text: notice }, { quoted: sanitized });
    } catch (replyError) {
      console.error("[MOD] Failed to reply with deletion reason:", replyError);
    }
    await logDeletedMessage(msg, reason, imageBuffer);
  } catch (error) {
    console.error("[MOD] Failed to delete message:", error);
  }
}

const defaultService = new ModerationService(
  {
    analyzeText: analyzeMessage,
    analyzeMedia: analyzeImage,
    downloadMedia: async (msg) => await downloadMediaMessage(msg, "buffer", {}) as Buffer,
    removeMessage: deleteMessage,
  },
  { minMessageLength: config.bot.minMessageLength }
);

export async function moderateMessage(sock: WASocket, groupJid: string, msg: WAMessage): Promise<void> {
  await defaultService.moderate(sock, groupJid, msg);
}
