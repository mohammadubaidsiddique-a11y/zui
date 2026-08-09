import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

function makeFixture(bytes: number): Uint8Array {
  const fileBytes = new Uint8Array(bytes);
  for (let i = 0; i < fileBytes.length; i += 1) fileBytes[i] = (i * 31 + 7) % 251;
  return fileBytes;
}

async function runRoundTrip(page: import("@playwright/test").Page, fixturePath: string, fileName: string, expectedSha: string) {
  const dls: import("@playwright/test").Download[] = [];
  page.on("download", (d) => dls.push(d));

  await page.goto("/");
  await page.setInputFiles("#wrap-input", fixturePath);

  await page.getByRole("button", { name: `Download ${fileName}.zui` }).click();
  await expect
    .poll(() => dls.find((d) => d.suggestedFilename().endsWith(".zui")), { timeout: 120_000 })
    .not.toBeUndefined();
  const wrapDownload = dls.find((d) => d.suggestedFilename().endsWith(".zui"))!;
  const zuiPath = join(join(fixturePath, ".."), `${fileName}.zui`);
  await wrapDownload.saveAs(zuiPath);
  const zuiStat = await stat(zuiPath);
  expect(zuiStat.size).toBeGreaterThan(0);

  await page.setInputFiles("#conv-input", zuiPath);
  const restoredBtn = page.getByRole("button", { name: `Download ${fileName}`, exact: true });
  await expect(restoredBtn).toBeVisible({ timeout: 120_000 });

  await restoredBtn.click();
  await expect
    .poll(() => dls.find((d) => d.suggestedFilename() === fileName), { timeout: 120_000 })
    .not.toBeUndefined();
  const dl = dls.find((d) => d.suggestedFilename() === fileName)!;
  const restoredPath = join(join(fixturePath, ".."), `${fileName}-restored`);
  await dl.saveAs(restoredPath);
  const restoredStat = await stat(restoredPath);
  const originalStat = await stat(fixturePath);
  expect(restoredStat.size).toBe(originalStat.size);
  expect(sha256(await readFile(restoredPath))).toBe(expectedSha);
}

test("Send: 8 MiB round trip, byte-exact, no zero-byte downloads", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "zui-e2e-full-"));
  const fixturePath = join(dir, "report.tar");
  const fileBytes = makeFixture(8 * 1024 * 1024 + 1234);
  await writeFile(fixturePath, fileBytes);
  await runRoundTrip(page, fixturePath, "report.tar", sha256(Buffer.from(fileBytes)));
});

test("Send: 200 MiB round trip via chunked upload (server route), byte-exact", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "zui-e2e-big-"));
  const fixturePath = join(dir, "video.mp4");
  const fileBytes = makeFixture(200 * 1024 * 1024);
  await writeFile(fixturePath, fileBytes);
  await runRoundTrip(page, fixturePath, "video.mp4", sha256(Buffer.from(fileBytes)));
});