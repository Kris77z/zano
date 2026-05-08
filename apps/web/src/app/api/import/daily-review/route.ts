import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

interface DailyReviewImportMessage {
  channel: string;
  title: string;
  body: string;
  artifacts?: string[];
}

interface DailyReviewImportPayload {
  date: string;
  plan_date?: string;
  server_id?: string;
  server_slug?: string;
  messages: DailyReviewImportMessage[];
}

interface ServerRecord {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
}

interface ChannelRecord {
  id: string;
  name: string;
}

function bearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return request.headers.get("x-zano-import-token");
}

function normalizeChannelName(value: string): string {
  return value
    .trim()
    .replace(/^#/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function parsePayload(value: unknown): DailyReviewImportPayload {
  if (!value || typeof value !== "object") {
    throw new Error("JSON body is required");
  }

  const raw = value as Record<string, unknown>;
  const date = requireString(raw.date, "date");
  const messages = raw.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }

  return {
    date,
    plan_date:
      typeof raw.plan_date === "string" && raw.plan_date.trim()
        ? raw.plan_date.trim()
        : undefined,
    server_id:
      typeof raw.server_id === "string" && raw.server_id.trim()
        ? raw.server_id.trim()
        : undefined,
    server_slug:
      typeof raw.server_slug === "string" && raw.server_slug.trim()
        ? raw.server_slug.trim()
        : undefined,
    messages: messages.map((message, index) => {
      if (!message || typeof message !== "object") {
        throw new Error(`messages[${index}] must be an object`);
      }
      const rawMessage = message as Record<string, unknown>;
      const channel = normalizeChannelName(
        requireString(rawMessage.channel, `messages[${index}].channel`)
      );
      if (!channel) {
        throw new Error(`messages[${index}].channel is invalid`);
      }

      const artifacts = rawMessage.artifacts;
      return {
        channel,
        title: requireString(rawMessage.title, `messages[${index}].title`),
        body: requireString(rawMessage.body, `messages[${index}].body`),
        artifacts: Array.isArray(artifacts)
          ? artifacts.filter(
              (artifact): artifact is string =>
                typeof artifact === "string" && Boolean(artifact.trim())
            )
          : [],
      };
    }),
  };
}

function importId(
  payload: DailyReviewImportPayload,
  message: DailyReviewImportMessage
) {
  return createHash("sha256")
    .update(
      [payload.date, payload.plan_date ?? "", message.channel, message.title].join(
        "\x1f"
      )
    )
    .digest("hex")
    .slice(0, 16);
}

function renderMessage(
  payload: DailyReviewImportPayload,
  message: DailyReviewImportMessage
): string {
  const id = importId(payload, message);
  const artifactLines =
    message.artifacts && message.artifacts.length > 0
      ? [
          "",
          "## Artifacts",
          "",
          ...message.artifacts.map((artifact) => `- \`${artifact}\``),
        ]
      : [];

  return [
    `<!-- zano-import:${id} -->`,
    "",
    `# ${message.title}`,
    "",
    `> Imported from Daily Review on ${payload.date}${
      payload.plan_date ? `, plan date ${payload.plan_date}` : ""
    }.`,
    "",
    message.body,
    ...artifactLines,
  ].join("\n");
}

async function resolveServer(
  admin: ReturnType<typeof createAdminClient>,
  payload: DailyReviewImportPayload
): Promise<ServerRecord> {
  const serverId = payload.server_id || process.env.ZANO_DAILY_IMPORT_SERVER_ID;
  const serverSlug =
    payload.server_slug || process.env.ZANO_DAILY_IMPORT_SERVER_SLUG;

  let query = admin.from("servers").select("id, name, slug, owner_id");

  if (serverId) {
    query = query.eq("id", serverId);
  } else if (serverSlug) {
    query = query.eq("slug", serverSlug);
  } else {
    throw new Error(
      "server_id or server_slug is required, either in payload or env"
    );
  }

  const { data, error } = await query.single();
  if (error || !data) {
    throw new Error(error?.message || "server not found");
  }
  return data as ServerRecord;
}

async function getOrCreateChannel(
  admin: ReturnType<typeof createAdminClient>,
  server: ServerRecord,
  name: string
): Promise<ChannelRecord> {
  const { data: existing, error: findError } = await admin
    .from("channels")
    .select("id, name")
    .eq("server_id", server.id)
    .eq("name", name)
    .maybeSingle();

  if (findError) {
    throw new Error(findError.message);
  }

  if (existing) {
    return existing as ChannelRecord;
  }

  const { data: channel, error: createError } = await admin
    .from("channels")
    .insert({
      server_id: server.id,
      name,
      type: "public",
      description: "Daily Review imported workspace channel",
      created_by: server.owner_id,
    })
    .select("id, name")
    .single();

  if (createError || !channel) {
    throw new Error(createError?.message || "failed to create channel");
  }

  const { error: memberError } = await admin.from("channel_members").upsert(
    {
      channel_id: channel.id,
      member_id: server.owner_id,
      member_type: "human",
    },
    { onConflict: "channel_id,member_id" }
  );

  if (memberError) {
    throw new Error(memberError.message);
  }

  return channel as ChannelRecord;
}

async function messageAlreadyImported(
  admin: ReturnType<typeof createAdminClient>,
  channelId: string,
  id: string
): Promise<boolean> {
  const marker = `<!-- zano-import:${id} -->`;
  const { data, error } = await admin
    .from("messages")
    .select("id")
    .eq("channel_id", channelId)
    .ilike("content", `%${marker}%`)
    .limit(1);

  if (error) {
    throw new Error(error.message);
  }
  return Array.isArray(data) && data.length > 0;
}

export async function POST(request: NextRequest) {
  const expectedToken = process.env.ZANO_DAILY_IMPORT_TOKEN;
  if (!expectedToken) {
    return NextResponse.json(
      { error: "ZANO_DAILY_IMPORT_TOKEN is not configured" },
      { status: 500 }
    );
  }

  if (bearerToken(request) !== expectedToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: DailyReviewImportPayload;
  try {
    payload = parsePayload(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid payload" },
      { status: 400 }
    );
  }

  try {
    const admin = createAdminClient();
    const server = await resolveServer(admin, payload);
    const results = [];

    for (const message of payload.messages) {
      const channel = await getOrCreateChannel(admin, server, message.channel);
      const id = importId(payload, message);

      if (await messageAlreadyImported(admin, channel.id, id)) {
        results.push({
          channel: channel.name,
          title: message.title,
          status: "skipped",
        });
        continue;
      }

      const { error } = await admin.from("messages").insert({
        channel_id: channel.id,
        sender_id: server.owner_id,
        sender_type: "system",
        content: renderMessage(payload, message),
      });

      if (error) {
        throw new Error(error.message);
      }

      results.push({
        channel: channel.name,
        title: message.title,
        status: "inserted",
      });
    }

    return NextResponse.json({
      ok: true,
      server: { id: server.id, slug: server.slug, name: server.name },
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import failed" },
      { status: 500 }
    );
  }
}
