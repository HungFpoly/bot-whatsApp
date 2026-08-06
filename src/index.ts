import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
const qrcode = require("qrcode-terminal");
import { config } from "./config";
import { moderateMessage, getMessageText } from "./moderation";

const logger = pino({ level: "silent" });

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(
    config.whatsapp.sessionPath
  );

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    logger,
    version,
    printQRInTerminal: false,
  });

  let pairingRequested = false;

  // Connection updates: QR / pairing code / open / close
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Wait for the "qr" event before requesting a pairing code
    // (this signals the socket is ready to authenticate)
    if (qr && !pairingRequested && !state.creds.registered) {
      if (config.whatsapp.phoneNumber) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(
            config.whatsapp.phoneNumber.replace(/[^0-9]/g, "")
          );
          console.log(`\n========================================`);
          console.log(`  PAIRING CODE: ${code}`);
          console.log(`========================================`);
          console.log(`\n  Enter this code on your phone:`);
          console.log(`  WhatsApp → Linked Devices → Link a Device`);
          console.log(`  → "Link with phone number instead"\n`);
        } catch (err) {
          console.error("[BOT] Failed to request pairing code:", err);
        }
      } else {
        console.log("[BOT] Scan this QR code with WhatsApp:");
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === "open") {
      console.log("[BOT] ✅ Bot is connected and ready!");
      console.log("[BOT] Monitoring messages...");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output
        ?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `[BOT] Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        startBot();
      } else {
        console.log("[BOT] Logged out. Please delete session and re-pair.");
        process.exit(1);
      }
    }
  });

  // Persist credentials whenever they update
  sock.ev.on("creds.update", saveCreds);

  // Incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (error) {
        console.error("[BOT] Error handling message:", error);
      }
    }
  });

  async function handleMessage(sock: ReturnType<typeof makeWASocket>, msg: WAMessage) {
    // Ignore messages without content
    if (!msg.message) return;

    // Ignore messages sent by the bot itself
    if (msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid || "";

    // Only moderate group chats (group JIDs end with @g.us)
    if (!remoteJid.endsWith("@g.us")) return;

    // If a specific group is configured, only moderate that group
    if (config.whatsapp.groupId && remoteJid !== config.whatsapp.groupId) {
      return;
    }

    const text = getMessageText(msg);
    const isMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage);

    if (!text && !isMedia) return;

    if (text) {
      console.log(`[DEBUG] Group message in ${remoteJid}: "${text}"`);
    } else {
      console.log(`[DEBUG] Group media message in ${remoteJid}: ${msg.message?.imageMessage ? "image" : "video"}`);
    }

    await moderateMessage(sock, remoteJid, msg);
  }
}

console.log("[BOT] Starting WhatsApp Moderation Bot...");
startBot().catch((err) => {
  console.error("[BOT] Fatal error starting bot:", err);
  process.exit(1);
});
