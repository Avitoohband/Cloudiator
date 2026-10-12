import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../../assets/source/tools/png.mjs';

function checkerboard(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const on = (x + y) % 2 === 0;
      rgba.set(on ? [217, 168, 91, 255] : [31, 127, 134, x % 3 === 0 ? 0 : 128], i);
    }
  }
  return rgba;
}

describe('png tools', () => {
  it('encodes a valid PNG signature and header', () => {
    const png = encodePng(3, 2, checkerboard(3, 2));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(3);
    expect(png.readUInt32BE(20)).toBe(2);
  });

  it('round-trips RGBA pixels exactly, including transparency', () => {
    const pixels = checkerboard(17, 9);
    const decoded = decodePng(encodePng(17, 9, pixels));
    expect(decoded.width).toBe(17);
    expect(decoded.height).toBe(9);
    expect([...decoded.rgba]).toEqual([...pixels]);
  });

  it('produces identical bytes for identical pixels', () => {
    const pixels = checkerboard(8, 8);
    expect(encodePng(8, 8, pixels).equals(encodePng(8, 8, pixels))).toBe(true);
  });

  it('rejects data that is not a PNG', () => {
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(/PNG signature/);
  });

  it('rejects a pixel buffer whose size does not match the dimensions', () => {
    expect(() => encodePng(4, 4, new Uint8Array(10))).toThrow(/expected 64 bytes/);
  });
});
