import type { WASocket } from "@whiskeysockets/baileys";
import { google } from "googleapis";
import { config } from "./config";

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
  unitValidationAttempts?: number;
}

// ── No longer needed - unit validation removed ────────────────────────────────

// let validUnitsCache: Set<string> | null = null;
//
// async function loadValidUnits(): Promise<Set<string>> { ... }
// function isValidUnit(unit: string): boolean { ... }

// ── In-memory session store ──────────────────────────────────────────────────

const sessions = new Map<string, OnboardingSession>();

// ── Privacy Notice ───────────────────────────────────────────────────────────

const PRIVACY_NOTICE = `*LAGUNA PARK OFFICIAL WHATSAPP COMMUNITY*
*Privacy & Consent Notice — v1.0*

This Community is operated by MCST Plan No. 3271 – Laguna Park.

To register you, we may collect your WhatsApp number, name, unit number, status (SP / resident / tenant), optional email and verification records.

Your information will be used to verify and administer your membership and for official estate communications, announcements, events, polls, surveys and resident engagement. Your details may be checked against the strata roll, MCST and/or Management Office records.

Verification may take place after you join. Access may be removed if eligibility cannot be confirmed.

The Community includes a General Chat. If you participate, your WhatsApp number and profile information may be visible to other members.

Participation is voluntary. You may leave or withdraw consent for WhatsApp communications at any time.

Privacy enquiries:
Secretary, MCST 3271
mcst3271.council@gmail.com

By replying *I AGREE*, you consent to MCST 3271 collecting, using and disclosing your personal data for the purposes above.

Reply *I AGREE* to continue.`;


// ── Admin notification ───────────────────────────────────────────────────────

async function notifyAdminInvalidUnit(
  sock: WASocket,
  resident: {
    mobileNumber: string;
    name: string;
    unitAttempt: string;
  }
): Promise<void> {
  try {
    const adminJid = `${config.whatsapp.adminNumber}@s.whatsapp.net`;
    const message =
      `⚠️ *ONBOARDING ALERT*\n\n` +
      `Resident entered invalid unit number:\n\n` +
      `*Mobile:* ${resident.mobileNumber}\n` +
      `*Name:* ${resident.name}\n` +
      `*Unit Entered:* ${resident.unitAttempt}\n\n` +
      `Please verify and follow up if needed.`;

    await sock.sendMessage(adminJid, { text: message });
    console.log(
      `[ONBOARDING] Admin notified about invalid unit from ${resident.mobileNumber}`
    );
  } catch (error) {
    console.error("[ONBOARDING] Failed to notify admin:", error);
  }
}

async function appendToSheet(session: OnboardingSession): Promise<void> {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.google.serviceAccountKeyFile,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    // Format timestamp: DD/MM/YYYY HH:MM:SS
    const formatTimestamp = (isoString: string): string => {
      const date = new Date(isoString);
      const day = String(date.getDate()).padStart(2, "0");
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const year = date.getFullYear();
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      const seconds = String(date.getSeconds()).padStart(2, "0");
      return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
    };

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

// ── Invite link ──────────────────────────────────────────────────────────────

async function getAndRevokeInviteLink(
  sock: WASocket,
  groupJid: string
): Promise<string> {
  const code = await sock.groupInviteCode(groupJid);
  const link = `https://chat.whatsapp.com/${code}`;
  // Revoke immediately so the link is single-use in effect
  await sock.groupRevokeInvite(groupJid);
  return link;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleOnboardingMessage(
  sock: WASocket,
  senderJid: string,
  text: string
): Promise<void> {
  // Extract phone number from JID (remove @s.whatsapp.net or @lid suffix)
  // Format: 6591234567@s.whatsapp.net or 6591234567@lid → 6591234567
  let mobile = senderJid.replace("@s.whatsapp.net", "").replace("@lid", "");
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
    // Unknown message, not in onboarding yet — ignore
    return;
  }

  // ── Step 2: Waiting for "I AGREE" ─────────────────────────────────────────
  if (session.step === "awaiting_agree") {
    if (normalised === "i agree" || /^i\s+agree\s*$/.test(normalised)) {
      session.step = "awaiting_form";
      session.consentTimestamp = new Date().toISOString();
      await sock.sendMessage(senderJid, {
        text: `✅ *Thank you. Your consent has been recorded.*\n\nTo complete your registration, please copy and fill in this form:\n\n*Name:* \n*Unit Number:* \n*Status:* \n*Email:* \n\nThen send it back to us.\n\nStatus options: SP, Resident, or Tenant\nEmail is optional`,
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
    // Parse form: extract Name, Unit Number, Status, Email
    const lines = text.split('\n').map(line => line.trim().replace(/^\*|\*$/g, '').trim()).filter(l => l);
    
    console.log(`[ONBOARDING] Form parsing - raw lines: ${JSON.stringify(lines)}`);
    
    let name = "", unit = "", status = "", email = "";
    
    for (const line of lines) {
      const lowerLine = line.toLowerCase();
      console.log(`[ONBOARDING] Processing line: "${line}" (lower: "${lowerLine}")`);
      
      if (lowerLine.startsWith("name:")) {
        name = line.substring(line.indexOf(":") + 1).trim().replace(/^\*|\*$/g, '').trim();
        console.log(`[ONBOARDING] Extracted name: "${name}"`);
      } else if (lowerLine.startsWith("unit number:") || lowerLine.startsWith("unit:")) {
        unit = line.substring(line.indexOf(":") + 1).trim().replace(/^\*|\*$/g, '').trim().toUpperCase();
        console.log(`[ONBOARDING] Extracted unit: "${unit}"`);
      } else if (lowerLine.startsWith("status:")) {
        status = line.substring(line.indexOf(":") + 1).trim().replace(/^\*|\*$/g, '').trim().replace(/\s+/g, '').toUpperCase();
        console.log(`[ONBOARDING] Extracted status: "${status}"`);
      } else if (lowerLine.startsWith("email:")) {
        email = line.substring(line.indexOf(":") + 1).trim().replace(/^\*|\*$/g, '').trim();
        console.log(`[ONBOARDING] Extracted email: "${email}"`);
      }
    }

    console.log(`[ONBOARDING] Final parsed: name="${name}", unit="${unit}", status="${status}", email="${email}"`);

    // Validate required fields
    if (!name || name.length < 2) {
      await sock.sendMessage(senderJid, {
        text: "❌ Name is required and must be at least 2 characters. Please fill the form again.",
      });
      return;
    }

    if (!unit || unit.length < 2) {
      await sock.sendMessage(senderJid, {
        text: "❌ Unit Number is required. Please fill the form again.",
      });
      return;
    }

    if (!status || !["SP", "RESIDENT", "TENANT"].includes(status)) {
      console.log(`[ONBOARDING] Invalid status "${status}", allowed: ["SP", "RESIDENT", "TENANT"]`);
      await sock.sendMessage(senderJid, {
        text: "❌ Status must be one of: SP, Resident, or Tenant. Please fill the form again.",
      });
      return;
    }

    // No strict unit validation — just accept any format (19-08, C19-08, etc)
    // Admin will verify manually after registration

    // Save data
    session.name = name;
    session.unit = unit;
    session.status = status;
    session.email = email || "";
    session.step = "complete";

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

  // Get invite link
  let inviteLink = "";
  try {
    inviteLink = await getAndRevokeInviteLink(sock, config.whatsapp.groupId);
  } catch (err) {
    console.error("[ONBOARDING] Failed to get invite link:", err);
  }

  // Send confirmation + invite
  await sock.sendMessage(senderJid, {
    text:
      `✅ *Registration complete!*\n\n` +
      `*Name:* ${session.name}\n` +
      `*Unit:* ${session.unit}\n` +
      `*Status:* ${session.status}\n` +
      (session.email ? `*Email:* ${session.email}\n` : "") +
      `\nWelcome to Laguna Park! Please use the link below to join the community:\n\n` +
      (inviteLink || "Please contact the admin for the invite link."),
  });

  console.log(`[ONBOARDING] ✅ Completed for ${session.mobileNumber} — ${session.name} Unit ${session.unit}`);

  // Clean up session
  sessions.delete(senderJid);
}
