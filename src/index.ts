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
import { handleOnboardingMessage, initContactMapping } from "./onboarding";

const logger = pino({ level: "warn" });

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

  initContactMapping(sock);

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

  // New member welcome message
  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    if (action !== "add") return;

    // If a specific group is configured, only handle that group
    if (config.whatsapp.groupId && id !== config.whatsapp.groupId) return;

    for (const participant of participants) {
      try {
        await sock.sendMessage(id, {
          text: `Welcome to the Official Laguna Park WhatsApp Community Chatgroup. 🏡

By remaining in this group, you consent to your mobile number being visible to other members. Please do not share or harvest contact details from this group without explicit consent, in compliance with the PDPA.

After joining the chat group, please add your member tag.

*How to add it:*

1. Open the chat group and tap the group name.
2. Under "Members", tap "Add member tag" below your name.
3. Enter your unit and status, then tap "Save".

*Example:* DXX-XX SP
*Other status:* Resident or Tenant

Your WhatsApp name will appear separately. If the option is unavailable, please update WhatsApp to the latest version.

Thank you for helping us maintain a respectful and properly organised community.`,
        });
        console.log(`[BOT] Welcome message sent to new member: ${participant}`);
      } catch (error) {
        console.error(`[BOT] Failed to send welcome message to ${participant}:`, error);
      }
    }
  });

  // Persist credentials whenever they update
  sock.ev.on("creds.update", saveCreds);

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
    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid || "";
    const text = getMessageText(msg);
    const isMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage);

    // ── Private chat → onboarding flow ──────────────────────────────────────
    if (!remoteJid.endsWith("@g.us")) {
      if (text) {
        await handleOnboardingMessage(sock, remoteJid, text, msg.key);
      }
      return;
    }

    // ── Group chat → moderation ──────────────────────────────────────────────
    if (config.whatsapp.groupId && remoteJid !== config.whatsapp.groupId) {
      return;
    }

    if (!text && !isMedia) return;

    await moderateMessage(sock, remoteJid, msg);
  }
}

console.log("[BOT] Starting WhatsApp Moderation Bot...");
startBot().catch((err) => {
  console.error("[BOT] Fatal error starting bot:", err);
  process.exit(1);
});
