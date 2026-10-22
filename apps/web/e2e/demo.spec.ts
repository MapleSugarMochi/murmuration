import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

// gifenc is CommonJS; its functions hang off the default export.
const { GIFEncoder, applyPalette, quantize } = gifenc;

/**
 * Records docs/demo.gif: two people editing one document side by side.
 *   DEMO=1 pnpm e2e demo
 * Screenshots both windows ~10 times a second while a scripted session
 * runs, then stitches and encodes them in-process (no ffmpeg needed).
 */
test.skip(!process.env.DEMO, 'set DEMO=1 to record the README demo');

const VIEW = { width: 1100, height: 640 };
const SCALE = 0.6;
const GAP = 8;
const OUT = fileURLToPath(new URL('../../../docs/demo.gif', import.meta.url));

async function person(browser: Browser, url: string, name: string): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  await context.addInitScript(
    (n) => localStorage.setItem('murmuration.name', JSON.stringify(n)),
    name,
  );
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.getByTestId('status')).toContainText('Saved');
  return page;
}

/** Area-average downscale of an RGBA image. */
function downscale(src: PNG, scale: number): { data: Uint8Array; width: number; height: number } {
  const width = Math.round(src.width * scale);
  const height = Math.round(src.height * scale);
  const data = new Uint8Array(width * height * 4);
  const inv = 1 / scale;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * inv);
    const y1 = Math.min(src.height, Math.ceil((y + 1) * inv));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * inv);
      const x1 = Math.min(src.width, Math.ceil((x + 1) * inv));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i]!;
          g += src.data[i + 1]!;
          b += src.data[i + 2]!;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      data[o] = r / n;
      data[o + 1] = g / n;
      data[o + 2] = b / n;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

test('record the README demo', async ({ browser, page }) => {
  test.setTimeout(180_000);
  const res = await page.request.post('/api/docs', { data: { name: 'Product launch board' } });
  const doc = (await res.json()) as { id: string; editToken: string };
  const url = `/d/${doc.id}#edit=${doc.editToken}`;
  const ada = await person(browser, url, 'Ada');
  const bob = await person(browser, url, 'Bob');
  const canvas = async (p: Page) => (await p.getByTestId('canvas').boundingBox())!;
  const A = await canvas(ada);
  const B = await canvas(bob);

  // Capture both windows continuously while the script runs.
  const frames: Array<{ t: number; ada: Buffer; bob: Buffer }> = [];
  let recording = true;
  const recorder = (async () => {
    while (recording) {
      const t = Date.now();
      const [a, b] = await Promise.all([ada.screenshot(), bob.screenshot()]);
      frames.push({ t, ada: a, bob: b });
      await new Promise((r) => setTimeout(r, Math.max(0, 100 - (Date.now() - t))));
    }
  })();

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Pointer moves are spread over time so they span several captured frames
  // and remote cursors visibly glide.
  const at = new Map<Page, { x: number; y: number }>([
    [ada, { x: A.x + A.width / 2, y: A.y + A.height - 40 }],
    [bob, { x: B.x + B.width / 2, y: B.y + B.height - 40 }],
  ]);
  const move = async (p: Page, x: number, y: number, ms = 600) => {
    const from = at.get(p)!;
    const steps = Math.max(1, Math.round(ms / 30));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // ease in-out
      await p.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await pause(30);
    }
    at.set(p, { x, y });
  };
  const drag = async (p: Page, x0: number, y0: number, x1: number, y1: number, ms = 900) => {
    await move(p, x0, y0, 400);
    await p.mouse.down();
    await move(p, x1, y1, ms);
    await p.mouse.up();
  };
  const fillHex = async (p: Page, hex: string) => {
    const field = p.getByLabel('Hex colour').first();
    await field.click();
    await field.fill(hex);
    await field.press('Enter');
  };
  for (const [p, pos] of at) await p.mouse.move(pos.x, pos.y);

  await pause(600);
  // Ada draws a frame.
  await ada.keyboard.press('f');
  await drag(ada, A.x + 40, A.y + 50, A.x + 570, A.y + 520, 1200);
  await pause(400);

  // Bob adds a rectangle inside it and makes it orange.
  await bob.keyboard.press('r');
  await drag(bob, B.x + 80, B.y + 100, B.x + 260, B.y + 230);
  await fillHex(bob, 'F24E1E');
  await pause(400);

  // Ada adds an ellipse, colours it blue, then drags it while Bob watches.
  await ada.keyboard.press('o');
  await drag(ada, A.x + 330, A.y + 100, A.x + 450, A.y + 220);
  await fillHex(ada, '0D99FF');
  await pause(300);
  await drag(ada, A.x + 390, A.y + 160, A.x + 440, A.y + 320, 1200);
  await pause(400);

  // Bob writes a note.
  await bob.keyboard.press('t');
  await move(bob, B.x + 80, B.y + 330, 500);
  await bob.mouse.click(B.x + 80, B.y + 330);
  await bob.getByLabel('Edit text').pressSequentially('Ship it Friday?', { delay: 80 });
  await bob.keyboard.press('Escape');
  await pause(300);

  // Ada answers with cursor chat.
  await move(ada, A.x + 470, A.y + 420, 700);
  await ada.keyboard.press('/');
  await ada.keyboard.type('Yes, ship it!', { delay: 90 });
  await ada.keyboard.press('Enter');
  await move(bob, B.x + 300, B.y + 460, 800);
  await pause(1800);

  recording = false;
  await recorder;

  // Stitch side by side, downscale, and encode with per-frame palettes.
  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const left = downscale(PNG.sync.read(f.ada), SCALE);
    const right = downscale(PNG.sync.read(f.bob), SCALE);
    const width = left.width + GAP + right.width;
    const height = left.height;
    const rgba = new Uint8Array(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) {
      rgba.set(left.data.subarray(y * left.width * 4, (y + 1) * left.width * 4), y * width * 4);
      rgba.set(
        right.data.subarray(y * right.width * 4, (y + 1) * right.width * 4),
        (y * width + left.width + GAP) * 4,
      );
      // A dark divider between the two people.
      for (let x = left.width; x < left.width + GAP; x++) {
        const o = (y * width + x) * 4;
        rgba[o] = 24;
        rgba[o + 1] = 24;
        rgba[o + 2] = 27;
      }
    }
    // Optional stills for reviewing the result: DEMO_STILLS=<dir>.
    if (process.env.DEMO_STILLS && i % Math.ceil(frames.length / 6) === 0) {
      const still = new PNG({ width, height });
      still.data = Buffer.from(rgba);
      writeFileSync(
        `${process.env.DEMO_STILLS}/frame-${String(i).padStart(3, '0')}.png`,
        PNG.sync.write(still),
      );
    }
    const next = frames[i + 1]?.t ?? f.t + 1500;
    const palette = quantize(rgba, 256);
    gif.writeFrame(applyPalette(rgba, palette), width, height, {
      palette,
      delay: Math.max(20, next - f.t),
    });
  }
  gif.finish();
  writeFileSync(OUT, gif.bytes());
  console.log(
    `demo: ${frames.length} frames, ${(gif.bytes().length / 1e6).toFixed(1)} MB -> ${OUT}`,
  );
});
