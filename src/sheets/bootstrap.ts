// Idempotent workbook bootstrap.
// Run with: npm run bootstrap-sheet  (or: tsx src/sheets/bootstrap.ts)
//
// For each of the four required tabs:
//   - if tab is missing, create it
//   - if header row is empty, write headers
//   - if header row matches expected, do nothing
//   - if header row is present but mismatched, fail loudly with a diff

import "dotenv/config";
import { getSheetsClient, headerRange } from "./client.js";
import { ALL_TABS } from "@curacel/shared";

type TabAction = "created" | "headers-written" | "ok";

interface TabResult {
  tab: string;
  action: TabAction;
}

async function ensureTab(tabName: string): Promise<boolean> {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets ?? []).some(
    (s) => s.properties?.title === tabName,
  );
  if (exists) return false;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  });
  return true;
}

async function readHeaderRow(
  tabName: string,
  numCols: number,
): Promise<string[]> {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: headerRange(tabName, numCols),
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const row = (res.data.values?.[0] ?? []) as unknown[];
  return row.map((v) => (v === undefined || v === null ? "" : String(v)));
}

async function writeHeaderRow(
  tabName: string,
  headers: readonly string[],
): Promise<void> {
  const { sheets, spreadsheetId } = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: headerRange(tabName, headers.length),
    valueInputOption: "RAW",
    requestBody: { values: [headers as string[]] },
  });
}

function formatHeaderDiff(
  expected: readonly string[],
  actual: readonly string[],
): string {
  const lines: string[] = [];
  const max = Math.max(expected.length, actual.length);
  for (let i = 0; i < max; i++) {
    const e = expected[i] ?? "(missing)";
    const a = actual[i] ?? "(missing)";
    const marker = e === a ? " " : "!";
    lines.push(`  ${marker} col ${i}: expected=${JSON.stringify(e)} actual=${JSON.stringify(a)}`);
  }
  return lines.join("\n");
}

async function bootstrapTab(
  tabName: string,
  headers: readonly string[],
): Promise<TabResult> {
  const created = await ensureTab(tabName);

  const headerRow = await readHeaderRow(tabName, headers.length);
  const isEmpty = headerRow.every((c) => c === "");

  if (isEmpty) {
    await writeHeaderRow(tabName, headers);
    return { tab: tabName, action: created ? "created" : "headers-written" };
  }

  // Compare cell-by-cell up to the schema length.
  const matches =
    headerRow.length >= headers.length &&
    headers.every((h, i) => headerRow[i] === h);
  if (!matches) {
    const diff = formatHeaderDiff(headers, headerRow);
    throw new Error(
      `Header mismatch on tab "${tabName}":\n${diff}\n` +
        `Refusing to overwrite. Fix the sheet manually or rename the tab and re-run bootstrap.`,
    );
  }
  return { tab: tabName, action: created ? "created" : "ok" };
}

export async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("[bootstrap] connecting to Google Sheets...");
  await getSheetsClient(); // surface auth errors early

  const results: TabResult[] = [];
  for (const { name, headers } of ALL_TABS) {
    // eslint-disable-next-line no-console
    console.log(`[bootstrap] checking tab "${name}"...`);
    const r = await bootstrapTab(name, headers);
    results.push(r);
  }

  // eslint-disable-next-line no-console
  console.log("\n[bootstrap] summary:");
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`  - ${r.tab}: ${r.action}`);
  }
  // eslint-disable-next-line no-console
  console.log("[bootstrap] done.");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
