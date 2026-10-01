# Change Log

All notable changes to the "iris-terminal" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.30]

- Fix: a by-reference argument (`.outSearch`) now counts as filling in that variable, so later reads of it (`outSearch.data...`) are no longer asked for. If you replace the argument with `.B`, those later reads follow to `B` automatically.

## [0.1.29]

- Change: the fill-in view now opens right away after the terminal is chosen; the quick-input boxes and their title-bar button are gone. Code without variables is still sent immediately.

## [0.1.28]

- Fix: after *Send Selection to Terminal and Run* the focus moves to the IRIS terminal (it stayed in the editor), same as for *Send*.

## [0.1.27]

- Change: *Send Selection to Terminal and Run* no longer shows the preview line; it runs right after the last variable. (The `confirmBeforeRun` setting is removed.)

## [0.1.26]

- Change: the quick-input box is the default again (Enter = next variable, Enter on the last = send / run). A new **preview button** in its title bar opens the fill-in view instead.
- Change: the fill-in view is now a small tab in the bottom panel (no editor split, nothing covered) showing the code with the variables as inline fields. Only the variables are editable; Tab / Enter move on, Enter on the last one sends or runs, Esc cancels. Typed values carry over from the quick-input box.
- Change: only one action per command: *Send* never runs, *Send and Run* shows the preview line (setting `confirmBeforeRun`). The extra "other action" shortcut is gone.
- Removed: the `inputMode` setting and the snippet-style editor from 0.1.24 / 0.1.25.

## [0.1.25]

- Change: Send Selection no longer remembers earlier answers. The quick-input box always starts empty, with the variable's name and the typing examples as its placeholder; the fill-in editor always starts with the original code. (The `rememberValues` setting is removed.)

## [0.1.24]

- New: **fill-in editor** for Send Selection. The selected code opens in a small editor beside yours with every variable as a Tab stop (repeated variables mirror as you type). Tab / Shift+Tab to move, Ctrl+Enter sends, Ctrl+Shift+Enter does the other action (Send vs. Run), Esc cancels; buttons above the code do the same. Switch back to the old one-by-one prompts with `iris-terminal.sendSelection.inputMode`.
- Fix: with more than one IRIS terminal open, Send Selection now always asks which terminal to use (the active one is listed first).

## [0.1.23]

- New: **Send Selection to Terminal** / **Send Selection to Terminal and Run** (editor right-click). Asks for a value for each variable the selected code reads but does not assign; what you type is inserted as ObjectScript (number, string, `[array]`, `{object}`, variable, `.byRef`), empty keeps the original. Understands command abbreviations, translates `$$$OK` / `$$$ISOK` / `$$$ISERR`, asks for other macros and for `$this` / `..Property`.
- New: marketplace icon.

## [Unreleased]

- Initial release
