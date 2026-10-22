import { expect, test, type Browser, type Page } from '@playwright/test';

interface Doc {
  id: string;
  editToken: string;
  viewToken: string;
}

interface NodeSummary {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  text: string;
  fill: string | null;
}

async function newDoc(page: Page): Promise<Doc> {
  const res = await page.request.post('/api/docs', { data: { name: 'E2E' } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as Doc;
}

/** Opens the document in a fresh browser context (a separate person). */
async function open(
  browser: Browser,
  doc: Doc,
  role: 'edit' | 'view',
  name: string,
): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript((n) => localStorage.setItem('tandem.name', JSON.stringify(n)), name);
  const page = await context.newPage();
  const token = role === 'edit' ? doc.editToken : doc.viewToken;
  await page.goto(`/d/${doc.id}#${role}=${token}`);
  await expect(page.getByTestId('status')).toContainText('Saved');
  return page;
}

function nodes(page: Page): Promise<NodeSummary[]> {
  return page.evaluate(() => {
    const editor = (
      window as unknown as { __tandem: { doc: { entries(): Iterable<[string, NodeSummary]> } } }
    ).__tandem;
    return [...editor.doc.entries()].map(([id, p]) => ({
      id,
      type: p.type,
      name: p.name,
      x: p.x,
      y: p.y,
      text: p.text,
      fill: p.fill,
    }));
  });
}

async function drawRect(page: Page, from: [number, number], to: [number, number]) {
  const canvas = page.getByTestId('canvas');
  const box = (await canvas.boundingBox())!;
  await page.keyboard.press('r');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 });
  await page.mouse.up();
}

test('two editors see each other’s shapes, cursors and presence', async ({ browser, page }) => {
  const doc = await newDoc(page);
  const ada = await open(browser, doc, 'edit', 'Ada');
  const bob = await open(browser, doc, 'edit', 'Bob');

  await expect(ada.getByRole('button', { name: 'Follow Bob' })).toBeVisible();
  await drawRect(ada, [200, 200], [320, 300]);
  await expect.poll(async () => (await nodes(bob)).length, { timeout: 1000 }).toBe(1);

  // Bob recolours it while Ada moves it: both edits survive.
  const [rect] = await nodes(bob);
  await bob.evaluate(
    (id) =>
      (
        window as unknown as { __tandem: { setProps(v: object, ids: string[]): void } }
      ).__tandem.setProps({ fill: '#ff0000ff' }, [id]),
    rect!.id,
  );
  const canvas = ada.getByTestId('canvas');
  const box = (await canvas.boundingBox())!;
  await ada.mouse.move(box.x + 260, box.y + 250);
  await ada.mouse.down();
  await ada.mouse.move(box.x + 400, box.y + 350, { steps: 8 });
  await ada.mouse.up();

  await expect
    .poll(async () => JSON.stringify(await nodes(ada)) === JSON.stringify(await nodes(bob)))
    .toBe(true);
  const [final] = await nodes(ada);
  expect(final!.fill).toBe('#ff0000ff');
  expect(final!.x).toBeGreaterThan(rect!.x + 100);
});

test('edits made offline sync after reconnecting', async ({ browser, page }) => {
  const doc = await newDoc(page);
  const ada = await open(browser, doc, 'edit', 'Ada');
  const bob = await open(browser, doc, 'edit', 'Bob');

  // Browser offline emulation ignores localhost in CI's Chromium, so cut the
  // connection through the app's own test hook.
  const setOffline = (offline: boolean) =>
    ada.evaluate(
      (o) =>
        (
          window as unknown as { __tandemConnection: { simulateOffline(o: boolean): void } }
        ).__tandemConnection.simulateOffline(o),
      offline,
    );
  await setOffline(true);
  await expect(ada.getByTestId('status')).toContainText(/Offline|Reconnecting/);
  await drawRect(ada, [150, 150], [250, 250]);
  await drawRect(ada, [300, 150], [400, 250]);
  await expect(ada.getByTestId('status')).toContainText('unsynced');
  expect(await nodes(bob)).toHaveLength(0);

  await setOffline(false);
  await expect(ada.getByTestId('status')).toContainText('Saved', { timeout: 15_000 });
  await expect.poll(async () => (await nodes(bob)).length).toBe(2);
});

test('view-only links cannot change the document', async ({ browser, page }) => {
  const doc = await newDoc(page);
  const viewer = await open(browser, doc, 'view', 'Vic');
  await expect(viewer.getByText('View only')).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Rectangle' })).toBeDisabled();
  await drawRect(viewer, [200, 200], [300, 300]);
  expect(await nodes(viewer)).toHaveLength(0);
});

test('undo and redo travel to collaborators', async ({ browser, page }) => {
  const doc = await newDoc(page);
  const ada = await open(browser, doc, 'edit', 'Ada');
  const bob = await open(browser, doc, 'edit', 'Bob');
  await drawRect(ada, [200, 200], [300, 300]);
  await expect.poll(async () => (await nodes(bob)).length).toBe(1);
  await ada.keyboard.press('Control+z');
  await expect.poll(async () => (await nodes(bob)).length).toBe(0);
  await ada.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await nodes(bob)).length).toBe(1);
});

test('text editing streams live, including IME input', async ({ browser, page }) => {
  const doc = await newDoc(page);
  const ada = await open(browser, doc, 'edit', 'Ada');
  const bob = await open(browser, doc, 'edit', 'Bob');
  const box = (await ada.getByTestId('canvas').boundingBox())!;
  await ada.keyboard.press('t');
  await ada.mouse.click(box.x + 300, box.y + 300);
  await ada.getByLabel('Edit text').pressSequentially('Hello ');
  await ada.keyboard.insertText('你好');
  await expect.poll(async () => (await nodes(bob))[0]?.text).toBe('Hello 你好');
  await ada.keyboard.press('Escape');
  await expect(ada.getByLabel('Edit text')).toHaveCount(0);
});

test('a layer deleted mid-drag cancels the drag gracefully', async ({ browser, page }) => {
  const doc = await newDoc(page);
  const ada = await open(browser, doc, 'edit', 'Ada');
  const bob = await open(browser, doc, 'edit', 'Bob');
  await drawRect(ada, [200, 200], [300, 300]);
  await expect.poll(async () => (await nodes(bob)).length).toBe(1);

  const box = (await ada.getByTestId('canvas').boundingBox())!;
  await ada.mouse.move(box.x + 250, box.y + 250);
  await ada.mouse.down();
  await ada.mouse.move(box.x + 300, box.y + 300, { steps: 4 });
  await bob.getByTestId('canvas').click({ position: { x: 250, y: 250 } });
  await bob.keyboard.press('Delete');
  await expect(ada.getByText(/deleted by Bob/)).toBeVisible();
  await ada.mouse.move(box.x + 350, box.y + 350, { steps: 4 });
  await ada.mouse.up();
  await expect.poll(async () => (await nodes(ada)).length).toBe(0);
});

test('cursor chat near the edge reaches others without shifting the canvas', async ({
  browser,
  page,
}) => {
  const doc = await newDoc(page);
  const ada = await open(browser, doc, 'edit', 'Ada');
  const bob = await open(browser, doc, 'edit', 'Bob');
  const box = (await ada.getByTestId('canvas').boundingBox())!;
  // Near the right edge, clear of the zoom badge in the bottom-right corner.
  await ada.mouse.move(box.x + box.width - 30, box.y + box.height - 80);
  const before = await ada.evaluate(() =>
    JSON.stringify((window as unknown as { __tandem: { view: unknown } }).__tandem.view),
  );
  await ada.keyboard.press('/');
  await ada.keyboard.type('Hello!');
  const peerChat = () =>
    bob.evaluate(() => {
      const editor = (
        window as unknown as {
          __tandem: { sync: { peers: Map<string, { presence: { chat: string | null } }> } };
        }
      ).__tandem;
      return [...editor.sync.peers.values()][0]?.presence.chat ?? null;
    });
  await expect.poll(peerChat).toBe('Hello!');
  expect(await ada.locator('.canvas-wrap').evaluate((el) => el.scrollLeft + el.scrollTop)).toBe(0);
  expect(
    await ada.evaluate(() =>
      JSON.stringify((window as unknown as { __tandem: { view: unknown } }).__tandem.view),
    ),
  ).toBe(before);
});
