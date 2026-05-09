'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GearSix } from '@phosphor-icons/react';
import TiptapMessageInput, { type TiptapMessageInputHandle } from './tiptap-message-input';
import { useAgentActivity } from '@/hooks/use-agent-activity';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GeneratedAvatar } from './generated-avatar';

interface Message {
  id: string;
  content: string;
  sender_id: string;
  sender_type: 'human' | 'agent' | 'system';
  seq: number | null;
  created_at: string;
  thread_parent_id: string | null;
  profiles?: { display_name: string } | null;
}

interface Channel {
  id: string;
  name: string;
  type: string;
  description: string | null;
}

interface AgentInfo {
  id: string;
  display_name: string;
  status: string;
  description: string | null;
}

function displayMessageContent(content: string): string {
  return content.replace(/^<!--\s*[^>]+-->\s*/u, "");
}

export function MessageArea({
  channel,
  onToggleSettings,
  showSettings,
}: {
  channel: Channel | null;
  onToggleSettings?: (agent: AgentInfo | null) => void;
  showSettings?: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasContent, setHasContent] = useState(false);
  const [sending, setSending] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [channelAgents, setChannelAgents] = useState<Map<string, AgentInfo>>(new Map());
  const [agentTyping, setAgentTyping] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingStartRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const inputRef = useRef<TiptapMessageInputHandle>(null);
  const supabase = createClient();
  const agentActivities = useAgentActivity();

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setUserId(user.id);
    });
  }, [supabase]);

  useEffect(() => {
    if (!channel) return;

    setMessages([]);
    setAgentInfo(null);
    setChannelAgents(new Map());
    setAgentTyping(false);
    setHasMore(true);
    setLoadingMore(false);
    isNearBottomRef.current = true;

    async function loadChannel() {
      const { data: members } = await supabase
        .from('channel_members')
        .select('member_id')
        .eq('channel_id', channel!.id)
        .eq('member_type', 'agent');

      if (members && members.length > 0) {
        const agentIds = members.map((m) => m.member_id);
        const { data: agentsData } = await supabase
          .from('agents')
          .select('id, display_name, status, description')
          .in('id', agentIds);

        if (agentsData) {
          const agentMap = new Map<string, AgentInfo>();
          for (const a of agentsData) {
            agentMap.set(a.id, a as AgentInfo);
          }
          setChannelAgents(agentMap);

          if (channel!.type === 'dm' && agentsData.length === 1) {
            setAgentInfo(agentsData[0] as AgentInfo);
          }
        }
      }

      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channel!.id)
        .is('thread_parent_id', null)
        .order('seq', { ascending: false })
        .limit(50);
      if (data) {
        const reversed = (data as Message[]).reverse();
        setMessages(reversed);
        setHasMore(data.length === 50);
        requestAnimationFrame(() => {
          const el = scrollContainerRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    }

    loadChannel();

    const subscription = supabase
      .channel(`messages:${channel.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channel.id}`,
        },
        (payload) => {
          const newMsg = payload.new as Message;
          if (!newMsg.thread_parent_id) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });
            if (newMsg.sender_type === 'agent') {
              setAgentTyping(false);
              typingStartRef.current = null;
            }
          }
        },
      )
      .subscribe();

    inputRef.current?.focus();

    return () => {
      supabase.removeChannel(subscription);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- channel is memoized; only re-run when channel ID changes
  }, [channel?.id, supabase]);

  useEffect(() => {
    if (!agentTyping || !channel) return;

    const poll = async () => {
      const since = typingStartRef.current;
      if (!since) return;

      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channel.id)
        .is('thread_parent_id', null)
        .eq('sender_type', 'agent')
        .gt('created_at', since)
        .order('created_at', { ascending: true })
        .limit(10);

      if (data && data.length > 0) {
        setMessages((prev) => {
          let updated = [...prev];
          for (const msg of data) {
            if (!updated.some((m) => m.id === msg.id)) {
              updated.push(msg as Message);
            }
          }
          return updated.length > prev.length ? updated : prev;
        });
        setAgentTyping(false);
        typingStartRef.current = null;
        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = null;
        }
      }
    };

    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [agentTyping, channel, supabase]);

  useEffect(() => {
    if (isNearBottomRef.current) {
      const el = scrollContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, agentTyping]);

  const loadOlderMessages = useCallback(async () => {
    if (!channel || loadingMore || !hasMore || messages.length === 0) return;
    const oldestSeq = messages[0]?.seq;
    if (!oldestSeq) return;

    setLoadingMore(true);
    const el = scrollContainerRef.current;
    const prevScrollHeight = el?.scrollHeight || 0;

    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('channel_id', channel.id)
      .is('thread_parent_id', null)
      .lt('seq', oldestSeq)
      .order('seq', { ascending: false })
      .limit(50);

    if (data) {
      const older = (data as Message[]).reverse();
      setHasMore(data.length === 50);
      setMessages((prev) => [...older, ...prev]);
      requestAnimationFrame(() => {
        if (el) {
          el.scrollTop = el.scrollHeight - prevScrollHeight;
        }
      });
    }
    setLoadingMore(false);
  }, [channel, loadingMore, hasMore, messages, supabase]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (el.scrollTop < 100 && hasMore && !loadingMore) {
      loadOlderMessages();
    }
  }, [hasMore, loadingMore, loadOlderMessages]);

  const doSend = useCallback(
    async (markdown: string) => {
      const content = markdown.trim();
      if (!content || !channel || !userId) return;

      setSending(true);
      setHasContent(false);

      let shouldType = false;
      if (channel.type === 'dm') {
        shouldType = true;
      } else if (channelAgents.size > 0) {
        shouldType = Array.from(channelAgents.values()).some((a) => {
          const pattern = new RegExp(
            `@${a.display_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,.:!?，。！？]|$)`,
            'i',
          );
          return pattern.test(content);
        });
      }
      if (shouldType) {
        setAgentTyping(true);
        typingStartRef.current = new Date().toISOString();
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => {
          setAgentTyping(false);
          typingStartRef.current = null;
        }, 130000);
      }

      const optimisticMsg: Message = {
        id: `optimistic-${Date.now()}`,
        content,
        sender_id: userId,
        sender_type: 'human',
        seq: null,
        created_at: new Date().toISOString(),
        thread_parent_id: null,
        profiles: null,
      };
      setMessages((prev) => [...prev, optimisticMsg]);

      const { data: inserted } = await supabase
        .from('messages')
        .insert({
          channel_id: channel.id,
          sender_id: userId,
          sender_type: 'human',
          content,
        })
        .select()
        .single();

      if (inserted) {
        setMessages((prev) =>
          prev.map((m) => (m.id === optimisticMsg.id ? ({ ...inserted, profiles: null } as Message) : m)),
        );
      }

      setSending(false);
      inputRef.current?.focus();
    },
    [channel, userId, supabase, channelAgents],
  );

  if (!channel) {
    return (
      <div className="flex flex-1 items-center justify-center bg-card">
        <div className="text-center">
          <div className="text-5xl font-light text-muted-foreground/20 mb-4">Z</div>
          <p className="text-sm text-muted-foreground">Select a conversation to start chatting</p>
        </div>
      </div>
    );
  }

  function getSenderName(msg: Message) {
    if (msg.sender_type === 'system') return 'System';
    if (msg.sender_type === 'agent') {
      const agent = channelAgents.get(msg.sender_id);
      return agent?.display_name || agentInfo?.display_name || 'Agent';
    }
    if (msg.profiles?.display_name) return msg.profiles.display_name;
    return 'You';
  }

  function formatTime(dateStr: string) {
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div className="flex flex-1 flex-col bg-card max-w-full text-pretty">
      {/* Channel header */}
      <div className="flex items-center gap-3 border-b-[0.5px] py-2 px-3">
        {channel.type === 'dm' && agentInfo ? (
          <>
            <div className="relative size-8">
              <GeneratedAvatar id={agentInfo.id} name={agentInfo.display_name} size="md" />
              {(() => {
                const act = agentActivities.get(agentInfo.id);
                const isActive = act?.activity === 'thinking' || act?.activity === 'working';
                const isOnline = agentInfo.status === 'online' || agentInfo.status === 'active';
                const dotColor = isActive
                  ? 'bg-green-500 animate-status-pulse'
                  : isOnline
                    ? 'bg-green-500'
                    : agentInfo.status === 'sleeping'
                      ? 'bg-yellow-500'
                      : act?.activity === 'error'
                        ? 'bg-red-500'
                        : 'bg-gray-400';
                return (
                  <div
                    className={`absolute bottom-0 right-0 h-2.5 w-2.5 translate-x-[2px] translate-y-[2px] rounded-full border-2 border-card ${dotColor}`}
                  />
                );
              })()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-[14px] font-semibold">{agentInfo.display_name}</h2>
                {(() => {
                  const act = agentActivities.get(agentInfo.id);
                  if (!act || act.activity === 'idle' || act.activity === 'error') return null;
                  const label = act.label || (act.activity === 'thinking' ? 'Thinking' : 'Working');
                  return (
                    <span className="flex items-center gap-1.5 text-[11px] text-primary">
                      <span className="font-medium">{label}</span>
                      {act.detail && <span className="text-muted-foreground truncate max-w-[200px]">{act.detail}</span>}
                    </span>
                  );
                })()}
              </div>
              {agentInfo.description && (
                <p className="text-[12px] text-muted-foreground truncate">{agentInfo.description}</p>
              )}
            </div>
            {onToggleSettings && (
              <Button
                onClick={() => onToggleSettings(showSettings ? null : agentInfo)}
                variant={showSettings ? 'secondary' : 'ghost'}
                size="icon-xs"
                aria-label="Agent Settings">
                <GearSix size={18} />
              </Button>
            )}
          </>
        ) : (
          <>
            <span className="text-lg text-muted-foreground">#</span>
            <div className="flex-1 min-w-0">
              <h2 className="text-[14px] font-semibold">{channel.name}</h2>
              {channel.description && (
                <p className="text-[12px] text-muted-foreground truncate">{channel.description}</p>
              )}
            </div>
            {channelAgents.size > 0 && (
              <div className="flex items-center gap-1">
                {Array.from(channelAgents.values()).map((agent) => (
                  <GeneratedAvatar key={agent.id} id={agent.id} name={agent.display_name} size="xs" />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-5 py-4 space-y-1">
        {loadingMore && (
          <div className="flex justify-center py-3">
            <span className="text-xs text-muted-foreground">Loading older messages...</span>
          </div>
        )}
        {!hasMore && messages.length > 0 && (
          <div className="flex justify-center py-3">
            <span className="text-xs text-muted-foreground">Beginning of conversation</span>
          </div>
        )}
        {messages.map((msg, i) => {
          const prevMsg = messages[i - 1];
          const sameSender =
            prevMsg &&
            prevMsg.sender_id === msg.sender_id &&
            new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime() < 5 * 60 * 1000;
          const isOwn = msg.sender_id === userId;

          return (
            <div
              key={msg.id}
              className={`group flex gap-3 rounded-lg px-2 py-1.5 transition-colors ${
                sameSender ? '' : 'mt-5 first:mt-0'
              }`}>
              <div className="w-8 shrink-0 pt-0.5">
                {!sameSender && <GeneratedAvatar id={msg.sender_id} name={getSenderName(msg)} size="md" />}
              </div>

              <div className="flex-1 min-w-0">
                {!sameSender && (
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="text-[13px] font-semibold">{getSenderName(msg)}</span>
                    {msg.sender_type === 'agent' && (
                      <Badge variant="secondary" className="text-[10px] py-0">
                        agent
                      </Badge>
                    )}
                    <span className="text-[11px] text-muted-foreground">{formatTime(msg.created_at)}</span>
                  </div>
                )}
                <div
                  className="prose-message text-[15px] wrap-break-word subpixel-antialiased prose-headings:antialiased"
                  style={{ lineHeight: '1.54' }}>
                  {msg.sender_type === 'agent' || msg.sender_type === 'system' ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {displayMessageContent(msg.content)}
                    </ReactMarkdown>
                  ) : (
                    <span className="whitespace-pre-wrap">
                      {msg.content.split(/(@[^\s,.:!?，。！？]+)/g).map((part, j) =>
                        part.startsWith('@') ? (
                          <span key={j} className="rounded bg-primary/10 px-0.5 text-primary font-medium">
                            {part}
                          </span>
                        ) : (
                          part
                        ),
                      )}
                    </span>
                  )}
                </div>
              </div>

              {sameSender && (
                <span className="hidden group-hover:block text-[11px] text-muted-foreground self-center flex-shrink-0">
                  {formatTime(msg.created_at)}
                </span>
              )}
            </div>
          );
        })}

        {/* Typing indicator */}
        {(() => {
          let activeAgentName: string | null = null;
          let activeAgentId: string | null = null;
          let activityLabel = '';
          let activityDetail = '';
          let isActive = false;

          if (channel?.type === 'dm' && agentInfo) {
            const act = agentActivities.get(agentInfo.id);
            if (act?.activity === 'thinking' || act?.activity === 'working') {
              isActive = true;
              activeAgentName = agentInfo.display_name;
              activeAgentId = agentInfo.id;
              activityLabel = act.label || '';
              activityDetail = act.detail || '';
            }
          } else if (channelAgents.size > 0) {
            for (const [agentId, agent] of channelAgents) {
              const act = agentActivities.get(agentId);
              if (act?.activity === 'thinking' || act?.activity === 'working') {
                isActive = true;
                activeAgentName = agent.display_name;
                activeAgentId = agentId;
                activityLabel = act.label || '';
                activityDetail = act.detail || '';
                break;
              }
            }
          }

          if (!isActive && agentTyping) {
            isActive = true;
            const firstAgent = agentInfo || Array.from(channelAgents.values())[0];
            activeAgentName = firstAgent?.display_name || 'Agent';
            activeAgentId = firstAgent?.id || 'unknown';
            activityLabel = 'Thinking';
            activityDetail = '';
          }

          if (!isActive) return null;

          const isTextOutput = !activityLabel && activityDetail;
          const displayLabel = activityLabel || 'Thinking';

          return (
            <div className="flex gap-3 px-2 py-1 mt-4">
              <div className="w-8 flex-shrink-0 pt-0.5">
                <GeneratedAvatar id={activeAgentId || 'unknown'} name={activeAgentName || 'A'} size="md" />
              </div>
              <div className="flex-1 min-w-0 py-1.5">
                {isTextOutput ? (
                  <p className="text-[13px] text-muted-foreground leading-relaxed line-clamp-2">{activityDetail}</p>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:0ms]" />
                      <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:150ms]" />
                      <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:300ms]" />
                    </div>
                    <span className="text-[12px] font-medium text-primary">{displayLabel}</span>
                    {activityDetail && (
                      <span className="text-[12px] text-muted-foreground truncate">{activityDetail}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="relative px-4 pb-4 pt-2">
        {/* @mention autocomplete dropdown */}
        {mentionQuery !== null &&
          channel.type !== 'dm' &&
          (() => {
            const agents = Array.from(channelAgents.values()).filter((a) =>
              a.display_name.toLowerCase().includes(mentionQuery.toLowerCase()),
            );
            if (agents.length === 0) return null;
            return (
              <div className="absolute bottom-full left-4 right-4 mb-1 py-1 max-h-48 overflow-y-auto z-50 rounded-lg border bg-popover shadow-lg">
                {agents.map((agent, i) => (
                  <button
                    key={agent.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      inputRef.current?.replaceMention(mentionQuery, `@${agent.display_name} `);
                      setMentionQuery(null);
                      setMentionIndex(0);
                      inputRef.current?.focus();
                    }}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] transition-colors ${
                      i === mentionIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/50'
                    }`}>
                    <GeneratedAvatar id={agent.id} name={agent.display_name} size="xs" />
                    <div className="flex-1 min-w-0 text-left">
                      <div>{agent.display_name}</div>
                      {agent.description && (
                        <div className="text-[10px] text-muted-foreground truncate">{agent.description}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            );
          })()}
        <div className="rounded-lg border bg-card shadow-xs/5 overflow-hidden focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24 transition-shadow">
          <div className="px-4 pt-3 pb-1 text-[15px] leading-[1.54]">
            <TiptapMessageInput
              ref={inputRef}
              placeholder={
                channel.type === 'dm'
                  ? `Message ${agentInfo?.display_name || 'agent'}...`
                  : `@ to mention an agent in #${channel.name}...`
              }
              disabled={sending}
              onSend={doSend}
              onTextUpdate={(textBeforeCursor, fullText) => {
                if (channel.type !== 'dm') {
                  const atMatch = textBeforeCursor.match(/@([^\s@]*)$/);
                  if (atMatch) {
                    setMentionQuery(atMatch[1]);
                    setMentionIndex(0);
                  } else {
                    setMentionQuery(null);
                  }
                }
                setHasContent(fullText.trim().length > 0);
              }}
              onKeyDown={(event) => {
                if (mentionQuery !== null && channel.type !== 'dm') {
                  const agents = Array.from(channelAgents.values()).filter((a) =>
                    a.display_name.toLowerCase().includes(mentionQuery.toLowerCase()),
                  );
                  if (agents.length > 0) {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      const agent = agents[mentionIndex];
                      inputRef.current?.replaceMention(mentionQuery, `@${agent.display_name} `);
                      setMentionQuery(null);
                      setMentionIndex(0);
                      return true;
                    }
                    if (event.key === 'ArrowDown') {
                      setMentionIndex((prev) => (prev + 1) % agents.length);
                      return true;
                    }
                    if (event.key === 'ArrowUp') {
                      setMentionIndex((prev) => (prev - 1 + agents.length) % agents.length);
                      return true;
                    }
                    if (event.key === 'Tab') {
                      const agent = agents[mentionIndex];
                      inputRef.current?.replaceMention(mentionQuery, `@${agent.display_name} `);
                      setMentionQuery(null);
                      setMentionIndex(0);
                      return true;
                    }
                    if (event.key === 'Escape') {
                      setMentionQuery(null);
                      return true;
                    }
                  }
                }
                return false;
              }}
            />
          </div>
          <div className="flex items-center justify-end px-2.5 pb-2.5">
            <Button
              type="button"
              onClick={() => {
                const md = inputRef.current?.getMarkdown() ?? '';
                if (md.trim()) {
                  doSend(md);
                  inputRef.current?.clear();
                }
              }}
              disabled={sending || !hasContent}
              size="sm">
              {sending ? 'Sending...' : 'Send'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
