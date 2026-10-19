; Vivary per-user Windows installer.
;
; build-installer.mjs supplies every define below. Build with it rather than
; calling makensis directly, because it also verifies the payload, writes the
; installed-file list and records which commits built the installer.
;
; Safety contract, enforced by tests/installer-script.test.mjs:
; - Runs as the current user and writes only HKCU, the per-user Start menu,
;   the desktop (when asked) and $LOCALAPPDATA\Programs\Vivary.
; - The install folder is fixed. .onInit resets it, so /D= cannot move it.
; - Nothing is deleted recursively. Upgrade and uninstall remove only the
;   files and folders that setup listed in install-files.txt, after
;   RequireFixedInstallDir confirms the exact folder. Files a user added stay.
; - Nothing here reads, writes or deletes Vivary's user data or projects.
; - No process is ever stopped. A running Vivary makes setup ask the user.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
RequestExecutionLevel user
; A file that cannot be written stops setup instead of being skipped.
AllowSkipFiles off

!macro REQUIRE_DEFINE NAME
  !ifndef ${NAME}
    !error "Missing -D${NAME}. Build with packages/desktop/build-installer.mjs."
  !endif
!macroend
!insertmacro REQUIRE_DEFINE PAYLOAD_DIR
!insertmacro REQUIRE_DEFINE INSTALL_LIST_FILE
!insertmacro REQUIRE_DEFINE OUTFILE
!insertmacro REQUIRE_DEFINE LICENSE_FILE
!insertmacro REQUIRE_DEFINE ICON_FILE
!insertmacro REQUIRE_DEFINE APP_VERSION
!insertmacro REQUIRE_DEFINE PAYLOAD_COMMIT
!insertmacro REQUIRE_DEFINE PAYLOAD_COMMIT_SHORT
!insertmacro REQUIRE_DEFINE INSTALLER_COMMIT
!insertmacro REQUIRE_DEFINE ESTIMATED_KB
!insertmacro REQUIRE_DEFINE LONGEST_FILE
!insertmacro REQUIRE_DEFINE LONGEST_FOLDER

!define DISPLAY_VERSION "${APP_VERSION}+${PAYLOAD_COMMIT_SHORT}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vivary"
!define UNINSTALLER "Uninstall Vivary.exe"
!define INSTALL_LIST "install-files.txt"
; Setup writes the list here first, then moves it over install-files.txt in one
; step, so a cut-off write never leaves a partial list.
!define INSTALL_LIST_TEMP "install-files.tmp"
; Setup writes this marker into a folder it creates, before any payload file.
; A rerun after a failed first install recognizes the folder by it.
!define SETUP_MARKER "vivary-setup.txt"
; One name for setup and the uninstaller, so they cannot run at the same time.
!define SETUP_MUTEX "Local\VivarySetup"
!define NO_LIST_TEXT "has no ${INSTALL_LIST}, so Vivary cannot tell which files it installed and removed nothing. Remove that folder by hand. Your projects, conversations and settings are stored elsewhere and are not affected."
!define UNFINISHED_TEXT "holds a Vivary install that did not finish or whose file list is damaged, so nothing was removed. Run Vivary setup again to repair it, then uninstall."
; The longest relative path a list line may hold. Windows file paths stop at
; 259 characters (MAX_PATH 260 with its terminator). The install root for a
; profile folder name of up to 40 characters,
; C:\Users\<name>\AppData\Local\Programs\Vivary\, takes 80 of them, which
; leaves 179 for a file. CreateDirectory stops at 247 characters (248 with its
; terminator), so build-installer.mjs holds folder paths to 167 and folder lines,
; with their trailing backslash, to 168. RequirePathRoom checks the real install
; root against the payload's own longest paths before setup changes anything.
!define MAX_LIST_LINE 179
!define KEPT_DATA_TEXT "Your projects, conversations and settings in %USERPROFILE%\.vivary and %APPDATA%\Vivary were kept. Project folders you opened in Vivary were not changed."

Name "Vivary"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Vivary"
BrandingText "Vivary ${DISPLAY_VERSION}"
ShowInstDetails show
ShowUninstDetails show

; Windows requires four numeric parts here. The readable version is below.
VIProductVersion "${APP_VERSION}.0"
VIFileVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "Vivary"
VIAddVersionKey "CompanyName" "Vivary"
VIAddVersionKey "FileDescription" "Vivary Setup"
VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 Jeff Kazzee"
VIAddVersionKey "ProductVersion" "${DISPLAY_VERSION}"
VIAddVersionKey "FileVersion" "${DISPLAY_VERSION}"
VIAddVersionKey "PayloadCommit" "${PAYLOAD_COMMIT}"
VIAddVersionKey "InstallerCommit" "${INSTALLER_COMMIT}"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TEXT "Setup installs Vivary ${DISPLAY_VERSION} for your Windows account. It does not need administrator rights.$\r$\n$\r$\nVivary goes in $LOCALAPPDATA\Programs\Vivary. Setup does not change your projects, conversations or settings.$\r$\n$\r$\nThis installer is not code signed, so Windows may warn that the publisher is unknown.$\r$\n$\r$\nClose Vivary before you continue."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Launch Vivary"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchVivary
; The finish page's second checkbox offers the desktop shortcut, off by default.
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "Vivary was removed from this computer.$\r$\n$\r$\n${KEPT_DATA_TEXT}"
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

; The installer and the uninstaller each need their own copy of a function,
; and the uninstaller's names must start with "un.".
!macro VIVARY_SHARED_FUNCTIONS PREFIX

; Stops setup unless $INSTDIR is exactly the fixed per-user folder and is not
; a link to somewhere else. StrCmp ignores case, as Windows paths do.
Function ${PREFIX}RequireFixedInstallDir
  StrLen $0 $LOCALAPPDATA
  IntCmp $0 3 refuse refuse
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\Vivary" 0 refuse
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i .r1'
  IntCmp $1 -1 accept
  ; 0x400 is FILE_ATTRIBUTE_REPARSE_POINT, set on links and junctions.
  IntOp $1 $1 & 0x400
  IntCmp $1 0 accept refuse refuse
  accept:
  Return
  refuse:
  MessageBox MB_OK|MB_ICONSTOP "Vivary is not in its expected folder, $LOCALAPPDATA\Programs\Vivary, so nothing was changed." /SD IDOK
  Abort "Vivary is not in its expected folder. Nothing was changed."
FunctionEnd

; Sets $R1 to 1 when the file at $R0 is open as a running program. Windows
; refuses write access to a running executable, so opening it for append
; fails. Nothing is written.
Function ${PREFIX}FileInUse
  StrCpy $R1 0
  IfFileExists $R0 0 done
  ClearErrors
  FileOpen $R2 $R0 a
  IfErrors in_use
  FileClose $R2
  Goto done
  in_use:
  StrCpy $R1 1
  done:
FunctionEnd

; Asks the user to close Vivary while it or its bundled runtimes run.
; Setup never stops a process itself.
Function ${PREFIX}RequireVivaryClosed
  check:
  StrCpy $R0 "$INSTDIR\vivary.exe"
  Call ${PREFIX}FileInUse
  StrCmp $R1 1 running
  StrCpy $R0 "$INSTDIR\resources\node\node.exe"
  Call ${PREFIX}FileInUse
  StrCmp $R1 1 running
  StrCpy $R0 "$INSTDIR\resources\original-runtime\python\python.exe"
  Call ${PREFIX}FileInUse
  StrCmp $R1 1 running
  StrCpy $R0 "$INSTDIR\resources\original-runtime\python\pythonw.exe"
  Call ${PREFIX}FileInUse
  StrCmp $R1 1 running
  Return
  running:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Vivary is running. Close Vivary, wait for it to finish, then choose Retry." /SD IDCANCEL IDRETRY check
  Abort "Vivary is running. Nothing was changed."
FunctionEnd

; Reads the next line of the open list $R3 into $R4 without its line break.
; Sets $R9 to "line", to "eof", or to "truncated" when a line has no line
; break, which means it was too long to read whole.
Function ${PREFIX}ReadListLine
  ClearErrors
  FileRead $R3 $R4
  IfErrors end_of_list
  StrCpy $2 $R4 1 -1
  StrCmp $2 "$\n" 0 truncated
  StrCpy $R4 $R4 -1
  StrCpy $2 $R4 1 -1
  StrCmp $2 "$\r" 0 read
  StrCpy $R4 $R4 -1
  read:
  StrCpy $R9 "line"
  Return
  truncated:
  StrCpy $R9 "truncated"
  Return
  end_of_list:
  StrCpy $R9 "eof"
FunctionEnd

; Sets $R5 to "" when the list line in $R4 is a safe relative path inside
; $INSTDIR, or to the reason it is not. A folder line ends with a backslash.
; Wildcards are refused because Delete would expand them.
Function ${PREFIX}CheckListLine
  StrCpy $R5 ""
  StrLen $2 $R4
  IntCmp $2 0 bad_length bad_length
  IntCmp $2 ${MAX_LIST_LINE} 0 0 bad_length
  StrCpy $3 $R4 1
  StrCmp $3 "\" bad_path
  StrCpy $4 0
  next_char:
  IntCmp $4 $2 components
  StrCpy $3 $R4 1 $4
  StrCmp $3 ":" bad_path
  StrCmp $3 "/" bad_path
  StrCmp $3 "*" bad_path
  StrCmp $3 "?" bad_path
  StrCmp $3 '"' bad_path
  StrCmp $3 "<" bad_path
  StrCmp $3 ">" bad_path
  StrCmp $3 "|" bad_path
  IntOp $4 $4 + 1
  Goto next_char
  ; "." and ".." are refused as whole path parts, so names such as
  ; "a..b.mjs" stay valid. Wrapping the line in backslashes lets one
  ; comparison find a part at the start, middle or end.
  components:
  StrCpy $5 "\$R4\"
  StrLen $2 $5
  StrCpy $4 0
  next_part:
  IntCmp $4 $2 done
  StrCpy $3 $5 4 $4
  StrCmp $3 "\..\" bad_path
  StrCpy $3 $5 3 $4
  StrCmp $3 "\.\" bad_path
  StrCpy $3 $5 2 $4
  ; Windows drops a trailing dot or space, so such a part names another file.
  StrCmp $3 ".\" bad_path
  StrCmp $3 " \" bad_path
  StrCmp $3 "\\" 0 next_index
  ; A folder line ends in one backslash, which the wrapping doubles.
  IntOp $3 $2 - 2
  IntCmp $4 $3 next_index bad_path bad_path
  next_index:
  IntOp $4 $4 + 1
  Goto next_part
  bad_length:
  StrCpy $R5 "an empty or too long line"
  Return
  bad_path:
  StrCpy $R5 "a path outside the Vivary folder"
  done:
FunctionEnd

; Removes what the previous setup listed in install-files.txt: the files,
; then the folders deepest first, in list order. Nothing is deleted
; recursively, so files a user added stay. Every line is checked before
; anything is deleted. A listed folder that became a link stops the
; removal, so no delete reaches outside $INSTDIR. Sets $R7 to the number of
; listed files that remain, and $R8 to 1 when there is no list or to 2 when the
; list is damaged but setup's marker is here, which a setup rerun can repair.
Function ${PREFIX}RemoveInstalledFiles
  Call ${PREFIX}RequireFixedInstallDir
  StrCpy $R7 0
  StrCpy $R8 0
  IfFileExists "$INSTDIR\${INSTALL_LIST}" 0 no_list
  ClearErrors
  FileOpen $R3 "$INSTDIR\${INSTALL_LIST}" r
  IfErrors unreadable
  check_line:
  Call ${PREFIX}ReadListLine
  StrCmp $R9 "eof" checked
  StrCmp $R9 "truncated" 0 check_content
  StrCpy $R5 "a cut-off line"
  Goto bad_line
  check_content:
  Call ${PREFIX}CheckListLine
  StrCmp $R5 "" 0 bad_line
  StrCpy $2 $R4 1 -1
  StrCmp $2 "\" 0 check_line
  ; Read the folder's own attributes. A trailing backslash would follow a link.
  StrCpy $6 $R4 -1
  ; .r3 is $3, not $R3, so the list handle in $R3 stays intact.
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\$6") i .r3'
  IntCmp $3 -1 check_line
  IntOp $3 $3 & 0x400
  IntCmp $3 0 check_line linked linked
  checked:
  FileClose $R3
  ClearErrors
  FileOpen $R3 "$INSTDIR\${INSTALL_LIST}" r
  IfErrors unreadable
  remove_line:
  Call ${PREFIX}ReadListLine
  StrCmp $R9 "line" 0 removed
  StrCpy $2 $R4 1 -1
  StrCmp $2 "\" remove_folder
  Delete "$INSTDIR\$R4"
  IfFileExists "$INSTDIR\$R4" 0 remove_line
  DetailPrint "Could not remove $INSTDIR\$R4"
  IntOp $R7 $R7 + 1
  Goto remove_line
  remove_folder:
  ; Not recursive: the folder goes only when it is empty.
  StrCpy $6 $R4 -1
  RMDir "$INSTDIR\$6"
  Goto remove_line
  removed:
  FileClose $R3
  Return
  no_list:
  StrCpy $R8 1
  Return
  unreadable:
  MessageBox MB_OK|MB_ICONSTOP "Setup could not read $INSTDIR\${INSTALL_LIST}, so nothing was removed." /SD IDOK
  Abort "Setup could not read the installed-file list. Nothing was removed."
  bad_line:
  FileClose $R3
  ; Nothing was deleted yet. With setup's marker here, a setup rerun rewrites
  ; the list, so the caller decides instead of stopping for good.
  IfFileExists "$INSTDIR\${SETUP_MARKER}" 0 bad_line_stop
  DetailPrint "$INSTDIR\${INSTALL_LIST} is damaged ($R5). Nothing was removed."
  StrCpy $R8 2
  Return
  ; $R5 holds the reason: a cut-off line or the CheckListLine result.
  bad_line_stop:
  MessageBox MB_OK|MB_ICONSTOP "$INSTDIR\${INSTALL_LIST} is damaged ($R5), so nothing was removed." /SD IDOK
  Abort "The installed-file list is damaged ($R5). Nothing was removed."
  linked:
  FileClose $R3
  MessageBox MB_OK|MB_ICONSTOP "$INSTDIR\$6 is a link to another folder, so nothing was removed. Remove that link, then try again." /SD IDOK
  Abort "A Vivary folder is a link. Nothing was removed."
FunctionEnd

; Holds a per-user mutex for the life of this process. A second setup or
; uninstaller finds it taken (ERROR_ALREADY_EXISTS, 183) and exits non-zero.
Function ${PREFIX}AcquireSetupMutex
  System::Call 'kernel32::CreateMutexW(p 0, i 1, w "${SETUP_MUTEX}") p .r0 ?e'
  Pop $1
  StrCmp $0 0 busy
  IntCmp $1 183 busy
  Return
  busy:
  MessageBox MB_OK|MB_ICONSTOP "Vivary setup or its uninstaller is already running. Finish or close it, then try again." /SD IDOK
  SetErrorLevel 2
  Quit
FunctionEnd

!macroend
!insertmacro VIVARY_SHARED_FUNCTIONS ""
!insertmacro VIVARY_SHARED_FUNCTIONS "un."

Function .onInit
  ; The packaged application is 64-bit only.
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Vivary needs 64-bit Windows. This computer runs 32-bit Windows, so setup installed nothing." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  Call AcquireSetupMutex
  ; A /D= command-line option would otherwise choose another folder.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Vivary"
FunctionEnd

; Stops setup, before it removes or extracts anything, when the payload's
; longest file or folder path would not fit under this install root. Windows
; limits a file path to 259 characters and a folder path to 247. The builder
; passes the payload's longest relative paths as LONGEST_FILE and LONGEST_FOLDER.
Function RequirePathRoom
  StrLen $0 "$INSTDIR\"
  IntOp $1 $0 + ${LONGEST_FILE}
  IntCmp $1 259 0 0 too_long
  IntOp $1 $0 + ${LONGEST_FOLDER}
  IntCmp $1 247 0 0 too_long
  Return
  too_long:
  MessageBox MB_OK|MB_ICONSTOP "The Vivary folder path, $INSTDIR, is too long for Vivary's files under the Windows path limit, so setup changed nothing." /SD IDOK
  SetErrorLevel 2
  Abort "The Vivary folder path is too long. Nothing was changed."
FunctionEnd

; An existing folder is changed only when it holds a previous Vivary: its
; uninstall entry points here, or it has the file list, vivary.exe or the
; uninstaller. A partly removed install still has its list, so setup can
; repair it. A previous install without a list is refused after this check.
Function RequirePreviousVivary
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  StrCmp $0 $INSTDIR found
  IfFileExists "$INSTDIR\${INSTALL_LIST}" found
  IfFileExists "$INSTDIR\${SETUP_MARKER}" found
  IfFileExists "$INSTDIR\vivary.exe" found
  IfFileExists "$INSTDIR\${UNINSTALLER}" found
  MessageBox MB_OK|MB_ICONSTOP "$INSTDIR already exists and does not contain Vivary, so setup did not change it." /SD IDOK
  Abort "$INSTDIR does not contain Vivary. Nothing was changed."
  found:
FunctionEnd

Section "Vivary"
  SectionIn RO
  ; RemoveInstalledFiles sets $R8 to 0, 1 or 2. A new folder skips it, so -1
  ; means no previous install was read and nothing was removed.
  StrCpy $R8 -1
  Call RequireFixedInstallDir
  Call RequirePathRoom
  Call RequireVivaryClosed
  ; Removes only an empty folder. A folder with files is checked first.
  RMDir "$INSTDIR"
  IfFileExists "$INSTDIR\*.*" 0 new_folder
  Call RequirePreviousVivary
  DetailPrint "Removing the previous Vivary application files."
  Call RemoveInstalledFiles
  ; A damaged list with setup's marker: copy over it, which rewrites the list.
  IntCmp $R8 2 copy_files
  IntCmp $R8 1 0 list_read list_read
  ; No list. Setup's marker means a first install that did not finish here, so
  ; setup copies over it. Without the marker setup cannot tell its files from
  ; others, so it changes nothing.
  IfFileExists "$INSTDIR\${SETUP_MARKER}" copy_files no_list
  list_read:
  IntCmp $R7 0 copy_files
  MessageBox MB_OK|MB_ICONSTOP "Some files of the previous Vivary in $INSTDIR are in use. Close Vivary and any program using those files, then run setup again." /SD IDOK
  Abort "Some previous Vivary files are in use. Run setup again after closing them."
  no_list:
  MessageBox MB_OK|MB_ICONSTOP "$INSTDIR ${NO_LIST_TEXT}" /SD IDOK
  Abort "The installed-file list is missing. Nothing was changed."
  ; The folder did not exist or was empty, so setup owns it. The marker goes in
  ; before any payload file, so a failed install can be repaired by a rerun.
  new_folder:
  ClearErrors
  CreateDirectory "$INSTDIR"
  FileOpen $0 "$INSTDIR\${SETUP_MARKER}" a
  IfErrors write_failed
  FileWrite $0 "Vivary setup created this folder. The Vivary uninstaller removes this file."
  FileClose $0
  copy_files:
  ClearErrors
  SetOutPath "$INSTDIR"
  ; The new list goes in before any payload file. The previous version's files
  ; are gone by now, so the list on disk always names every Vivary file there,
  ; and an uninstall after an interrupted extraction removes all of them. A
  ; listed file that never arrived counts as removed. The list is written under
  ; a temporary name, then moved over the old list in one step
  ; (MOVEFILE_REPLACE_EXISTING 1 + MOVEFILE_WRITE_THROUGH 8), so an interrupted
  ; write leaves the old list or the new one, never part of one.
  File "/oname=${INSTALL_LIST_TEMP}" "${INSTALL_LIST_FILE}"
  IfErrors write_failed
  ; Before anything is replaced, refuse a file at a payload path that setup does
  ; not own. A damaged list with the marker ($R8 = 2) cannot tell owned files
  ; from others, so that repair path keeps copying over the folder.
  StrCmp $R8 2 owned_checked
  Call RequireNoUnownedFiles
  owned_checked:
  System::Call 'kernel32::MoveFileExW(w "$INSTDIR\${INSTALL_LIST_TEMP}", w "$INSTDIR\${INSTALL_LIST}", i 9) i .r0'
  IntCmp $0 0 write_failed
  File /r "${PAYLOAD_DIR}/*"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"
  CreateShortcut "$SMPROGRAMS\Vivary.lnk" "$INSTDIR\vivary.exe" "" "$INSTDIR\vivary.exe" 0
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Vivary"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${DISPLAY_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Jeff Kazzee"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\vivary.exe,0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" ${ESTIMATED_KB}
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  IfErrors write_failed
  Return
  write_failed:
  MessageBox MB_OK|MB_ICONSTOP "Setup could not write every Vivary file to $INSTDIR. Run setup again." /SD IDOK
  Abort "Setup could not write every Vivary file."
SectionEnd

; Stops setup when a file already sits at a payload file path in the new list,
; install-files.tmp. Every file the previous list named is gone by now, and a
; failed removal already stopped setup, so such a file is one setup does not own,
; for example one the user added. Setup deletes only install-files.tmp, so the old
; list, entry, uninstaller and marker stay as they were, and a rerun after the user
; moves the file succeeds. When RemoveInstalledFiles read a list ($R8 = 0), the
; previous version's files are already gone, and the message says so. Otherwise
; nothing was removed. Folder lines are skipped: a file at a payload folder path
; makes File /r fail, which stops setup through write_failed and replaces nothing.
Function RequireNoUnownedFiles
  ClearErrors
  FileOpen $R3 "$INSTDIR\${INSTALL_LIST_TEMP}" r
  IfErrors unreadable
  next_line:
  Call ReadListLine
  StrCmp $R9 "eof" checked
  StrCmp $R9 "truncated" invalid
  Call CheckListLine
  StrCmp $R5 "" 0 invalid
  StrCpy $2 $R4 1 -1
  StrCmp $2 "\" next_line
  IfFileExists "$INSTDIR\$R4" unowned next_line
  checked:
  FileClose $R3
  Return
  unowned:
  FileClose $R3
  Delete "$INSTDIR\${INSTALL_LIST_TEMP}"
  StrCmp $R8 0 0 nothing_removed
  MessageBox MB_OK|MB_ICONSTOP "$INSTDIR\$R4 is not a Vivary file, so setup did not replace it. The previous Vivary files were already removed, so Vivary will not start until setup finishes. Move that file out of $INSTDIR, then run setup again." /SD IDOK
  SetErrorLevel 2
  Abort "$INSTDIR\$R4 is not a Vivary file. The previous Vivary files were already removed. Move that file, then run setup again."
  nothing_removed:
  MessageBox MB_OK|MB_ICONSTOP "$INSTDIR\$R4 is not a Vivary file, so setup did not replace it. Move it out of $INSTDIR, then run setup again." /SD IDOK
  SetErrorLevel 2
  Abort "$INSTDIR\$R4 is not a Vivary file. Nothing was changed."
  invalid:
  FileClose $R3
  unreadable:
  Delete "$INSTDIR\${INSTALL_LIST_TEMP}"
  MessageBox MB_OK|MB_ICONSTOP "Setup could not read its new file list. Run setup again." /SD IDOK
  SetErrorLevel 2
  Abort "Setup could not read its new file list. Run setup again."
FunctionEnd

Function LaunchVivary
  SetOutPath "$INSTDIR"
  Exec '"$INSTDIR\vivary.exe"'
FunctionEnd

; Records the shortcut so the uninstaller removes only one that setup made.
Function CreateDesktopShortcut
  SetOutPath "$INSTDIR"
  ClearErrors
  CreateShortcut "$DESKTOP\Vivary.lnk" "$INSTDIR\vivary.exe" "" "$INSTDIR\vivary.exe" 0
  ; Record only a shortcut that exists, so the uninstaller never deletes another.
  IfErrors done
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "VivaryDesktopShortcut" 1
  done:
FunctionEnd

Function un.onInit
  Call un.AcquireSetupMutex
  Call un.RequireFixedInstallDir
FunctionEnd

; The uninstaller, the uninstall entry, the marker and the file list go last,
; and only when every listed file is gone. Otherwise they stay, so the
; uninstaller can run again. The list goes very last: a folder that holds only
; the list is still recognized and repaired by setup.
Section "Uninstall"
  Call un.RequireFixedInstallDir
  Call un.RequireVivaryClosed
  Call un.RemoveInstalledFiles
  IntCmp $R8 2 unfinished
  IntCmp $R8 1 0 list_read list_read
  IfFileExists "$INSTDIR\${SETUP_MARKER}" unfinished no_list
  list_read:
  IntCmp $R7 0 remove_entry
  MessageBox MB_OK|MB_ICONSTOP "Some Vivary files in $INSTDIR are in use and were not removed. Close the programs using them, then run the uninstaller again." /SD IDOK
  Abort "Some Vivary files are in use. Run the uninstaller again after closing them."
  no_list:
  MessageBox MB_OK|MB_ICONSTOP "$INSTDIR ${NO_LIST_TEXT}" /SD IDOK
  Abort "The installed-file list is missing. Nothing was removed."
  unfinished:
  MessageBox MB_OK|MB_ICONSTOP "$INSTDIR ${UNFINISHED_TEXT}" /SD IDOK
  Abort "The Vivary install did not finish. Nothing was removed."
  remove_entry:
  Delete "$SMPROGRAMS\Vivary.lnk"
  ReadRegDWORD $0 HKCU "${UNINSTALL_KEY}" "VivaryDesktopShortcut"
  ${If} $0 = 1
    Delete "$DESKTOP\Vivary.lnk"
  ${EndIf}
  Delete "$INSTDIR\${UNINSTALLER}"
  ; A scanner or another program can hold the file. The entry, marker and list
  ; then stay, so the uninstaller can run again.
  IfFileExists "$INSTDIR\${UNINSTALLER}" 0 uninstaller_removed
  MessageBox MB_OK|MB_ICONSTOP "$INSTDIR\${UNINSTALLER} could not be removed. Close any program that is scanning or holding it, then run the uninstaller again." /SD IDOK
  Abort "The uninstaller could not remove itself. Run it again."
  uninstaller_removed:
  ClearErrors
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  IfErrors 0 entry_removed
  ; The error flag is also set when the key is already gone. Only a key that
  ; still opens is a failure.
  ClearErrors
  EnumRegValue $0 HKCU "${UNINSTALL_KEY}" 0
  IfErrors entry_removed
  ; The marker and list stay, so setup can still recognize and repair the folder.
  MessageBox MB_OK|MB_ICONSTOP "The Installed apps entry for Vivary could not be removed. Run Vivary setup to repair the install, then uninstall again." /SD IDOK
  Abort "The uninstall entry could not be removed. Run setup, then uninstall again."
  entry_removed:
  Delete "$INSTDIR\${SETUP_MARKER}"
  Delete "$INSTDIR\${INSTALL_LIST_TEMP}"
  Delete "$INSTDIR\${INSTALL_LIST}"
  ; Removes the folder only when it is empty. Files a user added stay.
  RMDir "$INSTDIR"
  IfFileExists "$INSTDIR\*.*" 0 kept_data
  ; Files the user added keep the folder. A new marker tells the next setup that
  ; the folder is Vivary's, so it installs beside those files and deletes none.
  ClearErrors
  FileOpen $0 "$INSTDIR\${SETUP_MARKER}" a
  IfErrors marker_not_written
  FileWrite $0 "Vivary was uninstalled. Files you added to this folder were kept. Vivary setup can install here again beside them."
  FileClose $0
  DetailPrint "Files you added to $INSTDIR were kept. Vivary setup can install there again beside them."
  Goto kept_data
  marker_not_written:
  DetailPrint "Files you added to $INSTDIR were kept. Move them elsewhere before you run Vivary setup again."
  kept_data:
  DetailPrint "${KEPT_DATA_TEXT}"
SectionEnd
