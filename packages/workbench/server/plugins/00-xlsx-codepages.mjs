import { defineNitroPlugin } from "@agent-native/core/server";
import { set_cptable } from "xlsx";
import * as codepages from "xlsx/dist/cpexcel.full.mjs";

// Issue #23. The xlsx 0.20.3 ES module starts without codepage tables, unlike the 0.18.5
// CommonJS build it replaces. Without them, Core's spreadsheet parser misreads 8-bit text in
// Excel 95 and older workbooks. Core and Workbench resolve one xlsx package, so loading the
// SheetJS tables here, before any upload is parsed, covers Core's parser.
set_cptable(codepages);

export default defineNitroPlugin(() => undefined);
