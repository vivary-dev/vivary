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

function functionBody(name) {
  const match = code.match(new RegExp(`^Function ${name.replace(/[$.{}]/g, "\\$&")}\\n([\\s\\S]*?)^FunctionEnd`, "m"));
  assert.ok(match, `function ${name} exists`);
  return match[1].split("\n");
}

function sectionBody(name) {
  const match = code.match(new RegExp(`^Section "${name}"\\n([\\s\\S]*?)^SectionEnd`, "m"));
  assert.ok(match, `section ${name} exists`);
  return match[1].split("\n");
}

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

test("the only recursive delete is the guarded application folder", () => {
  const recursive = lines.filter(line => /^RMDir\b/i.test(line) && /\/r\b/i.test(line));
  assert.deepEqual(recursive, ['RMDir /r "$INSTDIR"']);
  const remove = functionBody("${PREFIX}RemoveApplicationFolder");
  assert.equal(remove[0], "Call ${PREFIX}RequireFixedInstallDir", "the guard runs before RMDir /r");
  assert.equal(remove[1], 'RMDir /r "$INSTDIR"');

  const guard = functionBody("${PREFIX}RequireFixedInstallDir");
  assert.ok(guard.includes(`StrCmp $INSTDIR "${installDir}" 0 refuse`), "exact path comparison");
  assert.ok(guard.includes("IntCmp $0 3 refuse refuse"), "an empty LOCALAPPDATA is refused");
  const refuse = guard.indexOf("refuse:");
  assert.ok(refuse > 0 && guard.slice(refuse).some(line => line.startsWith("Abort ")), "a failed guard aborts");
  assert.ok(guard.slice(0, refuse).includes("Return"), "only an accepted path returns");

  // Both the installer and the uninstaller get the guarded functions.
  assert.ok(lines.includes('!insertmacro VIVARY_SHARED_FUNCTIONS ""'));
  assert.ok(lines.includes('!insertmacro VIVARY_SHARED_FUNCTIONS "un."'));
  assert.equal(sectionBody("Uninstall")[0], "Call un.RequireFixedInstallDir");
  assert.ok(functionBody("un.onInit").includes("Call un.RequireFixedInstallDir"));
});

test("deletes touch only the install folder and the shortcuts setup made", () => {
  const allowed = new Set(['"$INSTDIR"', '"$SMPROGRAMS\\Vivary.lnk"', '"$DESKTOP\\Vivary.lnk"']);
  for (const line of lines.filter(line => /^(Delete|RMDir)\b/i.test(line))) {
    const target = line.replace(/^(Delete|RMDir)\s+(\/\w+\s+)*/i, "");
    assert.ok(allowed.has(target), `unexpected delete target in: ${line}`);
  }
  assert.doesNotMatch(code, /\/REBOOTOK|\bReboot\b|SetRebootFlag/i);
  assert.doesNotMatch(code, /\b(Rename|CopyFiles)\b/);
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
  assert.ok(lines.includes('!define DISPLAY_VERSION "${APP_VERSION}+${SOURCE_COMMIT_SHORT}"'));
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

test("installer metadata names Vivary and its owner", () => {
  for (const expected of [
    'VIAddVersionKey "ProductName" "Vivary"',
    'VIAddVersionKey "CompanyName" "Vivary"',
    'VIAddVersionKey "FileDescription" "Vivary Setup"',
    'VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 Jeff Kazzee"',
    '!define MUI_ICON "${ICON_FILE}"',
    '!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"',
    'CreateShortcut "$SMPROGRAMS\\Vivary.lnk" "$INSTDIR\\vivary.exe" "" "$INSTDIR\\vivary.exe" 0',
    "!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED",
  ]) assert.ok(lines.includes(expected), expected);
});
