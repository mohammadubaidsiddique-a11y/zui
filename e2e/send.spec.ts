import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeFixture(size: number, unit: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at += unit.byteLength) {
    const len = Math.min(unit.byteLength, size - at);
    bytes.set(unit.subarray(0, len), at);
  }
  return bytes;
}

test("Send: compress → travel → link, no stalling at 0%", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#share-file-input")).toBeAttached();

  // ~24 MiB compressible → ~12 chunks of 2 MiB.
  const dir = await mkdtemp(join(tmpdir(), "zui-send-e2e-"));
  const fixturePath = join(dir, "big.txt");
  const unit = new Uint8Array(20_000).fill(65); // "A"
  await writeFile(fixturePath, makeFixture(24 * 1024 * 1024, unit));

  await page.setInputFiles("#share-file-input", fixturePath);

  // Stage 1 — compress (analyzing). Active hashing phase is visible.
  await expect(page.getByText(/analyzing the file/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("1 · compress")).toBeVisible();

  // Stage 2 — travel. Progress advances off 0% (chunk counter ticks upward).
  await expect(page.getByText("2 · travel")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/compressing chunk \d+\/\d+/)).toBeVisible({ timeout: 60_000 });

  // Done: share link produced. "3 · restore" happens on the receiver page.
  await expect(page.getByText(/Upload complete/)).toBeVisible({ timeout: 30_000 });
  const link = await page.locator(".link-text").textContent();
  expect(link).toMatch(/\/receiver\?zui=/);
});