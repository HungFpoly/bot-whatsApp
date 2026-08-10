import type { WASocket } from "@whiskeysockets/baileys";
import { google } from "googleapis";
import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";
import { config } from "./config";

// ── Types ────────────────────────────────────────────────────────────────────

type OnboardingStep =
  | "awaiting_join"
  | "awaiting_agree"
  | "awaiting_name"
  | "awaiting_unit"
  | "awaiting_status"
  | "awaiting_email"
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

// ── Unit validation cache ────────────────────────────────────────────────────

let validUnitsCache: Set<string> | null = null;

async function loadValidUnits(): Promise<Set<string>> {
  if (validUnitsCache) return validUnitsCache;

  try {
    const excelPath = path.resolve("Laguna Park Unit Numbers.xlsx");
    
    if (!fs.existsSync(excelPath)) {
      console.error("[ONBOARDING] Excel file not found:", excelPath);
      return new Set();
    }

    const workbook = XLSX.readFile(excelPath);
    const firstSheet = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheet];
    
    // Get all values from the sheet as array of arrays
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
    }) as unknown[][];

    const units = new Set<string>();

    // Extract unit numbers from all cells
    rows.forEach((row) => {
      if (Array.isArray(row)) {
        row.forEach((cell) => {
          if (cell !== null && cell !== undefined && cell !== "") {
            const unitNumber = String(cell).trim().toUpperCase();
            if (unitNumber && unitNumber !== "UNIT") {
              units.add(unitNumber);
            }
          }
        });
      }
    });

    validUnitsCache = units;
    console.log(`[ONBOARDING] Loaded ${units.size} valid units from Excel`);
    return units;
  } catch (error) {
    console.error("[ONBOARDING] Error loading units from Excel:", error);
    return new Set();
  }
}

function isValidUnit(unit: string): boolean {
  if (!validUnitsCache) return false;
  return validUnitsCache.has(unit.toUpperCase());
}

// ── In-memory session store ──────────────────────────────────────────────────

const sessions = new Map<string, OnboardingSession>();

// ── Privacy Notice ───────────────────────────────────────────────────────────

const PRIVACY_NOTICE = `*LAGUNA PARK OFFICIAL WHATSAPP COMMUNITY*
*Privacy & Consent Notice — Version 1.0*

Welcome to the official WhatsApp Community operated by The Management Corporation Strata Title Plan No. 3271 (MCST 3271) – Laguna Park.

Before proceeding, please read this Privacy & Consent Notice.

*Information we collect*

For registration and administration of the Community, MCST 3271 may collect and use:
• your WhatsApp mobile number;
• your name;
• your unit number;
• your declared status as a Subsidiary Proprietor (SP), resident or tenant;
• your email address, if voluntarily provided; and
• your registration, consent and verification records.

*How your information will be used*

Your information may be used to:
• register and administer your membership of the Laguna Park Official WhatsApp Community;
• verify, where reasonably practicable, your association with Laguna Park;
• provide official estate announcements, notices and updates;
• communicate information relating to estate matters, activities and events;
• conduct polls, surveys and resident engagement exercises;
• facilitate estate-related feedback and communications; and
• support the proper administration and moderation of the Community.

Verification may take place *after you are admitted to the Community*. If your eligibility cannot subsequently be verified, MCST 3271 may contact you for clarification and may restrict or remove your access.

*General Chat*

If you join or participate in the General Chat, your WhatsApp mobile number, profile name, profile photograph and other information made available through WhatsApp may be visible to other participants.

Please do not share another person's personal information without appropriate authority or consent.

*Voluntary participation*

Participation is voluntary. You may leave the Community at any time or request MCST 3271 to stop using your personal data for WhatsApp Community communications.

For privacy enquiries, contact:
Secretary, MCST Plan No. 3271 – Laguna Park
mcst3271.council@gmail.com

────────────────────────
*CONSENT*

By replying *I AGREE* you confirm that:
1. you have read and understood this Privacy & Consent Notice;
2. the information you provide is accurate to the best of your knowledge;
3. you voluntarily wish to participate in the Community; and
4. you consent to MCST 3271 collecting, using and disclosing your personal data for the purposes stated above.

Please reply *I AGREE* to continue.
If you do not agree, please do not proceed.`;

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

    const row = [
      session.mobileNumber,
      session.name || "",
      session.unit || "",
      session.status || "",
      session.email || "",
      session.consentTimestamp || "",
      "Privacy Notice v1.0",
      "I AGREE",
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: config.google.sheetId,
      range: "Sheet1!A:H",
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
  const mobile = senderJid.replace("@s.whatsapp.net", "");
  const normalised = text.trim().toLowerCase();

  // Load valid units on first use
  if (!validUnitsCache) {
    await loadValidUnits();
  }

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
    if (normalised === "i agree") {
      session.step = "awaiting_name";
      session.consentTimestamp = new Date().toISOString();
      await sock.sendMessage(senderJid, {
        text: "Thank you for agreeing. ✅\n\nPlease enter your *Full Name*:",
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

  // ── Step 3: Full Name ──────────────────────────────────────────────────────
  if (session.step === "awaiting_name") {
    session.name = text.trim();
    session.step = "awaiting_unit";
    await sock.sendMessage(senderJid, {
      text: "Please enter your *Unit Number* (e.g. D01-01):",
    });
    return;
  }

  // ── Step 4: Unit Number with validation ────────────────────────────────────
  if (session.step === "awaiting_unit") {
    const unitInput = text.trim().toUpperCase();
    session.unitValidationAttempts = (session.unitValidationAttempts || 0) + 1;

    if (isValidUnit(unitInput)) {
      // Valid unit — proceed
      session.unit = unitInput;
      session.step = "awaiting_status";
      await sock.sendMessage(senderJid, {
        text: "Please select your status:\n\n1. *SP* (Subsidiary Proprietor)\n2. *Resident*\n3. *Tenant*\n\nReply with SP, Resident, or Tenant:",
      });
      return;
    }

    // Invalid unit
    if (session.unitValidationAttempts === 1) {
      // First attempt — ask again
      await sock.sendMessage(senderJid, {
        text: `Unit *${unitInput}* is not found in our system. Please check and try again, or contact the admin if you believe this is an error.`,
      });
      return;
    }

    // Second attempt — accept but notify admin
    session.unit = unitInput;
    session.step = "awaiting_status";

    // Notify admin about the invalid unit
    await notifyAdminInvalidUnit(sock, {
      mobileNumber: mobile,
      name: session.name || "Unknown",
      unitAttempt: unitInput,
    });

    await sock.sendMessage(senderJid, {
      text: "Thank you. We've recorded your unit number. Please note that our records may take time to update.\n\nPlease select your status:\n\n1. *SP* (Subsidiary Proprietor)\n2. *Resident*\n3. *Tenant*\n\nReply with SP, Resident, or Tenant:",
    });
    return;
  }

  // ── Step 5: Status ─────────────────────────────────────────────────────────
  if (session.step === "awaiting_status") {
    const status = text.trim().toUpperCase();
    if (!["SP", "RESIDENT", "TENANT"].includes(status)) {
      await sock.sendMessage(senderJid, {
        text: "Please reply with *SP*, *Resident*, or *Tenant*:",
      });
      return;
    }
    session.status = status;

    if (status === "SP") {
      session.step = "awaiting_email";
      await sock.sendMessage(senderJid, {
        text: "Please enter your *Email Address* (optional — reply *skip* to skip):",
      });
    } else {
      session.step = "complete";
      await completeOnboarding(sock, senderJid, session);
    }
    return;
  }

  // ── Step 6: Email (SP only, optional) ─────────────────────────────────────
  if (session.step === "awaiting_email") {
    session.email = normalised === "skip" ? "" : text.trim();
    session.step = "complete";
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
