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