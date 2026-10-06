# Change Log

All notable changes to the "iris-terminal" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.44]

- New: **Run in Terminal / Send to Terminal now follow the editor's server and namespace.** A terminal of the editor's server that is already on the editor's namespace is used; otherwise a terminal of that server is switched there with `zn "NS"` in the same line; if there is no terminal for that server one is opened (on the editor's namespace, encoding remembered per server) and the code is sent once it is ready. Previously you got "no IRIS terminal is open" or the code ran in whatever namespace the terminal happened to be on.
- Fix: in `.int` / `.mac` labels, `&name` (by reference) and `*name` (output) in the signature are passed as `.name` (`do Label^RTN(.out)`) instead of `name`.

## [0.1.43]

- New: **Run in Terminal** link next to *Debug | Copy Invocation* above every label (`.mac` / `.int`) and `Method` / `ClassMethod` (`.cls`). It builds the call - `set status=$$Label^ROUTINE(args)` for a function, `do Label^ROUTINE(args)` for a subroutine, `set status=##class(Pkg.Class).Method(args)` / `do ##class(...)...` for class methods (instance methods ask for a variable, `%New()` or `%OpenId(id)`) - and sends it through the normal Fill-in step. A label is a function when its body has a `quit` / `return` with a value. Setting `iris-terminal.runLens.enabled` turns the link off.
- Change: the extension now loads when an ObjectScript file is opened (`onLanguage:objectscript`, `-class`, `-int`) so the link is there without using a command first.
- Change: **one "Send to Terminal"** instead of Send and Send-and-Run. It always presses Enter; the Fill-in step is the review. `iris-terminal.sendSelection` stays registered as an alias so keybindings keep working.

## [0.1.42]

- Fix: **Send to Global Watch** with only the global's name selected (a double-click) sent the whole reference with its subscripts. Now what you select is what you get: `mtempTest` -> `^mtempTest`, `mtempTest(` -> `^mtempTest(`, `^g("a","b",` -> `^g("a","b",`. With nothing selected (just the cursor in the reference) it still sends the whole reference.

## [0.1.41]

- Change: the Global Watch filter syntax help is no longer printed under the field; a **?** button next to *Add watch* opens it as a popover (click elsewhere or press Esc to close). The field itself stays as simple as before.
- Change: **Send to Global Watch** with only the first part of a reference selected (from `^` or the name to somewhere inside the subscripts) now sends just that part: selecting `^g("a","b",` sends `^g("a","b",` (everything below that node). Cursor only or the whole reference selected send the whole reference (selecting just the name changed in 0.1.42).

## [0.1.40]

- New: **filters on subscripts in Global Watch patterns.** Per slot: `2:5` / `:5` / `2:` (number range), `>2 >=2 <5 <=5`, `["out` (contains), `'["out` (does not contain), `"ab"*` (starts with), `]"abc"` (sorts after), `'="x"` (is not), `?3N` (ObjectScript pattern match) and lists `{"abc","bbb",7,2:5}`. Example: `^mtempTest(2:5,,["out"`. The field describes the pattern in words while you type.
  - Filtered watches stop after scanning 200,000 subscripts and say so in the watch.
- New: a namespace can lead the reference: `^["ACC"]g(...)` or `^|"ACC"|g(...)`. Pasting one into the field selects that namespace in the dropdown.
- New: **IRIS: Send to Global Watch** (right-click in an ObjectScript editor). Finds the global under the cursor / in the selection (adds `^` to a double-clicked bare name, ignores `label^routine`, `$$^routine`, `do ^routine`), takes the editor's server and namespace (`isfs://server:NS/...` or `objectscript.conn`), opens Global Watch on that server's tab (connecting if needed), selects the namespace and puts the global in the field. It does not add the watch or read anything.
- Build: the pattern parser is one source (`src/patternSyntax.ts`) used by the extension and, transpiled by `scripts/embed-media.js`, by the Global Watch page.

## [0.1.39]

- New: **Global Viewer redesigned** (fixes the grid-view cards whose delimiter dropdown, Original/Flipped button, time and x spilled outside the card). Entries now live in a sidebar with one wide detail pane next to it, so nothing can overflow.
  - The sidebar has a **Tree | List** switch: Tree groups by server > global > subscripts (with expand / collapse all), List is flat, newest first. The choice, the selected entry, the pinned entry and which branches are open are remembered.
  - **Pin to compare**: pin an entry, select another and see them side by side with differing pieces highlighted (a new Ctrl+Click capture is compared with the pinned one straight away).
  - Clicking the same global again keeps each capture (shown by time), so you can see how it changed.
  - The old List / Grid / Expand all / Collapse all buttons are gone; everything else (delimiter, Original/Flipped, piece search, Hide empty, Copy, Move to new window, Keep open, Clear all) is still there, now per entry in the detail pane. Colours follow your VS Code theme.
- Build: the viewer page is `media/globalViewer.html`, embedded at compile time into `src/globalViewerHtml.ts` (same as Global Watch).

## [0.1.38]

- New: Global Watch has a **Highlight changes** switch in the toolbar (on by default, remembered). Turn it off to just see the current data after every refresh: no *new* / *changed* / *removed* marks, no old values, and nodes that disappeared are simply gone.

## [0.1.37]

- Fix: the **Global Watch** tab could show "An error occurred while loading view: iris-terminal.globalWatch". The tab's page is now built into the extension itself instead of being read from a separate `media` file, and if something else ever stops it from starting, the tab shows the actual reason.
- Build: `npm run compile` now also generates `src/globalWatchHtml.ts` from `media/globalWatch.html` (via `scripts/embed-media.js`).

## [0.1.36]

- Fix: the extension could not be installed on VS Code older than 1.108 ("not compatible with the current version of Visual Studio Code"). It now installs on VS Code 1.95 and newer (compiled against the 1.95 API, so nothing newer is used).

## [0.1.35]

- New: **Global Watch** - a bottom-panel tab (command *IRIS: Open Global Watch*) that watches globals on a server through its own hidden connection, with one tab per server.
  - Pick a namespace per watch (the list comes from the server, the same call *Switch Namespace* uses) and type a global or a subscript pattern: `^g`, `^g()`, `^g(,)`, `^g("x")`, `^g("x"`, `^g("x",`, `^g(,,"out")`.
  - Nothing is read until you press refresh or turn Auto-refresh on (off by default; seconds box, default 10; paused while the tab is hidden). Changed / new / removed nodes are highlighted.
  - A missing global (or one you killed) is shown as such and keeps being watched.
  - Split values by `*` `^` `|` `~` or another delimiter, collapsible JSON values, at most 500 nodes per watch with *Show more*.
  - Disconnect with the plug button or by closing the server's tab. Watches are remembered; connections are not (a restored tab shows Reconnect).
  - New command *IRIS: Global Watch - Show Last Query* prints the ObjectScript that was sent.

## [0.1.34]

- Change: a chain with method calls such as `outSearch.data.%Get(0).ID` or `cust.GetName()` is now one field as a whole when every call has only literal arguments (numbers / strings), so you can replace the entire value (`55`). To use an object instead, type it with the call, e.g. `[{"ID":5}].%Get(0).ID`. When a call's arguments contain variables (`obj.Method(arg)`), only the object part is asked and the arguments are asked on their own, as before.

## [0.1.33]

- Fix: the **Object** row was always visible in the fill-in tab, even when the code needs no object (for example only `..ClassMethod(` calls). It now only shows for instance methods, properties and `$this`.

## [0.1.32]

- Change: the class file is only read when the selected code contains `..` or `$this`.

## [0.1.31]

- New: `..Method(` / `..Property` / `$this` in code selected from a class file now work at the terminal. The class name and the ClassMethod / Method declarations are read from the file you selected from.
  - `..ClassMethod(` is translated to `##class(Pkg.Class).ClassMethod(` automatically (a method that is not declared in the file is assumed to be a class method; `%New`, `%OpenId` etc. are known class methods).
  - Instance methods, properties and `$this` need an object: an **Object** row appears above the code with a dropdown - *Variable* (type the variable that holds the object), *%New* (becomes `##class(Pkg.Class).%New()`) or *%OpenId* (`##class(Pkg.Class).%OpenId(id)`, with a box for the id). If the object is used more than once it is created / opened once (`set obj=...`) so all uses share it. Leaving it empty keeps `..` as it is and warns that it will fail at the terminal.
  - Code that is not from a class file behaves as before (`..Name` is asked as a field).

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
