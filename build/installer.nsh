; Revolution Fiskalizim — instalim si FURRA:
; UPDATE dhe instalim i ri: MOS fshi biznes.db, Revolution Fiskalizim, FiskalizimLicense / .install-salt.
; - Shortcuts → ProgramData\RevolutionInvest\{PRODUCT_NAME}-Launch\Start.cmd (JO $INSTDIR)
; - Folderi i instalimit fshehur (sef-lock.ps1)
; - Pa listë skedarësh gjatë instalimit

!macro customHeader
  ShowInstDetails nevershow
  ShowUninstDetails nevershow
  BrandingText " "
  !ifndef MUI_FINISHPAGE_RUN_TEXT
    !define MUI_FINISHPAGE_RUN_TEXT "Hap Revolution Fiskalizim"
  !endif
  !ifndef MUI_TEXT_INSTALLING_TITLE
    !define MUI_TEXT_INSTALLING_TITLE "Revolution Fiskalizim"
  !endif
  !ifndef MUI_TEXT_INSTALLING_SUBTITLE
    !define MUI_TEXT_INSTALLING_SUBTITLE "Duke u instaluar..."
  !endif
  !ifndef MUI_TEXT_FINISH_INFO_TITLE
    !define MUI_TEXT_FINISH_INFO_TITLE "Instalimi përfundoi!"
  !endif
  !ifndef MUI_TEXT_FINISH_INFO_TEXT
    !define MUI_TEXT_FINISH_INFO_TEXT "Revolution Fiskalizim u instalua me sukses.$\r$\n$\r$\nKlikoni Hap Revolution Fiskalizim për të filluar."
  !endif
!macroend

; LEGACY — mos thirr nga customInstall/customUnInstall. Factory wipe vetëm nga app (flag), jo Setup.
!macro WipeSEFDataDir DIR
  IfFileExists "${DIR}\*" 0 +2
    RMDir /r "${DIR}"
!macroend

!macro WipeAllSEFLocalData
  !insertmacro WipeSEFDataDir "$APPDATA\biznes-sef"
  !insertmacro WipeSEFDataDir "$APPDATA\Revolution-POS-SEF"
  !insertmacro WipeSEFDataDir "$APPDATA\Revolution-Fiskalizim"
  !insertmacro WipeSEFDataDir "$APPDATA\Revolution Fiskalizim"
  !insertmacro WipeSEFDataDir "$LOCALAPPDATA\biznes-sef"
  !insertmacro WipeSEFDataDir "$LOCALAPPDATA\Revolution-POS-SEF"
  !insertmacro WipeSEFDataDir "$LOCALAPPDATA\Revolution-Fiskalizim"
!macroend

!macro SEFLaunchDir
  ReadEnvStr $R7 "PROGRAMDATA"
  StrCmp $R7 "" 0 +2
    StrCpy $R7 "C:\ProgramData"
  StrCpy $R7 "$R7\RevolutionInvest\${PRODUCT_NAME}-Launch"
!macroend

!macro WriteSEFLaunchStub
  !insertmacro SEFLaunchDir
  RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}-Launch"
  RMDir /r "$R7"
  CreateDirectory "$R7"
  FileOpen $R8 "$R7\Start.cmd" w
  FileWrite $R8 "@echo off$\r$\n"
  FileWrite $R8 "start $\"$\" $\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\"$\r$\n"
  FileClose $R8
!macroend

!macro customUnInstall
  ; Çinstalim: hiq vetëm launcher — MOS fshi FiskalizimLicense / .install-salt / DB.
  !insertmacro SEFLaunchDir
  RMDir /r "$R7"
  RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}-Launch"
!macroend

!macro customInit
  ExecWait 'cmd /c taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T 2>nul' $0
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  Delete "C:\Users\Public\Desktop\${PRODUCT_NAME}.lnk"
  Sleep 800
!macroend

!macro customInstall
  SetDetailsPrint none
  SetDetailsView hide

  ; Instalim/update: ruaj DB dhe FiskalizimLicense (.install-salt, licencë).

  File "/oname=$PLUGINSDIR\sef-lock.ps1" "${BUILD_RESOURCES_DIR}\sef-lock.ps1"
  ExecWait '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\sef-lock.ps1" -Dir "$INSTDIR"' $0
  ExecWait 'cmd /c attrib +H "$INSTDIR"' $0

  IfFileExists "$APPDATA\RevolutionInvest\FiskalizimLicense\.install-salt" fisk_salt_skip
    File "/oname=$PLUGINSDIR\create-install-salt.ps1" "${BUILD_RESOURCES_DIR}\create-install-salt.ps1"
    ExecWait '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\create-install-salt.ps1"' $0
  fisk_salt_skip:

  !insertmacro WriteSEFLaunchStub
  !insertmacro SEFLaunchDir
  SetOutPath "$R7"
  File "/oname=$R7\app.ico" "${BUILD_RESOURCES_DIR}\icon.ico"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$R7\Start.cmd" "" "$R7\app.ico" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$R7\Start.cmd" "" "$R7\app.ico" 0
  CreateShortCut "C:\Users\Public\Desktop\${PRODUCT_NAME}.lnk" "$R7\Start.cmd" "" "$R7\app.ico" 0
  CreateShortCut "$newDesktopLink" "$R7\Start.cmd" "" "$R7\app.ico" 0
  CreateShortCut "$newStartMenuLink" "$R7\Start.cmd" "" "$R7\app.ico" 0
  StrCpy $launchLink "$newDesktopLink"
  ExecWait 'cmd /c attrib +H "$R7\app.ico"' $0
!macroend
