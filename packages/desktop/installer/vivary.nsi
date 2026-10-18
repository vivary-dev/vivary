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

!define DISPLAY_VERSION "${APP_VERSION}+${PAYLOAD_COMMIT_SHORT}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vivary"
!define UNINSTALLER "Uninstall Vivary.exe"
!define INSTALL_LIST "install-files.txt"
; Setup writes this marker into a folder it creates, before any payload file.
; A rerun after a failed first install recognizes the folder by it.
!define SETUP_MARKER "vivary-setup.txt"
; One name for setup and the uninstaller, so they cannot run at the same time.
!define SETUP_MUTEX "Local\VivarySetup"
!define NO_LIST_TEXT "has no ${INSTALL_LIST}, so Vivary cannot tell which files it installed and removed nothing. Remove that folder by hand. Your projects, conversations and settings are stored elsewhere and are not affected."
!define UNFINISHED_TEXT "holds a Vivary install that did not finish, so nothing was removed. Run Vivary setup again to finish it, then uninstall."
; The longest relative path a list line may hold. Windows paths stop at 259
; characters (MAX_PATH 260 with its terminator). The install root for a profile
; folder name of up to 40 characters, C:\Users\<name>\AppData\Local\Programs\Vivary\,
; takes 80 of them, which leaves 179. build-installer.mjs uses the same budget.
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
; listed files that remain and $R8 to 1 when there is no list.
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
  StrCmp $R9 "truncated" bad_line
  Call ${PREFIX}CheckListLine
  StrCmp $R5 "" 0 bad_line
  StrCpy $2 $R4 1 -1
  StrCmp $2 "\" 0 check_line
  ; Read the folder's own attributes. A trailing backslash would follow a link.
  StrCpy $6 $R4 -1
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\$6") i .r3'
  IntCmp $3 -1 check_line
  IntOp $3 $3 & 0x400
  IntCmp $3 0 check_line linked linked
  checked:
  FileClose $R3
  FileOpen $R3 "$INSTDIR\${INSTALL_LIST}" r
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
  MessageBox MB_OK|MB_ICONSTOP "$INSTDIR\${INSTALL_LIST} names a path outside the Vivary folder, so nothing was removed." /SD IDOK
  Abort "The installed-file list is not valid. Nothing was removed."
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
  Call RequireFixedInstallDir
  Call RequireVivaryClosed
  ; Removes only an empty folder. A folder with files is checked first.
  RMDir "$INSTDIR"
  IfFileExists "$INSTDIR\*.*" 0 new_folder
  Call RequirePreviousVivary
  DetailPrint "Removing the previous Vivary application files."
  Call RemoveInstalledFiles
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
  ; The list goes last, so it exists only after every file was written.
  File "/oname=${INSTALL_LIST}" "${INSTALL_LIST_FILE}"
  IfErrors write_failed
  Return
  write_failed:
  MessageBox MB_OK|MB_ICONSTOP "Setup could not write every Vivary file to $INSTDIR. Run setup again." /SD IDOK
  Abort "Setup could not write every Vivary file."
SectionEnd

Function LaunchVivary
  SetOutPath "$INSTDIR"
  Exec '"$INSTDIR\vivary.exe"'
FunctionEnd

; Records the shortcut so the uninstaller removes only one that setup made.
Function CreateDesktopShortcut
  SetOutPath "$INSTDIR"
  CreateShortcut "$DESKTOP\Vivary.lnk" "$INSTDIR\vivary.exe" "" "$INSTDIR\vivary.exe" 0
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "VivaryDesktopShortcut" 1
FunctionEnd

Function un.onInit
  Call un.AcquireSetupMutex
  Call un.RequireFixedInstallDir
FunctionEnd

; The uninstall entry, the file list and the uninstaller go last, and only
; when every listed file is gone. Otherwise they stay, so the uninstaller
; can run again.
Section "Uninstall"
  Call un.RequireFixedInstallDir
  Call un.RequireVivaryClosed
  Call un.RemoveInstalledFiles
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
  Delete "$INSTDIR\${INSTALL_LIST}"
  Delete "$INSTDIR\${SETUP_MARKER}"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  Delete "$INSTDIR\${UNINSTALLER}"
  ; Removes the folder only when it is empty. Files a user added stay.
  RMDir "$INSTDIR"
  IfFileExists "$INSTDIR\*.*" 0 kept_data
  DetailPrint "Files you added to $INSTDIR were kept."
  kept_data:
  DetailPrint "${KEPT_DATA_TEXT}"
SectionEnd
