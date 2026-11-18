export const ONLINE_MS = 40_000;
export const isOnline = (lastSeen) => !!lastSeen && Date.now() - new Date(lastSeen).getTime() < ONLINE_MS;
export const onlineSince = () => new Date(Date.now() - ONLINE_MS);
