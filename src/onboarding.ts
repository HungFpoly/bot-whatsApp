import type { WASocket } from "@whiskeysockets/baileys";
import { google } from "googleapis";
import { config } from "./config";
import { parseRegistrationForm } from "./registration-form";

// ── Types ────────────────────────────────────────────────────────────────────

type OnboardingStep =
  | "awaiting_join"
  | "awaiting_agree"
  | "awaiting_form"
  | "complete";

interface OnboardingSession {
  step: OnboardingStep;
  mobileNumber: string;
  consentTimestamp?: string;
  name?: string;
  unit?: string;
  status?: string;
  email?: string;
  reminderSent?: boolean;
  inviteLinkTimestamp?: string; // Timestamp when invite link was generated (expires after 2 days)
}

// ── Contact mapping cache (LID → Phone Number) ──────────────────────────────

const contactMap = new Map<string, string>(); // LID → Phone Number

// ── In-memory session store ──────────────────────────────────────────────────

const sessions = new Map<string, OnboardingSession>();

function buildContactMap(sock: WASocket): void {
  try {
    sock.ev.on("contacts.upsert", (contacts) => {
      contacts.forEach((contact) => {
        // contact.id is the primary identifier (could be LID or PN)
        // contact.phoneNumber has the phone in PN format
        if (contact.phoneNumber) {
          // Extract phone without @s.whatsapp.net suffix
          const phone = contact.phoneNumber.replace("@s.whatsapp.net", "");
          // If contact.lid exists, map it
          if (contact.lid) {
            const lid = contact.lid.replace("@lid", "");
            contactMap.set(lid, phone);
            console.log(`[ONBOARDING] Contact map: ${lid} → ${phone}`);
          }
        }
      });
    });
  } catch (err) {
    console.error(`[ONBOARDING] Error building contact map: ${err}`);
  }
}

// ── Welcome message (sent automatically when user first messages bot) ──────────

const WELCOME_MESSAGE = `Welcome! 👋

Send *JOIN* to register for the Laguna Park WhatsApp Community.`;

// ── Privacy Notice ───────────────────────────────────────────────────────────

const PRIVACY_NOTICE = `*LAGUNA PARK OFFICIAL WHATSAPP COMMUNITY*
*Privacy & Consent Notice — v1.0*

This Community is operated by MCST Plan No. 3271 – Laguna Park.

To register you, we may collect your WhatsApp number, name, unit number, status (Owner / Resident / Tenant), and optional email.

Your information will be used to administer your membership and for official estate communications, announcements, events, polls, surveys and resident engagement.

The Community includes a General Chat. If you participate, your WhatsApp number and profile information may be visible to other members.

Participation is voluntary. You may leave or withdraw consent for WhatsApp communications at any time.

Privacy enquiries:
Secretary, MCST 3271
mcst3271.council@gmail.com

By replying *I AGREE*, you consent to MCST 3271 collecting, using and disclosing your personal data for the purposes above.

Reply *I AGREE* to continue.`;

async function notifyAdminNewRegistration(
  sock: WASocket,
  resident: {
    mobileNumber: string;
    name: string;
    unit: string;
    status: string;
    email: string;
  }
): Promise<void> {
  if (!config.whatsapp.adminNumber) {
    console.warn("[ONBOARDING] ADMIN_WHATSAPP_NUMBER is not configured; admin was not notified");
    return;
  }

  try {
    const adminJid = `${config.whatsapp.adminNumber}@s.whatsapp.net`;
    const message =
      `📋 *NEW REGISTRATION*\n\n` +
      `*Mobile:* ${resident.mobileNumber}\n` +
      `*Name:* ${resident.name}\n` +
      `*Unit:* ${resident.unit}\n` +
      `*Resident Type:* ${resident.status}\n` +
      `*Email:* ${resident.email || "Not provided"}`;

    await sock.sendMessage(adminJid, { text: message });
    console.log(`[ONBOARDING] Admin notified of new registration: ${resident.mobileNumber}`);
  } catch (error) {
    console.error("[ONBOARDING] Failed to notify admin of new registration:", error);
  }
}


async function appendToSheet(session: OnboardingSession): Promise<void> {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.google.serviceAccountKeyFile,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    // Format timestamp: DD/MM/YYYY HH:MM:SS (Singapore timezone UTC+8)
    const formatTimestamp = (isoString: string): string => {
      const date = new Date(isoString);
      // Convert to Singapore time (UTC+8)
      const singaporeTime = new Date(date.getTime() + (8 * 60 * 60 * 1000) - (date.getTimezoneOffset() * 60 * 1000));
      const day = String(singaporeTime.getUTCDate()).padStart(2, "0");
      const month = String(singaporeTime.getUTCMonth() + 1).padStart(2, "0");
      const year = singaporeTime.getUTCFullYear();
      const hours = String(singaporeTime.getUTCHours()).padStart(2, "0");
      const minutes = String(singaporeTime.getUTCMinutes()).padStart(2, "0");
      const seconds = String(singaporeTime.getUTCSeconds()).padStart(2, "0");
      return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
    };

    // Note: Column headers in Google Sheet:
    // A: WhatsApp Number, B: Name, C: Unit Number, D: Resident Type, E: Email, 
    // F: Registration Date & Time, G: Privacy Notice Version, H: Consent
    const row = [
      session.mobileNumber,
      session.name || "",
      session.unit || "",
      session.status || "",
      session.email || "",
      formatTimestamp(session.consentTimestamp || new Date().toISOString()),
      "Privacy Notice v1.0",
      "I AGREE",
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: config.google.sheetId,
      range: "Members!A:H",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });

    console.log(`[ONBOARDING] Saved to Google Sheet: ${session.mobileNumber}`);
  } catch (error) {
    console.error("[ONBOARDING] Failed to save to Google Sheet:", error);
  }
}

// ── Invite link (expires after 2 days) ───────────────────────────────────────

async function getAndRevokeInviteLink(
  sock: WASocket,
  groupJid: string
): Promise<{ link: string; expiresAt: string }> {
  const code = await sock.groupInviteCode(groupJid);
  const link = `https://chat.whatsapp.com/${code}`;
  
  // Link expires after 2 days
  const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  
  // Schedule revoke after 2 days
  setTimeout(async () => {
    try {
      await sock.groupRevokeInvite(groupJid);
      console.log(`[ONBOARDING] Invite link revoked for group after 2 days`);
    } catch (err) {
      console.error(`[ONBOARDING] Failed to revoke invite link:`, err);
    }
  }, 2 * 24 * 60 * 60 * 1000); // 2 days in milliseconds
  
  return { link, expiresAt };
}

// ── Main handler ─────────────────────────────────────────────────────────────

export function initContactMapping(sock: WASocket): void {
  buildContactMap(sock);
}

// ── Check if user is already in community ─────────────────────────────────────

async function isUserInCommunity(
  sock: WASocket,
  userJid: string
): Promise<boolean> {
  try {
    if (!config.whatsapp.groupId) {
      console.log("[ONBOARDING] No group ID configured, skipping member check");
      return false;
    }

    const groupMetadata = await sock.groupMetadata(config.whatsapp.groupId);
    const participants = groupMetadata.participants || [];
    
    // Check if user's JID is in the participants list
    // Need to check both formats: phone@s.whatsapp.net and lid@lid
    const userPhone = userJid.replace("@s.whatsapp.net", "").replace("@lid", "");
    
    const isMember = participants.some((p) => {
      const participantId = p.id.replace("@s.whatsapp.net", "").replace("@lid", "");
      return participantId === userPhone || p.id === userJid;
    });

    if (isMember) {
      console.log(`[ONBOARDING] User ${userJid} is already in community, skipping welcome message`);
    }

    return isMember;
  } catch (error) {
    console.error("[ONBOARDING] Failed to check if user is in community:", error);
    return false; // If check fails, allow welcome message to be sent
  }
}

export async function handleOnboardingMessage(
  sock: WASocket,
  senderJid: string,
  text: string,
  messageKey?: any // WAMessageKey optional for remoteJidAlt
): Promise<void> {
  // Extract phone number: prefer remoteJidAlt (PN format), fallback to senderJid parsing
  let mobile = senderJid.replace("@s.whatsapp.net", "").replace("@lid", "");
  
  // If we have messageKey with remoteJidAlt, use that (actual phone number)
  if (messageKey?.remoteJidAlt) {
    const altJid = messageKey.remoteJidAlt.replace("@s.whatsapp.net", "").replace("@lid", "");
    if (altJid && altJid.match(/^\d+$/)) {
      mobile = altJid;
      console.log(`[ONBOARDING] Got phone from remoteJidAlt: ${mobile}`);
    }
  } else if (senderJid.includes("@lid")) {
    // Fallback: try LIDMappingStore for LID format
    const lid = senderJid.replace("@lid", "");
    
    if (contactMap.has(lid)) {
      mobile = contactMap.get(lid)!;
      console.log(`[ONBOARDING] Got phone from contact map: ${mobile}`);
    } else {
      try {
        const phoneNumber = await sock.signalRepository.lidMapping.getPNForLID(lid);
        if (phoneNumber) {
          mobile = phoneNumber;
          contactMap.set(lid, phoneNumber);
          console.log(`[ONBOARDING] Got phone from LIDMapping: ${mobile}`);
        }
      } catch (err) {
        console.log(`[ONBOARDING] Could not convert LID: ${err}`);
      }
    }
    
    if (mobile === lid) {
      console.log(`[ONBOARDING] WARNING: Could not convert LID ${lid} to phone number.`);
    }
  }

  let normalised = text.trim().toLowerCase().replace(/^\*|\*$/g, '').trim();

  let session = sessions.get(senderJid);

  // ── Step 1: Resident sends "JOIN" ──────────────────────────────────────────
  if (!session || session.step === "awaiting_join") {
    if (normalised === "join") {
      sessions.set(senderJid, {
        step: "awaiting_agree",
        mobileNumber: mobile,
      });
      await sock.sendMessage(senderJid, { text: PRIVACY_NOTICE });
      return;
    }
    // First message from user → check if already in community
    if (!session) {
      // Check if user is already in community
      const alreadyMember = await isUserInCommunity(sock, senderJid);
      if (alreadyMember) {
        console.log(`[ONBOARDING] User ${senderJid} already in community, no welcome message sent`);
        return; // Don't send welcome message, don't create session
      }
      
      // User not in community → send welcome message
      sessions.set(senderJid, {
        step: "awaiting_join",
        mobileNumber: mobile,
      });
      await sock.sendMessage(senderJid, { text: WELCOME_MESSAGE });
      return;
    }
    return;
  }

  // ── Step 2: Waiting for "I AGREE" ─────────────────────────────────────────
  if (session.step === "awaiting_agree") {
    if (normalised === "i agree" || /^i\s+agree\s*$/.test(normalised)) {
      session.step = "awaiting_form";
      session.consentTimestamp = new Date().toISOString();
      await sock.sendMessage(senderJid, {
        text: `✅ *Consent recorded.*\n\nPlease reply with:\n\nName:\nUnit:\nResident Type: Owner / Resident / Tenant\nEmail: Optional`,
      });
      return;
    }

    // Send reminder once
    if (!session.reminderSent) {
      session.reminderSent = true;
      await sock.sendMessage(senderJid, {
        text: 'Please reply *I AGREE* to continue with your registration, or simply do not proceed if you do not wish to join.',
      });
    }
    return;
  }

  // ── Step 3: Parse form submission ─────────────────────────────────────────
  if (session.step === "awaiting_form") {
    const { name, unit, status, email } = parseRegistrationForm(text);

    session.name = name;
    session.unit = unit;
    session.status = status;
    session.email = email || "";
    session.step = "complete";

    console.log(`[ONBOARDING] Accepted unit "${unit}" (user input preserved)`);

    await notifyAdminNewRegistration(sock, {
      mobileNumber: mobile,
      name,
      unit,
      status,
      email,
    });

    // Complete registration
    await completeOnboarding(sock, senderJid, session);
    return;
  }
}

// ── Complete onboarding ───────────────────────────────────────────────────────

async function completeOnboarding(
  sock: WASocket,
  senderJid: string,
  session: OnboardingSession
): Promise<void> {
  // Save to Google Sheet
  await appendToSheet(session);

  // Use fixed invite link
  const inviteLink = "https://chat.whatsapp.com/GCpmxxrgXZp76K7OKodf13";

  // Send confirmation + invite
  const confirmationMessage = await sock.sendMessage(senderJid, {
    text:
      `✅ *Registration received*\n\n` +
      `${session.name} | ${session.unit} | ${session.status}${session.email ? ` | ${session.email}` : ""}\n\n` +
      `Welcome to the Laguna Park WhatsApp Community.\n\n` +
      `👇 *TAP BELOW TO JOIN THE COMMUNITY*\n` +
      inviteLink,
  });

  console.log(`[ONBOARDING] ✅ Completed for ${session.mobileNumber} — ${session.name} Unit ${session.unit}`);

  // Wait a moment for user to see the message
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Save contact to bot's address book by sending vCard to ourselves
  try {
    const botJid = sock.user?.id || '';
    if (botJid) {
      const vcard = 
        'BEGIN:VCARD\n' +
        'VERSION:3.0\n' +
        `FN:${session.name} - ${session.unit}\n` +
        `TEL;type=CELL;type=VOICE;waid=${session.mobileNumber}:+${session.mobileNumber}\n` +
        'END:VCARD';
      
      await sock.sendMessage(botJid, {
        contacts: {
          displayName: `${session.name} - ${session.unit}`,
          contacts: [{ vcard }]
        }
      });
      console.log(`[ONBOARDING] ✅ Contact saved to bot: ${session.name} - ${session.unit}`);
    }
  } catch (error) {
    console.error("[ONBOARDING] Failed to save contact:", error);
  }

  // Wait a moment before deleting
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Delete conversation from bot's side for privacy
  try {
    await sock.chatModify(
      { delete: true, lastMessages: [] },
      senderJid
    );
    console.log(`[ONBOARDING] ✅ Conversation deleted from bot side: ${session.mobileNumber}`);
  } catch (error) {
    console.error("[ONBOARDING] Failed to delete conversation:", error);
  }

  // Clean up session from memory
  sessions.delete(senderJid);
}
