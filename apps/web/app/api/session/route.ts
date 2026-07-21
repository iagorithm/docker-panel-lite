import { NextRequest, NextResponse } from "next/server";

import { adminAuth } from "@/lib/firebase-admin";
import { SESSION_COOKIE } from "@/lib/session";

const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000;

function requestUsesHttps(request: NextRequest) {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return forwardedProto ? forwardedProto === "https" : request.nextUrl.protocol === "https:";
}

export async function POST(request: NextRequest) {
  const { idToken } = (await request.json()) as { idToken?: string };
  if (!idToken) return NextResponse.json({ error: "Missing ID token" }, { status: 400 });
  try {
    await adminAuth.verifyIdToken(idToken, true);
    const sessionCookie = await adminAuth.createSessionCookie(idToken, { expiresIn: SESSION_TTL_MS });
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, sessionCookie, {
      httpOnly: true,
      secure: requestUsesHttps(request),
      sameSite: "lax",
      maxAge: SESSION_TTL_MS / 1000,
      path: "/",
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Invalid authentication token" }, { status: 401 });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { expires: new Date(0), path: "/" });
  return response;
}
