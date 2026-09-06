"use client";

import { useEffect, useState, useCallback, useMemo, memo } from "react";
import { FastNavLink } from "@/components/layout/FastNavLink";
import { useParams } from "next/navigation";
import { UserPlus, Search, MessageCircle } from "lucide-react";
import { api } from "@/lib/api";
import { useSocket } from "@/hooks/useSocket";
import { Conversation, Message } from "@/types";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListItemSkeleton } from "@/components/ui/Skeleton";
import { cn, formatDay } from "@/lib/utils";
import { isEncryptedMessage } from "@/lib/e2ee";
import { getConversationCache, isConversationCacheFresh, setConversationCache } from "@/lib/conversationCache";

const ConversationRow = memo(function ConversationRow({
  conversation,
  active,
  online,
}: {
  conversation: Conversation;
  active: boolean;
  online: boolean;
}) {
  const { friend, lastMessage, unreadCount } = conversation;
  return (
    <FastNavLink
      href={`/chats/${friend.id}`}
      className={cn(
        "flex items-center gap-3 px-3 py-3 transition-colors active:bg-black/[0.04] sm:hover:bg-black/[0.03]",
        active && "bg-accent-soft"
      )}
    >
      <Avatar src={friend.avatar} name={friend.username} size={46} online={online} />
      <div className="min-w-0 flex-1 border-b border-border/60 pb-3 pt-0.5 -mb-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">{friend.username}</span>
          {lastMessage && (
            <span className="shrink-0 text-xs text-muted">{formatDay(lastMessage.createdAt)}</span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm text-muted">
            {lastMessage ? (lastMessage.deletedAt ? "Message deleted" : isEncryptedMessage(lastMessage.content) ? "🔒 Encrypted message" : lastMessage.mediaId ? "🔒 Encrypted attachment" : lastMessage.content) : "Say hello 👋"}
          </span>
          {unreadCount > 0 && <Badge>{unreadCount > 99 ? "99+" : unreadCount}</Badge>}
        </div>
      </div>
    </FastNavLink>
  );
});

export function ChatList() {
  const { socket, onlineUserIds } = useSocket();
  const params = useParams<{ friendId?: string }>();
  const activeFriendId = params?.friendId;

  const initialConversations = getConversationCache();
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations ?? []);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(!initialConversations);

  const loadConversations = useCallback(async () => {
    try {
      const res = await api.get<{ conversations: Conversation[] }>("/messages/conversations");
      setConversations(res.conversations);
      setConversationCache(res.conversations);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isConversationCacheFresh()) loadConversations();
    else setLoading(false);
  }, [loadConversations]);

  useEffect(() => {
    if (conversations.length > 0) setConversationCache(conversations);
  }, [conversations]);

  // Patch state locally instead of refetching the whole list on every socket
  // event. This keeps navigation and real-time updates cheap.
  useEffect(() => {
    if (!socket) return;

    const onReceive = (msg: Message) => {
      setConversations((prev) => {
        const friendId = msg.senderId === activeFriendId || msg.receiverId === activeFriendId ? activeFriendId : null;
        const otherPartyId = msg.senderId; // conversation list is keyed by the friend, not "me"
        const idx = prev.findIndex((c) => c.friend.id === otherPartyId || c.friend.id === msg.receiverId);
        if (idx === -1) return prev; // message with someone not yet in the list (shouldn't happen for friends-only chat)

        const isIncoming = msg.senderId !== undefined && prev[idx].friend.id === msg.senderId;
        const next = [...prev];
        const existing = next[idx];
        next[idx] = {
          ...existing,
          lastMessage: msg,
          unreadCount:
            isIncoming && friendId !== existing.friend.id ? existing.unreadCount + 1 : existing.unreadCount,
        };
        // Move updated conversation to the top (newest first)
        const [moved] = next.splice(idx, 1);
        next.unshift(moved);
        return next;
      });
    };

    const onSeenByFriend = (data: { by: string }) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.friend.id === data.by && c.lastMessage
            ? { ...c, lastMessage: { ...c.lastMessage, status: "seen" } }
            : c
        )
      );
    };

    const onFriendAccept = () => loadConversations();

    socket.on("receive_message", onReceive);
    socket.on("message_seen", onSeenByFriend);
    socket.on("friend_accept", onFriendAccept);
    return () => {
      socket.off("receive_message", onReceive);
      socket.off("message_seen", onSeenByFriend);
      socket.off("friend_accept", onFriendAccept);
    };
  }, [socket, loadConversations, activeFriendId]);

  // Clear unread badge instantly when navigating into a conversation
  useEffect(() => {
    if (!activeFriendId) return;
    setConversations((prev) =>
      prev.map((c) => (c.friend.id === activeFriendId ? { ...c, unreadCount: 0 } : c))
    );
  }, [activeFriendId]);

  const filtered = useMemo(
    () => conversations.filter((c) => c.friend.username.toLowerCase().includes(query.toLowerCase())),
    [conversations, query]
  );

  return (
    <div className="flex h-full w-full flex-col border-r-0 bg-surface sm:w-80 sm:shrink-0 sm:border-r sm:border-border">
      <div className="safe-top flex items-center gap-2 border-b border-border p-3">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="pl-9"
            aria-label="Search chats"
          />
        </div>
        <FastNavLink
          href="/friends"
          aria-label="Add friend"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-accent hover:bg-accent-soft"
        >
          <UserPlus size={20} />
        </FastNavLink>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex flex-col gap-1 p-2">
            <ListItemSkeleton />
            <ListItemSkeleton />
            <ListItemSkeleton />
            <ListItemSkeleton />
          </div>
        )}
        {!loading && filtered.length === 0 && conversations.length === 0 && (
          <EmptyState
            icon={MessageCircle}
            title="No conversations yet"
            description="Add a friend to start chatting."
          />
        )}
        {!loading && filtered.length === 0 && conversations.length > 0 && (
          <EmptyState icon={Search} title="No matches" description="Try a different search." />
        )}
        {filtered.map((conversation) => (
          <ConversationRow
            key={conversation.friend.id}
            conversation={conversation}
            active={conversation.friend.id === activeFriendId}
            online={onlineUserIds.has(conversation.friend.id)}
          />
        ))}
      </div>
    </div>
  );
}
