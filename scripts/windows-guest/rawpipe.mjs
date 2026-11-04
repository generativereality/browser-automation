// Minimal: does Chrome on Windows answer on --remote-debugging-pipe (fds 3/4)?
// node rawpipe.mjs <dir-for-a-temp-profile>. Run it once as is, and once with USERPROFILE
// pointed elsewhere to see Chrome refuse DevTools (see README).
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const chrome = process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
const dir = mkdtempSync(join(process.argv[2] || tmpdir(), 'rawpipe-'))
const c = spawn(chrome, ['--remote-debugging-pipe', `--user-data-dir=${dir}`, '--headless=new', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] })
let err = ''
c.stderr.on('data', (d) => { err += d })
c.stdout.on('data', () => {})
c.stdio[4].on('data', (d) => { console.log('REPLY', String(d).replace(/\0/g, '').slice(0, 160)); c.kill(); process.exit(0) })
setTimeout(() => c.stdio[3].write(JSON.stringify({ id: 1, method: 'Browser.getVersion' }) + '\0'), 3000)
setTimeout(() => { console.log('NO REPLY in 15s; stderr:', err.split('\n').slice(0, 5).join(' | ')); c.kill(); process.exit(1) }, 15000)
