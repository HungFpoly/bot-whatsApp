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
- No vulgar language, profanity, or slurs
- No personal attacks or insults directed at individuals
- No talking bad about other residents or management
- No harassment, bullying, or threatening language
- No hate speech or discrimination

Respond ONLY in JSON format:
{
  "isToxic": true/false,
  "reason": "brief explanation",
  "confidence": 0.0 to 1.0
}

Be strict but fair. Normal complaints about facilities or services are OK. 
Only flag messages that are clearly toxic, rude, or attacking people personally.`,
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
