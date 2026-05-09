"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useParams } from "next/navigation";
import { CreateAgentDialog } from "./create-agent-dialog";
import { CreateChannelDialog } from "./create-channel-dialog";
import { CreateServerDialog } from "./create-server-dialog";
import { EditChannelDialog } from "./edit-channel-dialog";
import { MachineDetailDialog } from "./machine-detail-dialog";
import { ContextMenu } from "./context-menu";
import { useAgentActivity } from "@/hooks/use-agent-activity";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { ChevronDownIcon, CheckIcon, PlusIcon, PencilIcon, LogOutIcon, MonitorIcon } from "lucide-react";
import { GeneratedAvatar } from "./generated-avatar";

interface Server {
  id: string;
  name: string;
  slug: string;
}

interface Channel {
  id: string;
  name: string;
  type: string;
  description: string | null;
}

interface Agent {
  id: string;
  name: string;
  display_name: string;
  status: string;
  avatar_url: string | null;
  description: string | null;
}

interface MachineKey {
  id: string;
  name: string;
  key_prefix: string;
  key_value: string | null;
  last_used_at: string | null;
}

interface DmChannel extends Channel {
  agent?: Agent;
}

export function Sidebar({
  serverSlug,
  serverId,
  serverName,
}: {
  serverSlug: string;
  serverId: string;
  serverName: string;
}) {
  const [dmChannels, setDmChannels] = useState<DmChannel[]>([]);
  const [groupChannels, setGroupChannels] = useState<Channel[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [userId, setUserId] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [userName, setUserName] = useState("");
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [showServerMenu, setShowServerMenu] = useState(false);
  const [servers, setServers] = useState<Server[]>([]);
  const [machineKeys, setMachineKeys] = useState<MachineKey[]>([]);
  // Heartbeat-based online status (bridge updates last_used_at every 30s)
  const [bridgeOnline, setBridgeOnline] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [selectedMachine, setSelectedMachine] = useState<MachineKey | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    channel: Channel;
  } | null>(null);
  const supabase = createClient();
  const router = useRouter();
  const params = useParams();
  const agentActivities = useAgentActivity();

  // Determine active channel from URL
  const activeChannelId = params.channelId as string | undefined;

  const loadData = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);
    setUserEmail(user.email ?? "");

    // Get user profile
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", user.id)
      .single();
    if (profile) setUserName(profile.display_name);

    // Load user's servers for the switcher
    const { data: serverMemberships } = await supabase
      .from("server_members")
      .select("server_id")
      .eq("member_id", user.id)
      .eq("member_type", "human");

    if (serverMemberships && serverMemberships.length > 0) {
      const serverIds = serverMemberships.map((m) => m.server_id);
      const { data: allServers } = await supabase
        .from("servers")
        .select("id, name, slug")
        .in("id", serverIds)
        .order("created_at");
      if (allServers) setServers(allServers as Server[]);
    }

    // Load machine keys for this server
    const { data: keys } = await supabase
      .from("machine_keys")
      .select("id, name, key_prefix, key_value, last_used_at")
      .eq("server_id", serverId)
      .eq("user_id", user.id)
      .order("created_at");
    if (keys) {
      setMachineKeys(keys as MachineKey[]);
      // Check online status based on heartbeat (last_used_at within 60 seconds = online)
      const now = Date.now();
      const hasRecentHeartbeat = (keys as MachineKey[]).some(
        (k) => k.last_used_at && now - new Date(k.last_used_at).getTime() < 60_000
      );
      setBridgeOnline(hasRecentHeartbeat);
    }

    // Get all channels in this server that the user is a member of
    const { data: memberships } = await supabase
      .from("channel_members")
      .select("channel_id")
      .eq("member_id", user.id);

    if (!memberships || memberships.length === 0) return;

    const channelIds = memberships.map((m) => m.channel_id);
    const { data: channels } = await supabase
      .from("channels")
      .select("*")
      .eq("server_id", serverId)
      .in("id", channelIds)
      .order("created_at");

    if (!channels) return;

    // Get all agents in this server
    const { data: allAgents } = await supabase
      .from("agents")
      .select("*")
      .eq("server_id", serverId)
      .order("created_at");

    const agentList = (allAgents || []) as Agent[];
    setAgents(agentList);

    // Separate DM and group channels
    const dms: DmChannel[] = [];
    const groups: Channel[] = [];

    for (const ch of channels) {
      if (ch.type === "dm") {
        // Find which agent is in this DM
        const { data: members } = await supabase
          .from("channel_members")
          .select("member_id, member_type")
          .eq("channel_id", ch.id)
          .eq("member_type", "agent");

        const agentMember = members?.[0];
        const agent = agentMember
          ? agentList.find((a) => a.id === agentMember.member_id)
          : undefined;

        dms.push({ ...ch, agent });
      } else {
        groups.push(ch);
      }
    }

    setDmChannels(dms);
    setGroupChannels(groups);
  }, [supabase, serverId]);

  // Load sidebar data on mount (realtime subscriptions handle subsequent updates)
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Set up realtime subscriptions (stable across navigations, only recreate on server change)
  useEffect(() => {
    const realtimeSub = supabase
      .channel("sidebar-realtime")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "agents" },
        (payload) => {
          const updated = payload.new as Agent;
          setAgents((prev) => {
            if (prev.some((a) => a.id === updated.id)) {
              return prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a));
            }
            loadData();
            return prev;
          });
          setDmChannels((prev) =>
            prev.map((dm) =>
              dm.agent?.id === updated.id
                ? { ...dm, agent: { ...dm.agent, ...updated } }
                : dm
            )
          );
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agents" },
        () => {
          setTimeout(() => loadData(), 1500);
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "channel_members" },
        () => {
          loadData();
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "machine_keys" },
        (payload) => {
          const updated = payload.new as MachineKey & { id: string };
          setMachineKeys((prev) =>
            prev.map((mk) =>
              mk.id === updated.id ? { ...mk, ...updated } : mk
            )
          );
        }
      )
      .subscribe();

    // Heartbeat polling keeps local dev resilient when Supabase Presence
    // reconnects during React Strict Mode or Next.js hot reloads.
    async function checkHeartbeat() {
      const { data: keys } = await supabase
        .from("machine_keys")
        .select("last_used_at")
        .eq("server_id", serverId);
      if (keys) {
        const now = Date.now();
        setBridgeOnline(
          keys.some(
            (k: { last_used_at: string | null }) =>
              k.last_used_at && now - new Date(k.last_used_at).getTime() < 60_000
          )
        );
      }
    }

    const heartbeatInterval = setInterval(checkHeartbeat, 15_000);

    return () => {
      clearInterval(heartbeatInterval);
      supabase.removeChannel(realtimeSub);
    };
  }, [serverId]);

  function navigateToChannel(channel: Channel) {
    const prefix = channel.type === "dm" ? "dm" : "channel";
    router.push(`/s/${serverSlug}/${prefix}/${channel.id}`);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  function handleAgentCreated() {
    loadData();
  }

  function handleChannelCreated() {
    loadData();
  }

  function getStatusDot(agentId: string) {
    const activityState = agentActivities.get(agentId);
    const activity = activityState?.activity;
    // Agent is online when the bridge is online (bridge manages all agents)
    const isOnline = bridgeOnline;

    if (isOnline && (activity === "thinking" || activity === "working")) {
      return "bg-green-500 animate-status-pulse";
    }
    if (isOnline) return "bg-green-500";
    if (activity === "error") return "bg-red-500";
    return "bg-muted-foreground/40";
  }

  return (
    <aside className="flex h-full w-[var(--sidebar-width)] flex-col">
      {/* Header — Server switcher */}
      <div className="relative px-2 pt-2 pb-1">
        <button
          onClick={() => setShowServerMenu((v) => !v)}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-all hover:bg-accent"
        >
          <span className="text-[13px] font-semibold text-foreground truncate flex-1 text-left">
            {serverName}
          </span>
          <ChevronDownIcon className={`size-3 text-muted-foreground transition-transform flex-shrink-0 ${showServerMenu ? "rotate-180" : ""}`} />
        </button>

        {/* Server dropdown menu */}
        {showServerMenu && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setShowServerMenu(false)}
            />
            <div className="absolute left-2 right-2 top-full mt-1 z-50 py-1 max-h-64 overflow-y-auto rounded-lg border bg-popover shadow-md">
              {servers.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setShowServerMenu(false);
                    if (s.slug !== serverSlug) {
                      router.push(`/s/${s.slug}`);
                    }
                  }}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-[13px] transition-colors rounded-md mx-1 ${
                    s.slug === serverSlug
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  }`}
                  style={{ width: "calc(100% - 8px)" }}
                >
                  <GeneratedAvatar id={s.id} name={s.name} size="xs" className="rounded-md" initials />
                  <span className="truncate">{s.name}</span>
                  {s.slug === serverSlug && (
                    <CheckIcon className="ml-auto size-3.5 flex-shrink-0" strokeWidth={2.5} />
                  )}
                </button>
              ))}
              <Separator className="my-1" />
              <button
                onClick={() => {
                  setShowServerMenu(false);
                  setShowCreateServer(true);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground rounded-md mx-1"
                style={{ width: "calc(100% - 8px)" }}
              >
                <div className="flex size-6 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground flex-shrink-0">
                  <PlusIcon className="size-3" />
                </div>
                <span>Create Workspace</span>
              </button>
            </div>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-4">
        {/* DM Conversations */}
        <div>
          <div className="mb-1.5 px-2 flex items-center justify-between h-[22px]">
            <span className="text-[12px] font-medium text-muted-foreground">
              Agents
            </span>
            <button
              onClick={() => setShowCreateAgent(true)}
              className="rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              title="Create agent"
            >
              <PlusIcon className="size-3.5" />
            </button>
          </div>
          <div className="flex flex-col gap-[2px]">
            {dmChannels.map((dm) => (
              <button
                key={dm.id}
                onClick={() => navigateToChannel(dm)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 h-[32px] text-[13px] transition-all ${
                  activeChannelId === dm.id
                    ? "bg-sanda-3 text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-sanda-3 hover:text-accent-foreground"
                }`}
              >
                {/* Agent avatar */}
                <div className="relative flex-shrink-0 size-6">
                  <GeneratedAvatar id={dm.agent?.id || dm.id} name={dm.agent?.display_name || dm.name} size="xs" />
                  {/* Status dot */}
                  <div
                    className={`absolute bottom-0 right-0 h-1.5 w-1.5 translate-x-[1px] translate-y-[1px] rounded-full border-[1.5px] border-background ${getStatusDot(dm.agent?.id || "")}`}
                    title={(() => {
                      const act = agentActivities.get(dm.agent?.id || "");
                      if (act?.label && act.activity !== "idle") {
                        return act.detail ? `${act.label}: ${act.detail}` : act.label;
                      }
                      return bridgeOnline ? "Online" : "Offline";
                    })()}
                  />
                </div>

                <div className="flex-1 min-w-0 text-left">
                  <div className="truncate">
                    {dm.agent?.display_name || dm.name}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Group Channels */}
        <div>
          <div className="mb-1.5 px-2 flex items-center justify-between h-[22px]">
            <span className="text-[12px] font-medium text-muted-foreground">
              Channels
            </span>
            <button
              onClick={() => setShowCreateChannel(true)}
              className="rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              title="Create channel"
            >
              <PlusIcon className="size-3.5" />
            </button>
          </div>
          <div className="flex flex-col gap-[2px]">
            {groupChannels.map((channel) => (
              <button
                key={channel.id}
                onClick={() => navigateToChannel(channel)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, channel });
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2 h-[32px] text-[13px] transition-all ${
                  activeChannelId === channel.id
                    ? "bg-sanda-3 text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-sanda-3 hover:text-accent-foreground"
                }`}
              >
                <span className="text-muted-foreground">#</span>
                {channel.name}
              </button>
            ))}
          </div>
        </div>

        {/* Machines */}
        {machineKeys.length > 0 && (
          <div>
            <div className="mb-1.5 px-2 flex items-center justify-between h-[22px]">
              <span className="text-[12px] font-medium text-muted-foreground">
                Machines
              </span>
            </div>
            <div className="flex flex-col gap-[2px]">
              {machineKeys.map((mk) => (
                  <button
                    key={mk.id}
                    onClick={() => setSelectedMachine(mk)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 h-[32px] text-[13px] text-muted-foreground transition-colors hover:bg-sanda-3 hover:text-accent-foreground"
                  >
                    <div className="relative flex-shrink-0">
                      <MonitorIcon className="size-4 text-muted-foreground/60" />
                      <div
                        className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full border-[1.5px] border-background ${
                          bridgeOnline ? "bg-green-500" : "bg-muted-foreground/40"
                        }`}
                        title={bridgeOnline ? "Online" : "Offline"}
                      />
                    </div>
                    <span className="truncate text-left">{mk.name || mk.key_prefix}</span>
                  </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* User footer */}
      <div className="flex items-center gap-2 px-3 py-2.5 mx-2 mb-1 rounded-lg">
        <GeneratedAvatar id={userId || userEmail} name={userName || userEmail} size="xs" />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium text-muted-foreground truncate">
            {userName}
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          title="Sign out"
        >
          <LogOutIcon className="size-3.5" />
        </button>
      </div>
      <CreateAgentDialog
        open={showCreateAgent}
        onClose={() => setShowCreateAgent(false)}
        onCreated={handleAgentCreated}
        serverId={serverId}
      />
      <CreateChannelDialog
        open={showCreateChannel}
        onClose={() => setShowCreateChannel(false)}
        onCreated={handleChannelCreated}
        serverId={serverId}
      />
      <CreateServerDialog
        open={showCreateServer}
        onClose={() => setShowCreateServer(false)}
      />
      {editingChannel && (
        <EditChannelDialog
          channel={editingChannel}
          open={!!editingChannel}
          onClose={() => setEditingChannel(null)}
          onUpdated={loadData}
        />
      )}
      {selectedMachine && (
        <MachineDetailDialog
          open={!!selectedMachine}
          onClose={() => setSelectedMachine(null)}
          machine={selectedMachine}
          serverId={serverId}
          onUpdated={loadData}
        />
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: "Edit Channel",
              icon: <PencilIcon className="size-3.5" />,
              onClick: () => setEditingChannel(contextMenu.channel),
            },
          ]}
        />
      )}
    </aside>
  );
}
