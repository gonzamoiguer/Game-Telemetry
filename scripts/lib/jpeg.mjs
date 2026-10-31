// Minimal baseline JPEG encoder for placeholder screenshots (seed and smoke).
// Each 8×8 block is one flat colour, so only DC coefficients are coded.
// Good enough for test images, and needs no dependencies.

const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // a single code: end-of-block
const AC_VALUES = [0];
const Q = 8; // quantiser for every coefficient; DC = 8 × (level − 128), so DC / Q = level − 128

/** Canonical Huffman codes (JPEG spec, Annex C). */
function huffman(bits, values) {
  const codes = new Map();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < bits[length - 1]; i++) codes.set(values[k++], { code: code++, length });
    code <<= 1;
  }
  return codes;
}

class BitWriter {
  bytes = [];
  acc = 0;
  count = 0;
  write(value, length) {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      if (++this.count === 8) this.flushByte();
    }
  }
  flushByte() {
    this.bytes.push(this.acc);
    if (this.acc === 0xff) this.bytes.push(0); // byte stuffing
    this.acc = 0;
    this.count = 0;
  }
  finish() {
    while (this.count !== 0) this.write(1, 1); // pad with ones
    return this.bytes;
  }
}

const segment = (marker, payload) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];

/**
 * Encodes an image whose width and height are multiples of 8.
 * `pixel(bx, by)` returns [r, g, b] for the 8×8 block at block coordinates (bx, by).
 */
export function encodeJpeg(width, height, pixel) {
  const dc = huffman(DC_BITS, DC_VALUES);
  const eob = huffman(AC_BITS, AC_VALUES).get(0);
  const out = new BitWriter();
  const pred = [0, 0, 0];

  for (let by = 0; by < height / 8; by++) {
    for (let bx = 0; bx < width / 8; bx++) {
      const [r, g, b] = pixel(bx, by);
      const ycc = [
        0.299 * r + 0.587 * g + 0.114 * b,
        128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
        128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
      ];
      ycc.forEach((level, c) => {
        const value = Math.max(-128, Math.min(127, Math.round(level - 128)));
        const diff = value - pred[c];
        pred[c] = value;
        const size = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
        const code = dc.get(size);
        out.write(code.code, code.length);
        if (size) out.write(diff > 0 ? diff : diff + (1 << size) - 1, size);
        out.write(eob.code, eob.length);
      });
    }
  }

  const jfif = [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const dqt = [0, ...new Array(64).fill(Q)];
  const sof = [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0];
  const dht = [0x00, ...DC_BITS, ...DC_VALUES, 0x10, ...AC_BITS, ...AC_VALUES];
  const sos = [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0];
  return new Uint8Array([
    0xff, 0xd8,
    ...segment(0xe0, jfif),
    ...segment(0xdb, dqt),
    ...segment(0xc0, sof),
    ...segment(0xc4, dht),
    ...segment(0xda, sos),
    ...out.finish(),
    0xff, 0xd9,
  ]);
}
