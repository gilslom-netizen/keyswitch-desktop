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
;   4. A progress bar that behaves like a progress bar (see "OWNED PROGRESS
;      BAR" below): starts at 0% when installing starts, keeps moving at a
;      steady pace, NEVER moves backwards, and reaches 100% exactly when the
;      installation completes.
; =============================================================================

; electron-builder injects this file via a command-line -X!include BEFORE its
; own installer.nsi template runs "!include MUI2.nsh", so MUI_HEADER_TEXT and
; friends are not yet defined at this point unless we pull them in ourselves.
; MUI2.nsh has its own include guard, so re-including it here is a no-op once
; the main template includes it later.
!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh

; =============================================================================
; OWNED PROGRESS BAR
; =============================================================================
; The stock electron-builder install page's progress bar is driven by THREE
; uncoordinated writers, which is why it looks broken no matter how the
; section is tuned:
;   1. NSIS's own engine weighs progress by instruction data size — and the
;      single `File` that unpacks the embedded app archive into $PLUGINSDIR
;      carries almost ALL the weight, so the bar races to ~90% in the first
;      seconds;
;   2. the Nsis7z plugin then takes the bar over with its own scale while it
;      extracts that archive — visibly jumping the bar BACKWARDS mid-install;
;   3. the tail (CopyFiles into $INSTDIR, shortcuts, registry, settings) has
;      almost no weight, so the bar sits at ~100% while work is still going.
;
; Fix: take ownership. When the install page appears (KsInstFilesShow):
;   * the stock bar (control id 1004) is hidden — NSIS and Nsis7z keep
;     happily messaging the hidden control;
;   * an identical-looking progress bar (same rect, same styles, so RTL and
;     theming match) is created in its place — ONLY KeySwitch writes to it;
;   * the installer relaunches its own exe hidden with /KSPROG flags: that
;     instance (KsMaybeRunProgressWatcher, exits in .onInit long before any
;     UI or the single-instance mutex) is a WATCHER that drives the visible
;     bar every 100ms. A separate process is required because NSIS cannot
;     safely execute script on a timer while the install section runs
;     (script timers would race the engine's shared string buffers).
;
; The watcher's position is monotonic BY CONSTRUCTION — it only ever takes
; the maximum of:
;   * its own eased motion toward 98.5% (so the bar never freezes, even
;     inside long opaque steps like CopyFiles);
;   * the REAL extraction progress mirrored from the hidden stock bar,
;     rescaled into 0..87% (Nsis7z's backward resets are simply ignored
;     because a maximum can't go down);
;   * milestone floors the install section drops as flag files in
;     $PLUGINSDIR: files-in-place → 90%, settings written → 96%.
; When the section completes, .onInstSuccess drops the "done" flag: the
; watcher sets 100% and exits. So 0% is when installing starts, 100% is when
; installing is actually finished, and there is no path by which the bar can
; ever move backwards. If the watcher could not start at all, the milestone
; writers below notice the bar never moved and drive it directly (coarse but
; still monotonic and still ending at 100%).
;
; Progress-bar messages (WinUser/CommCtrl): PBM_SETPOS=0x0402,
; PBM_SETRANGE32=0x0406, PBM_GETRANGE=0x0407 (wParam=0 → high limit),
; PBM_GETPOS=0x0408. The visible bar's range is 0..1000.

; Runs first thing in .onInit (both installer and uninstaller-stub builds
; call preInit, so this lives outside the BUILD_UNINSTALLER guard). A normal
; launch returns immediately; a /KSPROG launch never comes back.
!macro preInit
  Call KsMaybeRunProgressWatcher
!macroend

Function KsMaybeRunProgressWatcher
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/KSPROG=" $1     ; visible (overlay) bar HWND
  ${If} ${Errors}
    Return                            ; normal launch — continue as installer
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/KSPROGN=" $2    ; hidden stock bar HWND
  ${If} ${Errors}
    StrCpy $2 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/KSPROGD=" $8    ; installer's $PLUGINSDIR (flag files)
  ${If} ${Errors}
    StrCpy $8 ""
  ${EndIf}

  StrCpy $3 0                         ; current position, 0..1000
  StrCpy $9 9000                      ; safety budget: ~15 minutes of ticks
  ${Do}
    IntOp $9 $9 - 1
    ${If} $9 < 0
      Quit
    ${EndIf}
    ; install dialog gone (finished / cancelled) → nothing left to drive
    System::Call 'user32::IsWindow(p r1) i .r4'
    ${If} $4 = 0
      Quit
    ${EndIf}
    ; section completed → snap to 100% and stop; this is the ONLY way the
    ; bar reaches full, so "100%" always means "actually done"
    ${If} $8 != ""
    ${AndIf} ${FileExists} "$8\ks-done"
      SendMessage $1 0x0402 1000 0
      Quit
    ${EndIf}
    ; milestone floors dropped by the install section
    ${If} $8 != ""
    ${AndIf} ${FileExists} "$8\ks-floor-960"
      ${If} $3 < 960
        StrCpy $3 960
      ${EndIf}
    ${ElseIf} $8 != ""
    ${AndIf} ${FileExists} "$8\ks-floor-900"
      ${If} $3 < 900
        StrCpy $3 900
      ${EndIf}
    ${EndIf}
    ; mirror REAL extraction progress from the hidden stock bar into 0..870.
    ; Taking the max means Nsis7z's mid-install range resets push nothing
    ; backwards — dips are ignored, rises count.
    ${If} $2 <> 0
      SendMessage $2 0x0408 0 0 $5    ; PBM_GETPOS
      SendMessage $2 0x0407 0 0 $6    ; PBM_GETRANGE → high limit
      ${If} $6 > 1000000              ; keep 32-bit IntOp math overflow-free
        IntOp $6 $6 / 1024
        IntOp $5 $5 / 1024
      ${EndIf}
      ${If} $6 > 0
        IntOp $5 $5 * 870
        IntOp $5 $5 / $6
        ${If} $5 > 870
          StrCpy $5 870
        ${EndIf}
        ${If} $5 > $3
          StrCpy $3 $5
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ; steady easing toward 985 so the bar visibly keeps moving even inside
    ; long steps that report nothing (CopyFiles, the old-version uninstall)
    IntOp $7 985 - $3
    IntOp $7 $7 / 80
    ${If} $7 < 1
      StrCpy $7 1
    ${EndIf}
    IntOp $3 $3 + $7
    ${If} $3 > 985
      StrCpy $3 985
    ${EndIf}
    SendMessage $1 0x0402 $3 0        ; PBM_SETPOS
    Sleep 100
  ${Loop}
FunctionEnd

; ---------------------------------------------------------------------------
; Silently close a running KeySwitch before installing/updating.
; ---------------------------------------------------------------------------
; KeySwitch is a background tray app, so during a manual re-install/upgrade the
; default electron-builder check pops up "KeySwitch is running — click OK to
; close it. If it doesn't close, try closing it manually." and PAUSES the
; installer (which is why the green progress bar appears frozen partway). That
; prompt is pointless for a background app the installer can close itself.
;
; Defining customCheckAppRunning replaces electron-builder's default
; _CHECK_APP_RUNNING. This is the same termination it does — graceful taskkill,
; then a forced one, with retries — just WITHOUT the upfront confirmation
; dialog, so the install proceeds without stalling and the progress bar keeps
; moving to completion. The only prompt kept is the genuine last resort: a
; process that refuses to die (e.g. running elevated), where manual action is
; truly required. Defined outside the BUILD_UNINSTALLER guard so both the
; installer and the uninstaller get the same quiet behavior.
!macro customCheckAppRunning
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    DetailPrint `Closing running "${PRODUCT_NAME}"...`
    !ifdef INSTALL_MODE_PER_ALL_USERS
      nsExec::Exec `taskkill /im "${APP_EXECUTABLE_FILENAME}"`
    !else
      nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
    !endif
    Sleep 300
    StrCpy $R1 0
    ks_kill_loop:
      IntOp $R1 $R1 + 1
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        Sleep 1000
        !ifdef INSTALL_MODE_PER_ALL_USERS
          nsExec::Exec `taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
        !else
          nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
        !endif
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
          DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
          Sleep 2000
        ${else}
          Goto ks_not_running
        ${endif}
      ${else}
        Goto ks_not_running
      ${endif}
      ${if} $R1 > 2
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY ks_kill_loop
        Quit
      ${else}
        Goto ks_kill_loop
      ${endif}
    ks_not_running:
  ${endif}
!macroend

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

Var KsBar        ; our visible progress bar (overlay owned by the watcher)
Var KsNBar       ; the hidden stock progress bar (id 1004)

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
  StrCpy $KsValAT "0" ; auto-toast OFF by default — the notification SOUND is
                      ; the default feedback (the app's autoSound default is
                      ; true and kicks in whenever the toast is off)
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
  ; The very next MUI page electron-builder inserts after this macro is
  ; MUI_PAGE_INSTFILES, so this SHOW hook binds to the install page — where
  ; we take ownership of the progress bar (see the header at the top).
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW KsInstFilesShow
!macroend

; Runs on the UI thread when the install page is shown, BEFORE the install
; section starts executing: hide the stock bar, clone an identical bar over
; it, and start the watcher process that will drive it.
Function KsInstFilesShow
  FindWindow $0 "#32770" "" $HWNDPARENT   ; inner page dialog
  ${If} $0 = 0
    Return
  ${EndIf}
  GetDlgItem $1 $0 1004                   ; the stock progress bar
  ${If} $1 = 0
    Return
  ${EndIf}
  ; the stock bar's rectangle, in the page dialog's client coordinates
  System::Call '*(i, i, i, i) p .r2'
  System::Call 'user32::GetWindowRect(p r1, p r2)'
  System::Call 'user32::MapWindowPoints(p 0, p r0, p r2, i 2)'
  System::Call '*$2(i .r3, i .r4, i .r5, i .r6)'
  System::Free $2
  IntOp $5 $5 - $3                        ; width
  IntOp $6 $6 - $4                        ; height
  ; clone the stock bar's styles so ours is pixel-identical (incl. the RTL
  ; mirroring of the Hebrew installer and the themed smooth fill)
  System::Call 'user32::GetWindowLongW(p r1, i -16) i .r7'   ; GWL_STYLE
  System::Call 'user32::GetWindowLongW(p r1, i -20) i .r8'   ; GWL_EXSTYLE
  System::Call 'user32::CreateWindowExW(i r8, w "msctls_progress32", w "", i r7, i r3, i r4, i r5, i r6, p r0, p 0, p 0, p 0) p .r9'
  ${If} $9 = 0
    Return                                ; couldn't create → keep stock behavior
  ${EndIf}
  StrCpy $KsBar $9
  StrCpy $KsNBar $1
  System::Call 'user32::ShowWindow(p r1, i 0)'               ; SW_HIDE stock bar
  SendMessage $KsBar 0x0406 0 1000        ; PBM_SETRANGE32 0..1000
  SendMessage $KsBar 0x0402 0 0           ; PBM_SETPOS 0 — starts at the start
  Exec '"$EXEPATH" /KSPROG=$KsBar /KSPROGN=$KsNBar /KSPROGD="$PLUGINSDIR"'
FunctionEnd

; Milestone from the install section: drop a floor flag for the watcher. If
; the bar never moved, the watcher isn't running (blocked relaunch?) — then
; drive the bar directly as a coarse fallback (still monotonic: floors only
; ever go up, and 100% still comes only from .onInstSuccess).
; $0 = floor value (0..1000)
Function KsProgressFloor
  ${If} $KsBar == ""
    Return
  ${EndIf}
  Push $1
  Push $2
  FileOpen $1 "$PLUGINSDIR\ks-floor-$0" w
  FileClose $1
  SendMessage $KsBar 0x0408 0 0 $2        ; PBM_GETPOS
  ${If} $2 < 25
    SendMessage $KsBar 0x0402 $0 0
  ${EndIf}
  Pop $2
  Pop $1
FunctionEnd

; All application files are inside $INSTDIR — the heavy ~90% of the work is
; done (electron-builder calls this right after archive decompression+copy).
!macro customFiles_x64
  Push $0
  StrCpy $0 900
  Call KsProgressFloor
  Pop $0
!macroend

; The section finished successfully — this, and only this, completes the bar.
Function .onInstSuccess
  ${If} $KsBar != ""
    Push $1
    Push $2
    FileOpen $1 "$PLUGINSDIR\ks-done" w
    FileClose $1
    SendMessage $KsBar 0x0408 0 0 $2
    ${If} $2 < 25
      SendMessage $KsBar 0x0402 1000 0    ; watcher never ran — finish directly
    ${EndIf}
    Pop $2
    Pop $1
  ${EndIf}
FunctionEnd

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

  ${NSD_CreateCheckbox} 10u 28u 280u 12u "הצג הודעה צפה לאחר תיקון אוטומטי (כבוי: צליל עדין במקום)"
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

  ; settings are written — everything but the final bookkeeping is done
  Push $0
  StrCpy $0 960
  Call KsProgressFloor
  Pop $0
!macroend

!endif ; !BUILD_UNINSTALLER
