import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Static checks of the installer's safety contract. They read the NSIS source,
// so they run on any platform without makensis.
const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "installer", "vivary.nsi");
const source = await readFile(scriptPath, "utf8");
const lines = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^[;#]/.test(line));
const code = lines.join("\n");
const installDir = "$LOCALAPPDATA\\Programs\\Vivary";

function body(kind, name) {
  const opener = kind === "Section" ? `Section "${name}"` : `Function ${name}`;
  const end = kind === "Section" ? "SectionEnd" : "FunctionEnd";
  const start = lines.indexOf(opener);
  assert.ok(start >= 0, `${opener} exists`);
  return lines.slice(start + 1, lines.indexOf(end, start));
}
const functionBody = name => body("Function", name);
const sectionBody = name => body("Section", name);
const position = (block, line) => {
  const index = block.indexOf(line);
  assert.ok(index >= 0, `missing: ${line}`);
  return index;
};

test("installer runs per user without elevation", () => {
  assert.ok(lines.includes("RequestExecutionLevel user"));
  assert.doesNotMatch(code, /RequestExecutionLevel\s+(admin|highest)/i);
  assert.doesNotMatch(code, /SetShellVarContext\s+all/i);
  assert.doesNotMatch(code, /UserInfo::|UAC::/i);
});

test("install folder is fixed and cannot be redirected", () => {
  assert.ok(lines.includes(`InstallDir "${installDir}"`));
  assert.ok(functionBody(".onInit").includes(`StrCpy $INSTDIR "${installDir}"`), ".onInit overrides /D=");
  assert.doesNotMatch(code, /MUI_PAGE_DIRECTORY|InstallDirRegKey|PageEx\s+directory|Page\s+directory/i);
});

test("setup refuses 32-bit Windows before anything else", () => {
  assert.ok(lines.includes('!include "x64.nsh"'));
  const init = functionBody(".onInit");
  assert.equal(init[0], "${IfNot} ${RunningX64}", "the first check in .onInit");
  const end = position(init, "${EndIf}");
  assert.ok(init.slice(0, end).some(line => line.startsWith("MessageBox ") && line.includes("64-bit")));
  assert.ok(init.slice(0, end).includes("SetErrorLevel 2"), "exits non-zero");
  assert.ok(init.slice(0, end).includes("Quit"));
});

test("setup and the uninstaller hold one per-user mutex", () => {
  assert.ok(lines.includes('!define SETUP_MUTEX "Local\\VivarySetup"'));
  const mutex = functionBody("${PREFIX}AcquireSetupMutex");
  assert.equal(mutex[0], "System::Call 'kernel32::CreateMutexW(p 0, i 1, w \"${SETUP_MUTEX}\") p .r0 ?e'");
  assert.deepEqual(mutex.slice(1, 4), ["Pop $1", "StrCmp $0 0 busy", "IntCmp $1 183 busy"], "ERROR_ALREADY_EXISTS or no handle refuses");
  const busy = position(mutex, "busy:");
  assert.deepEqual(mutex.slice(busy + 2), ["SetErrorLevel 2", "Quit"], "a second instance exits non-zero");
  const init = functionBody(".onInit");
  assert.ok(position(init, "${EndIf}") < position(init, "Call AcquireSetupMutex"));
  assert.ok(position(init, "Call AcquireSetupMutex") < position(init, `StrCpy $INSTDIR "${installDir}"`));
  assert.equal(functionBody("un.onInit")[0], "Call un.AcquireSetupMutex", "the uninstaller takes the same mutex first");
});

test("a previous install without a list is refused, never cleaned up", () => {
  const install = sectionBody("Vivary");
  const noList = position(install, "IntCmp $R8 1 0 list_read list_read");
  assert.ok(position(install, "Call RemoveInstalledFiles") < noList);
  assert.ok(noList < position(install, 'IfFileExists "$INSTDIR\\${SETUP_MARKER}" copy_files no_list'));
  assert.ok(noList < position(install, "IntCmp $R7 0 copy_files"));
  const label = position(install, "no_list:");
  assert.deepEqual(install.slice(label + 1, label + 3), [
    'MessageBox MB_OK|MB_ICONSTOP "$INSTDIR ${NO_LIST_TEXT}" /SD IDOK',
    'Abort "The installed-file list is missing. Nothing was changed."',
  ]);
  assert.ok(label < position(install, "copy_files:"));
  const text = lines.find(line => line.startsWith("!define NO_LIST_TEXT "));
  assert.match(text, /Remove that folder by hand\. Your projects, conversations and settings are stored elsewhere and are not affected\./);
  assert.ok(sectionBody("Uninstall").includes('MessageBox MB_OK|MB_ICONSTOP "$INSTDIR ${NO_LIST_TEXT}" /SD IDOK'));
});

test("a new folder gets setup's marker before any payload file, and a rerun accepts it", () => {
  assert.ok(lines.includes('!define SETUP_MARKER "vivary-setup.txt"'));
  const install = sectionBody("Vivary");
  // Only an absent or emptied folder takes the new-folder path and the marker.
  assert.ok(position(install, 'RMDir "$INSTDIR"') < position(install, 'IfFileExists "$INSTDIR\\*.*" 0 new_folder'));
  const created = position(install, "new_folder:");
  const marker = position(install, 'FileOpen $0 "$INSTDIR\\${SETUP_MARKER}" a');
  const payload = position(install, 'File /r "${PAYLOAD_DIR}/*"');
  assert.ok(created < marker && marker < payload, "the marker precedes payload extraction");
  assert.equal(install[marker + 1], "IfErrors write_failed", "a marker that cannot be written stops setup");
  assert.equal(install.filter(line => line.includes("${SETUP_MARKER}") && line.startsWith("FileOpen")).length, 1,
    "setup writes the marker only into a folder it created");
  assert.ok(functionBody("RequirePreviousVivary").includes('IfFileExists "$INSTDIR\\${SETUP_MARKER}" found'), "a rerun recognizes the marker");
});

test("setup checks the real install path against the payload's longest paths before changing anything", () => {
  assert.ok(lines.includes("!insertmacro REQUIRE_DEFINE LONGEST_FILE"));
  assert.ok(lines.includes("!insertmacro REQUIRE_DEFINE LONGEST_FOLDER"));
  assert.deepEqual(functionBody("RequirePathRoom").slice(0, 7), [
    'StrLen $0 "$INSTDIR\\"',
    "IntOp $1 $0 + ${LONGEST_FILE}",
    "IntCmp $1 259 0 0 too_long",
    "IntOp $1 $0 + ${LONGEST_FOLDER}",
    "IntCmp $1 247 0 0 too_long",
    "Return",
    "too_long:",
  ]);
  const room = functionBody("RequirePathRoom");
  assert.ok(room.includes("SetErrorLevel 2") && room.some(line => line.startsWith("Abort ")), "exits with code 2");
  const install = sectionBody("Vivary");
  const check = position(install, "Call RequirePathRoom");
  for (const step of ['RMDir "$INSTDIR"', "Call RemoveInstalledFiles", 'File /r "${PAYLOAD_DIR}/*"',
    'FileOpen $0 "$INSTDIR\\${SETUP_MARKER}" a']) {
    assert.ok(check < position(install, step), `the path check precedes ${step}`);
  }
});

test("a second read of the list that fails removes nothing", () => {
  const remove = functionBody("${PREFIX}RemoveInstalledFiles");
  const checked = position(remove, "checked:");
  assert.deepEqual(remove.slice(checked + 1, checked + 5), [
    "FileClose $R3",
    "ClearErrors",
    'FileOpen $R3 "$INSTDIR\\${INSTALL_LIST}" r',
    "IfErrors unreadable",
  ]);
});

test("the desktop shortcut is recorded only when it was created", () => {
  const shortcut = functionBody("CreateDesktopShortcut");
  const create = position(shortcut, 'CreateShortcut "$DESKTOP\\Vivary.lnk" "$INSTDIR\\vivary.exe" "" "$INSTDIR\\vivary.exe" 0');
  assert.equal(shortcut[create - 1], "ClearErrors");
  assert.equal(shortcut[create + 1], "IfErrors done");
  assert.ok(create + 1 < position(shortcut, 'WriteRegDWORD HKCU "${UNINSTALL_KEY}" "VivaryDesktopShortcut" 1'));
  assert.ok(position(shortcut, 'WriteRegDWORD HKCU "${UNINSTALL_KEY}" "VivaryDesktopShortcut" 1') < position(shortcut, "done:"));
});

test("nothing is deleted recursively", () => {
  assert.doesNotMatch(code, /^RMDir\s+(\/\w+\s+)*\/r\b/im);
  assert.doesNotMatch(code, /\/REBOOTOK|\bReboot\b|SetRebootFlag/i);
  assert.doesNotMatch(code, /\b(Rename|CopyFiles)\b/);
});

test("deletes reach only listed paths, setup's own files and its shortcuts", () => {
  const allowed = new Set([
    '"$INSTDIR\\$R4"', '"$INSTDIR\\$6"', '"$INSTDIR"', '"$INSTDIR\\${INSTALL_LIST}"',
    '"$INSTDIR\\${UNINSTALLER}"', '"$INSTDIR\\${SETUP_MARKER}"', '"$INSTDIR\\${INSTALL_LIST_TEMP}"', '"$SMPROGRAMS\\Vivary.lnk"', '"$DESKTOP\\Vivary.lnk"',
  ]);
  for (const line of lines.filter(line => /^(Delete|RMDir)\b/i.test(line))) {
    const target = line.replace(/^(Delete|RMDir)\s+/i, "");
    assert.ok(allowed.has(target), `unexpected delete target in: ${line}`);
  }
});

test("removal reads the installed-file list behind the exact-folder guard", () => {
  const remove = functionBody("${PREFIX}RemoveInstalledFiles");
  assert.equal(remove[0], "Call ${PREFIX}RequireFixedInstallDir", "the guard runs first");
  const guard = functionBody("${PREFIX}RequireFixedInstallDir");
  assert.ok(guard.includes(`StrCmp $INSTDIR "${installDir}" 0 refuse`), "exact path comparison");
  assert.ok(guard.includes("IntCmp $0 3 refuse refuse"), "an empty LOCALAPPDATA is refused");
  assert.ok(guard.includes("IntOp $1 $1 & 0x400"), "a linked install folder is refused");
  const refuse = guard.indexOf("refuse:");
  assert.ok(refuse > 0 && guard.slice(refuse).some(line => line.startsWith("Abort ")), "a failed guard aborts");

  // Every line is checked, and every listed folder tested for a link, before
  // the second pass deletes anything.
  const firstDelete = remove.findIndex(line => /^(Delete|RMDir)\b/.test(line));
  const checked = position(remove, "checked:");
  assert.ok(position(remove, "Call ${PREFIX}CheckListLine") < checked);
  const truncated = position(remove, 'StrCmp $R9 "truncated" 0 check_content');
  assert.ok(truncated < checked);
  assert.deepEqual(remove.slice(truncated + 1, truncated + 4), ['StrCpy $R5 "a cut-off line"', "Goto bad_line", "check_content:"],
    "a cut-off line is refused with its own reason");
  assert.ok(position(remove, "System::Call 'kernel32::GetFileAttributesW(w \"$INSTDIR\\$6\") i .r3'") < checked);
  assert.ok(checked < firstDelete, "deletes follow the check pass");
  for (const label of ["bad_line_stop:", "linked:", "unreadable:"]) {
    const at = position(remove, label);
    assert.ok(remove.slice(at).find(line => /^(Abort|Return)\b/.test(line)).startsWith("Abort "), `${label} aborts`);
  }
  // A damaged list returns to the caller only when setup's marker is here.
  const badLine = position(remove, "bad_line:");
  assert.deepEqual(remove.slice(badLine + 1, badLine + 6), [
    "FileClose $R3",
    'IfFileExists "$INSTDIR\\${SETUP_MARKER}" 0 bad_line_stop',
    'DetailPrint "$INSTDIR\\${INSTALL_LIST} is damaged ($R5). Nothing was removed."',
    "StrCpy $R8 2",
    "Return",
  ]);
  // Without the marker the message names the damage and its reason.
  const stop = position(remove, "bad_line_stop:");
  assert.deepEqual(remove.slice(stop + 1, stop + 3), [
    'MessageBox MB_OK|MB_ICONSTOP "$INSTDIR\\${INSTALL_LIST} is damaged ($R5), so nothing was removed." /SD IDOK',
    'Abort "The installed-file list is damaged ($R5). Nothing was removed."',
  ]);
  assert.ok(!code.includes("names a path outside the Vivary folder"));
  assert.ok(lines.includes('!insertmacro VIVARY_SHARED_FUNCTIONS ""'));
  assert.ok(lines.includes('!insertmacro VIVARY_SHARED_FUNCTIONS "un."'));
});

test("list lines must be safe relative paths", () => {
  const check = functionBody("${PREFIX}CheckListLine");
  assert.ok(lines.includes("!define MAX_LIST_LINE 179"), "matches maxPayloadPath in build-installer.mjs");
  assert.ok(check.includes('StrCmp $3 ".\\" bad_path'), "refuses a part ending in a dot");
  assert.ok(check.includes('StrCmp $3 " \\" bad_path'), "refuses a part ending in a space");
  assert.ok(check.includes("IntCmp $2 ${MAX_LIST_LINE} 0 0 bad_length"), "length bound");
  assert.ok(check.includes('StrCmp $3 "\\" bad_path'), "leading backslash");
  for (const character of [":", "/", "*", "?", "<", ">", "|"]) {
    assert.ok(check.includes(`StrCmp $3 "${character}" bad_path`), `refuses ${character}`);
  }
  assert.ok(check.includes(`StrCmp $3 '"' bad_path`), 'refuses "');
  assert.ok(check.includes('StrCmp $3 "\\..\\" bad_path'), "refuses a .. part");
  assert.ok(check.includes('StrCmp $3 "\\.\\" bad_path'), "refuses a . part");
  assert.ok(functionBody("${PREFIX}ReadListLine").includes('StrCmp $2 "$\\n" 0 truncated'), "a line without a break is refused");
});

test("install writes the new list after removing the old files and before extracting, and refuses skipped files", () => {
  assert.ok(lines.includes("AllowSkipFiles off"));
  assert.doesNotMatch(code, /AllowSkipFiles\s+on/i);
  const install = sectionBody("Vivary");
  const list = position(install, 'File "/oname=${INSTALL_LIST_TEMP}" "${INSTALL_LIST_FILE}"');
  const payload = position(install, 'File /r "${PAYLOAD_DIR}/*"');
  // The list is written under a temporary name and moved into place in one step.
  assert.deepEqual(install.slice(list + 1, list + 8), [
    "IfErrors write_failed",
    "StrCmp $R8 2 owned_checked",
    "Call RequireNoUnownedFiles",
    "owned_checked:",
    "System::Call 'kernel32::MoveFileExW(w \"$INSTDIR\\${INSTALL_LIST_TEMP}\", w \"$INSTDIR\\${INSTALL_LIST}\", i 9) i .r0'",
    "IntCmp $0 0 write_failed",
    'File /r "${PAYLOAD_DIR}/*"',
  ], "the moved list is in place before the first payload file");
  assert.ok(!lines.some(line => line.includes('/oname=${INSTALL_LIST}"')), "the list is never written in place");
  const copy = position(install, "copy_files:");
  assert.ok(position(install, "Call RemoveInstalledFiles") < copy, "old files are removed first");
  assert.deepEqual(install.slice(copy + 1, copy + 3), ["ClearErrors", 'SetOutPath "$INSTDIR"']);
  assert.ok(copy < list && list < payload);
  // A damaged list with setup's marker is copied over, which rewrites it.
  assert.ok(position(install, "Call RemoveInstalledFiles") < position(install, "IntCmp $R8 2 copy_files"));
  assert.ok(position(install, "IntCmp $R8 2 copy_files") < position(install, "IntCmp $R8 1 0 list_read list_read"));
  // Errors from the payload, uninstaller, shortcut or registry still stop setup.
  const lastRegistry = position(install, 'WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1');
  assert.deepEqual(install.slice(lastRegistry + 1, lastRegistry + 3), ["IfErrors write_failed", "Return"]);
  // An upgrade removes the previous files and stops if any remain.
  assert.ok(install.includes("IntCmp $R7 0 copy_files"));
  assert.doesNotMatch(code, /^Call\s+(un\.)?RemoveApplicationFolder/m);
});

test("an uninstall that keeps added files leaves setup's marker for the next setup", () => {
  const uninstall = sectionBody("Uninstall");
  const folder = position(uninstall, 'RMDir "$INSTDIR"');
  assert.deepEqual(uninstall.slice(folder + 1, folder + 6), [
    'IfFileExists "$INSTDIR\\*.*" 0 kept_data',
    "ClearErrors",
    'FileOpen $0 "$INSTDIR\\${SETUP_MARKER}" a',
    "IfErrors marker_not_written",
    'FileWrite $0 "Vivary was uninstalled. Files you added to this folder were kept. Vivary setup can install here again beside them."',
  ]);
  assert.ok(position(uninstall, 'Delete "$INSTDIR\\${INSTALL_LIST}"') < folder, "the marker comes back only after the list is gone");
  assert.equal(uninstall.filter(line => line.startsWith("FileOpen ")).length, 1, "the uninstaller writes the marker in one place only");
  // The next setup takes the marker-without-list path and deletes nothing.
  const install = sectionBody("Vivary");
  assert.equal(install[position(install, "IntCmp $R8 1 0 list_read list_read") + 1],
    'IfFileExists "$INSTDIR\\${SETUP_MARKER}" copy_files no_list');
});

/**
 * Models one upgrade that stops partway, then an uninstall, then setup, using
 * the step order the script itself has. Fails when an uninstall can leave
 * Vivary files that no list names, or when the next setup would refuse the folder.
 */
test("setup refuses a file it does not own at a payload path before replacing anything", () => {
  const install = sectionBody("Vivary");
  assert.deepEqual(install.slice(0, 2), ["SectionIn RO", "StrCpy $R8 0"], "a new folder never looks like a damaged list");
  const removal = position(install, "Call RemoveInstalledFiles");
  const temp = position(install, 'File "/oname=${INSTALL_LIST_TEMP}" "${INSTALL_LIST_FILE}"');
  const skip = position(install, "StrCmp $R8 2 owned_checked");
  const check = position(install, "Call RequireNoUnownedFiles");
  const move = position(install, "System::Call 'kernel32::MoveFileExW(w \"$INSTDIR\\${INSTALL_LIST_TEMP}\", w \"$INSTDIR\\${INSTALL_LIST}\", i 9) i .r0'");
  const payload = position(install, 'File /r "${PAYLOAD_DIR}/*"');
  assert.ok(removal < temp && temp < skip && skip + 1 === check && check < move && move < payload,
    "after removal and the temporary list, before the move and extraction");
  assert.equal(install.filter(line => line === "Call RequireNoUnownedFiles").length, 1);

  const owned = functionBody("RequireNoUnownedFiles");
  assert.deepEqual(owned.slice(0, 13), [
    "ClearErrors",
    'FileOpen $R3 "$INSTDIR\\${INSTALL_LIST_TEMP}" r',
    "IfErrors unreadable",
    "next_line:",
    "Call ReadListLine",
    'StrCmp $R9 "eof" checked',
    'StrCmp $R9 "truncated" invalid',
    "Call CheckListLine",
    'StrCmp $R5 "" 0 invalid',
    "StrCpy $2 $R4 1 -1",
    'StrCmp $2 "\\" next_line',
    'IfFileExists "$INSTDIR\\$R4" unowned next_line',
    "checked:",
  ], "every file line of the new list is checked, folder lines are skipped");
  const unowned = position(owned, "unowned:");
  assert.deepEqual(owned.slice(unowned + 1, unowned + 6), [
    "FileClose $R3",
    'Delete "$INSTDIR\\${INSTALL_LIST_TEMP}"',
    'MessageBox MB_OK|MB_ICONSTOP "$INSTDIR\\$R4 is not a Vivary file, so setup did not replace it. Move it out of $INSTDIR, then run setup again." /SD IDOK',
    "SetErrorLevel 2",
    'Abort "$INSTDIR\\$R4 is not a Vivary file. Nothing was changed."',
  ]);
  // Only the temporary list is deleted, so the old list, entry, uninstaller and marker stay.
  const deletes = owned.filter(line => /^(Delete|RMDir|DeleteReg)/.test(line));
  assert.deepEqual([...new Set(deletes)], ['Delete "$INSTDIR\\${INSTALL_LIST_TEMP}"']);
  assert.ok(!owned.some(line => line.includes("MoveFileExW") || line.startsWith("File ")));
  for (const label of ["invalid:", "unreadable:"]) {
    assert.ok(owned.slice(position(owned, label)).some(line => line.startsWith("Abort ")), `${label} aborts`);
  }
});

test("a user file at a new payload path survives an upgrade or a reinstall beside kept files", () => {
  const install = sectionBody("Vivary");
  const at = line => position(install, line);
  const steps = [
    ["remove", at("Call RemoveInstalledFiles")],
    ["check", at("Call RequireNoUnownedFiles")],
    ["list", at("System::Call 'kernel32::MoveFileExW(w \"$INSTDIR\\${INSTALL_LIST_TEMP}\", w \"$INSTDIR\\${INSTALL_LIST}\", i 9) i .r0'")],
    ["extract", at('File /r "${PAYLOAD_DIR}/*"')],
  ].sort((a, b) => a[1] - b[1]).map(([name]) => name);
  const newFiles = ["vivary.exe", "shared.dll", "new-only.dll"];
  const cases = [
    { name: "upgrade", disk: ["vivary.exe", "shared.dll", "new-only.dll"], list: ["vivary.exe", "shared.dll"] },
    { name: "reinstall beside kept files", disk: ["new-only.dll"], list: null },
  ];
  for (const { name, disk: start, list: oldList } of cases) {
    // new-only.dll is the user's own file in both cases.
    const disk = new Map(start.map(file => [file, oldList?.includes(file) ? "vivary" : "user"]));
    let list = oldList;
    let stopped = false;
    for (const step of steps) {
      if (stopped) break;
      if (step === "remove" && list) for (const file of list) disk.delete(file);
      if (step === "check") stopped = newFiles.some(file => disk.has(file));
      if (step === "list") list = [...newFiles];
      if (step === "extract") for (const file of newFiles) disk.set(file, "vivary");
    }
    assert.equal(disk.get("new-only.dll"), "user", `${name}: the user's file is not replaced`);
    assert.ok(stopped, `${name}: setup stops`);
    assert.deepEqual(list, oldList, `${name}: the old list stays`);
    // After the user moves the file, a rerun finishes: listed files already gone count as removed.
    disk.delete("new-only.dll");
    stopped = false;
    for (const step of steps) {
      if (step === "remove" && list) for (const file of list) disk.delete(file);
      if (step === "check") stopped = newFiles.some(file => disk.has(file));
      if (stopped) break;
      if (step === "list") list = [...newFiles];
      if (step === "extract") for (const file of newFiles) disk.set(file, "vivary");
    }
    assert.ok(!stopped && newFiles.every(file => disk.get(file) === "vivary"), `${name}: the rerun installs`);
  }
});

test("an interrupted upgrade, then uninstall, then setup recovers with the script's step order", () => {
  const install = sectionBody("Vivary");
  const at = line => position(install, line);
  const steps = [
    ["remove", at("Call RemoveInstalledFiles")],
    ["list", at('File "/oname=${INSTALL_LIST_TEMP}" "${INSTALL_LIST_FILE}"')],
    ["extract", at('File /r "${PAYLOAD_DIR}/*"')],
  ].sort((a, b) => a[1] - b[1]).map(([name]) => name);
  const uninstall = sectionBody("Uninstall");
  const rewritesMarker = uninstall.slice(position(uninstall, 'RMDir "$INSTDIR"'))
    .includes('FileOpen $0 "$INSTDIR\\${SETUP_MARKER}" a');
  const previous = functionBody("RequirePreviousVivary");
  const recognizesMarker = previous.includes('IfFileExists "$INSTDIR\\${SETUP_MARKER}" found');

  const oldFiles = ["vivary.exe", "old-only.dll", "shared.dll"];
  const newFiles = ["vivary.exe", "shared.dll", "new-only.dll", "resources\\new.pak"];
  const userFile = "my-notes.txt";
  // Stop after each step, and inside the extraction after each file.
  const stops = [];
  for (let step = 0; step <= steps.length; step++) {
    if (steps[step - 1] === "extract") {
      for (let extracted = 0; extracted <= newFiles.length; extracted++) stops.push({ step, extracted });
    } else stops.push({ step, extracted: 0 });
  }
  for (const stop of stops) {
    // An install from a build without the marker, plus one file the user added.
    const disk = new Set([...oldFiles, userFile]);
    let list = [...oldFiles];
    for (const [index, name] of steps.slice(0, stop.step).entries()) {
      const partial = name === "extract" && index === stop.step - 1;
      if (name === "remove") for (const file of list) disk.delete(file);
      if (name === "list") list = [...newFiles];
      if (name === "extract") for (const file of newFiles.slice(0, partial ? stop.extracted : newFiles.length)) disk.add(file);
    }
    const label = `stopped after ${steps.slice(0, stop.step).join(", ") || "nothing"} (${stop.extracted} extracted)`;
    // Uninstall: delete what the list on disk names. A missing file counts as removed.
    for (const file of list) disk.delete(file);
    list = null;
    let marker = false;
    const leftover = [...disk].filter(file => file !== userFile);
    assert.deepEqual(leftover, [], `${label}: uninstall leaves no Vivary file behind`);
    if (disk.size > 0 && rewritesMarker) marker = true;
    assert.ok(disk.has(userFile), `${label}: the added file stays`);
    // Next setup: a folder that holds files needs the list or the marker.
    const recognized = list !== null || (marker && recognizesMarker);
    assert.ok(disk.size === 0 || recognized, `${label}: the next setup recognizes the folder`);
  }
});

test("a previous install is recognized by its entry, list, marker, executable or uninstaller", () => {
  const previous = functionBody("RequirePreviousVivary");
  assert.deepEqual(previous.slice(0, 6), [
    'ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"',
    "StrCmp $0 $INSTDIR found",
    'IfFileExists "$INSTDIR\\${INSTALL_LIST}" found',
    'IfFileExists "$INSTDIR\\${SETUP_MARKER}" found',
    'IfFileExists "$INSTDIR\\vivary.exe" found',
    'IfFileExists "$INSTDIR\\${UNINSTALLER}" found',
  ]);
  assert.ok(previous.some(line => line.startsWith("Abort ")));
});

test("the uninstaller removes itself, its entry, the marker and then the list, only when the listed files are gone", () => {
  const uninstall = sectionBody("Uninstall");
  assert.equal(uninstall[0], "Call un.RequireFixedInstallDir");
  assert.ok(functionBody("un.onInit").includes("Call un.RequireFixedInstallDir"));
  const removeFiles = position(uninstall, "Call un.RemoveInstalledFiles");
  const entry = position(uninstall, 'DeleteRegKey HKCU "${UNINSTALL_KEY}"');
  const self = position(uninstall, 'Delete "$INSTDIR\\${UNINSTALLER}"');
  const list = position(uninstall, 'Delete "$INSTDIR\\${INSTALL_LIST}"');
  const marker = position(uninstall, 'Delete "$INSTDIR\\${SETUP_MARKER}"');
  const temp = position(uninstall, 'Delete "$INSTDIR\\${INSTALL_LIST_TEMP}"');
  const gate = position(uninstall, "IntCmp $R7 0 remove_entry");
  const removeEntry = position(uninstall, "remove_entry:");
  // Interrupted at any point, the folder still holds the list or nothing setup made,
  // and a folder that holds only the list is repaired by setup.
  assert.ok(removeFiles < gate && gate < removeEntry && removeEntry < self && self < entry && entry < marker
    && marker < temp && temp < list, "uninstaller, entry, marker, temporary list, then the list");
  assert.equal(uninstall[list + 1].startsWith("Delete "), false, "nothing is deleted after the list");
  assert.equal(position(uninstall, "IntCmp $R8 2 unfinished") + 1, position(uninstall, "IntCmp $R8 1 0 list_read list_read"),
    "a damaged list with the marker asks for a setup rerun");
  const missing = position(uninstall, "IntCmp $R8 1 0 list_read list_read");
  assert.ok(missing < gate, "a missing list removes nothing");
  assert.equal(uninstall[missing + 1], 'IfFileExists "$INSTDIR\\${SETUP_MARKER}" unfinished no_list');
  const unfinished = position(uninstall, "unfinished:");
  assert.ok(unfinished < removeEntry && uninstall.slice(unfinished, removeEntry).some(line => line.startsWith("Abort ")),
    "an unfinished install asks for a setup rerun and removes nothing");
  // Remaining files and a missing list both abort before the entry is touched.
  const noList = position(uninstall, "no_list:");
  assert.ok(uninstall.slice(gate, noList).some(line => line.startsWith("Abort ")));
  assert.ok(uninstall.slice(noList, removeEntry).some(line => line.startsWith("Abort ")));
  assert.ok(position(uninstall, 'RMDir "$INSTDIR"') > list, "the folder goes last, and only when empty");
});

test("the uninstaller stops before the marker and list when it cannot remove itself or its entry", () => {
  const uninstall = sectionBody("Uninstall");
  const self = position(uninstall, 'Delete "$INSTDIR\\${UNINSTALLER}"');
  assert.deepEqual(uninstall.slice(self + 1, self + 5), [
    'IfFileExists "$INSTDIR\\${UNINSTALLER}" 0 uninstaller_removed',
    'MessageBox MB_OK|MB_ICONSTOP "$INSTDIR\\${UNINSTALLER} could not be removed. Close any program that is scanning or holding it, then run the uninstaller again." /SD IDOK',
    'Abort "The uninstaller could not remove itself. Run it again."',
    "uninstaller_removed:",
  ], "a held uninstaller stops before the entry, marker and list");
  const entry = position(uninstall, 'DeleteRegKey HKCU "${UNINSTALL_KEY}"');
  assert.equal(uninstall[entry - 1], "ClearErrors");
  assert.deepEqual(uninstall.slice(entry + 1, entry + 8), [
    "IfErrors 0 entry_removed",
    "ClearErrors",
    'EnumRegValue $0 HKCU "${UNINSTALL_KEY}" 0',
    "IfErrors entry_removed",
    'MessageBox MB_OK|MB_ICONSTOP "The Installed apps entry for Vivary could not be removed. Run Vivary setup to repair the install, then uninstall again." /SD IDOK',
    'Abort "The uninstall entry could not be removed. Run setup, then uninstall again."',
    "entry_removed:",
  ], "an entry that still opens stops before the marker and list");
  const removed = position(uninstall, "entry_removed:");
  for (const file of ["${SETUP_MARKER}", "${INSTALL_LIST_TEMP}", "${INSTALL_LIST}"]) {
    assert.ok(removed < position(uninstall, `Delete "$INSTDIR\\${file}"`), `${file} goes only after both succeed`);
  }
});

test("user data is never referenced except in the kept-data message", () => {
  const userData = /\.vivary|%USERPROFILE%|\$PROFILE|(?<!LOCAL)APPDATA/i;
  const mentions = lines.filter(line => userData.test(line));
  assert.equal(mentions.length, 1, mentions.join("\n"));
  assert.match(mentions[0], /^!define KEPT_DATA_TEXT "Your projects, conversations and settings in %USERPROFILE%\\\.vivary and %APPDATA%\\Vivary were kept\./);
  // The uninstaller's finish page and its log both say what was kept.
  const finishText = lines.indexOf('!define MUI_FINISHPAGE_TEXT "Vivary was removed from this computer.$\\r$\\n$\\r$\\n${KEPT_DATA_TEXT}"');
  assert.ok(finishText >= 0 && lines[finishText + 1] === "!insertmacro MUI_UNPAGE_FINISH", "uninstall finish page text");
  assert.ok(sectionBody("Uninstall").includes('DetailPrint "${KEPT_DATA_TEXT}"'), "uninstall log text");
});

test("registry access stays in the current user's uninstall key", () => {
  assert.doesNotMatch(code, /\bHK(LM|CR|U|CC)\b|HKEY_|SHCTX|HKEY_LOCAL_MACHINE/i);
  const registry = lines.filter(line => /^(Write|Read|Delete|Enum)Reg/i.test(line));
  assert.ok(registry.length > 0);
  for (const line of registry) assert.match(line, /^\w+ (\$\w+ )?HKCU "\$\{UNINSTALL_KEY\}"/, line);
  assert.ok(lines.includes('!define UNINSTALL_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Vivary"'));
  for (const name of ["DisplayName", "DisplayVersion", "Publisher", "DisplayIcon", "InstallLocation",
    "UninstallString", "QuietUninstallString", "EstimatedSize", "NoModify", "NoRepair"]) {
    assert.ok(registry.some(line => line.includes(` "${name}" `)), `uninstall entry has ${name}`);
  }
  assert.ok(lines.includes('WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Jeff Kazzee"'));
  assert.ok(lines.includes('!define DISPLAY_VERSION "${APP_VERSION}+${PAYLOAD_COMMIT_SHORT}"'));
});

test("setup never stops processes and never blocks silent mode", () => {
  assert.doesNotMatch(code, /taskkill|nsProcess|KillProc|FindProcDLL|TerminateProcess|nsExec|ExecWait/i);
  const running = functionBody("${PREFIX}RequireVivaryClosed");
  for (const file of ["vivary.exe", "resources\\node\\node.exe"]) {
    assert.ok(running.includes(`StrCpy $R0 "$INSTDIR\\${file}"`), `checks ${file}`);
  }
  assert.ok(functionBody("${PREFIX}FileInUse").includes("FileOpen $R2 $R0 a"), "opens for append, never truncates");
  assert.doesNotMatch(code, /FileOpen\s+\S+\s+\S+\s+w\b/i);
  for (const line of lines.filter(line => line.startsWith("MessageBox "))) {
    assert.match(line, /\/SD ID/, `MessageBox needs a silent default: ${line}`);
  }
});

test("installer metadata names Vivary, its owner and both commits", () => {
  for (const expected of [
    'VIAddVersionKey "ProductName" "Vivary"',
    'VIAddVersionKey "CompanyName" "Vivary"',
    'VIAddVersionKey "FileDescription" "Vivary Setup"',
    'VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 Jeff Kazzee"',
    'VIAddVersionKey "PayloadCommit" "${PAYLOAD_COMMIT}"',
    'VIAddVersionKey "InstallerCommit" "${INSTALLER_COMMIT}"',
    '!define MUI_ICON "${ICON_FILE}"',
    '!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"',
    'CreateShortcut "$SMPROGRAMS\\Vivary.lnk" "$INSTDIR\\vivary.exe" "" "$INSTDIR\\vivary.exe" 0',
    "!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED",
  ]) assert.ok(lines.includes(expected), expected);
});
