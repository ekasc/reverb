function concatBytes(a: Uint8Array, b: Uint8Array) {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

function bytesToBase64(bytes: Uint8Array) {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) {
		bin += String.fromCharCode(bytes[i]!);
	}
	return btoa(bin);
}

function base64ToBytes(b64: string) {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

async function importAesKey(rawKey: Uint8Array) {
	const buf: ArrayBuffer =
		rawKey.buffer instanceof ArrayBuffer
			? rawKey.buffer.slice(rawKey.byteOffset, rawKey.byteOffset + rawKey.byteLength)
			: new Uint8Array(rawKey).buffer;
	return crypto.subtle.importKey(
		"raw",
		buf,
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
}

function parseKeyBytes(key: string) {
	// Prefer base64 (recommended), but accept raw utf-8.
	try {
		const asB64 = base64ToBytes(key);
		if (asB64.length === 32) return asB64;
	} catch {
		// ignore
	}

	const asUtf8 = new TextEncoder().encode(key);
	if (asUtf8.length === 32) return asUtf8;
	throw new Error(
		"TOKEN_ENC_KEY must be 32 bytes (base64 or raw utf-8) for AES-256-GCM",
	);
}

export async function encryptString(params: { plain: string; key: string }) {
	const keyBytes = parseKeyBytes(params.key);
	const key = await importAesKey(keyBytes);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plainBytes = new TextEncoder().encode(params.plain);
	const enc = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes as any),
	);
	const tag = enc.slice(enc.length - 16);
	const data = enc.slice(0, enc.length - 16);
	return `${bytesToBase64(iv)}.${bytesToBase64(tag)}.${bytesToBase64(data)}`;
}

export async function decryptString(params: { enc: string; key: string }) {
	const [ivB64, tagB64, dataB64] = params.enc.split(".");
	if (!ivB64 || !tagB64 || !dataB64) throw new Error("Invalid encrypted payload format");

	const keyBytes = parseKeyBytes(params.key);
	const key = await importAesKey(keyBytes);
	const iv = base64ToBytes(ivB64);
	const tag = base64ToBytes(tagB64);
	const data = base64ToBytes(dataB64);
	const joined = concatBytes(data, tag);
	const dec = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		joined as any,
	);
	return new TextDecoder().decode(dec);
}
