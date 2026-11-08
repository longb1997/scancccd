/**
 * Glare + sharpness of the luma (Y) plane inside [x0,x1) x [y0,y1), on a sparse grid.
 * Caller keeps a 1px margin to the buffer edge (the Laplacian reads neighbours).
 */
export function measureLuma(
  luma: Uint8Array,
  stride: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { glare: number; sharpness: number } {
  'worklet';
  const cols = 80;
  const rows = 50;
  const dx = (x1 - x0) / cols;
  const dy = (y1 - y0) / rows;
  let bright = 0;
  let sum = 0;
  let sumSq = 0;
  for (let j = 0; j < rows; j++) {
    const row = Math.floor(y0 + j * dy) * stride;
    for (let i = 0; i < cols; i++) {
      const p = row + Math.floor(x0 + i * dx);
      const c = luma[p];
      if (c >= 250) bright++;
      const lap =
        4 * c - luma[p - 1] - luma[p + 1] - luma[p - stride] - luma[p + stride];
      sum += lap;
      sumSq += lap * lap;
    }
  }
  const n = cols * rows;
  const mean = sum / n;
  return { glare: bright / n, sharpness: sumSq / n - mean * mean };
}
