import type { WAMessage } from "@whiskeysockets/baileys";

export function getMessageText(msg: WAMessage): string {
  const message = msg.message;
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  );
}

export function simplifyTrustedGoogleUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/gi, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      const hostname = url.hostname.toLowerCase();
      if (hostname === "share.google") return "[Google shared link]";

      const isGoogleSearch =
        (hostname === "google.com" || hostname === "www.google.com") &&
        url.pathname === "/search";
      if (!isGoogleSearch) return rawUrl;

      const query = url.searchParams.get("q")?.trim();
      return query
        ? `[Google Search query: ${query}]`
        : "[Google Search link]";
    } catch {
      return rawUrl;
    }
  });
}
