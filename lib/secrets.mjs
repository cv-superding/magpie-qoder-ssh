// 凭据存储：单独文件，权限 600。
//
// 为什么不用 magpie 的账号槽：账号槽是「登录式」模型（一个 provider 一个账号槽），
// 而这里要管三台服务器、每台一套 host/port/user/password，账号槽结构对不上。
// 文件放在 magpie 的配置目录旁，权限 600，只有 magpie 运行用户能读。
//
// 目录来源优先级：client.directory（magpie 给的配置文件夹）> $XDG_CONFIG_HOME/magpie > ~/.config/magpie

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const FILE = "qoder-ssh-secrets.json"

function configDir(client) {
  // client.directory 在 magpie 里可能是函数或字符串，只接受字符串
  const fromClient = client && typeof client.directory === "string" ? client.directory : null
  const d =
    fromClient ||
    (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "magpie") : null) ||
    join(homedir(), ".config", "magpie")
  return d
}

function pathFor(client) {
  return join(configDir(client), FILE)
}

/** 读全部凭据：{ [serverId]: { password } } */
export function readSecrets(client) {
  const p = pathFor(client)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, "utf8")) || {}
  } catch {
    return {}
  }
}

/** 整体写入，权限 600（先写临时文件再改名，避免半截文件） */
export function writeSecrets(client, data) {
  const dir = configDir(client)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const p = pathFor(client)
  const tmp = p + ".tmp"
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
  try { chmodSync(p, 0o600) } catch {}
  return p
}

/** 设置/覆盖一台服务器的密码 */
export function setSecret(client, serverId, password) {
  const all = readSecrets(client)
  if (password) all[serverId] = { password }
  else delete all[serverId]
  writeSecrets(client, all)
  return all
}

/** 删掉某台的凭据 */
export function removeSecret(client, serverId) {
  const all = readSecrets(client)
  delete all[serverId]
  writeSecrets(client, all)
}

/** 哪些 server 已设密码（给页面看，不泄露值） */
export function secretPresence(client, ids) {
  const all = readSecrets(client)
  const out = {}
  for (const id of ids) out[id] = !!(all[id] && all[id].password)
  return out
}
