import dotenv from "dotenv";
dotenv.config();

export const config = {
  openai: {
    apiKey: process.env.AI_API_KEY || "",
    baseUrl: process.env.AI_BASE_URL || "https://api.moonshot.ai/v1",
    model: process.env.AI_MODEL || "moonshot-v1-8k",
  },
  whatsapp: {
    groupId: process.env.WHATSAPP_GROUP_ID || "",
    sessionPath: process.env.WHATSAPP_SESSION_PATH || "./session",
    phoneNumber: process.env.WHATSAPP_PHONE_NUMBER || "",
    adminNumber: process.env.ADMIN_WHATSAPP_NUMBER || "",
  },
  bot: {
    minMessageLength: parseInt(process.env.MIN_MESSAGE_LENGTH || "5", 10),
    violationAction: process.env.VIOLATION_ACTION || "delete",
    warningMessage:
      process.env.WARNING_MESSAGE ||
      "Your message was removed for violating group rules.",
  },
  quietHours: {
    enabled: process.env.QUIET_HOURS_ENABLED !== "false",
    startHour: parseInt(process.env.QUIET_HOURS_START || "23", 10), // 11pm
    endHour: parseInt(process.env.QUIET_HOURS_END || "7", 10),     // 7am
    timezone: process.env.QUIET_HOURS_TIMEZONE || "Asia/Singapore",
    reminderMessage:
      process.env.QUIET_HOURS_MESSAGE ||
      "🌝 Quiet hours are from 11 pm to 7 am. Please be mindful when posting during this time. Thank you for your understanding.",
  },
  google: {
    sheetId: process.env.GOOGLE_SHEET_ID || "",
    serviceAccountKeyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || "./service-account.json",
  },
  port: parseInt(process.env.PORT || "3000", 10),
};
