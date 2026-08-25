import { google } from "googleapis";
import type { WAMessage } from "@whiskeysockets/baileys";
import { config } from "./config";

const SHEET_NAME = "Deleted Messages";
const HEADERS = [
  "Deleted At",
  "Sender Name",
  "Phone Number / JID",
  "Message Type",
  "Message Content",
  "Reason",
  "Group JID",
  "Message ID",
];

let sheetReadyPromise: Promise<void> | null = null;

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

function getSenderIdentifier(msg: WAMessage): string {
  const key = msg.key as typeof msg.key & { participantAlt?: string };
  return key.participantAlt || key.participant || key.remoteJid || "unknown";
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
): Promise<void> {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: config.google.sheetId,
    fields: "sheets.properties.title",
  });

  const exists = spreadsheet.data.sheets?.some(
    (sheet) => sheet.properties?.title === SHEET_NAME
  );

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
      },
    });
  }

  const headerResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: `'${SHEET_NAME}'!A1:H1`,
  });

  if (!headerResponse.data.values?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.google.sheetId,
      range: `'${SHEET_NAME}'!A1:H1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
  }
}

export async function logDeletedMessage(
  msg: WAMessage,
  groupJid: string,
  reason: string
): Promise<void> {
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
    await sheetReadyPromise;

    await sheets.spreadsheets.values.append({
      spreadsheetId: config.google.sheetId,
      range: `'${SHEET_NAME}'!A:H`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          formatSingaporeTimestamp(new Date()),
          msg.pushName || "",
          getSenderIdentifier(msg),
          getMessageType(msg),
          getMessageContent(msg),
          reason,
          groupJid,
          msg.key.id || "",
        ]],
      },
    });

    console.log(`[MOD] Deletion logged to Google Sheet: ${msg.key.id || "unknown"}`);
  } catch (error) {
    console.error("[MOD] Failed to log deleted message to Google Sheet:", error);
  }
}
