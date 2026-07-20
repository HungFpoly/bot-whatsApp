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
  },
  bot: {
    minMessageLength: parseInt(process.env.MIN_MESSAGE_LENGTH || "5", 10),
    violationAction: process.env.VIOLATION_ACTION || "delete",
    warningMessage:
      process.env.WARNING_MESSAGE ||
      "Your message was removed for violating group rules.",
  },
  port: parseInt(process.env.PORT || "3000", 10),
};
