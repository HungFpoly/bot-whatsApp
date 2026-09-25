import { google } from "googleapis";
import type { WAMessage } from "@whiskeysockets/baileys";
import { config } from "./config";
import { saveLogImage } from "./image-log-store";

const SHEET_NAME = "Deleted Messages";
const HEADERS = [
  "Deleted At",
  "Sender Name",
  "Phone Number",
  "Message Type",
  "Message Content",
  "Reason",
  "Image",
];

let sheetReadyPromise: Promise<number> | null = null;

function getMessageText(msg: WAMessage): string {
  const message = msg.message;
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  );
}

function getMessageType(msg: WAMessage): string {
  const message = msg.message;
  if (!message) return "unknown";
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.stickerMessage || message.lottieStickerMessage) return "sticker";
  if (getMessageText(msg)) return "text";
  return Object.keys(message)[0] || "unknown";
}

function getMessageContent(msg: WAMessage): string {
  const text = getMessageText(msg);
  if (text) return text;

  const message = msg.message;
  if (message?.stickerMessage || message?.lottieStickerMessage) {
    return "[Sticker]";
  }
  if (message?.imageMessage) return "[Image without caption]";
  if (message?.videoMessage) return "[Video without caption]";
  return "[No text content]";
}

function getSenderPhoneNumber(msg: WAMessage): string {
  const key = msg.key as typeof msg.key & { participantAlt?: string };
  const candidates = [key.participantAlt, key.participant, key.remoteJid];
  const phoneJid = candidates.find((jid) => jid?.endsWith("@s.whatsapp.net"));
  return phoneJid?.replace("@s.whatsapp.net", "") || "";
}

function formatSingaporeTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

async function ensureSheetExists(
  sheets: ReturnType<typeof google.sheets>
): Promise<number> {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: config.google.sheetId,
    fields: "sheets.properties(title,sheetId)",
  });

  const existing = spreadsheet.data.sheets?.find(
    (sheet) => sheet.properties?.title === SHEET_NAME
  );

  let sheetId = existing?.properties?.sheetId;
  if (!existing) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
      },
    });
    sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId;
  }

  const headerResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: `'${SHEET_NAME}'!A1:G1`,
  });

  const currentHeaders = headerResponse.data.values?.[0] || [];
  if (JSON.stringify(currentHeaders) !== JSON.stringify(HEADERS)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.google.sheetId,
      range: `'${SHEET_NAME}'!A1:G1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
  }
  if (sheetId == null) throw new Error("Missing Deleted Messages sheet ID");
  return sheetId;
}

export function imageLoggingEnabled(): boolean {
  return !!(config.google.sheetId && config.imageLog.publicUrl);
}

export async function logDeletedMessage(
  msg: WAMessage,
  reason: string,
  imageBuffer?: Buffer
): Promise<void> {
  const messageType = getMessageType(msg);
  if (messageType !== "text" && messageType !== "image") {
    console.log(`[MOD] Skipping Google Sheet log for ${messageType} message`);
    return;
  }

  if (!config.google.sheetId) {
    console.warn("[MOD] GOOGLE_SHEET_ID is not configured; deletion was not logged");
    return;
  }

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.google.serviceAccountKeyFile,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    if (!sheetReadyPromise) {
      sheetReadyPromise = ensureSheetExists(sheets).catch((error) => {
        sheetReadyPromise = null;
        throw error;
      });
    }
    const sheetId = await sheetReadyPromise;

    let imageUrl: string | undefined;
    let imageStatus = "";
    if (messageType === "image") {
      imageStatus = "Image unavailable: VPS image hosting is not configured";
      if (imageLoggingEnabled()) {
        imageStatus = "Image unavailable: download or storage failed";
        if (imageBuffer) {
          try {
            imageUrl = await saveLogImage(imageBuffer);
          } catch {
            console.error("[MOD] Failed to save image for deletion log");
          }
        }
      }
    }
    const values = [
      formatSingaporeTimestamp(new Date()), msg.pushName || "", getSenderPhoneNumber(msg),
      messageType, getMessageContent(msg), reason,
    ];
    const appended = await sheets.spreadsheets.values.append({
      spreadsheetId: config.google.sheetId,
      range: `'${SHEET_NAME}'!A:G`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          // Literal strings: preserve phone numbers and prevent captions/names becoming formulas.
          ...values.map(value => value ? `'${value}` : ""),
          imageUrl ? `=IMAGE("${imageUrl.replace(/"/g, '""')}")` : imageStatus,
        ]],
      },
    });

    console.log(`[MOD] Deletion logged to Google Sheet: ${msg.key.id || "unknown"}`);
    if (imageUrl) {
      // Use the range returned by this append, never the current last row.
      const row = Number(appended.data.updates?.updatedRange?.match(/!A(\d+):G\d+$/)?.[1]);
      try {
        if (!Number.isInteger(row) || row < 2) throw new Error("Missing appended row");
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: config.google.sheetId,
          requestBody: { requests: [
            { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: row - 1, endIndex: row }, properties: { pixelSize: 180 }, fields: "pixelSize" } },
            { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 6, endIndex: 7 }, properties: { pixelSize: 240 }, fields: "pixelSize" } },
          ] },
        });
      } catch {
        console.error(`[MOD] Image logged but failed to resize row ${row}`);
      }
    }
  } catch (error) {
    console.error("[MOD] Failed to log deleted message to Google Sheet:", error);
  }
}
