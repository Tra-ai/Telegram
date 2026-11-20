import React, { useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Navigate, Outlet } from "react-router-dom";
import Header from "../components/header/Header";
import Loading from "../components/UI/Loading/Loading";
import { useEffect } from "react";
import { useState } from "react";
import axios from "axios";
import { socket } from "../utils/socket";
import { queryClient } from "../App";
import chat_notification from "../assets/chat_notification.wav";
import notification_sweet from "../assets/notification_sweet.wav";
import { setOnlineUsers } from "../app/slices/soketSlice";
import { updateNStats, logout } from "../app/slices/userSlice";

export { socket };

function playNotificationSound() {
  const audio = new Audio(chat_notification);
  audio.play().catch(() => {});
}

function playNotificationSound2() {
  const audio = new Audio(notification_sweet);
  audio.play().catch(() => {});
}

const POLL_MS = 6000;

export default function IsLoggedIn({ user }) {
  const dispatch = useDispatch();
  const last = useRef({ m: null, n: null });

  // No websockets on the Layzzchat server → poll badges + presence, and refresh the open lists
  useEffect(() => {
    if (!user.userinfo) return undefined;
    let stop = false;
    const tick = async () => {
      if (stop || document.visibilityState === "hidden") return;
      try {
        const base = import.meta.env.VITE_BACKEND_URL;
        const [{ data: stats }, { data: online }] = await Promise.all([
          axios.put(`${base}/api/v1/users/ping`, {}, { withCredentials: true }),
          axios.get(`${base}/api/v1/users/online`, { withCredentials: true }),
        ]);
        if (last.current.m !== null && stats.unseenMessages > last.current.m) playNotificationSound();
        if (last.current.n !== null && stats.unseenNotification > last.current.n) playNotificationSound2();
        last.current = { m: stats.unseenMessages, n: stats.unseenNotification };
        dispatch(updateNStats({
          recivedRequestsCount: stats.recivedRequestsCount,
          unseenMessages: stats.unseenMessages,
          unseenNotification: stats.unseenNotification,
        }));
        dispatch(setOnlineUsers({ type: "connect", info: online.data.users }));
        queryClient.invalidateQueries({ queryKey: ["getChats"], refetchType: "active" });
        queryClient.invalidateQueries({ queryKey: ["getMessages"], refetchType: "active" });
        queryClient.invalidateQueries({ queryKey: ["getNotifications"], refetchType: "active" });
      } catch (e) {
        if (e?.response?.status === 401) dispatch(logout());
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { stop = true; clearInterval(id); };
  }, [user.userinfo?._id]);

  return user.userinfo ? (
    <>
      <Header />
      <React.Suspense fallback={<Loading />}>
        <Outlet />
      </React.Suspense>
    </>
  ) : (
    <Navigate to="/login" />
  );
}
