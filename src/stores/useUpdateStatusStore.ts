import { create } from "zustand";

export type UpdateStatus = {
  upToDate: boolean;
  /** The newest released version the endpoint reported (null if it didn't say). */
  latestVersion: string | null;
};

interface UpdateStatusState {
  /** What the last update check this run learned; null until one answers
   * (never checked, endpoint unreachable, or auto-check disabled). Not
   * persisted — staleness across runs would mislead. */
  status: UpdateStatus | null;
  record: (status: UpdateStatus) => void;
}

export const useUpdateStatusStore = create<UpdateStatusState>()((set) => ({
  status: null,
  record: (status) => set({ status }),
}));
