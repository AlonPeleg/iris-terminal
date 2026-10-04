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
* **Piece Explorer**: Automatically splits global data by the `*` delimiter into a structured list.
* **BiDi / Hebrew "Flip"**: Specialized logic to handle "Visual Hebrew" (reversed text) often found in legacy Caché systems. Includes smart character swapping for parentheses and brackets.

### 📌 Productivity Tweaks
* **Auto-Pin (`isfs`)**: Forcefully pins server-side files to your tab bar, preventing "Preview Mode" from closing your work while you navigate.
* **Persistent Sessions**: Retains webview context even when hidden, so your global history isn't lost during your session.

### 👁️ Global Watch
A bottom-panel tab (**IRIS: Open Global Watch**) that watches globals on a server without a visible terminal.

* **One tab per server.** `+ Connect to server` picks a server and encoding and opens a hidden connection to it; the ✕ on its tab or the plug button disconnects. Namespaces are read from the server and chosen per watch.
* **Patterns.** `^g` is the whole global. Empty slot = any value, `"text"` or a number = exact. A closing `)` means exactly that level; without it, that level and everything below. `^g()` level 1 only · `^g(,)` level 2 only · `^g("x")` that node only · `^g("x"` that node and everything below · `^g("x",` everything below, not the node · `^g(,,"out")` level 3 where the 3rd subscript is "out". Text subscripts need both quotes.
* **Nothing is read until you ask.** Press ⟳ or switch **Auto-refresh** on (off by default, every 10 seconds by default; polling pauses while the tab is hidden). Changed, new and removed nodes are highlighted until the next refresh.
* A global that does not exist (or was killed) is reported and keeps being watched; it appears when it is set again.
* **Highlight changes** (switch in the toolbar, on by default): marks nodes that are new, changed or removed since the previous refresh. Turn it off to see only the current data on every refresh.
* Values can be split on `*`, `^`, `|`, `~` or your own delimiter; long JSON values collapse; a watch shows at most 500 nodes at a time (**Show more** loads the next 500).
* Each connection is an IRIS process (it can use a license seat like a terminal does). **IRIS: Global Watch - Show Last Query** prints the ObjectScript that was typed, if you need to see what runs on the server.

### ⌨️ Send Selection to Terminal
Select code in any editor, right-click, and choose one of:

* **IRIS: Send Selection to Terminal** – types the code at the IRIS prompt and stops, so you can review it and press Enter yourself.
* **IRIS: Send Selection to Terminal and Run** – same, then presses Enter.

With no selection, the current line is sent. Multi-line code is flattened to a single line (comments removed), so nothing runs before you decide it should.

**Which terminal.** With one IRIS terminal open it is used; with several, you are asked which one first.

**Fill in the variables.** Copied code usually depends on variables that only exist inside the original method. After the terminal is chosen (it is only asked when more than one is open), a small *Fill in variables* tab opens in the bottom panel next to Terminal, so it never splits or covers your editor. It shows the code with every name that the code *reads* but does not assign as an inline field:

* **Tab / Enter** – next variable, **Shift+Tab** – back.
* **Enter on the last one** – sends the line (*Send*) or sends it and presses Enter (*Send and Run*). The action is the one you picked from the menu. **Esc** – cancel.
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