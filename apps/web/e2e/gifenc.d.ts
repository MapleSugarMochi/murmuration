declare module 'gifenc' {
  export type Palette = number[][];
  export interface Encoder {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: { palette?: Palette; delay?: number; repeat?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  const gifenc: {
    GIFEncoder(): Encoder;
    quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number): Palette;
    applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette): Uint8Array;
  };
  export default gifenc;
}
