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

function normalizeGroupDescription(description?: string | null): string {
  return (description || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

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
      
      // Update community description on startup
      if (config.whatsapp.groupId) {
        try {
          const communityDescription = `Welcome to the Laguna Park WhatsApp Community Chatgroup. 🏡

This group is for verified Laguna Park SPs, residents and tenants.

Please keep discussions relevant, respectful and factual.

*Community Rules*

- Robust discussion, disagreement, criticism of decisions or ideas, and factual rebuttals are welcome, even when expressed firmly. Please address the issue, not the person.
- No personal attacks, insults, harassment, bullying, threats, hate speech or discriminatory content.
- Do not make disparaging personal remarks about other residents, Council members, Management or staff.
- No vulgar language, profanity or slurs.
- No scams, phishing, suspicious requests, impersonation or requests for OTPs, passwords or banking information.
- No commercial advertising, solicitation or repeated promotional messages.
- No religious content or promotional material.
- No sexual, pornographic, graphic violent or otherwise inappropriate content.
- Stickers are not allowed.
- Repeated messages and message flooding may be treated as spam.
- Respect members' privacy. Do not share or collect another member's contact details, private messages or screenshots without consent.
- Your mobile number will be visible to other members of this group.

Property, neighbourhood, en bloc and estate-related discussions are allowed, together with legitimate news, government or community information relevant to Laguna Park residents.

Formal requests, maintenance issues and complaints should continue to be submitted through the Management Office or iCondo. For emergencies, contact the appropriate emergency service.

This chat is moderated, including through automated moderation. Moderation is intended to maintain a constructive environment, not to prevent members from expressing different views or responding to statements with relevant facts or evidence.

*Please add your Member Tag after joining.*

*How to add your Member Tag*

1. Open this chat and tap the group name at the top.
2. Under "Members", find your name and tap "Add member tag".
3. Enter your unit and status, then tap "Save".

Example: *DXX-XX Owner*

Other status: *Resident / Tenant*

Your WhatsApp name will remain displayed separately.

If you do not see the Member Tag option, please update WhatsApp to the latest version.

Thank you for helping us maintain a respectful, organised and responsible Laguna Park community.`;
          
          const metadata = await sock.groupMetadata(config.whatsapp.groupId);
          const currentDescription = normalizeGroupDescription(metadata.desc);
          const desiredDescription = normalizeGroupDescription(communityDescription);

          if (currentDescription !== desiredDescription) {
            await sock.groupUpdateDescription(
              config.whatsapp.groupId,
              communityDescription
            );
            console.log("[BOT] ✅ Community description updated successfully");
          } else {
            console.log("[BOT] Community description is already up to date");
          }
        } catch (error) {
          console.error("[BOT] Failed to update community description:", error);
        }
      }
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

  // New member welcome message - TEMPORARILY DISABLED
  /*
  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    if (action !== "add") return;

    // If a specific group is configured, only handle that group
    if (config.whatsapp.groupId && id !== config.whatsapp.groupId) return;

    for (const participant of participants) {
      try {
        await sock.sendMessage(id, {
          text: `Welcome to the Laguna Park WhatsApp Community Chatgroup. 🏡

By remaining in this group, you consent to your mobile number being visible to other members. Please do not share or harvest contact details from this group without explicit consent, in compliance with the PDPA.

After joining the chat group, please add your member tag.

*How to add it:*

1. Open the chat group and tap the group name.
2. Under "Members", tap "Add member tag" below your name.
3. Enter your unit and status, then tap "Save".

*Example:* DXX-XX Owner
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
  */

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
    
    // Debug: Log all messages
    console.log(`[BOT] Message received: fromMe=${msg.key.fromMe}, remoteJid=${msg.key.remoteJid}, types=${Object.keys(msg.message || {})}`);
    
    if (msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid || "";
    const text = getMessageText(msg);
    const isMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage);
    const isSticker = !!(msg.message?.stickerMessage || msg.message?.lottieStickerMessage);

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

    if (!text && !isMedia && !isSticker) return;

    await moderateMessage(sock, remoteJid, msg);
  }
}

console.log("[BOT] Starting WhatsApp Moderation Bot...");
startBot().catch((err) => {
  console.error("[BOT] Fatal error starting bot:", err);
  process.exit(1);
});
