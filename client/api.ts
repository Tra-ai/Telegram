// Drop into the frontend as src/api.ts  (no socket.io needed — realtime = polling)
export const API = import.meta.env.VITE_API_URL || "http://localhost:3000";
export const fileUrl = (u?: string | null) => u || undefined; // files are full https:// Blob URLs

let token: string | null = localStorage.getItem("token");

async function req<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(API + "/api" + path, {
    ...opts,
    headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: "Bearer " + token } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) api.logout();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  register: (username: string, password: string, displayName: string) => post("/auth/register", { username, password, displayName }).then(saveAuth),
  login: (username: string, password: string) => post("/auth/login", { username, password }).then(saveAuth),
  me: () => req("/auth/me"),
  logout() { token = null; localStorage.removeItem("token"); },
  isLoggedIn: () => !!token,

  chats: () => req("/chats"),
  openPrivate: (userId: string) => post("/chats/private", { userId }),
  createGroup: (title: string, memberIds: string[]) => post("/chats/group", { title, memberIds }),
  addMembers: (chatId: string, userIds: string[]) => post(`/chats/${chatId}/members`, { userIds }),
  leaveGroup: (chatId: string) => req(`/chats/${chatId}/members/me`, { method: "DELETE" }),
  messages: (chatId: string, before?: string) => req(`/chats/${chatId}/messages${before ? "?before=" + encodeURIComponent(before) : ""}`),
  messagesAfter: (chatId: string, after: string) => req(`/chats/${chatId}/messages?after=${encodeURIComponent(after)}`),
  send: (chatId: string, m: { type?: string; text?: string; fileUrl?: string; fileName?: string; fileSize?: number; duration?: number; replyToId?: string }) =>
    post(`/chats/${chatId}/messages`, m),
  typing: (chatId: string, isTyping = true) => post(`/chats/${chatId}/typing`, { isTyping }),
  markRead: (chatId: string) => post(`/chats/${chatId}/read`, {}),
  searchUsers: (q: string) => req("/users/search?q=" + encodeURIComponent(q)),
  uploadAvatar(file: Blob) {
    const fd = new FormData();
    fd.append("file", file, "avatar.jpg");
    return req("/users/me/avatar", { method: "POST", body: fd });
  },
  updateProfile: (p: { displayName?: string; bio?: string }) => req("/users/me", { method: "PATCH", body: JSON.stringify(p) }),

  // account / sessions (a new token is returned and saved; every other device is logged out)
  changePassword: (currentPassword: string, newPassword: string) => post("/auth/password", { currentPassword, newPassword }).then(saveAuth),
  logoutEverywhere: () => post("/auth/logout-all", {}).then(saveAuth),

  // blocking (blocked users can't message you; chat objects carry blockedByMe)
  block: (userId: string) => post(`/users/${userId}/block`, {}),
  unblock: (userId: string) => req(`/users/${userId}/block`, { method: "DELETE" }),
  blockedUsers: () => req("/users/blocked"),

  // messages
  editMessage: (chatId: string, messageId: string, text: string) => req(`/chats/${chatId}/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ text }) }),
  deleteMessage: (chatId: string, messageId: string) => req(`/chats/${chatId}/messages/${messageId}`, { method: "DELETE" }),

  // groups
  chat: (chatId: string) => req(`/chats/${chatId}`),
  renameGroup: (chatId: string, title: string) => req(`/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  uploadGroupAvatar(chatId: string, file: Blob) {
    const fd = new FormData();
    fd.append("file", file, "avatar.jpg");
    return req(`/chats/${chatId}/avatar`, { method: "POST", body: fd });
  },
  removeMember: (chatId: string, userId: string) => req(`/chats/${chatId}/members/${userId}`, { method: "DELETE" }),
  setAdmin: (chatId: string, userId: string, isAdmin: boolean) => req(`/chats/${chatId}/members/${userId}`, { method: "PATCH", body: JSON.stringify({ isAdmin }) }),
  transferOwner: (chatId: string, userId: string) => post(`/chats/${chatId}/transfer`, { userId }),

  // Image / video / voice (max 4 MB): upload first, then send with the returned fields
  upload(file: Blob, name = "file") {
    const fd = new FormData();
    fd.append("file", file, name);
    return req<{ type: "IMAGE" | "VIDEO" | "VOICE"; fileUrl: string; fileName: string; fileSize: number }>("/upload", { method: "POST", body: fd });
  },
};

function saveAuth(d: any) { token = d.token; localStorage.setItem("token", d.token); return d; }

// ---------- realtime by polling ----------
/** Chat list (unread, last message, online dots). Returns a stop() function. */
export function watchChats(onData: (chats: any[]) => void, ms = 4000) {
  let stop = false, t: any;
  const tick = async () => {
    try { onData((await api.chats()).chats); } catch {}
    if (!stop) t = setTimeout(tick, document.hidden ? 15000 : ms);
  };
  tick();
  return () => { stop = true; clearTimeout(t); };
}

/**
 * Open chat: pass the serverTime from the first api.messages() call.
 * onData gets { messages (new/changed; m.deleted === true → remove it), typing: userId[], reads }
 * Messages are de-duplicated here, but the first poll may repeat messages from the initial load,
 * so always UPSERT by m.id in your state (never blindly append).
 */
export function watchChat(chatId: string, since: string, onData: (d: any) => void, ms = 2000) {
  const OVERLAP = 5000; // re-read the last 5s so clock skew / late commits can't drop a message
  const seen = new Map<string, string>(); // id → updatedAt already delivered
  const back = (iso: string) => new Date(new Date(iso).getTime() - OVERLAP).toISOString();
  let stop = false, t: any, after = back(since);
  const tick = async () => {
    let more = false;
    try {
      const d = await api.messagesAfter(chatId, after);
      const fresh = d.messages.filter((m: any) => seen.get(m.id) !== m.updatedAt);
      fresh.forEach((m: any) => seen.set(m.id, m.updatedAt));
      if (seen.size > 2000) seen.clear();
      more = d.hasMore && d.messages.length > 0;
      // full page → continue from the last row's updatedAt (no overlap, so it always advances), otherwise from serverTime
      after = more ? d.messages[d.messages.length - 1].updatedAt : back(d.serverTime);
      onData({ ...d, messages: fresh });
    } catch {}
    if (!stop) t = setTimeout(tick, more ? 0 : document.hidden ? 10000 : ms);
  };
  t = setTimeout(tick, ms);
  return () => { stop = true; clearTimeout(t); };
}

/*
✓✓ read receipt: message is read when any other member's lastReadAt >= message.createdAt
Typing: call api.typing(chatId) while the user types (throttle ~3s), api.typing(chatId,false) on send.
Voice example:
  const up = await api.upload(blob, "voice.webm");
  await api.send(chatId, { type: "VOICE", fileUrl: up.fileUrl, fileName: up.fileName, fileSize: up.fileSize, duration: seconds });
*/
