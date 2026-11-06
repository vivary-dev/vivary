import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CFB, utils, write } from "xlsx";
import "../server/plugins/00-xlsx-codepages.mjs";
import { parseOfficeDocument } from "@agent-native/core/ingestion";

const workbench = fileURLToPath(new URL("../", import.meta.url));
const core = realpathSync(path.join(workbench, "node_modules/@agent-native/core"));
const xlsxPackageFrom = (directory) => path.dirname(createRequire(path.join(directory, "package.json")).resolve("xlsx"));

const record = (type, body) => {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(body.length, 2);
  return Buffer.concat([header, body]);
};
const words = (...values) => {
  const body = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => body.writeUInt16LE(value, index * 2));
  return body;
};

// An Excel 95 (BIFF5) workbook stores text as 8-bit bytes in the CODEPAGE record's encoding.
// This one declares Windows-1251 and holds one LABEL cell with the bytes for "Привет".
function biff5Workbook() {
  const bof = (kind) => record(0x0809, words(0x0500, kind, 0x0dbb, 0x07cc));
  const sheetName = Buffer.from("Sheet1", "latin1");
  const boundSheet = (offset) => {
    const body = Buffer.alloc(7 + sheetName.length);
    body.writeUInt32LE(offset, 0);
    body.writeUInt8(sheetName.length, 6);
    sheetName.copy(body, 7);
    return record(0x0085, body);
  };
  const globals = (offset) => Buffer.concat([bof(0x0005), record(0x0042, words(1251)), boundSheet(offset), record(0x000a, Buffer.alloc(0))]);
  const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
  const sheet = Buffer.concat([
    bof(0x0010),
    record(0x0200, words(0, 1, 0, 1, 0)),
    record(0x0204, Buffer.concat([words(0, 0, 0, cp1251.length), cp1251])),
    record(0x000a, Buffer.alloc(0)),
  ]);
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, "Book", Buffer.concat([globals(globals(0).length), sheet]));
  return CFB.write(container, { type: "buffer" });
}

test("Core decodes Windows-1251 text in an Excel 95 workbook once Workbench loads the codepages", async () => {
  const result = await parseOfficeDocument({ fileName: "legacy.xls", mimeType: "application/vnd.ms-excel", data: biff5Workbook() });
  assert.equal(result.fileType, "xls");
  assert.match(result.text, /Привет/);
  assert.doesNotMatch(result.text, /Ïðèâåò/);
});

test("Core still reads Unicode text from a current XLSX workbook", async () => {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet([["Привет", "café", 42]]), "Данные");
  const result = await parseOfficeDocument({
    fileName: "current.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    data: write(book, { bookType: "xlsx", type: "buffer" }),
  });
  assert.equal(result.fileType, "xlsx");
  assert.match(result.text, /Данные/);
  assert.match(result.text, /Привет/);
  assert.match(result.text, /café/);
});

test("Workbench and Core resolve the same xlsx package, so the codepages reach Core's parser", () => {
  assert.equal(xlsxPackageFrom(core), xlsxPackageFrom(workbench));
});
