// SSH 执行：调用系统 ssh 客户端（Windows 10+ / Linux / macOS 都自带），
// 用 SSH_ASKPASS 传密码，不引入额外 npm 依赖。
//
// 为什么不引 ssh2：magpie 装插件的 bun add 不跑 install scripts，带原生编译的包会失败；
// 系统 ssh 已经够用，也复用用户已有的 known_hosts/ssh_config。

import { spawn } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const isWin = process.platform === "win32"

function sshBin() {
  return "ssh"
}

/** 写一个临时 askpass 脚本，返回 { dir, env } */
function makeAskpass(password) {
  const dir = mkdtempSync(join(tmpdir(), "qoder-ssh-"))
  if (isWin) {
    // Windows: .cmd 由 cmd.exe 执行，echo 输出密码
    const p = join(dir, "askpass.cmd")
    writeFileSync(p, `@echo off\r\necho ${password}\r\n`, "utf8")
    return { dir, file: p, env: { SSH_ASKPASS: p, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0" } }
  }
  const p = join(dir, "askpass.sh")
  // 单引号包裹，内部单引号转义
  const safe = String(password).replace(/'/g, `'\\''`)
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' '${safe}'\n`, "utf8")
  chmodSync(p, 0o700)
  return { dir, file: p, env: { SSH_ASKPASS: p, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0" } }
}

/**
 * 跑一条远端命令。
 * @param {{host:string,port?:number,user:string,password?:string}} srv
 * @param {string} remoteCmd
 * @param {{timeoutMs?:number}} [opt]
 * @returns {Promise<{ok:boolean, code:number|null, out:string, err:string, ms:number}>}
 */
export function runRemote(srv, remoteCmd, opt = {}) {
  const timeoutMs = opt.timeoutMs ?? 25000
  const port = srv.port || 22
  const target = `${srv.user}@${srv.host}`

  const args = [
    "-p", String(port),
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=" + (isWin ? "NUL" : "/dev/null"),
    "-o", "PreferredAuthentications=password,keyboard-interactive",
    "-o", "PubkeyAuthentication=no",
    "-o", "NumberOfPasswordPrompts=1",
    "-o", "ConnectTimeout=12",
    "-o", "LogLevel=ERROR",
    target,
    remoteCmd,
  ]

  let ask = null
  if (srv.password) ask = makeAskpass(srv.password)

  const t0 = Date.now()
  return new Promise((resolve) => {
    let out = ""
    let err = ""
    let done = false
    const child = spawn(sshBin(), args, {
      env: { ...process.env, ...(ask ? ask.env : {}) },
      windowsHide: true,
    })

    const timer = setTimeout(() => {
      if (!done) {
        done = true
        try { child.kill("SIGKILL") } catch {}
        cleanup()
        resolve({ ok: false, code: null, out, err: err + "\n[timeout]", ms: Date.now() - t0 })
      }
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timer)
      if (ask) { try { rmSync(ask.dir, { recursive: true, force: true }) } catch {} }
    }

    child.stdout.on("data", (b) => { out += b.toString("utf8") })
    child.stderr.on("data", (b) => { err += b.toString("utf8") })
    child.on("error", (e) => {
      if (done) return
      done = true
      cleanup()
      resolve({ ok: false, code: null, out, err: err + "\n" + e.message, ms: Date.now() - t0 })
    })
    child.on("close", (code) => {
      if (done) return
      done = true
      cleanup()
      resolve({ ok: code === 0, code, out, err, ms: Date.now() - t0 })
    })
  })
}

/** 探测一台：连通性 + 系统信息 + qoderclicn 是否已装 */
export async function probeServer(srv) {
  const cmd = [
    "echo 'HOSTNAME:'$(hostname 2>/dev/null)",
    "echo 'ARCH:'$(uname -m 2>/dev/null)",
    "echo 'OS:'$(. /etc/os-release 2>/dev/null && echo $PRETTY_NAME)",
    "echo 'HOME:'$HOME",
    "Q=$(command -v qoderclicn 2>/dev/null || ls -1 $HOME/.local/bin/qoderclicn 2>/dev/null || echo NONE); echo 'QODER:'$Q",
    "V=$($HOME/.local/bin/qoderclicn --version 2>/dev/null || qoderclicn --version 2>/dev/null || echo NONE); echo 'VERSION:'$V",
  ].join("; ")
  const r = await runRemote(srv, cmd, { timeoutMs: 30000 })

  const pick = (k) => {
    const m = r.out.match(new RegExp(`^${k}:(.*)$`, "m"))
    return m ? m[1].trim() : ""
  }
  return {
    ok: r.ok,
    ms: r.ms,
    hostname: pick("HOSTNAME"),
    arch: pick("ARCH"),
    os: pick("OS"),
    home: pick("HOME"),
    qoder: pick("QODER"),
    version: pick("VERSION"),
    error: r.ok ? "" : (r.err || "").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300),
  }
}
