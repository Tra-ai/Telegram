import { useMutation } from "@tanstack/react-query";
import axios from "axios";

const GetChat = async ({ user }) => {
  const { data } = await axios.post(
    `${import.meta.env.VITE_BACKEND_URL}/api/v1/chats/create/private`,
    { userId: user },
    {
      withCredentials: true,
    }
  );
  return data;
};

export const useGetChat = () => {
  return useMutation({
    mutationKey: "useGetChat",
    mutationFn: GetChat,
  });
};
