/** Minimal MessagePack decoder for the game's .msg files. Maps decode to
 * [key, value] pair lists, not objects: duplicate keys are the norm (one
 * "ActionInfo" entry per action). Shared by gen-game-icons.mjs and
 * gen-skill-name-sources.mjs, which read the same
 * `system/player/data/pl####/pl####_action.msg` dump. */
export const msgDecode = (buf) => {
  let p = 0;
  const str = (n) => {
    const v = buf.toString("utf8", p, p + n);
    p += n;
    return v;
  };
  const arr = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(read());
    return out;
  };
  const map = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const k = read();
      out.push([k, read()]);
    }
    return out;
  };
  const read = () => {
    const b = buf[p++];
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if (b >= 0xa0 && b <= 0xbf) return str(b - 0xa0);
    if (b >= 0x80 && b <= 0x8f) return map(b - 0x80);
    if (b >= 0x90 && b <= 0x9f) return arr(b - 0x90);
    switch (b) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xca: {
        const v = buf.readFloatBE(p);
        p += 4;
        return v;
      }
      case 0xcb: {
        const v = buf.readDoubleBE(p);
        p += 8;
        return v;
      }
      case 0xcc:
        return buf[p++];
      case 0xcd: {
        const v = buf.readUInt16BE(p);
        p += 2;
        return v;
      }
      case 0xce: {
        const v = buf.readUInt32BE(p);
        p += 4;
        return v;
      }
      case 0xd0:
        return buf.readInt8(p++);
      case 0xd1: {
        const v = buf.readInt16BE(p);
        p += 2;
        return v;
      }
      case 0xd2: {
        const v = buf.readInt32BE(p);
        p += 4;
        return v;
      }
      case 0xd9:
        return str(buf[p++]);
      case 0xda: {
        const n = buf.readUInt16BE(p);
        p += 2;
        return str(n);
      }
      case 0xdc: {
        const n = buf.readUInt16BE(p);
        p += 2;
        return arr(n);
      }
      case 0xdd: {
        const n = buf.readUInt32BE(p);
        p += 4;
        return arr(n);
      }
      case 0xde: {
        const n = buf.readUInt16BE(p);
        p += 2;
        return map(n);
      }
      case 0xdf: {
        const n = buf.readUInt32BE(p);
        p += 4;
        return map(n);
      }
      default:
        throw new Error(`unhandled msgpack byte 0x${b.toString(16)} at ${p - 1}`);
    }
  };
  return read();
};
