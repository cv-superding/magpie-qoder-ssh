// 隧道管理：在飞牛（或任意 Linux/macOS）上用系统 ssh 的远程转发
//   远端 127.0.0.1:<remotePort>  →  本机 127.0.0.1:<localPort>（飞牛 magpie 网关）
//
// 为什么用 ssh -R 而不是复刻 gateway_bridge 的 session 通道中继：
//   实测 qdai 允许 remote forward（OpenSSH 9.2），-R 走的是 SSH 内核转发，
//   比 Python 用户态逐块 relay 快，且不需要 python3/paramiko。
//
// 密码用 SSH_ASKPASS 传（OpenSSH ≥ 8.4 支持 SSH_ASKPASS_REQUIRE=force），
// 这样不必依赖 sshpass，Windows 也能用。

import { spawn } from "node:child_process"
import { appendFileSync, chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const isWin = process.platform === "win32"

function makeAskpass(password) {
  const dir = mkdtempSync(join(tmpdir(), "qoder-tun-"))
  if (isWin) {
    const p = join(dir, "askpass.cmd")
    writeFileSync(p, `@echo off\r\necho ${password}\r\n`, "utf8")
    return { dir, env: { SSH_ASKPASS: p, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0" } }
  }
  const p = join(dir, "askpass.sh")
  const safe = String(password).replace(/'/g, `'\\''`)
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' '${safe}'\n`, "utf8")
  chmodSync(p, 0o700)
  return { dir, env: { SSH_ASKPASS: p, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0" } }
}

// 每个 serverId 一个正在跑的隧道
const procs = new Map()

export function tunnelState(serverId) {
  const t = procs.get(serverId)
  if (!t) return { running: false }
  const alive = t.child.exitCode === null && !t.child.killed
  return {
    running: alive,
    localPort: t.localPort,
    remotePort: t.remotePort,
    since: t.since,
    pid: t.child.pid,
  }
}

/**
 * 启动隧道（幂等：同一 serverId 已在跑就直接返回）。
 * @param {{id:string,host:string,port?:number,user:string,password:string}} srv
 * @param {{remotePort:number,localPort:number,logFile?:string}} opt
 */
export function startTunnel(srv, opt) {
  const id = srv.id
  const cur = tunnelState(id)
  if (cur.running) return cur

  const remotePort = opt.remotePort || 23425
  const localPort = opt.localPort || 3426
  const logFile = opt.logFile

  const writeLog = (s) => {
    if (!logFile) return
    try {
      appendFileSync(logFile, s.endsWith("\n") ? s : s + "\n", "utf8")
    } catch {}
  }

  const ask = srv.password ? makeAskpass(srv.password) : null
  // -o ExitOnForwardFailure=yes：远端端口被占用时立即退出，而不是静默失败
  const args = [
    "-N",
    "-T",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=" + (isWin ? "NUL" : "/dev/null"),
    "-o", "LogLevel=ERROR",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "PreferredAuthentications=password,keyboard-interactive",
    "-o", "PubkeyAuthentication=no",
    "-o", "NumberOfPasswordPrompts=1",
    "-R", `${remotePort}:127.0.0.1:${localPort}`,
    "-p", String(srv.port || 22),
    `${srv.user}@${srv.host}`,
  ]

  writeLog(`[${new Date().toISOString()}] 启动隧道 远端:${remotePort} → 本机:${localPort}`)

  const child = spawn("ssh", args, {
    env: { ...process.env, ...(ask ? ask.env : {}) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (b) => writeLog("[out] " + b.toString("utf8").trim()))
  child.stderr.on("data", (b) => writeLog("[err] " + b.toString("utf8").trim()))

  child.on("exit", (code, sig) => {
    writeLog(`[${new Date().toISOString()}] 隧道退出 code=${code} sig=${sig || ""}`)
    procs.delete(id)
    if (ask) { try { rmSync(ask.dir, { recursive: true, force: true }) } catch {} }
  })

  const rec = { child, localPort, remotePort, since: Date.now() }
  procs.set(id, rec)
  return tunnelState(id)
}

export function stopTunnel(serverId) {
  const t = procs.get(serverId)
  if (!t) return { running: false }
  try {
    t.child.kill("SIGTERM")
  } catch {}
  procs.delete(serverId)
  return { running: false }
}

export function stopAllTunnels() {
  for (const id of Array.from(procs.keys())) stopTunnel(id)
}
