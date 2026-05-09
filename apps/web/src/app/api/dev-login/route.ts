import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function isLocalHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0];
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  if (
    process.env.ZANO_DEV_AUTO_LOGIN !== "1" ||
    !isLocalHost(request.headers.get("host"))
  ) {
    return NextResponse.json(
      { error: "Dev auto login is disabled" },
      { status: 404 },
    );
  }

  const email = process.env.ZANO_DEV_EMAIL;
  const password = process.env.ZANO_DEV_PASSWORD;

  if (!email || !password) {
    return NextResponse.json(
      { error: "Missing ZANO_DEV_EMAIL or ZANO_DEV_PASSWORD" },
      { status: 500 },
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const loginUrl = new URL("/login", url.origin);
    loginUrl.searchParams.set("error", "dev-login");
    return NextResponse.redirect(loginUrl);
  }

  const nextPath =
    url.searchParams.get("next") || process.env.ZANO_DEV_LOGIN_NEXT || "/";
  return NextResponse.redirect(new URL(nextPath, url.origin));
}
