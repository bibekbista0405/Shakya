// Minimal WebRTC signaling payload shapes (server just relays these opaquely).
export interface RTCSessionDescriptionInit {
  type: string;
  sdp?: string;
}

export interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface UserRow {
  id: string;
  username: string;
  email: string;
  password: string;
  avatar: string;
  bio: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  createdAt: string;
}

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  avatar: string;
  bio: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  createdAt: string;
}

export interface BlockedUserRow {
  id: string;
  userId: string;
  blockedId: string;
  createdAt: string;
}

export interface AuthPayload {
  userId: string;
  username: string;
  sessionId?: string;
  deviceId?: string;
}

export interface FriendRequestRow {
  id: string;
  senderId: string;
  receiverId: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}

export interface MessageRow {
  id: string;
  senderId: string;
  receiverId: string;
  content: string;
  status: "sent" | "delivered" | "seen";
  replyToId: string | null;
  replyToContent?: string | null;
  replyToSenderId?: string | null;
  reactions: Record<string, string[]>;
  editedAt: string | null;
  deletedAt: string | null;
  expiresAt: string | null;
  viewOnce: number;
  viewedAt: string | null;
  mediaId: string | null;
  createdAt: string;
}

export interface CallRow {
  id: string;
  callerId: string;
  receiverId: string;
  type: "audio" | "video";
  status: "missed" | "completed" | "rejected" | "outgoing_cancelled";
  duration: number;
  startedAt: string;
  endedAt: string | null;
}

export interface NotificationRow {
  id: string;
  userId: string;
  type: "message" | "friend_request" | "friend_accept" | "missed_call" | "incoming_call";
  content: string;
  relatedId: string | null;
  isRead: number;
  createdAt: string;
}
