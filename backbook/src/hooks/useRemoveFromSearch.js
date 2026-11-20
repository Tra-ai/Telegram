import { useMutation } from "@tanstack/react-query";
import axios from "axios";

const RemoveFromSearch = async ({ user }) => {
  const { data } = await axios.post(
    `${import.meta.env.VITE_BACKEND_URL}/api/v1/users/search/remove`,
    { searchUser: user },
    {
      withCredentials: true,
    }
  );
  return data;
};

export const useRemoveFromSearch = () => {
  return useMutation({
    mutationKey: "useRemoveFromSearch",
    mutationFn: RemoveFromSearch,
  });
};
