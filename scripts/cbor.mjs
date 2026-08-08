/** Minimal CBOR reader for stored encounter blobs (`Encounter::to_blob` is
 * cbor4ii + zstd). Returns a cursor rather than a bare value: the size report
 * needs the byte span of individual `rawEventLog` elements to charge bytes to
 * an event type, and that is only knowable while decoding.
 *
 * The encode side is deliberately only headers and text. The savings
 * simulation rebuilds blobs by splicing the ORIGINAL byte spans of the fields
 * it keeps, so it never has to re-encode a value — which means it cannot
 * accidentally measure the difference between cbor4ii's float encoding and
 * ours instead of the saving it is trying to measure. */

const half = (u) => {
  const sign = u & 0x8000 ? -1 : 1;
  const exp = (u >> 10) & 0x1f;
  const mant = u & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
};

const BREAK = Symbol("cbor-break");

/** A decoding cursor over `buf`. `read()` consumes one item; `pos()`/`seek()`
 * expose the offset so callers can measure what a read cost. */
export const cborReader = (buf) => {
  let p = 0;

  const count = (ai) => {
    if (ai < 24) return ai;
    if (ai === 24) return buf[p++];
    if (ai === 25) {
      const v = buf.readUInt16BE(p);
      p += 2;
      return v;
    }
    if (ai === 26) {
      const v = buf.readUInt32BE(p);
      p += 4;
      return v;
    }
    if (ai === 27) {
      const v = buf.readBigUInt64BE(p);
      p += 8;
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    if (ai === 31) return -1; // indefinite length
    throw new Error(`bad additional info ${ai} at ${p - 1}`);
  };

  const chunks = (join) => {
    const parts = [];
    while (buf[p] !== 0xff) {
      const v = read();
      if (v === BREAK) break;
      parts.push(v);
    }
    p++;
    return join(parts);
  };

  const read = () => {
    const ib = buf[p++];
    const mt = ib >> 5;
    const ai = ib & 0x1f;
    switch (mt) {
      case 0:
        return count(ai);
      case 1: {
        const n = count(ai);
        return typeof n === "bigint" ? -1n - n : -1 - n;
      }
      case 2: {
        const n = count(ai);
        if (n < 0) return chunks((ps) => Buffer.concat(ps));
        const b = buf.subarray(p, p + n);
        p += n;
        return b;
      }
      case 3: {
        const n = count(ai);
        if (n < 0) return chunks((ps) => ps.join(""));
        const s = buf.toString("utf8", p, p + n);
        p += n;
        return s;
      }
      case 4: {
        const n = count(ai);
        if (n < 0) return chunks((ps) => ps);
        const out = [];
        for (let i = 0; i < n; i++) out.push(read());
        return out;
      }
      case 5: {
        const n = count(ai);
        const out = {};
        if (n < 0) {
          while (buf[p] !== 0xff) {
            const k = read();
            if (k === BREAK) break;
            out[k] = read();
          }
          p++;
          return out;
        }
        for (let i = 0; i < n; i++) {
          const k = read();
          out[k] = read();
        }
        return out;
      }
      case 6:
        count(ai); // tag number: the stored format carries no semantic tags
        return read();
      default:
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22) return null;
        if (ai === 23) return undefined;
        if (ai === 25) {
          const v = half(buf.readUInt16BE(p));
          p += 2;
          return v;
        }
        if (ai === 26) {
          const v = buf.readFloatBE(p);
          p += 4;
          return v;
        }
        if (ai === 27) {
          const v = buf.readDoubleBE(p);
          p += 8;
          return v;
        }
        if (ai === 31) return BREAK;
        throw new Error(`unhandled simple value ${ai} at ${p - 1}`);
    }
  };

  return {
    read,
    pos: () => p,
    seek: (n) => {
      p = n;
    },
    /** Header of the container at `at`: its element count and first payload
     * offset, without consuming the elements. Definite-length only — the
     * encoder never emits indefinite containers, so a `null` count means the
     * caller should fall back to a plain `read()`. */
    header: (at) => {
      const ai = buf[at] & 0x1f;
      if (ai === 31) return { count: null, start: at + 1 };
      const save = p;
      p = at + 1;
      const n = count(ai);
      const start = p;
      p = save;
      return { count: n, start };
    },
  };
};

export const cborDecode = (buf) => cborReader(buf).read();

/** Major-type header for a value of length/count `n`. */
export const encodeHead = (mt, n) => {
  if (n < 24) return Buffer.from([(mt << 5) | n]);
  if (n < 0x100) return Buffer.from([(mt << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (mt << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  if (n < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = (mt << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = (mt << 5) | 27;
  b.writeBigUInt64BE(BigInt(Math.trunc(n)), 1);
  return b;
};

/** Re-encodes a value as a CBOR float32, the same shape cbor4ii writes for a
 * Rust f32. Lets the simulation model "round the number but keep the field's
 * type", which is the only version of quantizing that keeps stored logs
 * readable — cbor4ii dispatches on the stored value's own type, so a field that
 * changes f32 -> u16 rejects every log written before the change. */
export const encodeFloat32 = (n) => {
  const b = Buffer.alloc(5);
  b[0] = 0xfa;
  b.writeFloatBE(n, 1);
  return b;
};

export const encodeText = (s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([encodeHead(3, b.length), b]);
};

/** True for a map that is a serde struct rather than an enum: serde writes an
 * enum as a single-key map named after the Rust variant (capitalised), and a
 * struct as a map of camelCase field names. */
export const isStructMap = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  !Buffer.isBuffer(v) &&
  Object.keys(v).length > 0 &&
  Object.keys(v).every((k) => /^[a-z]/.test(k));
