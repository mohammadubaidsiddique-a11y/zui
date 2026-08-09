import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Codec Lab: encodes, inspects, verifies and reconstructs a real file in the browser", async ({ page }) => {
  await page.goto("/#/zui-lab");
  await expect(page.getByRole("heading", { name: "Codec Lab" })).toBeVisible();

  // Create a real multi-chunk fixture (3 MiB → 2 chunks at 2 MiB).
  const dir = await mkdtemp(join(tmpdir(), "zui-e2e-"));
  const fixturePath = join(dir, "roundtrip.bin");
  const chunk = new Uint8Array(1024 * 1024);
  for (let i = 0; i < chunk.length; i += 1) chunk[i] = i % 251;
  const fileBytes = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < 3; i += 1) fileBytes.set(chunk, i * 1024 * 1024);
  const { createHash } = await import("node:crypto");
  const expectedSha = createHash("sha256").update(fileBytes).digest("hex");
  await writeFile(fixturePath, fileBytes);

  await page.setInputFiles("#lab-file-input", fixturePath);

  await page.getByRole("button", { name: "Analyze & Encode" }).click();

  // Container panel appears with the original SHA-256.
  await expect(page.getByText("Chunk count", { exact: true })).toBeVisible();
  await expect(page.locator("dt").filter({ hasText: "Original SHA-256" }).locator("..").getByText(expectedSha)).toBeVisible({ timeout: 30_000 });

  // Integrity verdicts all OK.
  await expect(page.getByText(/container verify: valid/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/reconstructed SHA-256 == original SHA-256: exact match/)).toBeVisible();
  await expect(page.getByText(/independent WebCrypto SHA-256 == codec SHA-256: match/)).toBeVisible();
  await expect(page.getByText(/corrupted copy rejected: detected/)).toBeVisible();
  await expect(page.getByText(/✓ Transfer-in-a-box complete/)).toBeVisible();

  // Reconstructed download is offered once integrity holds.
  await expect(page.getByRole("button", { name: "Download reconstructed original" })).toBeVisible();

  // Clicking it must actually produce a browser download of the original file.
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download reconstructed original" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("roundtrip.bin");
});