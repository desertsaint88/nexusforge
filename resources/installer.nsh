# NexusForge's installer and uninstaller in the Grey Hat look of the app icon (npm run brand): near-black pages,
# light grey text in Bahnschrift titles, dark buttons and title bar, the hexagon mark on the side and header images.
# electron-builder puts this file before its installer script, so the MUI settings below are read by every page;
# the functions come later (customHeader) because they use MUI's page variables. Pages get them as SHOW functions
# through electron-builder's page macros (customWelcomePage ... customUninstallPage below). Two pages can't: the
# folder page and the uninstaller's progress page come right after electron-builder's install-mode page, which uses
# up any SHOW define meant for them. Those two are painted at run time (.onVerifyInstDir, the un.nfTheme section).
# No custom `script` in electron-builder.yml for this: with one, electron-builder stops building the uninstaller.

!define MUI_BGCOLOR "0E0E0E"
!define MUI_TEXTCOLOR "C8C8C8"
!define MUI_INSTFILESPAGE_COLORS "B4B4B4 121212"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"

!ifdef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.nfGuiInit
  !define MUI_WELCOMEPAGE_TITLE "REMOVE NEXUSFORGE"
  !define MUI_WELCOMEPAGE_TEXT "This removes the NexusForge program from this PC.$\r$\n$\r$\nYour game library, installed mods, profiles and settings in %APPDATA%\NexusForge stay, and so does everything NexusForge put into your games. To take the mods out of a game first, use Purge in NexusForge.$\r$\n$\r$\nClick Next to continue."
  !define MUI_FINISHPAGE_TITLE "NEXUSFORGE IS REMOVED"
  !define MUI_FINISHPAGE_TEXT "NexusForge has been removed from this PC. Your library and mods are still in %APPDATA%\NexusForge if you install it again."
!else
  !define MUI_CUSTOMFUNCTION_GUIINIT nfGuiInit
  !define MUI_WELCOMEPAGE_TITLE "NEXUSFORGE ${VERSION}"
  !define MUI_WELCOMEPAGE_TEXT "Universal game mod manager and launcher.$\r$\n$\r$\nMod loaders, ReShade, verified deployment and diagnostics for every game on this PC, with mods from Nexus Mods, the Steam Workshop, mod.io, CurseForge and more.$\r$\n$\r$\nAn installed NexusForge is updated in place: your library, mods, profiles and settings stay as they are.$\r$\n$\r$\nClick Next to continue."
  !define MUI_FINISHPAGE_TITLE "NEXUSFORGE IS READY"
  !define MUI_FINISHPAGE_TEXT "NexusForge ${VERSION} is installed.$\r$\n$\r$\nUpdates come from inside the app (Settings, About and updates)."
!endif

# A welcome page with the side image (electron-builder has none by default); skipped when the app updates itself.
!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW nfShowWelcome
  !insertmacro MUI_PAGE_WELCOME
!macroend

# Comes right before the progress page.
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW nfShowInstFiles
!macroend

# electron-builder's finish page (assistedInstaller.nsh), with the SHOW function added.
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW nfShowFinish
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.nfShowWelcome
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

# Comes right before the uninstaller's finish page.
!macro customUninstallPage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.nfShowFinish
!macroend

# NexusForge installs for the current user (its default, %LOCALAPPDATA%\Programs); no "for whom" page.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro NF_THEME_FUNCTIONS P
  # Dark title bar in the page colour (Windows 11; older Windows ignore it).
  Function ${P}nfDarkFrame
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x000E0E0E, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, *i 0x00262626, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i 0x00C8C8C8, i 4)'
  FunctionEnd

  # Every child window of $R8: text in light grey on near-black, push buttons in Windows' dark style, check boxes
  # and radio buttons drawn plainly (themed ones ignore the text colour), the progress bar in greys, the etched
  # white separator lines as flat dark grey ones.
  Function ${P}nfDarkChildren
    Push $0
    Push $1
    Push $2
    StrCpy $0 0
    nf_loop:
      FindWindow $0 "" "" $R8 $0
      StrCmp $0 0 nf_done
      System::Call 'user32::GetClassNameW(p r0, w .r1, i 64)'
      System::Call 'user32::GetWindowLongW(p r0, i -16) i .r2'
      StrCmp $1 "Button" nf_button
      StrCmp $1 "Edit" nf_edit
      StrCmp $1 "msctls_progress32" nf_progress
      StrCmp $1 "SysListView32" nf_list
      StrCmp $1 "#32770" nf_loop
      # Static: a picture (the side image) keeps its own pixels.
      IntOp $2 $2 & 0x1F
      IntCmp $2 0x0E nf_loop
      IntCmp $2 0x10 nf_line
      SetCtlColors $0 C8C8C8 0E0E0E
      Goto nf_loop
    nf_line:
      System::Call 'user32::GetWindowLongW(p r0, i -16) i .r2'
      IntOp $2 $2 & 0xFFFFFFE0
      System::Call 'user32::SetWindowLongW(p r0, i -16, i r2)'
      SetCtlColors $0 2A2A2A 2A2A2A
      Goto nf_loop
    nf_button:
      IntOp $2 $2 & 0xF
      IntCmp $2 1 nf_push nf_push
      System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
      SetCtlColors $0 C8C8C8 0E0E0E
      Goto nf_loop
    nf_push:
      System::Call 'uxtheme::#133(p r0, i 1)'
      System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
      SendMessage $0 0x031A 0 0
      Goto nf_loop
    nf_edit:
      System::Call 'uxtheme::#133(p r0, i 1)'
      System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_CFD", p 0)'
      SetCtlColors $0 DCDCDC 161616
      Goto nf_loop
    nf_progress:
      System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
      SendMessage $0 0x0409 0 0x00A8A8A8
      SendMessage $0 0x2001 0 0x001C1C1C
      Goto nf_loop
    nf_list:
      System::Call 'uxtheme::#133(p r0, i 1)'
      System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
      Goto nf_loop
    nf_done:
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  Function ${P}nfGuiInit
    Push $R6
    Push $R7
    Push $R8
    # Windows' dark mode for this program's controls (uxtheme SetPreferredAppMode: allow dark).
    System::Call 'uxtheme::#135(i 1)'
    Call ${P}nfDarkFrame
    SetCtlColors $HWNDPARENT C8C8C8 0E0E0E
    StrCpy $R8 $HWNDPARENT
    Call ${P}nfDarkChildren
    # Page title in Bahnschrift, like the mark's lettering; the branding line ("NexusForge 1.9.0") dimmed. MUI
    # draws it twice for an embossed look (1028 under 1256); only 1256 is kept (nfShowPage hides 1028).
    CreateFont $R7 "Bahnschrift" 11 600
    GetDlgItem $R6 $HWNDPARENT 1037
    SendMessage $R6 ${WM_SETFONT} $R7 1
    GetDlgItem $R6 $HWNDPARENT 1256
    SetCtlColors $R6 5A5A5A 0E0E0E
    Pop $R8
    Pop $R7
    Pop $R6
  FunctionEnd

  # $R8 = the newest page window. While a page opens, the one before it can still be there, above it (a new child
  # window goes below its siblings), so the last #32770 child is the new page.
  Function ${P}nfNewestPage
    Push $0
    StrCpy $0 0
    StrCpy $R8 0
    nf_next:
      FindWindow $0 "#32770" "" $HWNDPARENT $0
      StrCmp $0 0 nf_end
      StrCpy $R8 $0
      Goto nf_next
    nf_end:
    Pop $0
  FunctionEnd

  # The pages in the middle (folder, progress). Also called while a page is already on screen, so it repaints.
  Function ${P}nfShowPage
    Push $R7
    Push $R8
    GetDlgItem $R7 $HWNDPARENT 1028
    ShowWindow $R7 ${SW_HIDE}
    Call ${P}nfNewestPage
    SetCtlColors $R8 C8C8C8 0E0E0E
    Call ${P}nfDarkChildren
    System::Call 'user32::RedrawWindow(p R8, p 0, p 0, i 0x185)'
    Pop $R8
    Pop $R7
  FunctionEnd

  Function ${P}nfShowInstFiles
    Call ${P}nfShowPage
  FunctionEnd

  # Welcome and finish pages (side image): MUI paints them in MUI_BGCOLOR / MUI_TEXTCOLOR itself; the title gets
  # Bahnschrift and the "Run NexusForge" check box its text colour (themed check boxes ignore it, so it's drawn
  # plainly; MUI only does that in high contrast mode).
  Function ${P}nfShowWelcome
    Push $R7
    CreateFont $R7 "Bahnschrift" 16 600
    SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $R7 1
    Pop $R7
  FunctionEnd

  Function ${P}nfShowFinish
    Push $R7
    CreateFont $R7 "Bahnschrift" 16 600
    SendMessage $mui.FinishPage.Title ${WM_SETFONT} $R7 1
    # Only the installer's finish page has it (customFinishPage).
    !ifndef BUILD_UNINSTALLER
      !ifndef HIDE_RUN_AFTER_FINISH
        System::Call 'uxtheme::SetWindowTheme(p $mui.FinishPage.Run, w " ", w " ")'
      !endif
    !endif
    Pop $R7
  FunctionEnd
!macroend

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    !insertmacro NF_THEME_FUNCTIONS "un."

    # Sections run in the order they are written, and this one comes before electron-builder's uninstall section
    # (uninstaller.nsh is included last), so it paints the progress page as soon as the page is on screen.
    Section "un.nfTheme"
      ${IfNot} ${Silent}
        Call un.nfShowInstFiles
      ${EndIf}
    SectionEnd
  !else
    !insertmacro NF_THEME_FUNCTIONS ""

    # NSIS calls this as the folder page opens and on every change of the folder: paint the page the first time
    # (a window property marks it; going Back and Next again makes a new page).
    Function .onVerifyInstDir
      Push $0
      Push $R8
      Call nfNewestPage
      GetDlgItem $0 $R8 1019
      ${If} $0 != 0
        System::Call 'user32::GetPropW(p R8, w "nf.painted") p .r0'
        ${If} $0 == 0
          System::Call 'user32::SetPropW(p R8, w "nf.painted", p 1)'
          Call nfShowPage
        ${EndIf}
      ${EndIf}
      Pop $R8
      Pop $0
    FunctionEnd
  !endif
!macroend
