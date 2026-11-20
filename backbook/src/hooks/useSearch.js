import { useMutation } from "@tanstack/react-query";
import axios from "axios";

const Search = async ({ term }) => {
  const { data } = await axios.post(
    `${import.meta.env.VITE_BACKEND_URL}/api/v1/users/search`,
    { term },
    {
      withCredentials: true,
    }
  );
  return data;
};

export const useSearch = () => {
  return useMutation({
    mutationKey: "useSearch",
    mutationFn: Search,
  });
};
