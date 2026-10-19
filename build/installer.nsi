; rslvd-tunnel Windows Installer (NSIS)
; Builds a proper Setup.exe that installs the tunnel client

!include "MUI2.nsh"
!include "EnvVarUpdate.nsh"

; ─── General ──────────────────────────────────────────────────────────────────
Name "rslvd-tunnel"
OutFile "../app/public/dl/rslvd-tunnel-setup-windows-amd64.exe"
InstallDir "$PROGRAMFILES\rslvd-tunnel"
InstallDirRegKey HKLM "Software\rslvd-tunnel" "InstallDir"
RequestExecutionLevel admin

; ─── Version Info ─────────────────────────────────────────────────────────────
VIProductVersion "1.2.0.0"
VIAddVersionKey "ProductName" "rslvd-tunnel"
VIAddVersionKey "ProductVersion" "1.2.0"
VIAddVersionKey "CompanyName" "rslvd.privatedns.org"
VIAddVersionKey "FileDescription" "rslvd.privatedns.org Tunnel Client Installer"
VIAddVersionKey "LegalCopyright" "2026 rslvd.privatedns.org"

; ─── MUI Settings ────────────────────────────────────────────────────────────
!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

; ─── Pages ────────────────────────────────────────────────────────────────────
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ─── Install Section ──────────────────────────────────────────────────────────
Section "Install"
  SetOutPath "$INSTDIR"
  
  ; Copy binary
  File "../app/public/dl/rslvd-tunnel-windows-amd64.exe"
  Rename "$INSTDIR\rslvd-tunnel-windows-amd64.exe" "$INSTDIR\rslvd-tunnel.exe"
  
  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"
  
  ; Start Menu
  CreateDirectory "$SMPROGRAMS\rslvd-tunnel"
  CreateShortCut "$SMPROGRAMS\rslvd-tunnel\Uninstall.lnk" "$INSTDIR\uninstall.exe"
  
  ; Registry
  WriteRegStr HKLM "Software\rslvd-tunnel" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\rslvd-tunnel" "DisplayName" "rslvd-tunnel"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\rslvd-tunnel" "DisplayVersion" "1.2.0"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\rslvd-tunnel" "Publisher" "rslvd.privatedns.org"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\rslvd-tunnel" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\rslvd-tunnel" "URLInfoAbout" "https://rslvd.privatedns.org"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\rslvd-tunnel" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\rslvd-tunnel" "NoRepair" 1
  
  ; Add to PATH
  ${EnvVarUpdate} $0 "PATH" "A" "HKLM" "$INSTDIR"
SectionEnd

; ─── Uninstall Section ────────────────────────────────────────────────────────
Section "Uninstall"
  ; Remove files
  Delete "$INSTDIR\rslvd-tunnel.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  
  ; Remove Start Menu
  Delete "$SMPROGRAMS\rslvd-tunnel\Uninstall.lnk"
  RMDir "$SMPROGRAMS\rslvd-tunnel"
  
  ; Remove registry
  DeleteRegKey HKLM "Software\rslvd-tunnel"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\rslvd-tunnel"
  
  ; Remove from PATH
  ${un.EnvVarUpdate} $0 "PATH" "R" "HKLM" "$INSTDIR"
SectionEnd
