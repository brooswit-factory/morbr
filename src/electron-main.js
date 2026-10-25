import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";

const html = fileURLToPath(new URL("./management.html", import.meta.url));
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1100, height: 760, webPreferences: { contextIsolation: true } });
  if (process.env.MORBR_UI_URL) window.loadURL(process.env.MORBR_UI_URL);
  else window.loadFile(html);
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
