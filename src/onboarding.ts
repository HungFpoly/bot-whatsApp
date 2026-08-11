import type { WASocket } from "@whiskeysockets/baileys";
import { google } from "googleapis";
import { config } from "./config";
import * as XLSX from "xlsx";
import * as path from "path";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
  baseURL: config.openai.baseUrl,
});

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
  inviteLinkTimestamp?: string; // Timestamp when invite link was generated (expires after 2 days)
}

// ── Load valid units from Excel ───────────────────────────────────────────────

let validUnitsCache: string[] | null = null;

async function loadValidUnits(): Promise<string[]> {
  if (validUnitsCache) return validUnitsCache;

  try {
    const filePath = path.join(__dirname, "../Laguna Park Unit Numbers.xlsx");
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<{ Unit?: string }>(worksheet);

    validUnitsCache = data
      .map((row) => row.Unit || "")
      .filter((unit) => unit.trim().length > 0)
      .map((unit) => unit.trim().toUpperCase());

    console.log(`[ONBOARDING] Loaded ${validUnitsCache.length} valid units from Excel`);
    return validUnitsCache;
  } catch (error) {
    console.error("[ONBOARDING] Failed to load valid units from Excel:", error);
    return [];
  }
}

// ── AI Unit Validation ────────────────────────────────────────────────────────

interface UnitValidationResult {
  isValid: boolean;
  matchedUnit: string;
  confidence: number; // 0.0 to 1.0
  reason: string;
}

async function validateUnitWithAI(
  userInput: string,
  validUnits: string[]
): Promise<UnitValidationResult> {
  try {
    const prompt = `You are a unit number validation system for Laguna Park condominium.

Valid units list (${validUnits.length} units):
${validUnits.slice(0, 100).join(", ")}${validUnits.length > 100 ? "..." : ""}

User submitted: "${userInput}"

Task: Find the best matching unit from the valid units list.

Rules:
- Users may type units in different formats: "19-08", "C19-08", "1908", "C1908", "19 08", etc.
- Building prefix (A, B, C, D) might be included or omitted
- Hyphens and spaces might be present or missing
- Compare the user input with ALL valid units and find the closest match
- Calculate confidence score (0.0 to 1.0) based on similarity

Respond ONLY in JSON format:
{
  "isValid": true/false,
  "matchedUnit": "exact unit from valid list or empty",
  "confidence": 0.0 to 1.0,
  "reason": "brief explanation"
}

Examples:
- User: "1908" → might match "C19-08" or "B19-08" (check which exists)
- User: "C19-08" → exact match if exists
- User: "Z99-99" → no match (building Z doesn't exist)`;

    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 150,
    });

    const content = response.choices[0]?.message?.content || "";
    const cleaned = content.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
    const result = JSON.parse(cleaned) as UnitValidationResult;

    return {
      isValid: result.isValid || false,
      matchedUnit: result.matchedUnit || "",
      confidence: result.confidence || 0,
      reason: result.reason || "Unknown",
    };
  } catch (error) {
    console.error("[ONBOARDING] AI unit validation failed:", error);
    return {
      isValid: false,
      matchedUnit: "",
      confidence: 0,
      reason: "Error during validation",
    };
  }
}

// ── No longer needed - unit validation removed ────────────────────────────────

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

Scan the QR code and send *JOIN* to register for the Laguna Park WhatsApp Community.`;

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
      `⚠️ *ONBOARDING ALERT - Low Confidence Unit*\n\n` +
      `AI validation confidence < 80%\n\n` +
      `*Mobile:* ${resident.mobileNumber}\n` +
      `*Name:* ${resident.name}\n` +
      `*Unit Entered:* ${resident.unitAttempt}\n\n` +
      `Please verify this unit number manually.`;

    await sock.sendMessage(adminJid, { text: message });
    console.log(
      `[ONBOARDING] Admin notified about low-confidence unit from ${resident.mobileNumber}`
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
    // First message from user → send welcome message
    if (!session) {
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
        text: `✅ *Consent recorded.*\n\nPlease reply with:\n\nName:\nUnit:\nResident Type: SP / Resident / Tenant\nEmail: Optional`,
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
    // Use AI to parse free-form text
    let name = "", unit = "", status = "", email = "";
    
    try {
      const parsePrompt = `You are a form parser for Laguna Park condominium registration.

User submitted this text:
"""
${text}
"""

Extract the following information:
- Name: Full name (usually 2-4 words)
- Unit: Unit number (format like "06-06", "C19-08", "1908", etc.)
- Resident Type: One of "SP", "Resident", or "Tenant" (look for keywords like sp, resident, tenant, owner)
- Email: Optional email address

Rules:
- If user submits in format "Name: xxx", extract the value after colon
- If user submits free-form (3 lines without labels), assume: Line 1 = Name, Line 2 = Unit, Line 3 = Resident Type
- Names in Asian countries can be 2-4 words
- Resident Type: normalize to "SP", "RESIDENT", or "TENANT" (case insensitive match)
- Email is optional

Respond ONLY in JSON:
{
  "name": "extracted name or empty",
  "unit": "extracted unit or empty",
  "status": "SP/RESIDENT/TENANT or empty",
  "email": "extracted email or empty"
}`;

      const parseResponse = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [{ role: "user", content: parsePrompt }],
        temperature: 0.1,
        max_tokens: 200,
      });

      const parseContent = parseResponse.choices[0]?.message?.content || "";
      const parseCleaned = parseContent.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(parseCleaned) as {
        name: string;
        unit: string;
        status: string;
        email: string;
      };

      name = parsed.name || "";
      unit = (parsed.unit || "").toUpperCase();
      status = (parsed.status || "").toUpperCase();
      email = parsed.email || "";

      console.log(`[ONBOARDING] AI parsed: name="${name}", unit="${unit}", status="${status}", email="${email}"`);
    } catch (parseError) {
      console.error("[ONBOARDING] AI parsing failed, falling back to manual parse:", parseError);
      
      // Fallback: manual parsing
      const lines = text.split('\n').map(line => line.trim().replace(/^\*|\*$/g, '').trim()).filter(l => l);
      
      for (const line of lines) {
        const lowerLine = line.toLowerCase();
        
        if (lowerLine.startsWith("name:")) {
          name = line.substring(line.indexOf(":") + 1).trim().replace(/^\*|\*$/g, '').trim();
        } else if (lowerLine.startsWith("unit number:") || lowerLine.startsWith("unit:")) {
          unit = line.substring(line.indexOf(":") + 1).trim().replace(/^\*|\*$/g, '').trim().toUpperCase();
        } else if (lowerLine.startsWith("resident type:") || lowerLine.startsWith("status:")) {
          status = line.substring(line.indexOf(":") + 1).trim().replace(/^\*|\*$/g, '').trim().replace(/\s+/g, '').toUpperCase();
        } else if (lowerLine.startsWith("email:")) {
          email = line.substring(line.indexOf(":") + 1).trim().replace(/^\*|\*$/g, '').trim();
        }
      }
    }

    // Validate required fields
    if (!name || name.length < 2) {
      await sock.sendMessage(senderJid, {
        text: "❌ Please enter your full name, then submit the form again.",
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
      await sock.sendMessage(senderJid, {
        text: "❌ Resident Type must be one of: SP, Resident, or Tenant. Please fill the form again.",
      });
      return;
    }

    // AI Unit Validation
    const validUnits = await loadValidUnits();
    const validation = await validateUnitWithAI(unit, validUnits);

    console.log(
      `[ONBOARDING] Unit validation for "${unit}": confidence=${validation.confidence}, matched="${validation.matchedUnit}"`
    );

    // Decision logic
    if (validation.confidence >= 0.8) {
      // ✅ High confidence (≥80%) → Auto-approve
      console.log(`[ONBOARDING] ✅ Unit "${unit}" validated (confidence: ${validation.confidence})`);
      unit = validation.matchedUnit; // Use normalized unit from AI
    } else if (validation.confidence < 0.8) {
      // ⚠️ Low confidence (<80%) → Notify admin but still proceed
      console.log(
        `[ONBOARDING] ⚠️ Low confidence unit "${unit}" (confidence: ${validation.confidence}). Notifying admin.`
      );
      await notifyAdminInvalidUnit(sock, {
        mobileNumber: mobile,
        name: name,
        unitAttempt: unit,
      });
      // Continue with user's input (admin will verify manually later)
    }

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

  // Get invite link (expires after 2 days)
  let inviteLink = "";
  let expiresAt = "";
  try {
    const result = await getAndRevokeInviteLink(sock, config.whatsapp.groupId);
    inviteLink = result.link;
    expiresAt = result.expiresAt;
    session.inviteLinkTimestamp = expiresAt;
  } catch (err) {
    console.error("[ONBOARDING] Failed to get invite link:", err);
  }

  // Send confirmation + invite
  const confirmationMessage = await sock.sendMessage(senderJid, {
    text:
      `✅ *Registration received*\n\n` +
      `${session.name} | ${session.unit} | ${session.status}${session.email ? ` | ${session.email}` : ""}\n\n` +
      `Welcome to the Laguna Park Official WhatsApp Community.\n\n` +
      `👇 *TAP BELOW TO JOIN THE COMMUNITY*\n` +
      (inviteLink || "Please contact the admin for the invite link.") +
      `\n\nMembership is subject to subsequent verification.`,
  });

  console.log(`[ONBOARDING] ✅ Completed for ${session.mobileNumber} — ${session.name} Unit ${session.unit}`);
  if (expiresAt) {
    console.log(`[ONBOARDING] Link expires at: ${expiresAt}`);
  }

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

  // Wait a moment before archiving
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Archive conversation from bot's side for privacy
  try {
    await sock.chatModify(
      { archive: true, lastMessages: [] },
      senderJid
    );
    console.log(`[ONBOARDING] ✅ Conversation archived from bot side: ${session.mobileNumber}`);
  } catch (error) {
    console.error("[ONBOARDING] Failed to archive conversation:", error);
  }

  // Clean up session from memory
  sessions.delete(senderJid);
}
