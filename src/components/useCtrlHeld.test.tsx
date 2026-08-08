import { act, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import { useCtrlHeld } from "./useCtrlHeld";

/** A real key event on `window`, the way the browser delivers one. Fired
 * directly rather than through `fireEvent`, because the hook listens on the
 * window itself and there is no element in the tree to dispatch from. */
const press = (type: "keydown" | "keyup", ctrlKey: boolean, key = "Control") =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { key, ctrlKey }));
  });

describe("useCtrlHeld", () => {
  it("starts false — nothing is held before the user presses anything", () => {
    const { result } = renderHook(() => useCtrlHeld());
    expect(result.current).toBe(false);
  });

  it("reads true while Ctrl is down and false once it comes up", () => {
    const { result } = renderHook(() => useCtrlHeld());

    press("keydown", true);
    expect(result.current).toBe(true);

    press("keyup", false);
    expect(result.current).toBe(false);
  });

  it("follows the modifier FLAG, not the Control key itself", () => {
    // Ctrl+Shift, or any key pressed while Ctrl is already down, still reads
    // as held — and the order the two were pressed in cannot matter.
    const { result } = renderHook(() => useCtrlHeld());

    press("keydown", true, "Shift");
    expect(result.current).toBe(true);

    press("keydown", false, "Shift");
    expect(result.current).toBe(false);
  });

  it("clears when the window loses focus", () => {
    // Alt+Tab away mid-hold and the keyup lands in another window; without
    // this the flag stays stuck true and the next card opens detailed with
    // nothing held.
    const { result } = renderHook(() => useCtrlHeld());
    press("keydown", true);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current).toBe(false);
  });

  it("does not re-render on the repeat keydowns a held key produces", () => {
    // Holding a key fires keydown at the OS repeat rate. Committing state per
    // event would re-render the open card tens of times a second.
    let renders = 0;
    const { result } = renderHook(() => {
      const held = useCtrlHeld();
      useEffect(() => {
        renders += 1;
      });
      return held;
    });

    press("keydown", true);
    const afterFirst = renders;
    press("keydown", true);
    press("keydown", true);

    expect(result.current).toBe(true);
    expect(renders).toBe(afterFirst);
  });

  it("stops listening once unmounted", () => {
    const { result, unmount } = renderHook(() => useCtrlHeld());
    unmount();
    // No state update on an unmounted hook — the assertion is the pristine
    // console as much as the value, which React warns on otherwise.
    press("keydown", true);
    expect(result.current).toBe(false);
  });
});
