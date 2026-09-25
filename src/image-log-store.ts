import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer, type Server } from "node:http";
import sharp from "sharp";
import { config } from "./config";

function publicBase(): string {
  const url = new URL(config.imageLog.publicUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
    throw new Error("IMAGE_LOG_PUBLIC_URL must be an HTTP(S) origin, e.g. http://IP:8080");
  }
  return url.origin;
}

export async function saveLogImage(buffer: Buffer): Promise<string> {
  const base = publicBase();
  const image = await sharp(buffer, { limitInputPixels: 40_000_000 })
    .rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).jpeg({ quality: 80 }).toBuffer();
  const directory = resolve(config.imageLog.directory);
  await mkdir(directory, { recursive: true });
  const filename = `${randomBytes(24).toString("hex")}.jpg`;
  await writeFile(join(directory, filename), image, { flag: "wx", mode: 0o600 });
  return `${base}/images/${filename}`;
}

export async function startImageLogServer(): Promise<Server | undefined> {
  if (!config.imageLog.publicUrl) return;
  publicBase();
  if (!Number.isInteger(config.imageLog.port) || config.imageLog.port < 1 || config.imageLog.port > 65535) {
    throw new Error("Invalid IMAGE_LOG_PORT");
  }
  const directory = resolve(config.imageLog.directory);
  await mkdir(directory, { recursive: true });
  const server = createServer(async (request, response) => {
    // Match raw paths strictly: no directory listing, traversal, or other bot files.
    const match = request.url?.match(/^\/images\/([a-f0-9]{48}\.jpg)$/);
    if (!match) { response.writeHead(404).end(); return; }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end(); return;
    }
    try {
      const image = await readFile(join(directory, match[1]));
      response.writeHead(200, {
        "Content-Type": "image/jpeg", "Content-Length": image.length,
        "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : image);
    } catch (error) {
      response.writeHead((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500).end();
    }
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(config.imageLog.port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      server.on("error", error => console.error("[IMAGE] HTTP server error:", error));
      accept();
    });
  });
  console.log(`[IMAGE] Serving deletion images on port ${config.imageLog.port}`);
  return server;
}
