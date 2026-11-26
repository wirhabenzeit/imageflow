// Runs the tasks of IMAGEFLOW_SPIKE's JSON file in order and appends one JSON line per answer to its output file.
const { app, BrowserWindow, ipcMain, webUtils } = require('electron');
const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tasks, output, stay } = JSON.parse(readFileSync(process.argv.find((a) => a.endsWith('.tasks.json')), 'utf8'));
const addon = require(join(__dirname, 'native', 'photos.node'));
const log = (line) => appendFileSync(output, line + '\n');
let waiting;
addon.start((line) => { log(line); if (JSON.parse(line).task) waiting?.(); });
app.whenReady().then(async () => {
  if (stay) {
    const w = new BrowserWindow({ x: 540, y: 200, width: 420, height: 290, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    await w.loadURL('data:text/html,' + encodeURIComponent('<body style="font:14px system-ui;background:#fc9">Web drop: drag a photo from Photos here<script>' +
      "const {ipcRenderer,webUtils}=require('electron');document.ondragover=e=>e.preventDefault();document.ondrop=e=>{e.preventDefault();" +
      "ipcRenderer.send('drop',{types:[...e.dataTransfer.types],files:[...e.dataTransfer.files].map(f=>({type:f.type,size:f.size,path:(p=>!p?'none':p.includes('.photoslibrary')?'inside the library':'elsewhere')(webUtils.getPathForFile(f))}))})}</script>"));
    ipcMain.on('drop', (_e, value) => { log(JSON.stringify({ event: 'webDrop', ...value })); addon.run('dragboard', '{}'); });
  }
  for (const [name, args] of tasks) {
    const done = new Promise((resolve) => { waiting = resolve; });
    addon.run(name, JSON.stringify(args ?? {}));
    await done;
  }
  log(JSON.stringify({ done: true }));
  if (!stay) app.quit();
});
