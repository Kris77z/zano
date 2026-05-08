import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { signBridgeJwt } from "@/lib/jwt";

/**
 * POST /api/bridge/connect
 *
 * Validates a machine API key and returns credentials for the bridge to
 * connect to Supabase. The bridge never receives the service role key —
 * only a scoped JWT that identifies the user.
 *
 * Request body: { apiKey: "zk_..." }
 * Response: { supabaseUrl, supabaseAnonKey, token, userId, serverId, serverName, agents }
 */
export async function POST(request: NextRequest) {
  let body: { apiKey?: string; hostname?: string; platform?: string; arch?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { apiKey } = body;
  if (!apiKey || typeof apiKey !== "string") {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }

  // Hash the key and look it up
  const keyHash = createHash("sha256").update(apiKey).digest("hex");

  const admin = createAdminClient();

  const { data: keyRecord, error: keyError } = await admin
    .from("machine_keys")
    .select("id, user_id, server_id")
    .eq("key_hash", keyHash)
    .single();

  if (keyError || !keyRecord) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }

  // Update last_used_at and machine name (from hostname if provided)
  const keyUpdate: Record<string, string> = {
    last_used_at: new Date().toISOString(),
  };
  if (body.hostname) {
    // Use hostname as a friendly machine name (e.g. "Alices-MacBook-Pro")
    keyUpdate.name = body.hostname;
  }
  await admin
    .from("machine_keys")
    .update(keyUpdate)
    .eq("id", keyRecord.id);

  // Load server info
  const { data: server } = await admin
    .from("servers")
    .select("id, name, slug")
    .eq("id", keyRecord.server_id)
    .single();

  if (!server) {
    return NextResponse.json(
      { error: "Server not found for this key" },
      { status: 404 }
    );
  }

  // Load user's agents in this server
  const { data: agents } = await admin
    .from("agents")
    .select("id, name, display_name, description, model, status")
    .eq("owner_id", keyRecord.user_id)
    .eq("server_id", keyRecord.server_id)
    .order("created_at");

  // Sign a scoped JWT (7 day expiry — bridge refreshes periodically).
  // Local self-host setups can opt into using the service role token for the
  // bridge when Supabase does not expose the legacy JWT secret via CLI/API.
  const token =
    process.env.SUPABASE_JWT_SECRET
      ? signBridgeJwt(keyRecord.user_id, 7 * 24 * 3600)
      : process.env.ZANO_BRIDGE_USE_SERVICE_ROLE_TOKEN === "1"
        ? process.env.SUPABASE_SERVICE_ROLE_KEY
        : null;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey || !token) {
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    supabaseUrl,
    supabaseAnonKey,
    token,
    userId: keyRecord.user_id,
    serverId: keyRecord.server_id,
    serverName: server.name,
    agents: agents ?? [],
  });
}
