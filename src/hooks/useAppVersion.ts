import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

/** The running app's version, `""` until Tauri answers.
 *
 * Empty rather than a placeholder like "0.0.0": both call sites render the
 * version inline beside the app name, and a placeholder puts a version that is
 * simply wrong in front of the user for the frames before the real one lands.
 * Empty renders as nothing, which is what "not known yet" should look like.
 */
export const useAppVersion = (): string => {
  const [version, setVersion] = useState("");

  // The `[]` is load-bearing: without it this effect re-ran on every render and
  // re-issued the IPC call each time, for a value that cannot change while the
  // process is alive.
  useEffect(() => {
    getVersion().then(setVersion);
  }, []);

  return version;
};
