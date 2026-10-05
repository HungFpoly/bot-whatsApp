import type { WAMessage } from "@whiskeysockets/baileys";

export interface SpamResult {
  messagesToDelete: WAMessage[];
  shouldWarn: boolean;
}

interface RecentMessage {
  text: string;
  timestamp: number;
  message: WAMessage;
  deleted: boolean;
}

export class SpamDetector {
  private readonly recentBySender = new Map<string, RecentMessage[]>();
  private readonly warnedSenders = new Set<string>();

  constructor(
    private readonly windowMs = 15_000,
    private readonly duplicateThreshold = 2,
    private readonly floodThreshold = 5,
    private readonly now: () => number = Date.now
  ) {}

  check(
    groupJid: string,
    senderId: string,
    text: string,
    message: WAMessage
  ): SpamResult {
    const now = this.now();
    const normalized = normalize(text);
    const senderKey = `${groupJid}:${senderId}`;
    const recent = (this.recentBySender.get(senderKey) || []).filter(
      (entry) => now - entry.timestamp < this.windowMs
    );

    recent.push({ text: normalized, timestamp: now, message, deleted: false });
    this.recentBySender.set(senderKey, recent);

    const duplicates = recent.filter((entry) =>
      areSubstantiallySimilar(entry.text, normalized)
    );
    const isDuplicate = duplicates.length >= this.duplicateThreshold;
    const isFlood = recent.length > this.floodThreshold;
    if (!isDuplicate && !isFlood) {
      return { messagesToDelete: [], shouldWarn: false };
    }

    const candidates = isFlood
      ? recent.slice(this.floodThreshold)
      : duplicates.slice(1);
    const messagesToDelete: WAMessage[] = [];
    for (const candidate of candidates) {
      if (!candidate.deleted) {
        candidate.deleted = true;
        messagesToDelete.push(candidate.message);
      }
    }

    const shouldWarn =
      messagesToDelete.length > 0 && !this.warnedSenders.has(senderKey);
    if (shouldWarn) this.warnedSenders.add(senderKey);
    return { messagesToDelete, shouldWarn };
  }
}

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function areSubstantiallySimilar(first: string, second: string): boolean {
  if (first === second) return true;
  if (first.length < 12 || second.length < 12) return false;

  const firstBigrams = getBigrams(first);
  const secondBigrams = getBigrams(second);
  if (!firstBigrams.size || !secondBigrams.size) return false;

  let overlap = 0;
  for (const bigram of firstBigrams) {
    if (secondBigrams.has(bigram)) overlap++;
  }
  return (2 * overlap) / (firstBigrams.size + secondBigrams.size) >= 0.9;
}

function getBigrams(text: string): Set<string> {
  const compact = text.replace(/\s+/g, " ");
  const result = new Set<string>();
  for (let index = 0; index < compact.length - 1; index++) {
    result.add(compact.slice(index, index + 2));
  }
  return result;
}
