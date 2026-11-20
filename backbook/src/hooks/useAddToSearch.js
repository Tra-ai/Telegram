import { useMutation } from "@tanstack/react-query";
import axios from "axios";

const AddToSearch = async ({ user }) => {
  const { data } = await axios.post(
    `${import.meta.env.VITE_BACKEND_URL}/api/v1/users/search/add`,
    { searchUser: user },
    {
      withCredentials: true,
    }
  );
  return data;
};

export const useAddToSearch = () => {
  return useMutation({
    mutationKey: "useAddToSearch",
    mutationFn: AddToSearch,
  });
};
