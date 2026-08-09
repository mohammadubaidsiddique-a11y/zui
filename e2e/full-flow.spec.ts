import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

test("Send: wrap → download .zui → restore → download original, no zero-byte files", async ({ page }) => {
  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));

  const dir = await mkdtemp(join(tmpdir(), "zui-e2e-full-"));
  const fixturePath = join(dir, "report.tar");
  const fileBytes = new Uint8Array(8 * 1024 * 1024 + 1234);
  for (let i = 0; i < fileBytes.length; i += 1) fileBytes[i] = (i * 31 + 7) % 251;
  await writeFile(fixturePath, fileBytes);
  const expectedSha = sha256(Buffer.from(fileBytes));

  await page.goto("/");
  await page.setInputFiles("#wrap-input", fixturePath);

  // Grab whichever .zui download fires (auto-download or button click).
  const wrapDownloadExpected = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Download report.tar.zui" }).click();
  const wrapDownload = await wrapDownloadExpected
    .then((d) => (d.suggestedFilename().endsWith(".zui") ? d : null))
    .catch(() => null);
  expect(wrapDownload, "container download should fire").not.toBeNull();
  const zuiPath = join(dir, "report.tar.zui");
  await wrapDownload!.saveAs(zuiPath);
  const zuiStat = await stat(zuiPath);
  console.log("ZUI SIZE", zuiStat.size);
  expect(zuiStat.size).toBeGreaterThan(0);

  await page.setInputFiles("#conv-input", zuiPath);
  const restoredBtn = page.getByRole("button", { name: "Download report.tar", exact: true });
  await expect(restoredBtn).toBeVisible({ timeout: 120_000 });

  const restoreDownload = page.waitForEvent("download", { timeout: 60_000 });
  await restoredBtn.click();
  const dl = await restoreDownload;
  expect(dl.suggestedFilename()).toBe("report.tar");
  const restoredPath = join(dir, "report-restored.tar");
  await dl.saveAs(restoredPath);
  const restoredStat = await stat(restoredPath);
  console.log("RESTORED SIZE", restoredStat.size, "ORIGINAL SIZE", fileBytes.length);
  expect(restoredStat.size).toBe(fileBytes.length);
  expect(sha256(await readFile(restoredPath))).toBe(expectedSha);
});