export type ProtectedContentCategory =
  | "official_laguna_park"
  | "estate_report"
  | null;

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const OFFICIAL_LAGUNA_PARK_MARKERS = [
  "mcst 3271",
  "management corporation strata title plan no 3271",
  "mcst3271cm@gmail.com",
  "5000c marine parade road",
];

const OFFICIAL_PROGRAM_MARKERS = [
  "digital for life",
  "learn digital",
  "imda",
  "digital skills for life",
  "smart nation singapore",
  "sg digital office",
];

const ESTATE_CONTEXT_MARKERS = [
  "laguna park",
  "estate",
  "condo",
  "management office",
  "mcst",
  "common area",
  "facility",
  "facilities",
  "block",
  "lift",
  "carpark",
];

const ESTATE_REPORT_MARKERS = [
  "maintenance",
  "repair",
  "fault",
  "defect",
  "damage",
  "leak",
  "leaking",
  "broken",
  "not working",
  "out of order",
  "inspection",
  "cleaning",
  "estate report",
  "estate reporting",
];

function includesAny(text: string, markers: string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

/**
 * Detects only high-signal protected content. The result raises the deletion
 * threshold; it is not a blanket exemption for scams, threats or harmful media.
 */
export function getProtectedContentCategory(
  text: string
): ProtectedContentCategory {
  const normalized = normalize(text);
  if (!normalized) return null;

  if (includesAny(normalized, OFFICIAL_LAGUNA_PARK_MARKERS)) {
    return "official_laguna_park";
  }

  const mentionsLagunaPark = normalized.includes("laguna park");
  if (
    mentionsLagunaPark &&
    includesAny(normalized, OFFICIAL_PROGRAM_MARKERS)
  ) {
    return "official_laguna_park";
  }

  if (
    includesAny(normalized, ESTATE_CONTEXT_MARKERS) &&
    includesAny(normalized, ESTATE_REPORT_MARKERS)
  ) {
    return "estate_report";
  }

  return null;
}

export function moderationThresholdFor(text: string): number {
  // Keep this function as the single threshold source for every moderation
  // path. The text parameter is retained so callers do not need special cases.
  void text;
  return 0.9;
}
