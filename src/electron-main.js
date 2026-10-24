import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";

const html = fileURLToPath(new URL("./management.html", import.meta.url));
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1100, height: 760, webPreferences: { contextIsolation: true } });
  window.loadFile(html);
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
