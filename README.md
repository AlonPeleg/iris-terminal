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