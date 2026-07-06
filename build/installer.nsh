; installer.nsh - KeySwitch Desktop
; =============================================================================
; Custom NSIS logic for the KeySwitch installer (included by electron-builder's
; assisted installer, so the user gets a normal graphical wizard — never a
; console window):
;
;   1. A dedicated settings page (nsDialogs) with the exact same options the
;      browser extension's popup offers: autocorrect on/off, auto-toast,
;      manual-toast, primary typing language — plus "start with Windows".
;   2. Pre-seeded settings from the download link. A "KSCFG" token can be
;      embedded either in the installer's file name
;      (e.g. KeySwitch-Setup-1.0.0-KSCFG1111h.exe) or on the command line
;      (KeySwitch-Setup.exe /KSCFG=1111h). Token format — 5 characters:
;        [1] autocorrect enabled        0/1
;        [2] show auto-correction toast 0/1
;        [3] show manual-shortcut toast 0/1
;        [4] start with Windows         0/1
;        [5] primary language           h=Hebrew e=English m=mixed
;      The settings page opens pre-filled with these values, so a link from
;      the extension can hand the user an installer that already matches the
;      preferences they picked there.
;   3. On install the chosen settings are written to
;      %APPDATA%\KeySwitch\settings.json — the exact file the app reads.
;      On upgrade (settings.json already exists) the page is skipped unless a
;      KSCFG token explicitly asks to override.
; =============================================================================

; electron-builder injects this file via a command-line -X!include BEFORE its
; own installer.nsi template runs "!include MUI2.nsh", so MUI_HEADER_TEXT and
; friends are not yet defined at this point unless we pull them in ourselves.
; MUI2.nsh has its own include guard, so re-including it here is a no-op once
; the main template includes it later.
!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh

; electron-builder compiles this whole template TWICE: once with
; BUILD_UNINSTALLER defined (to produce the embedded uninstaller stub) and
; once without (the real installer). Our settings page, KSCFG parsing and
; install-time writer are only ever invoked from the non-uninstaller pass
; (customInit/customPageAfterChangeDir/customInstall are all inserted inside
; "!ifndef BUILD_UNINSTALLER" blocks in electron-builder's own templates), so
; without this guard the Functions below are defined but never called in the
; uninstaller pass — NSIS's "not referenced" warning is treated as a fatal
; error by electron-builder, aborting the whole build.
!ifndef BUILD_UNINSTALLER

Var KsDialog
Var KsChkAC
Var KsChkAT
Var KsChkMT
Var KsChkAS
Var KsDropLang
Var KsValAC
Var KsValAT
Var KsValMT
Var KsValAS
Var KsValLang     ; h / e / m
Var KsHasToken
Var KsWriteCfg

; --- Find a KSCFG token. CLI (/KSCFG=xxxxx) wins over the file name. ---------
Function KsParseCfg
  StrCpy $KsHasToken "0"
  ; defaults (match the app's built-in settings defaults)
  StrCpy $KsValAC "1"
  StrCpy $KsValAT "1"
  StrCpy $KsValMT "0" ; manual-shortcut toast OFF by default (deliberate action)
  StrCpy $KsValAS "1"
  StrCpy $KsValLang "h"

  ; -- search "KSCFG=" in the command line ------------------------------------
  StrLen $0 $CMDLINE
  IntOp $1 $0 - 11          ; need room for "KSCFG=" + 5 chars
  StrCpy $2 0
  cli_loop:
    IntCmp $2 $1 cli_check cli_check cli_file
  cli_check:
    StrCpy $3 $CMDLINE 6 $2
    StrCmp $3 "KSCFG=" 0 cli_next
    IntOp $4 $2 + 6
    StrCpy $5 $CMDLINE 5 $4
    Goto token_found
  cli_next:
    IntOp $2 $2 + 1
    Goto cli_loop

  ; -- search "KSCFG" in the installer file name ------------------------------
  cli_file:
  StrLen $0 $EXEFILE
  IntOp $1 $0 - 10          ; need room for "KSCFG" + 5 chars
  StrCpy $2 0
  file_loop:
    IntCmp $2 $1 file_check file_check done
  file_check:
    StrCpy $3 $EXEFILE 5 $2
    StrCmp $3 "KSCFG" 0 file_next
    IntOp $4 $2 + 5
    StrCpy $5 $EXEFILE 5 $4
    Goto token_found
  file_next:
    IntOp $2 $2 + 1
    Goto file_loop

  token_found:
    ; $5 = 5-char token: validate and apply
    StrCpy $6 $5 1 0
    StrCmp $6 "0" 0 +2
      StrCpy $KsValAC "0"
    StrCpy $6 $5 1 1
    StrCmp $6 "0" 0 +2
      StrCpy $KsValAT "0"
    StrCpy $6 $5 1 2
    StrCmp $6 "0" 0 +2
      StrCpy $KsValMT "0"
    StrCpy $6 $5 1 3
    StrCmp $6 "0" 0 +2
      StrCpy $KsValAS "0"
    StrCpy $6 $5 1 4
    StrCmp $6 "e" 0 +3
      StrCpy $KsValLang "e"
      Goto token_ok
    StrCmp $6 "m" 0 token_ok
      StrCpy $KsValLang "m"
  token_ok:
    StrCpy $KsHasToken "1"

  done:
FunctionEnd

!macro customInit
  Call KsParseCfg
!macroend

; --- The settings page (between the directory page and the install page) -----
!macro customPageAfterChangeDir
  Page custom KsSettingsPageCreate KsSettingsPageLeave
!macroend

Function KsSettingsPageCreate
  ; Upgrade with no explicit token: keep the user's existing settings untouched.
  ${If} ${FileExists} "$APPDATA\KeySwitch\settings.json"
  ${AndIf} $KsHasToken == "0"
    StrCpy $KsWriteCfg "0"
    Abort
  ${EndIf}
  StrCpy $KsWriteCfg "1"

  !insertmacro MUI_HEADER_TEXT "הגדרות KeySwitch" "בחרו איך KeySwitch יעבוד. אפשר לשנות הכל בכל רגע מתוך התוכנה."

  nsDialogs::Create 1018
  Pop $KsDialog
  ${If} $KsDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 10u 10u 280u 12u "תיקון אוטומטי בזמן הקלדה — זיהוי שפה שגויה והחלפת שפת המקלדת (מומלץ)"
  Pop $KsChkAC
  ${If} $KsValAC == "1"
    ${NSD_Check} $KsChkAC
  ${EndIf}

  ${NSD_CreateCheckbox} 10u 28u 280u 12u "הצג הודעה צפה לאחר תיקון אוטומטי"
  Pop $KsChkAT
  ${If} $KsValAT == "1"
    ${NSD_Check} $KsChkAT
  ${EndIf}

  ${NSD_CreateCheckbox} 10u 46u 280u 12u "הצג הודעה לאחר המרה ידנית (Alt+Shift+J)"
  Pop $KsChkMT
  ${If} $KsValMT == "1"
    ${NSD_Check} $KsChkMT
  ${EndIf}

  ${NSD_CreateCheckbox} 10u 64u 280u 12u "הפעל את KeySwitch אוטומטית עם Windows"
  Pop $KsChkAS
  ${If} $KsValAS == "1"
    ${NSD_Check} $KsChkAS
  ${EndIf}

  ${NSD_CreateLabel} 10u 88u 120u 12u "שפת הקלדה עיקרית:"
  Pop $0

  ${NSD_CreateDropList} 135u 86u 100u 12u ""
  Pop $KsDropLang
  ${NSD_CB_AddString} $KsDropLang "עברית"
  ${NSD_CB_AddString} $KsDropLang "חצי חצי"
  ${NSD_CB_AddString} $KsDropLang "אנגלית"
  ${If} $KsValLang == "e"
    ${NSD_CB_SelectString} $KsDropLang "אנגלית"
  ${ElseIf} $KsValLang == "m"
    ${NSD_CB_SelectString} $KsDropLang "חצי חצי"
  ${Else}
    ${NSD_CB_SelectString} $KsDropLang "עברית"
  ${EndIf}

  ${NSD_CreateLabel} 10u 110u 280u 24u "ההגדרות נשמרות עבור המשתמש הנוכחי וניתנות לשינוי בכל עת דרך חלון ההגדרות של KeySwitch (חפשו KeySwitch בתפריט התחל)."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function KsSettingsPageLeave
  ${NSD_GetState} $KsChkAC $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $KsValAC "1"
  ${Else}
    StrCpy $KsValAC "0"
  ${EndIf}
  ${NSD_GetState} $KsChkAT $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $KsValAT "1"
  ${Else}
    StrCpy $KsValAT "0"
  ${EndIf}
  ${NSD_GetState} $KsChkMT $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $KsValMT "1"
  ${Else}
    StrCpy $KsValMT "0"
  ${EndIf}
  ${NSD_GetState} $KsChkAS $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $KsValAS "1"
  ${Else}
    StrCpy $KsValAS "0"
  ${EndIf}
  ${NSD_GetText} $KsDropLang $0
  ${If} $0 == "אנגלית"
    StrCpy $KsValLang "e"
  ${ElseIf} $0 == "חצי חצי"
    StrCpy $KsValLang "m"
  ${Else}
    StrCpy $KsValLang "h"
  ${EndIf}
FunctionEnd

; --- Write %APPDATA%\KeySwitch\settings.json ---------------------------------
!macro customInstall
  ; Silent installs / skipped page: still seed settings when a token was given
  ; or when this is a fresh install with no settings file yet.
  ${If} $KsWriteCfg != "1"
    ${If} $KsHasToken == "1"
      StrCpy $KsWriteCfg "1"
    ${ElseIf} ${FileExists} "$APPDATA\KeySwitch\settings.json"
      StrCpy $KsWriteCfg "0"
    ${Else}
      StrCpy $KsWriteCfg "1"
    ${EndIf}
  ${EndIf}

  ${If} $KsWriteCfg == "1"
    ${If} $KsValAC == "1"
      StrCpy $1 "true"
    ${Else}
      StrCpy $1 "false"
    ${EndIf}
    ${If} $KsValAT == "1"
      StrCpy $2 "true"
    ${Else}
      StrCpy $2 "false"
    ${EndIf}
    ${If} $KsValMT == "1"
      StrCpy $3 "true"
    ${Else}
      StrCpy $3 "false"
    ${EndIf}
    ${If} $KsValAS == "1"
      StrCpy $4 "true"
    ${Else}
      StrCpy $4 "false"
    ${EndIf}
    ${If} $KsValLang == "e"
      StrCpy $5 "en"
    ${ElseIf} $KsValLang == "m"
      StrCpy $5 "mixed"
    ${Else}
      StrCpy $5 "he"
    ${EndIf}

    CreateDirectory "$APPDATA\KeySwitch"
    FileOpen $9 "$APPDATA\KeySwitch\settings.json" w
    FileWrite $9 '{$\r$\n'
    FileWrite $9 '  "autocorrectEnabled": $1,$\r$\n'
    FileWrite $9 '  "showAutoToast": $2,$\r$\n'
    FileWrite $9 '  "showManualToast": $3,$\r$\n'
    FileWrite $9 '  "launchAtLogin": $4,$\r$\n'
    FileWrite $9 '  "primaryLang": "$5",$\r$\n'
    FileWrite $9 '  "manualShortcut": "Alt+Shift+J"$\r$\n'
    FileWrite $9 '}$\r$\n'
    FileClose $9
  ${EndIf}
!macroend

!endif ; !BUILD_UNINSTALLER
