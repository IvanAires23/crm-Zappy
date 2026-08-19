import crypto from "node:crypto";
import { env } from "./env.js";

// TOKEN_ENCRYPTION_KEY deve ser uma chave de 32 bytes em base64.
// Gerar com: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
const KEY = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64");
const ALGO = "aes-256-gcm";

export function encryptToken(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // formato: iv.authTag.encrypted (tudo em base64, separado por ".")
  return [iv, authTag, encrypted].map((b) => b.toString("base64")).join(".");
}

export function decryptToken(stored: string): string {
  const [ivB64, authTagB64, encryptedB64] = stored.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const encrypted = Buffer.from(encryptedB64, "base64");

  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}
