"use client";

import { useEffect, useRef, useState, useCallback, useMemo, FormEvent } from "react";
import {
  Phone,
  Video,
  Send,
  ArrowLeft,
  MessageCircle,
  Smile,
  Search,
  X,
  ChevronUp,
  Reply,
  Edit3,
  ShieldCheck,
  ShieldAlert,
  Timer,
  Eye,
  Paperclip,
  Mic,
  Square,
} from "lucide-react";
import { FastNavLink } from "@/components/layout/FastNavLink";
import { api, ApiError, getDeviceId } from "@/lib/api";
import { getChatCache, isChatCacheFresh, setChatCache, updateCachedMessages } from "@/lib/chatCache";
import { useAuth } from "@/hooks/useAuth";
import { useSocket } from "@/hooks/useSocket";
import { useCall } from "@/hooks/useCall";
import { Message, User } from "@/types";
import { decryptForPeer, decryptHistoryForPeer, decryptHistoryForMultiDevice, decryptMultiDeviceForUser, encryptForPeer, encryptForAllDevices, verifySignedPrekey, hasSecureSession, getSafetyNumber, encryptMedia, decryptMedia, parseSecureMediaMeta, SecureMediaMeta } from "@/lib/e2ee";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { MessageBubbleSkeleton } from "@/components/ui/Skeleton";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { cn } from "@/lib/utils";

const EMOJIS = ["😀", "😂", "😍", "🥰", "😎", "😭", "😡", "👍", "❤️", "🔥", "🎉", "🙏", "👏", "✨", "💯", "🤝"];

export function ChatWindow({ friendId }: { friendId: string }) {
  const { user } = useAuth();
  const { socket, onlineUserIds } = useSocket();
  const { startCall } = useCall();

  const cached = getChatCache(friendId);
  const [friend, setFriend] = useState<User | null>(cached?.friend ?? null);
  const [messages, setMessages] = useState<Message[]>(cached?.messages ?? []);
  const [draft, setDraft] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [encryptionReady, setEncryptionReady] = useState(false);
  const [encryptionError, setEncryptionError] = useState<string | null>(null);
  const [keyVerified, setKeyVerified] = useState<boolean | null>(null);
  const [showSecurity, setShowSecurity] = useState(false);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState(0);
  const [viewOnce, setViewOnce] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [recording, setRecording] = useState(false);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const peerDevicesRef = useRef<any[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollToBottom = useCallback((smooth = true) => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    });
  }, []);

  const loadChat = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    setError(null);
    try {
      const [userRes, msgRes, bundleRes, deviceRes] = await Promise.all([
        api.get<{ user: User }>(`/users/${friendId}`),
        api.get<{ messages: Message[]; hasMore: boolean }>(`/messages/${friendId}?limit=100`),
        api.cryptoKeys.getBundle(friendId),
        api.cryptoKeys.devices(friendId),
      ]);
      peerDevicesRef.current = deviceRes.devices ?? [];
      const bundle = bundleRes.bundle;
      const verified = await verifySignedPrekey(
        JSON.parse(bundle.signingPublicKey) as JsonWebKey,
        JSON.parse(bundle.signedPrekey.publicKey) as JsonWebKey,
        bundle.signedPrekey.signature
      );
      setKeyVerified(verified);
      if (verified) {
        try { setSafetyNumber(await getSafetyNumber(JSON.parse(bundle.identityPublicKey) as JsonWebKey)); }
        catch { setSafetyNumber(null); }
      }
      const decrypted = user ? await decryptHistoryForMultiDevice(friendId, msgRes.messages, bundle, user.id, peerDevicesRef.current) : await decryptHistoryForPeer(friendId, msgRes.messages, bundle);
      for (const message of msgRes.messages) {
        if (message.viewOnce === 1 && !message.mediaId && message.senderId === friendId && message.content && !message.viewedAt) {
          try { await api.messages.claimViewOnce(friendId, message.id); } catch { /* message may already have been consumed */ }
        }
      }
      setFriend(userRes.user);
      setMessages(decrypted);
      setEncryptionReady(true);
      setEncryptionError(null);
      setHasMore(msgRes.hasMore);
      setChatCache(friendId, userRes.user, decrypted);
      setLoading(false);
      if (!background) scrollToBottom(false);
    } catch (err) {
      if (!background) {
        setError(err instanceof ApiError ? err.message : "Could not load conversation");
        setLoading(false);
      }
    }
  }, [friendId, scrollToBottom, user]);

  useEffect(() => {
    if (!isChatCacheFresh(friendId)) loadChat(!!cached);
    else {
      setLoading(false);
      requestAnimationFrame(() => scrollToBottom(false));
    }
  }, [friendId, loadChat, scrollToBottom, cached]);

  useEffect(() => {
    if (!socket) return;

    const isMessageForChat = (msg: Message) => msg.senderId === friendId || msg.receiverId === friendId;

    const onReceive = async (msg: Message) => {
      if (!isMessageForChat(msg)) return;
      let nextMessage = msg;
      if (msg.content.startsWith("sakhya:e2ee:v1:") || msg.content.startsWith("sakhya:e2ee:v2:") || msg.content.startsWith("sakhya:e2ee:v3:")) {
        try {
          const [bundleRes, deviceRes] = await Promise.all([api.cryptoKeys.getBundle(friendId), api.cryptoKeys.devices(friendId)]);
          peerDevicesRef.current = deviceRes.devices ?? peerDevicesRef.current;
          nextMessage = { ...msg, content: user ? await decryptMultiDeviceForUser(friendId, msg.content, bundleRes.bundle, user.id, peerDevicesRef.current) : await decryptForPeer(friendId, msg.content, bundleRes.bundle) };
          if (msg.viewOnce === 1 && !msg.mediaId && msg.senderId === friendId) void api.messages.claimViewOnce(friendId, msg.id).catch(() => undefined);
        } catch {
          nextMessage = { ...msg, content: "Unable to decrypt this message." };
        }
      }
      setMessages((prev) => {
        if (prev.some((m) => m.id === nextMessage.id)) return prev;
        const next = [...prev, nextMessage];
        updateCachedMessages(friendId, next);
        return next;
      });
      if (nextMessage.senderId === friendId) socket.emit("message_seen", { friendId });
      requestAnimationFrame(() => scrollToBottom(true));
    };

    const onMessageUpdated = async (msg: Message) => {
      if (!isMessageForChat(msg)) return;
      let nextMessage = msg;
      if (msg.content.startsWith("sakhya:e2ee:v1:") || msg.content.startsWith("sakhya:e2ee:v2:") || msg.content.startsWith("sakhya:e2ee:v3:")) {
        try {
          const [bundleRes, deviceRes] = await Promise.all([api.cryptoKeys.getBundle(friendId), api.cryptoKeys.devices(friendId)]);
          peerDevicesRef.current = deviceRes.devices ?? peerDevicesRef.current;
          nextMessage = { ...msg, content: user ? await decryptMultiDeviceForUser(friendId, msg.content, bundleRes.bundle, user.id, peerDevicesRef.current) : await decryptForPeer(friendId, msg.content, bundleRes.bundle) };
        } catch {
          nextMessage = { ...msg, content: "Unable to decrypt this message." };
        }
      }
      setMessages((prev) => {
        const next = prev.map((m) => (m.id === nextMessage.id ? nextMessage : m));
        updateCachedMessages(friendId, next);
        return next;
      });
    };

    const onSeen = (data: { by: string }) => {
      if (data.by !== friendId) return;
      setMessages((prev) => {
        const next = prev.map((m) => (m.receiverId === friendId ? { ...m, status: "seen" as const } : m));
        updateCachedMessages(friendId, next);
        return next;
      });
    };

    const onTyping = (data: { senderId: string }) => data.senderId === friendId && setIsTyping(true);
    const onStopTyping = (data: { senderId: string }) => data.senderId === friendId && setIsTyping(false);
    const onErrorMessage = (data: { error?: string }) => {
      setEncryptionError(data?.error || "Message could not be sent.");
    };

    socket.on("receive_message", onReceive);
    socket.on("message_updated", onMessageUpdated);
    socket.on("message_seen", onSeen);
    socket.on("typing", onTyping);
    socket.on("stop_typing", onStopTyping);
    socket.on("error_message", onErrorMessage);
    socket.emit("message_seen", { friendId });

    return () => {
      socket.off("receive_message", onReceive);
      socket.off("message_updated", onMessageUpdated);
      socket.off("message_seen", onSeen);
      socket.off("typing", onTyping);
      socket.off("stop_typing", onStopTyping);
      socket.off("error_message", onErrorMessage);
    };
  }, [socket, friendId, scrollToBottom, user]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || !messages[0]) return;
    setLoadingOlder(true);
    const container = scrollRef.current;
    const oldHeight = container?.scrollHeight ?? 0;
    try {
      const before = encodeURIComponent(messages[0].createdAt);
      const beforeId = encodeURIComponent(messages[0].id);
      const res = await api.get<{ messages: Message[]; hasMore: boolean }>(`/messages/${friendId}?limit=100&before=${before}&beforeId=${beforeId}`);
      const [bundleRes, deviceRes] = await Promise.all([api.cryptoKeys.getBundle(friendId), api.cryptoKeys.devices(friendId)]);
      peerDevicesRef.current = deviceRes.devices ?? peerDevicesRef.current;
      const decryptedOlder = user ? await decryptHistoryForMultiDevice(friendId, res.messages, bundleRes.bundle, user.id, peerDevicesRef.current) : await decryptHistoryForPeer(friendId, res.messages, bundleRes.bundle);
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const next = [...decryptedOlder.filter((m) => !ids.has(m.id)), ...prev];
        updateCachedMessages(friendId, next);
        return next;
      });
      setHasMore(res.hasMore);
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight - oldHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [friendId, hasMore, loadingOlder, messages]);

  const handleChange = useCallback((value: string) => {
    setDraft(value.slice(0, 4000));
    if (!socket) return;
    socket.emit("typing", { receiverId: friendId });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => socket.emit("stop_typing", { receiverId: friendId }), 1200);
  }, [socket, friendId]);

  const sendMediaFile = useCallback(async (file: File, voice = false) => {
    if (!socket || !friendId || uploadingMedia) return;
    if (file.size > 45 * 1024 * 1024) { setEncryptionError("Media must be 45 MB or smaller."); return; }
    setUploadingMedia(true); setEncryptionError(null);
    try {
      const bundleRes = await api.cryptoKeys.getBundle(friendId);
      const { blob, key, iv } = await encryptMedia(file);
      const mediaId = crypto.randomUUID().replace(/-/g, "");
      await api.media.upload(mediaId, friendId, blob);
      const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "file";
      const meta: SecureMediaMeta = { v: 1, kind, mediaId, name: file.name || (voice ? "Voice message" : "Attachment"), mime: file.type || "application/octet-stream", size: file.size, key, iv, voice };
      const deviceRes = await api.cryptoKeys.devices(friendId);
      peerDevicesRef.current = deviceRes.devices ?? peerDevicesRef.current;
      const encryptedMeta = await encryptForAllDevices(friendId, bundleRes.bundle, peerDevicesRef.current, `sakhya:media:v1:${JSON.stringify(meta)}`, getDeviceId(), (deviceId, prekeyId) => api.cryptoKeys.consumeDevicePrekey(deviceId, prekeyId));
      socket.emit("send_message", { receiverId: friendId, content: encryptedMeta, replyToId: replyTo?.id ?? null, expiresIn, viewOnce, mediaId });
      setReplyTo(null); setExpiresIn(0); setViewOnce(false); setEncryptionReady(true);
      requestAnimationFrame(() => scrollToBottom(true));
    } catch (err) { setEncryptionError(err instanceof Error ? err.message : "Could not send encrypted media."); }
    finally { setUploadingMedia(false); }
  }, [socket, friendId, uploadingMedia, replyTo, expiresIn, viewOnce, scrollToBottom]);

  const handleMediaPick = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = ""; if (file) await sendMediaFile(file);
  }, [sendMediaFile]);

  const toggleRecording = useCallback(async () => {
    if (recording) { mediaRecorderRef.current?.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setEncryptionError("Voice recording is not supported by this browser."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream); recordedChunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) recordedChunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const ext = blob.type.includes("ogg") ? "ogg" : "webm";
        await sendMediaFile(new File([blob], `voice-message.${ext}`, { type: blob.type || "audio/webm" }), true);
        setRecording(false);
      };
      recorder.start(250); mediaRecorderRef.current = recorder; setRecording(true);
    } catch { setEncryptionError("Microphone access was denied or unavailable."); }
  }, [recording, sendMediaFile]);

  const handleSend = useCallback(async (e?: FormEvent) => {
    e?.preventDefault();
    const content = draft.trim();
    if (!content || !socket) return;
    if (editing) {
      try {
        const bundleRes = await api.cryptoKeys.getBundle(friendId);
        const deviceRes = await api.cryptoKeys.devices(friendId);
        peerDevicesRef.current = deviceRes.devices ?? peerDevicesRef.current;
        const encrypted = await encryptForAllDevices(friendId, bundleRes.bundle, peerDevicesRef.current, content, getDeviceId(), (deviceId, prekeyId) => api.cryptoKeys.consumeDevicePrekey(deviceId, prekeyId));
        socket.emit("edit_message", { messageId: editing.id, content: encrypted });
        setEditing(null);
      } catch (error) {
        setEncryptionError(error instanceof Error ? error.message : "Secure encryption is unavailable.");
        return;
      }
    } else {
      try {
        const bundleRes = await api.cryptoKeys.getBundle(friendId);
        const deviceRes = await api.cryptoKeys.devices(friendId);
        peerDevicesRef.current = deviceRes.devices ?? peerDevicesRef.current;
        const encrypted = await encryptForAllDevices(friendId, bundleRes.bundle, peerDevicesRef.current, content, getDeviceId(), (deviceId, prekeyId) => api.cryptoKeys.consumeDevicePrekey(deviceId, prekeyId));
        socket.emit(
          "send_message",
          { receiverId: friendId, content: encrypted, replyToId: replyTo?.id ?? null, expiresIn, viewOnce },
          (response: { ok: boolean; error?: string; message?: Message }) => {
            if (!response?.ok || !response.message) {
              setEncryptionError(response?.error || "Message could not be sent.");
              return;
            }
            setMessages((prev) => {
              if (prev.some((m) => m.id === response.message!.id)) return prev;
              const next = [...prev, response.message!];
              updateCachedMessages(friendId, next);
              return next;
            });
            requestAnimationFrame(() => scrollToBottom(true));
          },
        );
        setReplyTo(null);
        setExpiresIn(0);
        setViewOnce(false);
        setEncryptionReady(true);
        setEncryptionError(null);
      } catch (error) {
        setEncryptionError(error instanceof Error ? error.message : "Secure encryption is unavailable.");
        return;
      }
    }
    socket.emit("stop_typing", { receiverId: friendId });
    setDraft("");
    setShowEmoji(false);
    inputRef.current?.focus();
  }, [draft, socket, editing, friendId, replyTo, expiresIn, viewOnce]);

  const insertEmoji = useCallback((emoji: string) => {
    setDraft((prev) => `${prev}${emoji}`.slice(0, 4000));
    setShowEmoji(false);
    inputRef.current?.focus();
  }, []);

  const handleDelete = useCallback((message: Message) => {
    if (window.confirm("Delete this message?")) socket?.emit("delete_message", { messageId: message.id });
  }, [socket]);

  const handleEdit = useCallback((message: Message) => {
    setEditing(message);
    setReplyTo(null);
    setDraft(message.content);
    inputRef.current?.focus();
  }, []);

  const handleReply = useCallback((message: Message) => {
    setReplyTo(message);
    setEditing(null);
    inputRef.current?.focus();
  }, []);

  const handleReact = useCallback((message: Message, emoji: string) => {
    socket?.emit("react_message", { messageId: message.id, emoji });
  }, [socket]);

  const filteredMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return q ? messages.filter((m) => !m.deletedAt && m.content.toLowerCase().includes(q)) : messages;
  }, [messages, searchQuery]);

  const online = onlineUserIds.has(friendId);
  const statusLabel = isTyping ? "typing..." : online ? "Online" : "Offline";

  const renderedMessages = useMemo(
    () => filteredMessages.map((m) => (
      <MessageBubble key={m.id} message={m} peerId={friendId} isOwn={m.senderId === user?.id} onReply={handleReply} onEdit={handleEdit} onDelete={handleDelete} onReact={handleReact} />
    )),
    [filteredMessages, user?.id, handleReply, handleEdit, handleDelete, handleReact]
  );

  if (loading) {
    return (
      <div className="flex h-full flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border bg-surface p-3"><div className="skeleton h-10 w-10 rounded-full" /><div className="flex flex-1 flex-col gap-2"><div className="skeleton h-3.5 w-24" /><div className="skeleton h-3 w-14" /></div></div>
        <div className="flex flex-1 flex-col gap-3 overflow-hidden bg-background p-4"><MessageBubbleSkeleton align="left" /><MessageBubbleSkeleton align="right" /><MessageBubbleSkeleton align="left" /></div>
      </div>
    );
  }

  if (error || !friend) {
    return <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"><p className="text-sm text-danger">{error || "This conversation is unavailable."}</p><FastNavLink href="/chats" className="text-sm text-accent hover:underline">Back to chats</FastNavLink></div>;
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {encryptionError ? (
        <div className="border-b border-danger/20 bg-danger/5 px-3 py-2 text-center text-xs text-danger">{encryptionError}</div>
      ) : encryptionReady ? (
        <button type="button" onClick={() => setShowSecurity(true)} className="flex w-full items-center justify-center gap-1.5 border-b border-border bg-surface px-3 py-1.5 text-[11px] text-muted hover:bg-surface-hover">
          {keyVerified ? <ShieldCheck size={13} className="text-success" /> : <ShieldAlert size={13} className="text-warning" />}
          {keyVerified ? "End-to-end encrypted · signed key valid" : "End-to-end encrypted · compare security key"}
        </button>
      ) : null}

      {showSecurity && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Conversation security">
          <div className="w-full max-w-sm rounded-3xl border border-border bg-surface p-5 shadow-2xl">
            <div className="mb-4 flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><ShieldCheck size={19} /></div>
              <div><h2 className="font-semibold">Conversation security</h2><p className="mt-1 text-xs text-muted">Messages use a per-conversation encrypted session. Compare this code with {friend.username} on a trusted channel.</p></div>
            </div>
            <div className="rounded-2xl border border-border bg-background p-4 text-center">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Safety code</p>
              <p className="font-mono text-sm leading-7 tracking-wide break-words">{safetyNumber ?? "Unavailable"}</p>
            </div>
            <p className="mt-3 text-[11px] leading-5 text-muted">If this code changes unexpectedly, stop sending sensitive messages and verify the other device before continuing.</p>
            <button type="button" onClick={() => setShowSecurity(false)} className="mt-4 w-full rounded-2xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:opacity-90">Done</button>
          </div>
        </div>
      )}

      <div className="safe-top sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface/95 p-2.5 backdrop-blur-sm">
        <FastNavLink href="/chats" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-surface-hover sm:hidden" aria-label="Back to chats"><ArrowLeft size={20} /></FastNavLink>
        <Avatar src={friend.avatar} name={friend.username} size={40} online={online} />
        <div className="min-w-0 flex-1"><p className="truncate font-medium leading-tight">{friend.username}</p><p className="truncate text-xs text-muted" aria-live="polite">{statusLabel}</p></div>
        <button onClick={() => setShowSearch((v) => !v)} className="flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-foreground" aria-label="Search messages"><Search size={19} /></button>
        <button onClick={() => startCall(friend, "audio")} aria-label="Start audio call" className="flex h-11 w-11 items-center justify-center rounded-full text-accent hover:bg-accent-soft"><Phone size={19} /></button>
        <button onClick={() => startCall(friend, "video")} aria-label="Start video call" className="flex h-11 w-11 items-center justify-center rounded-full text-accent hover:bg-accent-soft"><Video size={20} /></button>
      </div>

      {showSearch && (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <Search size={16} className="text-muted" />
          <input autoFocus value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search in conversation" className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none" />
          <button onClick={() => { setSearchQuery(""); setShowSearch(false); }} className="rounded-full p-2 text-muted hover:bg-surface-hover" aria-label="Close search"><X size={17} /></button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain bg-background p-3 sm:p-4">
        {hasMore && !searchQuery && (
          <div className="mb-3 flex justify-center"><button onClick={loadOlder} disabled={loadingOlder} className="flex items-center gap-1 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted hover:text-foreground disabled:opacity-50"><ChevronUp size={14} />{loadingOlder ? "Loading..." : "Load older messages"}</button></div>
        )}
        {filteredMessages.length === 0 ? (
          <EmptyState icon={searchQuery ? Search : MessageCircle} title={searchQuery ? "No messages found" : `Say hello to ${friend.username}`} description={searchQuery ? "Try another word." : "Your conversation will show up here."} />
        ) : (
          <div className="flex flex-col gap-2">{renderedMessages}</div>
        )}
      </div>

      {(replyTo || editing) && (
        <div className="flex items-center gap-2 border-t border-border bg-surface px-3 py-2 text-sm">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-accent">{editing ? <Edit3 size={15} /> : <Reply size={15} />}</div>
          <div className="min-w-0 flex-1"><p className="text-xs font-medium text-accent">{editing ? "Editing message" : `Replying to ${replyTo?.senderId === user?.id ? "yourself" : friend.username}`}</p><p className="truncate text-xs text-muted">{editing ? editing.content : replyTo?.content}</p></div>
          <button onClick={() => { setReplyTo(null); setEditing(null); setDraft(""); }} className="rounded-full p-2 text-muted hover:bg-surface-hover" aria-label="Cancel"><X size={16} /></button>
        </div>
      )}

      <form onSubmit={handleSend} className="safe-bottom relative flex items-end gap-2 border-t border-border bg-surface p-2.5">
        <input ref={mediaInputRef} type="file" accept="image/*,video/*,audio/*,.pdf,.txt,.zip" onChange={handleMediaPick} className="hidden" aria-label="Attach encrypted media" />
        {showEmoji && (
          <div className="absolute bottom-16 left-2 z-30 w-72 rounded-2xl border border-border bg-surface p-3 shadow-xl">
            <div className="grid grid-cols-8 gap-1">{EMOJIS.map((emoji) => <button key={emoji} type="button" onClick={() => insertEmoji(emoji)} className="rounded-lg p-1.5 text-xl hover:bg-surface-hover">{emoji}</button>)}</div>
          </div>
        )}
        <button type="button" onClick={() => mediaInputRef.current?.click()} disabled={uploadingMedia} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-foreground disabled:opacity-50" aria-label="Attach encrypted media"><Paperclip size={20} /></button>
        <button type="button" onClick={toggleRecording} disabled={uploadingMedia} className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-foreground disabled:opacity-50", recording && "bg-danger-soft text-danger")} aria-label={recording ? "Stop voice recording" : "Record voice message"}>{recording ? <Square size={16} fill="currentColor" /> : <Mic size={20} />}</button>
        <button type="button" onClick={() => setShowEmoji((v) => !v)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-foreground" aria-label="Add emoji"><Smile size={20} /></button>
        <div className="absolute bottom-full left-0 right-0 flex items-center gap-2 border-t border-border bg-surface px-3 py-2 text-[11px] text-muted">
          <Timer size={14} />
          <span>Disappear:</span>
          <select value={expiresIn} onChange={(e) => setExpiresIn(Number(e.target.value))} className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground outline-none">
            <option value={0}>Off</option><option value={30}>30 sec</option><option value={300}>5 min</option><option value={3600}>1 hour</option><option value={86400}>24 hours</option><option value={604800}>7 days</option>
          </select>
          <button type="button" onClick={() => setViewOnce((v) => !v)} className={cn("ml-auto inline-flex items-center gap-1 rounded-lg border px-2 py-1", viewOnce ? "border-accent bg-accent-soft text-accent" : "border-border text-muted")} aria-pressed={viewOnce}>
            <Eye size={14} /> View once
          </button>
        </div>
        <textarea ref={inputRef} value={draft} onChange={(e) => handleChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }} rows={1} placeholder={editing ? "Edit message" : "Type a message"} aria-label="Message" className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl border border-border bg-background px-4 py-3 text-[15px] leading-5 outline-none focus:ring-2 focus:ring-accent/40" />
        <Button type="submit" size="icon" disabled={!draft.trim() || uploadingMedia} aria-label={editing ? "Save message" : "Send message"}><Send size={18} /></Button>
      </form>
    </div>
  );
}
