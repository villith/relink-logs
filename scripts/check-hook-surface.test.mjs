import { describe, expect, it } from "vitest";

import { checkSurface, countMarker, exportedNames, PROTON_MARKERS } from "./check-hook-surface.mjs";

/**
 * A minimal PE32+ image with one section and an export directory carrying
 * `names` exported names. With zero names the directory still exists but its
 * AddressOfNames is 0 — which is exactly what the real injected hook.dll
 * looks like, and what naive parsing mistakes for an RVA to resolve.
 */
function fakePe({ names = [] } = {}) {
  const buf = Buffer.alloc(0x600);
  const peOff = 0x80;
  const optOff = peOff + 24;
  const optSize = 240;
  const secOff = optOff + optSize;
  const sectionVa = 0x1000;
  const sectionRaw = 0x200;

  buf.writeUInt32LE(peOff, 0x3c);
  buf.write("PE\0\0", peOff, "latin1");
  buf.writeUInt16LE(1, peOff + 6); // NumberOfSections
  buf.writeUInt16LE(optSize, peOff + 20); // SizeOfOptionalHeader
  buf.writeUInt32LE(sectionVa, optOff + 112); // data directory 0: export

  buf.write(".rdata\0\0", secOff, "latin1");
  buf.writeUInt32LE(0x1000, secOff + 8); // VirtualSize
  buf.writeUInt32LE(sectionVa, secOff + 12); // VirtualAddress
  buf.writeUInt32LE(sectionRaw, secOff + 20); // PointerToRawData

  const toOff = (rva) => rva - sectionVa + sectionRaw;
  buf.writeUInt32LE(names.length, sectionRaw + 24); // NumberOfNames
  if (names.length) {
    const namesTableRva = sectionVa + 0x100;
    buf.writeUInt32LE(namesTableRva, sectionRaw + 32); // AddressOfNames
    let strRva = sectionVa + 0x200;
    names.forEach((name, i) => {
      buf.writeUInt32LE(strRva, toOff(namesTableRva) + i * 4);
      buf.write(`${name}\0`, toOff(strRva), "latin1");
      strRva += name.length + 1;
    });
  }
  return buf;
}

/** A scan result for a DLL that carries the full Proton surface. */
const proton = () => ({
  markers: Object.fromEntries(PROTON_MARKERS.map((m) => [m, 1])),
  exports: ["DirectInput8Create"],
});

/** A scan result for a clean injected Windows DLL. */
const windows = () => ({
  markers: Object.fromEntries(PROTON_MARKERS.map((m) => [m, 0])),
  exports: [],
});

describe("countMarker", () => {
  it("finds ASCII occurrences", () => {
    expect(countMarker(Buffer.from("xx127.0.0.1yy127.0.0.1", "latin1"), "127.0.0.1")).toBe(2);
  });

  it("finds UTF-16LE occurrences, which is how wide string literals are stored", () => {
    expect(countMarker(Buffer.from("C:\\windows\\system32\\dinput8.dll", "utf16le"), "dinput8.dll")).toBe(1);
  });

  it("counts ASCII and UTF-16 occurrences together", () => {
    const buf = Buffer.concat([Buffer.from("dinput8.dll", "latin1"), Buffer.from("dinput8.dll", "utf16le")]);
    expect(countMarker(buf, "dinput8.dll")).toBe(2);
  });

  it("reports zero when the marker is absent", () => {
    expect(countMarker(Buffer.from("nothing to see", "latin1"), "39372")).toBe(0);
  });
});

describe("exportedNames", () => {
  it("reads the exported names", () => {
    expect(exportedNames(fakePe({ names: ["DirectInput8Create"] }))).toEqual(["DirectInput8Create"]);
  });

  // The real injected hook.dll hits this: it HAS an export directory but
  // exports nothing, so AddressOfNames is 0. Resolving that as an RVA threw
  // and took the whole CI check down with it.
  it("returns nothing for an export directory with zero names", () => {
    expect(exportedNames(fakePe({ names: [] }))).toEqual([]);
  });
});

describe("checkSurface", () => {
  it("passes when the Windows DLL is clean and the Proton DLL is not", () => {
    expect(checkSurface({ windows: windows(), proton: proton() })).toEqual([]);
  });

  it("fails when a marker survives into the Windows DLL", () => {
    const dirty = windows();
    dirty.markers["127.0.0.1"] = 1;
    const errors = checkSurface({ windows: dirty, proton: proton() });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/127\.0\.0\.1/);
  });

  it("fails when the Windows DLL exports anything at all", () => {
    const dirty = windows();
    dirty.exports = ["DirectInput8Create"];
    const errors = checkSurface({ windows: dirty, proton: proton() });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/export/i);
  });

  // Without this the check would "pass" for a Proton build that silently lost
  // its proxy export — a green CI run and a Linux release that cannot hook.
  it("fails when the Proton DLL has lost its proxy export", () => {
    const broken = proton();
    broken.exports = [];
    const errors = checkSurface({ windows: windows(), proton: broken });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/DirectInput8Create/);
  });

  // Likewise: a scan that finds nothing anywhere is far more likely to be a
  // broken scanner than two correct builds, and it must not read as success.
  it("fails when the Proton DLL carries none of the markers", () => {
    const broken = proton();
    broken.markers = Object.fromEntries(PROTON_MARKERS.map((m) => [m, 0]));
    const errors = checkSurface({ windows: windows(), proton: broken });
    expect(errors.length).toBeGreaterThan(0);
  });
});
