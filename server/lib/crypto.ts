import crypto from "crypto";
import { env } from "../env";

function keyBytes(): Buffer {
	// Prefer base64 (recommended), but accept raw utf-8 for local dev.
	const asBase64 = Buffer.from(env.TOKEN_ENC_KEY, "base64");
	if (asBase64.length === 32) return asBase64;

	const asUtf8 = Buffer.from(env.TOKEN_ENC_KEY, "utf8");
	if (asUtf8.length === 32) return asUtf8;

	throw new Error(
		"TOKEN_ENC_KEY must be 32 bytes (base64 or raw utf-8) for AES-256-GCM",
	);
}

const ALGO = "aes-256-gcm";

export function encryptString(plain: string): string {
	const key = keyBytes();
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv(ALGO, key, iv);
	const encrypted = Buffer.concat([
		cipher.update(Buffer.from(plain, "utf8")),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	// Format: base64(iv).base64(tag).base64(ciphertext)
	return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptString(enc: string): string {
	const [ivB64, tagB64, dataB64] = enc.split(".");
	if (!ivB64 || !tagB64 || !dataB64) {
		throw new Error("Invalid encrypted payload format");
	}

	const key = keyBytes();
	const iv = Buffer.from(ivB64, "base64");
	const tag = Buffer.from(tagB64, "base64");
	const data = Buffer.from(dataB64, "base64");

	const decipher = crypto.createDecipheriv(ALGO, key, iv);
	decipher.setAuthTag(tag);
	const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
	return decrypted.toString("utf8");
}
