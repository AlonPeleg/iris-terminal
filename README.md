# 🚀 IRIS Terminal Bridge

[![VS Code Extension](https://img.shields.io/badge/Visual%20Studio%20Code-Extension-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/)
[![InterSystems IRIS](https://img.shields.io/badge/InterSystems-IRIS%20%2F%20Cach%C3%A9-orange)](https://www.intersystems.com/)

An advanced **Auto-SSL Terminal Bridge** for InterSystems IRIS and Caché. This extension replaces the standard terminal with a smart, context-aware bridge that handles Telnet/SSL handshakes, automatic authentication, and features a built-in **Global Viewer** with BiDi support.

---

## ✨ Key Features

### 🛠️ Smart Terminal PTY
* **Auto-SSL Handshake**: Automatically detects and connects via SSL/TLS (port 23) with a fallback to standard Net sockets.
* **Zero-Touch Login**: Automatically injects credentials from your `intersystems.servers` configuration.
* **Live Namespace Tracking**: The terminal tab dynamically renames itself based on your current `$Namespace` (e.g., `USER>`, `ENSDEMO>`).
* **Legacy Encoding Support**: Full support for **Windows-1255** and **UTF-8**, ensuring Hebrew characters render correctly.

### 🔍 Interactive Global Viewer
* **Terminal Link Provider**: High-speed regex detection for Global references in your terminal. `Ctrl+Click` any global line to inspect it.
* **Sidebar + detail layout**: every global you `Ctrl+Click` is added to a sidebar with the full value and its pieces in a wide pane next to it. Switch the sidebar between **Tree** (server > global > subscripts, with expand / collapse all) and a flat **List** (newest first). Click the same global again later and it is kept as another capture, so you can compare how it changed.
* **Pin to compare**: pin one entry, select another (or click a new global) and the two are shown side by side with the differing pieces highlighted.
* **Piece Explorer**: Splits global data by `*` (or `^`, `|`, `~`, or any delimiter you type) into numbered pieces, with per-entry piece search, *Hide empty* and a *Copy* button per piece. Up / Down arrows move through the sidebar.
* **BiDi / Hebrew "Flip"**: Specialized logic to handle "Visual Hebrew" (reversed text) often found in legacy Caché systems. Includes smart character swapping for parentheses and brackets.

### 📌 Productivity Tweaks
* **Auto-Pin (`isfs`)**: Forcefully pins server-side files to your tab bar, preventing "Preview Mode" from closing your work while you navigate.
* **Persistent Sessions**: Retains webview context even when hidden, so your global history isn't lost during your session.

### 👁️ Global Watch
A bottom-panel tab (**IRIS: Open Global Watch**) that watches globals on a server without a visible terminal.

* **One tab per server.** `+ Connect to server` picks a server and encoding and opens a hidden connection to it; the ✕ on its tab or the plug button disconnects. Namespaces are read from the server and chosen per watch.
* **Patterns.** `^g` is the whole global. Empty slot = any value, `"text"` or a number = exact. A closing `)` means exactly that level; without it, that level and everything below. `^g()` level 1 only · `^g(,)` level 2 only · `^g("x")` that node only · `^g("x"` that node and everything below · `^g("x",` everything below, not the node · `^g(,,"out")` level 3 where the 3rd subscript is "out". Text subscripts need both quotes.
* **Filters on subscripts.** Each slot can hold more than a value (the field describes your pattern in words as you type; the **?** button next to Add watch lists everything):
  * `2:5`, `:5`, `2:` number from … to … (both ends included) · `>2` `>=2` `<5` `<=5`
  * `["out"` contains · `'["out"` does not contain · `"ab"*` starts with · `]"abc"` sorts after · `'="x"` is not · `?3N` ObjectScript pattern match (`'?3N` no match)
  * `{"abc","bbb",7,2:5}` any one of the listed values / ranges / prefixes (up to 100)
  * Example: `^mtempTest(2:5,,["out"` = 1st subscript from 2 to 5 and 3rd contains "out", at level 3 and below. `^mtempTest({"abc","bbb"},)` = everything below `^mtempTest("abc")` and `^mtempTest("bbb")`.
  * Filters are applied on the server and ranges / prefixes / exact lists skip straight to the matching subscripts; a contains / pattern filter has to look at every subscript at that level, so a watch stops after scanning 200,000 subscripts and says so (narrow it with a range, prefix or exact value on an earlier subscript).
* **Namespace in the reference.** `^["ACC"]g(...)` (or `^|"ACC"|g(...)`) uses that namespace; pasting one into the field selects the namespace in the dropdown and keeps just `^g(...)`.
* **Send to Global Watch from the editor.** Right-click in an ObjectScript editor (or run **IRIS: Send to Global Watch**) with the cursor inside a global reference, or with a global name selected (a double-click selects `mtempTest` without the `^`; the `^` is added, never doubled). Global Watch opens on that editor's server (`isfs://server:NS/…` or the workspace's `objectscript.conn`), connects if needed, selects the namespace and puts the reference in the global field with the cursor there. **Nothing is added or read**: edit the subscripts / filters, press Enter to add, ⟳ to read.
  * Subscripts that are plain literals are kept (`^mtempTest(1,"abc")`); variables and expressions become empty slots (`^mtempTest(id,"abc")` → `^mtempTest(,"abc")`). With just the cursor in it (nothing selected) the whole reference is copied as written, so a closing `)` means that level only - delete it to also see everything below. **What you select is what you get**, as long as the selection starts at the `^` or the name: selecting just `mtempTest` sends `^mtempTest` (the global), `mtempTest(` sends `^mtempTest(`, and `^g("a","b",` sends `^g("a","b",` (everything below that node, not the node itself). A selection that is only part of the name, or only inside the subscripts, falls back to the whole reference.
  * Routine calls are recognised and refused: `label^routine`, `$$^routine`, `$$label^routine`, `do ^routine`, `goto ^routine`, `$text(^routine)`. `^||x` (process-private) cannot be watched from another connection. An explicit namespace in the reference (`^["ACC"]x`) wins over the editor's namespace.
  * No default shortcut is assigned; bind **IRIS: Send to Global Watch** in Keyboard Shortcuts if you want one.
* **Nothing is read until you ask.** Press ⟳ or switch **Auto-refresh** on (off by default, every 10 seconds by default; polling pauses while the tab is hidden). Changed, new and removed nodes are highlighted until the next refresh.
* A global that does not exist (or was killed) is reported and keeps being watched; it appears when it is set again.
* **Highlight changes** (switch in the toolbar, on by default): marks nodes that are new, changed or removed since the previous refresh. Turn it off to see only the current data on every refresh.
* Values can be split on `*`, `^`, `|`, `~` or your own delimiter; long JSON values collapse; a watch shows at most 500 nodes at a time (**Show more** loads the next 500).
* Each connection is an IRIS process (it can use a license seat like a terminal does). **IRIS: Global Watch - Show Last Query** prints the ObjectScript that was typed, if you need to see what runs on the server.

### ⌨️ Send to Terminal
Select code in any editor, right-click, and choose **IRIS: Send to Terminal**. It types the code at the IRIS prompt and presses Enter. The *Fill in variables* step below is where you review it, so there is no separate "send but don't run" action any more. (The old command id `iris-terminal.sendSelection` still works for existing keybindings and does the same.)

With no selection, the current line is sent. Multi-line code is flattened to a single line (comments removed). Code that needs nothing filled in runs straight away.

**Which terminal.** With one IRIS terminal open it is used; with several, you are asked which one first.

**Fill in the variables.** Copied code usually depends on variables that only exist inside the original method. After the terminal is chosen (it is only asked when more than one is open), a small *Fill in variables* tab opens in the bottom panel next to Terminal, so it never splits or covers your editor. It shows the code with every name that the code *reads* but does not assign as an inline field:

* **Tab / Enter** – next variable, **Shift+Tab** – back.
* **Enter on the last one** – sends the line and runs it. **Esc** – cancel.
* Leave a field empty to keep the original text. A variable used several times is typed once and mirrored where it repeats.
* A line under the code tells what you typed (number, string, object, by-reference...) and warns about unbalanced quotes or brackets.

Code without any such variable is sent straight away, without opening the tab.

Whatever you type is inserted as ObjectScript:

| You type | It becomes |
|---|---|
| `123125` | a number |
| `"B"` | the string B |
| `[1,2,3]` | a dynamic array |
| `{"ID":1}` | a dynamic object |
| `B` | the variable B |
| `.B` | variable B passed by reference |
| *(empty)* | the original text stays as it is |

```objectscript
set status=$zaccessor.Customer.tableSearch(search,.outSearch)
```
`search` → `{"ID":1}`, `.outSearch` → *(empty)* gives `set status=$zaccessor.Customer.tableSearch({"ID":1},.outSearch)`.

* A chain with method calls, like `outSearch.data.%Get(0).ID`, is one field as a whole when the calls only have literal arguments, so you can type the final value (`55`). To use an object instead, type it together with the call (`[{"ID":5}].%Get(0).ID`). If a call's arguments contain variables (`obj.Method(arg)`), only the object part is asked, and the arguments are asked on their own.
* **`..Method(`, `..Property`, `$this`** (code selected from a class): the class name is read from the file. `..ClassMethod(` becomes `##class(Pkg.Class).ClassMethod(` automatically. Instance methods, properties and `$this` need an object, so an **Object** row appears above the code: pick *Variable* and type the variable that holds the object (`obj` → `obj.Method(`), or *%New* (`##class(Pkg.Class).%New()`), or *%OpenId* (`##class(Pkg.Class).%OpenId(<id>)`, type the id). When the object is used several times it is created or opened once, up front, so every use shares it.
* A by-reference argument such as `.outSearch` is treated as filled in by the call, so later uses (`outSearch.data`) are not asked. If you type `.B` for it, those later uses are renamed to `B` too.
* Command abbreviations (`s`, `k`, `d`, `f`, …) are understood. Assignment targets (`set x=`, `for i=`, `new`, `kill`, `catch ex`) are not asked for.
* A compound answer such as `3+1` is wrapped in parentheses, because ObjectScript evaluates strictly left to right.
* `$$$OK`, `$$$ISOK(x)` and `$$$ISERR(x)` are translated automatically. Any other macro is asked for (macros do not exist at the terminal prompt); simple `#define Name value` macros found in your workspace's `.inc` files are offered as the default.
* `$this`, `..Property` and `..Method()` are asked for too, since they only work inside a class.

Setting: `iris-terminal.sendSelection.lookupMacros`.

---

## 🚀 How to Use

1.  **Open Terminal**: Click the terminal icon in the Explorer title bar or right-click any folder and select **"IRIS: Open Terminal"**.
2.  **Select Server**: Choose from your configured InterSystems servers.
3.  **Choose Encoding**: Select between UTF-8 (Modern IRIS) or Windows-1255 (Legacy/Hebrew Caché).
4.  **Inspect Globals**: When a global reference appears in the terminal output (e.g., `^User.Data(1)="A*B*C"`), `Ctrl+Click` it to launch the **Global Viewer** in a side pane.

---

## ⚙️ Configuration

The extension leverages your existing InterSystems server definitions. Ensure your `settings.json` includes the standard server format:

```json
"intersystems.servers": {
    "LocalServer": {
        "host": "127.0.0.1",
        "username": "_SYSTEM",
        "password": "SYS",
        "description": "Production Server"
    }
}
### ▶ Run in Terminal (link above labels, functions and methods)
A **Run in Terminal** link appears next to *Debug | Copy Invocation* above every label in `.mac` / `.int` files and every `Method` / `ClassMethod` in `.cls` files. Click it and the call is built, run through the same *Fill in variables* step, and sent to the IRIS terminal:

| Signature | What is sent |
|---|---|
| routine function `TestFunction(test)` (its body has a `quit value` / `return value`) | `set status=$$TestFunction^WBLRSHOWFF(test)` |
| routine label `TestLabel(test)` (only a bare `quit`, or none) | `do TestLabel^WBLRSHOWFF(test)` |
| `ClassMethod getAllTables(ByRef out) As %Status` in `Tafnit.App.Portfolio.utils` | `set status=##class(Tafnit.App.Portfolio.utils).getAllTables(.out)` |
| `ClassMethod Reset()` (no return type) | `do ##class(Tafnit.App.Portfolio.utils).Reset()` |
| instance `Method Save(id) As %Status` | you choose the object (a variable you have, `%New()` or `%OpenId(id)`), e.g. `set status=##class(...).%OpenId(12).Save(5)` |

* The routine name comes from the `ROUTINE` line (or the file name); the class name from the `Class` line. `ByRef` / `Output` / `InOut` parameters of a method, and `&name` / `*name` in the signature of a routine label, are passed as `.name`.
* A label counts as a function when its body (down to the next label) has a `quit` or `return` that carries a value. When unsure it uses `do`, which is harmless for a function and avoids an error for a subroutine.
* The result lands in a variable called `status`; look at it in the terminal (`zw status`).
* **Which terminal, which namespace.** The editor's server and namespace come from its address (`isfs://server:NS/...`) or the workspace's `objectscript.conn`. A terminal of that server that is already on that namespace is used (the active one first). If the only terminals of that server are on another namespace, one of them is switched with `zn "NS"` typed in the same line before the code (a namespace that does not exist stops the line, so nothing runs in the wrong place), and it stays on that namespace. If there is no terminal for that server, one is opened on the editor's namespace (it asks for the encoding the first time and remembers it) and the code is sent once it is at a prompt. If a server's only terminal is disconnected, you are told to reconnect it. When the editor's server cannot be told (a plain local file without `objectscript.conn`), it uses the open terminal as before (asked when there are several) or starts the normal *open terminal* flow when there is none. The same applies to **Send to Terminal**.
* The link needs the extension to be loaded when an ObjectScript file opens (a small one-time load per VS Code window). Switch the link off with the setting `iris-terminal.runLens.enabled`.
