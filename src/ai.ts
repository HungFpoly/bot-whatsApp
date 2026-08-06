import OpenAI from "openai";
import { config } from "./config";

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
  baseURL: config.openai.baseUrl,
});

interface ModerationResult {
  isToxic: boolean;
  reason: string;
  confidence: number;
}

export async function analyzeMessage(
  message: string
): Promise<ModerationResult> {
  try {
    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: "system",
          content: `You are a content moderation bot for a condominium residents' group chat.
Analyze the message and determine if it violates group rules.

Rules:
1. No vulgar language, profanity, or slurs
2. No personal attacks or insults directed at individuals
3. No talking bad about other residents or management
4. No harassment, bullying, or threatening language
5. No hate speech or discrimination
6. No scams, phishing, suspicious links, or requests for OTPs / personal banking info
7. No impersonation of Council, Management (MA), security staff, or official bodies
8. No threats or encouragement of property damage, vandalism, or physical harm
9. No sexual, pornographic, or graphic violent content
10. No commercial advertising, solicitation, or repeated promotional messages

Respond ONLY in JSON format:
{
  "isToxic": true/false,
  "reason": "brief explanation",
  "confidence": 0.0 to 1.0
}

Be strict but fair. Normal complaints about facilities or services are OK.
Only flag messages that clearly violate one of the rules above.`,
        },
        {
          role: "user",
          content: message,
        },
      ],
      temperature: 0.1,
      max_tokens: 100,
    });

    const content = response.choices[0]?.message?.content || "";
    const result = JSON.parse(content) as ModerationResult;

    return {
      isToxic: result.isToxic || false,
      reason: result.reason || "Unknown",
      confidence: result.confidence || 0,
    };
  } catch (error) {
    console.error("[AI] Error analyzing message:", error);
    return {
      isToxic: false,
      reason: "Error during analysis",
      confidence: 0,
    };
  }
}
