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

const IMAGE_MODERATION_PROMPT = `You are a content moderation bot for a condominium residents' group chat.
Analyze this image and determine if it violates group rules.

Rules:
1. No sexual, pornographic, or nudity content
2. No graphic violence or gore
3. No hate symbols, racist or discriminatory imagery
4. No scam/phishing content (fake QR codes, fake payment screens, suspicious links shown in image)
5. No commercial advertising or promotional flyers (property agents, insurance, loans, renovation services)
6. No religious content (church posters, mass invitations, religious ceremonies, bible verses, religious symbols like crosses/crescents)

EXCEPTIONS - These are ALWAYS ALLOWED:
- News screenshots about property, real estate, neighborhood developments
- En bloc (collective sale) news and information - ALWAYS ALLOWED
- Community announcements and facility-related information
- Photos of the building, facilities, common areas, surroundings
- Legitimate news articles from reputable sources (Straits Times, CNA, Business Times, etc.)
- Government/Police/Official announcements and education materials (e.g., SCAM awareness talks, safety campaigns, CPF/HDB notices)
- Event posters from community centers, grassroots organizations (CC, RC, PA, IAEC, police)
- QR codes in official government/community event posters are LEGITIMATE, not scam

IMPORTANT:
- If image shows "SCAM awareness" or "anti-SCAM education" from official sources (Police, government agencies, community centers), it is ALLOWED
- Singapore Police Force, CPF, HDB, PA, grassroots logos/branding = LEGITIMATE, not scam
- Event registration QR codes from community centers/official organizations = ALLOWED

Respond ONLY in JSON format:
{
  "isToxic": true/false,
  "reason": "brief explanation",
  "confidence": 0.0 to 1.0
}

Be strict but fair. Normal photos (food, facilities, documents, selfies, news screenshots, en bloc information) are OK.
Official government/community announcements and education materials are ALWAYS allowed.
Religious content should be flagged with reason "Religious content not allowed in this group".
Only flag images that clearly violate one of the rules above.`;

export async function analyzeImage(
  imageBase64: string,
  mimeType: string = "image/jpeg"
): Promise<ModerationResult> {
  try {
    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`,
                detail: "low", // use "low" to save tokens, sufficient for moderation
              },
            },
            {
              type: "text",
              text: IMAGE_MODERATION_PROMPT,
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 100,
    });

    const content = response.choices[0]?.message?.content || "";
    // Strip markdown code blocks if AI wraps response in ```json ... ```
    const cleaned = content.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
    const result = JSON.parse(cleaned) as ModerationResult;

    return {
      isToxic: result.isToxic || false,
      reason: result.reason || "Unknown",
      confidence: result.confidence || 0,
    };
  } catch (error) {
    console.error("[AI] Error analyzing image:", error);
    return {
      isToxic: false,
      reason: "Error during image analysis",
      confidence: 0,
    };
  }
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
11. No religious content (church/mosque/temple invitations, religious ceremonies, prayers, bible/quran verses, religious links like youtube.be/church videos)

EXCEPTIONS - These are ALWAYS ALLOWED:
- News articles about property, real estate, neighborhood developments (e.g., Straits Times, CNA, Business Times links)
- En bloc (collective sale) news and discussions - ALWAYS ALLOWED, very important for residents
- Community announcements and local area updates
- Sharing information relevant to residents (nearby construction, facilities, etc.)
- Government/Police/Official announcements and education campaigns (SCAM awareness talks, safety campaigns, CPF/HDB notices)
- Event invitations from community centers, grassroots organizations (CC, RC, PA, IAEC, police)
- Messages mentioning "SCAM awareness" or "anti-SCAM education" from official sources are LEGITIMATE community service announcements

IMPORTANT:
- If message talks about SCAM awareness talks/events organized by Police/IAEC/CC/official bodies, it is ALLOWED (community education, not actual scam)
- Singapore Police Force, CPF, HDB, PA, grassroots organizations = LEGITIMATE sources
- Event registration messages with QR codes from official community organizations = ALLOWED

Respond ONLY in JSON format:
{
  "isToxic": true/false,
  "reason": "brief explanation",
  "confidence": 0.0 to 1.0
}

Be strict but fair. Normal complaints about facilities or services are OK.
News articles, en bloc information and community information sharing are OK.
Official government/community announcements and education materials are ALWAYS allowed.
En bloc discussions are ALWAYS allowed as they directly affect residents.
Religious content should be flagged with reason "Religious content not allowed in this group".
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
    // Strip markdown code blocks if AI wraps response in ```json ... ```
    const cleaned = content.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
    const result = JSON.parse(cleaned) as ModerationResult;

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
