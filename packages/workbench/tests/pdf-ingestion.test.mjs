import assert from "node:assert/strict";
import test from "node:test";
import { parseOfficeDocument } from "@agent-native/core/ingestion";

// One Helvetica text line per page, with a byte-exact cross-reference table so
// PDF.js reads it without falling back to repair.
function pdfWithPages(lines) {
  const pageIds = lines.map((_, index) => 4 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${lines.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, line] of lines.entries()) {
    const content = `BT /F1 12 Tf 20 50 Td (${line}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  let body = "%PDF-1.7\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
  ].join("\n");
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`;
  return new TextEncoder().encode(`${body}${xref}\n${trailer}`);
}

const upload = (data) => ({ fileName: "report.pdf", mimeType: "application/pdf", data });

test("an uploaded PDF yields its text in page order through officeparser and PDF.js", async () => {
  const result = await parseOfficeDocument(upload(pdfWithPages(["First page text", "Second page text"])));
  assert.equal(result.fileType, "pdf");
  assert.equal(result.parser, "officeparser-pdf");
  assert.equal(result.text, "First page text\nSecond page text");
  assert.deepEqual(result.parts.map((part) => part.text), [result.text]);
});

test("a corrupt PDF upload is rejected as an invalid structure instead of empty text", async () => {
  await assert.rejects(
    parseOfficeDocument(upload(new TextEncoder().encode("%PDF-1.7\nnot a document\n%%EOF\n"))),
    { message: /Invalid PDF structure/ },
  );
});
