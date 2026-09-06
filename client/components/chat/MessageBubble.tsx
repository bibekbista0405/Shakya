"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { Check, CheckCheck, Copy, Edit3, MoreHorizontal, Reply, Trash2, Timer, Eye, Download, LockKeyhole, Play } from "lucide-react";
import { Message } from "@/types";
import { cn, formatTime } from "@/lib/utils";
import { api } from "@/lib/api";
import { decryptMedia, parseSecureMediaMeta } from "@/lib/e2ee";

const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "😡", "🔥", "👏"];

interface MessageBubbleProps {
  message: Message;
  peerId: string;
  isOwn: boolean;
  onReply: (message: Message) => void;
  onEdit: (message: Message) => void;
  onDelete: (message: Message) => void;
  onReact: (message: Message, emoji: string) => void;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  peerId,
  isOwn,
  onReply,
  onEdit,
  onDelete,
  onReact,
}: MessageBubbleProps) {
  const [open, setOpen] = useState(false);
  const deleted = !!message.deletedAt;
  const reactions = useMemo(() => Object.entries(message.reactions || {}), [message.reactions]);
  const mediaMeta = useMemo(() => parseSecureMediaMeta(message.content), [message.content]);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [viewOnceConsumedLocally, setViewOnceConsumedLocally] = useState(false);
  const viewOnceConsumed = message.viewOnce === 1 && (viewOnceConsumedLocally || !!message.viewedAt) && (!message.content || !!mediaMeta);

  useEffect(() => () => { if (mediaUrl) URL.revokeObjectURL(mediaUrl); }, [mediaUrl]);

  const openMedia = async (): Promise<string | null> => {
    if (!mediaMeta || mediaLoading) return mediaUrl;
    if (mediaUrl) return mediaUrl;
    setMediaLoading(true);
    try {
      const encrypted = await api.media.download(mediaMeta.mediaId);
      const plain = await decryptMedia(encrypted, mediaMeta.key, mediaMeta.iv, mediaMeta.mime);
      const url = URL.createObjectURL(plain);
      setMediaUrl(url);
      if (message.viewOnce === 1 && !message.viewedAt && !isOwn) {
        // Media downloads atomically claim view-once access on the server.
        setViewOnceConsumedLocally(true);
        try { await api.messages.claimViewOnce(peerId, message.id); } catch { /* media endpoint already claimed it */ }
      }
      return url;
    } catch { return null; } finally { setMediaLoading(false); }
  };

  const downloadMedia = async () => {
    const url = await openMedia();
    if (url && mediaMeta) { const a = document.createElement("a"); a.href = url; a.download = mediaMeta.name; document.body.appendChild(a); a.click(); a.remove(); }
  };

  const copyMessage = async () => {
    if (deleted || message.viewOnce === 1) return;
    await navigator.clipboard?.writeText(message.content);
    setOpen(false);
  };

  return (
    <div className={cn("group flex", isOwn ? "justify-end" : "justify-start")}>
      <div className="relative max-w-[82%] sm:max-w-[75%]">
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2 text-sm shadow-sm",
            isOwn
              ? "rounded-br-md bg-accent text-white"
              : "rounded-bl-md border border-border bg-surface text-foreground"
          )}
        >
          {message.replyToId && !deleted && (
            <div className={cn("mb-2 rounded-xl border-l-2 px-2 py-1 text-xs", isOwn ? "border-white/60 bg-white/10 text-white/80" : "border-accent bg-accent-soft text-muted")}>
              <span className="font-medium">Reply</span>
              <p className="mt-0.5 truncate">{message.replyToContent || "Original message"}</p>
            </div>
          )}
          {mediaMeta && !deleted && !viewOnceConsumed ? (
            <div className="min-w-[180px] max-w-[280px]">
              {!mediaUrl ? (
                <button type="button" onClick={openMedia} disabled={mediaLoading} className="flex w-full items-center gap-3 rounded-xl border border-current/15 bg-black/5 px-3 py-3 text-left hover:bg-black/10 disabled:opacity-60">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">{mediaMeta.kind === "image" ? "🖼️" : mediaMeta.kind === "video" ? <Play size={18} /> : mediaMeta.kind === "audio" ? "🎙️" : <LockKeyhole size={18} />}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{mediaMeta.voice ? "Voice message" : mediaMeta.name}</span><span className="block text-[11px] opacity-70">{mediaLoading ? "Decrypting securely…" : `${Math.max(1, Math.round(mediaMeta.size / 1024))} KB · encrypted`}</span></span>
                </button>
              ) : mediaMeta.kind === "image" ? <img src={mediaUrl} alt={mediaMeta.name} className="max-h-72 w-full rounded-xl object-cover" /> : mediaMeta.kind === "video" ? <video src={mediaUrl} controls className="max-h-72 w-full rounded-xl" /> : mediaMeta.kind === "audio" ? <audio src={mediaUrl} controls className="w-full" /> : <button type="button" onClick={downloadMedia} className="flex w-full items-center gap-2 rounded-xl border border-current/15 px-3 py-3 text-sm"><Download size={16} /> Download encrypted file</button>}
              {mediaUrl && mediaMeta.kind !== "file" && <button type="button" onClick={downloadMedia} className="mt-2 flex items-center gap-1 text-[11px] opacity-75 hover:opacity-100"><Download size={13} /> Save a copy</button>}
            </div>
          ) : <p className={cn("whitespace-pre-wrap break-words", deleted && "italic text-muted")}>{deleted ? "Message deleted" : viewOnceConsumed ? "View-once message · opened" : message.content}</p>}
          {message.viewOnce === 1 && !deleted && !viewOnceConsumed && <div className={cn("mb-1 flex items-center gap-1 text-[10px]", isOwn ? "text-white/70" : "text-muted")}><Eye size={11} /> View once</div>}
          {message.expiresAt && !deleted && !viewOnceConsumed && <div className={cn("mb-1 flex items-center gap-1 text-[10px]", isOwn ? "text-white/70" : "text-muted")}><Timer size={11} /> Disappears automatically</div>}
          <div className={cn("mt-1 flex items-center justify-end gap-1 text-[11px]", isOwn ? "text-white/70" : "text-muted")}>
            <span>{formatTime(message.createdAt)}</span>
            {message.editedAt && !deleted && <span>edited</span>}
            {isOwn && (
              <span>
                {message.status === "seen" ? <CheckCheck size={14} className="text-white" /> : message.status === "delivered" ? <CheckCheck size={14} /> : <Check size={14} />}
              </span>
            )}
          </div>
        </div>

        {reactions.length > 0 && !deleted && (
          <div className={cn("absolute -bottom-3 flex gap-1 rounded-full border border-border bg-surface px-1.5 py-0.5 text-xs shadow-sm", isOwn ? "right-2" : "left-2")}>
            {reactions.map(([emoji, users]) => (
              <button key={emoji} onClick={() => onReact(message, emoji)} className="px-0.5" aria-label={`React with ${emoji}`}>
                {emoji} {users.length}
              </button>
            ))}
          </div>
        )}

        <button
          onClick={() => setOpen((v) => !v)}
          className={cn("absolute -top-3 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-sm sm:hidden", isOwn ? "right-0" : "left-0")}
          aria-label="Message actions"
        >
          <MoreHorizontal size={14} />
        </button>

        <div className={cn("absolute -top-10 z-20 hidden items-center gap-1 rounded-full border border-border bg-surface p-1 shadow-md group-hover:flex", isOwn ? "right-0" : "left-0")}>
          <button onClick={() => onReply(message)} className="rounded-full p-2 text-muted hover:bg-surface-hover hover:text-foreground" aria-label="Reply"><Reply size={15} /></button>
          {!deleted && message.viewOnce !== 1 && <button onClick={copyMessage} className="rounded-full p-2 text-muted hover:bg-surface-hover hover:text-foreground" aria-label="Copy"><Copy size={15} /></button>}
          {!deleted && message.viewOnce !== 1 && <button onClick={() => onReact(message, "👍")} className="rounded-full p-2 text-muted hover:bg-surface-hover hover:text-foreground" aria-label="Like"><span className="text-sm">👍</span></button>}
          {isOwn && !deleted && <button onClick={() => onEdit(message)} className="rounded-full p-2 text-muted hover:bg-surface-hover hover:text-foreground" aria-label="Edit"><Edit3 size={15} /></button>}
          {isOwn && !deleted && <button onClick={() => onDelete(message)} className="rounded-full p-2 text-muted hover:bg-danger-soft hover:text-danger" aria-label="Delete"><Trash2 size={15} /></button>}
          <button onClick={() => setOpen((v) => !v)} className="rounded-full p-2 text-muted hover:bg-surface-hover hover:text-foreground" aria-label="More actions"><MoreHorizontal size={15} /></button>
        </div>

        {open && !deleted && (
          <div className={cn("absolute top-10 z-30 w-48 rounded-xl border border-border bg-surface p-2 shadow-lg", isOwn ? "right-0" : "left-0")}>
            <p className="px-2 pb-1 text-[11px] font-medium text-muted">React</p>
            <div className="grid grid-cols-4 gap-1">
              {REACTIONS.map((emoji) => (
                <button key={emoji} onClick={() => { onReact(message, emoji); setOpen(false); }} className="rounded-lg p-2 text-lg hover:bg-surface-hover" aria-label={`React with ${emoji}`}>{emoji}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
