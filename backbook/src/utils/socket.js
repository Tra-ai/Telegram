// Backbook used socket.io. Layzzchat's server runs on Vercel (no websockets), so this is a
// no-op stand-in with the same surface; real-time updates come from polling (see routes/IsLoggedIn.jsx).
export const socket = {
  emit() {},
  on() { return socket; },
  off() { return socket; },
  disconnect() {},
};
