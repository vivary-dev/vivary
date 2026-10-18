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
  const noList = position(install, "IntCmp $R8 1 no_list");
  assert.ok(position(install, "Call RemoveInstalledFiles") < noList);
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

test("nothing is deleted recursively", () => {
  assert.doesNotMatch(code, /^RMDir\s+(\/\w+\s+)*\/r\b/im);
  assert.doesNotMatch(code, /\/REBOOTOK|\bReboot\b|SetRebootFlag/i);
  assert.doesNotMatch(code, /\b(Rename|CopyFiles)\b/);
});

test("deletes reach only listed paths, setup's own files and its shortcuts", () => {
  const allowed = new Set([
    '"$INSTDIR\\$R4"', '"$INSTDIR\\$6"', '"$INSTDIR"', '"$INSTDIR\\${INSTALL_LIST}"',
    '"$INSTDIR\\${UNINSTALLER}"', '"$SMPROGRAMS\\Vivary.lnk"', '"$DESKTOP\\Vivary.lnk"',
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
  assert.ok(position(remove, "StrCmp $R9 \"truncated\" bad_line") < checked);
  assert.ok(position(remove, "System::Call 'kernel32::GetFileAttributesW(w \"$INSTDIR\\$6\") i .r3'") < checked);
  assert.ok(checked < firstDelete, "deletes follow the check pass");
  for (const label of ["bad_line:", "linked:", "unreadable:"]) {
    const at = position(remove, label);
    assert.ok(remove.slice(at).find(line => /^(Abort|Return)\b/.test(line)).startsWith("Abort "), `${label} aborts`);
  }
  assert.ok(lines.includes('!insertmacro VIVARY_SHARED_FUNCTIONS ""'));
  assert.ok(lines.includes('!insertmacro VIVARY_SHARED_FUNCTIONS "un."'));
});

test("list lines must be safe relative paths", () => {
  const check = functionBody("${PREFIX}CheckListLine");
  assert.ok(lines.includes("!define MAX_LIST_LINE 240"));
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

test("install writes the list last and refuses skipped files", () => {
  assert.ok(lines.includes("AllowSkipFiles off"));
  assert.doesNotMatch(code, /AllowSkipFiles\s+on/i);
  const install = sectionBody("Vivary");
  const list = position(install, 'File "/oname=${INSTALL_LIST}" "${INSTALL_LIST_FILE}"');
  for (const step of ['File /r "${PAYLOAD_DIR}/*"', 'WriteUninstaller "$INSTDIR\\${UNINSTALLER}"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"']) {
    assert.ok(position(install, step) < list, `${step} precedes the list`);
  }
  assert.ok(install.slice(list).includes("IfErrors write_failed"), "a failed list write aborts");
  assert.ok(position(install, "ClearErrors") < position(install, 'File /r "${PAYLOAD_DIR}/*"'));
  assert.ok(position(install, "IfErrors write_failed") < list, "errors before the list abort");
  // An upgrade removes the previous files and stops if any remain.
  assert.ok(position(install, "Call RemoveInstalledFiles") < position(install, "copy_files:"));
  assert.ok(install.includes("IntCmp $R7 0 copy_files"));
  assert.doesNotMatch(code, /^Call\s+(un\.)?RemoveApplicationFolder/m);
});

test("a previous install is recognized by its entry, list, executable or uninstaller", () => {
  const previous = functionBody("RequirePreviousVivary");
  assert.deepEqual(previous.slice(0, 5), [
    'ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"',
    "StrCmp $0 $INSTDIR found",
    'IfFileExists "$INSTDIR\\${INSTALL_LIST}" found',
    'IfFileExists "$INSTDIR\\vivary.exe" found',
    'IfFileExists "$INSTDIR\\${UNINSTALLER}" found',
  ]);
  assert.ok(previous.some(line => line.startsWith("Abort ")));
});

test("the uninstaller removes its entry and itself last, only when the listed files are gone", () => {
  const uninstall = sectionBody("Uninstall");
  assert.equal(uninstall[0], "Call un.RequireFixedInstallDir");
  assert.ok(functionBody("un.onInit").includes("Call un.RequireFixedInstallDir"));
  const removeFiles = position(uninstall, "Call un.RemoveInstalledFiles");
  const entry = position(uninstall, 'DeleteRegKey HKCU "${UNINSTALL_KEY}"');
  const self = position(uninstall, 'Delete "$INSTDIR\\${UNINSTALLER}"');
  const list = position(uninstall, 'Delete "$INSTDIR\\${INSTALL_LIST}"');
  const gate = position(uninstall, "IntCmp $R7 0 remove_entry");
  const removeEntry = position(uninstall, "remove_entry:");
  assert.ok(removeFiles < gate && gate < removeEntry && removeEntry < list && list < entry && entry < self);
  assert.ok(position(uninstall, "IntCmp $R8 1 no_list") < gate, "a missing list removes nothing");
  // Remaining files and a missing list both abort before the entry is touched.
  const noList = position(uninstall, "no_list:");
  assert.ok(uninstall.slice(gate, noList).some(line => line.startsWith("Abort ")));
  assert.ok(uninstall.slice(noList, removeEntry).some(line => line.startsWith("Abort ")));
  assert.ok(position(uninstall, 'RMDir "$INSTDIR"') > self, "the folder goes last, and only when empty");
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
  const registry = lines.filter(line => /^(Write|Read|Delete)Reg/i.test(line));
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
