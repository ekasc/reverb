import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sessions, users } from "../../db/schema";
import type { Db } from "./db";

function nowMs() {
	return Date.now();
}

export type SessionUser = typeof users.$inferSelect;

export async function requireUser<E extends { Variables: { db: Db } }>(
	c: Context<E>,
) {
	const sid = getCookie(c, "sid");
	if (!sid) return null;

	const db = c.get("db");
	const session = await db.query.sessions.findFirst({
		where: eq(sessions.id, sid),
	});
	if (!session) return null;
	if (session.expiresAt.getTime() < nowMs()) {
		await db.delete(sessions).where(eq(sessions.id, sid));
		return null;
	}

	const user = await db.query.users.findFirst({
		where: eq(users.id, session.userId),
	});
	return user ?? null;
}

export async function createSession<E extends { Variables: { db: Db } }>(params: {
	c: Context<E>;
	userId: string;
}) {
	const sessionId = crypto.randomUUID();
	const db = params.c.get("db");
	await db.insert(sessions).values({
		id: sessionId,
		userId: params.userId,
		createdAt: new Date(nowMs()),
		expiresAt: new Date(nowMs() + 1000 * 60 * 60 * 24 * 30),
	});

	const secure = new URL(params.c.req.url).protocol === "https:";
	setCookie(params.c, "sid", sessionId, {
		httpOnly: true,
		secure,
		sameSite: "Lax",
		path: "/",
		maxAge: 60 * 60 * 24 * 30,
	});
	return sessionId;
}

export async function clearSession<E extends { Variables: { db: Db } }>(
	c: Context<E>,
) {
	const sid = getCookie(c, "sid");
	if (sid) {
		const db = c.get("db");
		await db.delete(sessions).where(eq(sessions.id, sid));
	}
	deleteCookie(c, "sid", { path: "/" });
}
