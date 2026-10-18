; Vivary per-user Windows installer.
;
; build-installer.mjs supplies every define below. Build with it rather than
; calling makensis directly, because it also validates the payload and checks
; that every payload file went into the installer.
;
; Safety contract, enforced by tests/installer-script.test.mjs:
; - Runs as the current user and writes only HKCU, the per-user Start menu,
;   the desktop (when asked) and $LOCALAPPDATA\Programs\Vivary.
; - The install folder is fixed. .onInit resets it, so /D= cannot move it.
; - The only recursive delete is RemoveApplicationFolder, and it runs only
;   after RequireFixedInstallDir confirms the exact folder.
; - Nothing here reads, writes or deletes Vivary's user data or projects.
; - No process is ever stopped. A running Vivary makes setup ask the user.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
RequestExecutionLevel user

!macro REQUIRE_DEFINE NAME
  !ifndef ${NAME}
    !error "Missing -D${NAME}. Build with packages/desktop/build-installer.mjs."
  !endif
!macroend
!insertmacro REQUIRE_DEFINE PAYLOAD_DIR
!insertmacro REQUIRE_DEFINE OUTFILE
!insertmacro REQUIRE_DEFINE LICENSE_FILE
!insertmacro REQUIRE_DEFINE ICON_FILE
!insertmacro REQUIRE_DEFINE APP_VERSION
!insertmacro REQUIRE_DEFINE SOURCE_COMMIT
!insertmacro REQUIRE_DEFINE SOURCE_COMMIT_SHORT
!insertmacro REQUIRE_DEFINE ESTIMATED_KB

!define DISPLAY_VERSION "${APP_VERSION}+${SOURCE_COMMIT_SHORT}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vivary"
!define UNINSTALLER "Uninstall Vivary.exe"
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
VIAddVersionKey "SourceCommit" "${SOURCE_COMMIT}"

!include "MUI2.nsh"
!include "LogicLib.nsh"

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

; Removes the application folder. This is the only recursive delete in setup.
Function ${PREFIX}RemoveApplicationFolder
  Call ${PREFIX}RequireFixedInstallDir
  RMDir /r "$INSTDIR"
  IfFileExists "$INSTDIR\*.*" 0 removed
  MessageBox MB_OK|MB_ICONSTOP "Some files in $INSTDIR are in use. Close Vivary and any program using those files, then run setup again." /SD IDOK
  Abort "Some Vivary files are in use."
  removed:
FunctionEnd

!macroend
!insertmacro VIVARY_SHARED_FUNCTIONS ""
!insertmacro VIVARY_SHARED_FUNCTIONS "un."

Function .onInit
  ; A /D= command-line option would otherwise choose another folder.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Vivary"
FunctionEnd

; An existing folder is replaced only when it holds a previous Vivary.
Function RequirePreviousVivary
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
  IfFileExists "$INSTDIR\*.*" 0 copy_files
  Call RequirePreviousVivary
  DetailPrint "Removing the previous Vivary application files."
  Call RemoveApplicationFolder
  copy_files:
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
  Call un.RequireFixedInstallDir
FunctionEnd

Section "Uninstall"
  Call un.RequireFixedInstallDir
  Call un.RequireVivaryClosed
  Call un.RemoveApplicationFolder
  Delete "$SMPROGRAMS\Vivary.lnk"
  ReadRegDWORD $0 HKCU "${UNINSTALL_KEY}" "VivaryDesktopShortcut"
  ${If} $0 = 1
    Delete "$DESKTOP\Vivary.lnk"
  ${EndIf}
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DetailPrint "${KEPT_DATA_TEXT}"
SectionEnd
