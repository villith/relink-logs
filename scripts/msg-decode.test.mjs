import { describe, expect, it } from "vitest";

import { msgDecode } from "./msg-decode.mjs";

/** Hand-assembled MessagePack, because the whole point of the decoder is the
 * game's .msg files: maps decode to [key, value] PAIR LISTS, not objects —
 * duplicate keys are the norm (one "ActionInfo" entry per action). */
const fixstr = (s) => Buffer.concat([Buffer.from([0xa0 + s.length]), Buffer.from(s, "utf8")]);

describe("msgDecode", () => {
  it("decodes a map with duplicate keys into a pair list", () => {
    // { ActionInfo: {id_: 1900}, ActionInfo: {id_: 1100} } — impossible as a JS
    // object, routine in an action.msg.
    const inner = (id) =>
      Buffer.concat([Buffer.from([0x81]), fixstr("id_"), Buffer.from([0xcd, (id >> 8) & 0xff, id & 0xff])]);
    const buf = Buffer.concat([
      Buffer.from([0x82]),
      fixstr("ActionInfo"),
      inner(1900),
      fixstr("ActionInfo"),
      inner(1100),
    ]);

    expect(msgDecode(buf)).toEqual([
      ["ActionInfo", [["id_", 1900]]],
      ["ActionInfo", [["id_", 1100]]],
    ]);
  });

  it("decodes the numeric widths the game files use", () => {
    // [127, -1, uint16 1900, uint32 80000, int8 -100]
    const buf = Buffer.from([0x95, 0x7f, 0xff, 0xcd, 0x07, 0x6c, 0xce, 0x00, 0x01, 0x38, 0x80, 0xd0, 0x9c]);

    expect(msgDecode(buf)).toEqual([127, -1, 1900, 80000, -100]);
  });

  it("decodes str8 strings past the fixstr length limit", () => {
    const long = "AB_PL2400_09_and_then_some_padding_to_exceed_31_chars";
    const buf = Buffer.concat([Buffer.from([0xd9, long.length]), Buffer.from(long, "utf8")]);

    expect(msgDecode(buf)).toBe(long);
  });

  it("throws on a byte it does not understand instead of guessing", () => {
    expect(() => msgDecode(Buffer.from([0xc1]))).toThrow(/0xc1/);
  });
});
