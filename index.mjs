// qoder-ssh — magpie 插件
//
// 两件事：
//   1) 把一台 magpie 网关（OpenAI 兼容，默认 127.0.0.1:3425）桥接成 provider `mgw`，
//      让所有 agent 能用网关里的模型；模型列表从网关 /v1/models 实时生成。
//   2) 带一个管理页（page/），管理多台 SSH 服务器：增删改、连通性检测、
//      一键在该服务器上装/配 qoderclicn。
//
// 页面 sandbox 是 connect-src 'none'，不能发网络请求；它只能：
//   · 读写本插件自己的 options（plugins.json）
//   · 用 <script src> 读本插件目录里的文件
// 所以后端（Bun 宿主）负责真正的 SSH 操作，把状态写进 page/snapshot.js 供页面读取，
// 页面把用户操作写进 options.jobs，后端轮询执行。
//
// 配置优先级：plugin options > 环境变量 > 默认值
//   options: {"url":"http://<gateway-host>:3425","key":"magpie","servers":[...]}

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { probeServer, runRemote } from "./lib/ssh.mjs"
import { readSecrets, removeSecret, secretPresence, setSecret } from "./lib/secrets.mjs"
import { startTunnel, stopTunnel, tunnelState, stopAllTunnels } from "./lib/tunnel.mjs"

const PROVIDER = "mgw"
const ENV_BASE = process.env.MAGPIE_GATEWAY_URL || "http://127.0.0.1:3425"
const ENV_KEY = process.env.MAGPIE_GATEWAY_KEY || "magpie"

const HERE = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_FILE = join(HERE, "page", "snapshot.js")
const SELF_NAME = "qoder-ssh"

function stripSlash(u) {
  return String(u || "").replace(/\/+$/, "")
}

function modelShape(m) {
  const id = m.id
  const context = Number(m.context_window || m.context_length || 1000000)
  const output = Number(m.max_output_tokens || 32000)
  let levels = Array.isArray(m.reasoning_levels)
    ? m.reasoning_levels
    : (m.supported_reasoning_levels || []).map((x) => x && x.effort).filter(Boolean)
  levels = levels.filter((lv) => String(lv).toLowerCase() !== "none")
  const inputs = (m.modalities && m.modalities.input) || []
  const variants = {}
  for (const lv of levels) variants[String(lv)] = {}

  return {
    id,
    name: m.display_name || m.name || id,
    limit: { context, output },
    capabilities: {
      reasoning: levels.length > 0,
      toolcall: !!m.tool_call,
      input: {
        text: true,
        image: inputs.includes("image"),
        video: inputs.includes("video"),
        pdf: inputs.includes("pdf"),
      },
    },
    ...(levels.length ? { variants } : {}),
  }
}

// ── 读本插件在 plugins.json 里的 options ────────────────────────────────
// 直接读文件而不是等 hook：定时器里没有 hook 上下文。
function magpieConfigDir() {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "magpie")
    : join(homedir(), ".config", "magpie")
}

function readOwnOptions() {
  const p = join(magpieConfigDir(), "plugins.json")
  if (!existsSync(p)) return {}
  try {
    const d = JSON.parse(readFileSync(p, "utf8"))
    const e = (d.plugins || []).find(
      (x) => typeof x.spec === "string" && x.spec.startsWith(SELF_NAME)
    )
    return (e && e.options) || {}
  } catch {
    return {}
  }
}

function writeSnapshot(data) {
  try {
    writeFileSync(
      SNAPSHOT_FILE,
      "window.__QODER_SSH_SNAPSHOT__ = " + JSON.stringify(data) + ";\n",
      "utf8"
    )
  } catch (e) {
    console.error("snapshot write failed:", e && e.message)
  }
}

// ── 读日志文件的最后 N 行（只从尾部读，不整文件加载） ────────────────────
function readTail(file, n) {
  try {
    if (!file || !existsSync(file)) return { error: "文件不存在" }
    const st = statSync(file)
    const maxBytes = Math.min(st.size, 256 * 1024) // 最多读尾部 256KB
    const buf = Buffer.alloc(maxBytes)
    const fd = openSync(file, "r")
    try {
      readSync(fd, buf, 0, maxBytes, st.size - maxBytes)
    } finally {
      closeSync(fd)
    }
    let text = buf.toString("utf8")
    // 截断处的第一行可能不完整，丢掉
    if (st.size > maxBytes) {
      const i = text.indexOf("\n")
      if (i >= 0) text = text.slice(i + 1)
    }
    const all = text.split(/\r?\n/).filter((l) => l.trim() !== "")
    const lines = all.slice(-n)
    return { file, lines, total: all.length, size: st.size, mtime: st.mtimeMs }
  } catch (e) {
    return { file, error: String(e && e.message).slice(0, 160) }
  }
}

// 自动挑日志文件：显式设置 > magpie 配置目录 > 当前工作目录
function resolveLogFile(opts) {
  if (opts.logFile) return opts.logFile
  const cands = [
    process.env.QODER_SSH_LOG,
    join(magpieConfigDir(), "qoder-ssh-tunnel.log"),
    join(process.cwd(), "gw.log"),
  ].filter(Boolean)
  for (const c of cands) {
    if (existsSync(c)) return c
  }
  return cands[0] || ""
}

// ── 深度测试：比常规探测多查几项，用于「测试」按钮 ──────────────────────
// 检查：SSH / OS / node / qoderclicn 版本 / settings.json 现状 / 远端到网关可达
async function testServer(srv, gatewayUrl, gatewayKey) {
  const checks = []

  const script = [
    "echo '###OS:'$(. /etc/os-release 2>/dev/null && echo $PRETTY_NAME)",
    "echo '###ARCH:'$(uname -m)",
    "echo '###NODE:'$(command -v node >/dev/null 2>&1 && node -v || echo NONE)",
    "echo '###NPM:'$(command -v npm >/dev/null 2>&1 && npm -v || echo NONE)",
    "echo '###CURL:'$(command -v curl >/dev/null 2>&1 && echo yes || echo no)",
    "echo '###WGET:'$(command -v wget >/dev/null 2>&1 && echo yes || echo no)",
    "echo '###PY3:'$(command -v python3 >/dev/null 2>&1 && echo yes || echo no)",
    "Q=$(command -v qoderclicn 2>/dev/null || ls -1 $HOME/.local/bin/qoderclicn 2>/dev/null || command -v qodercn 2>/dev/null || echo NONE)",
    "echo '###QODER:'$Q",
    "if [ \"$Q\" != NONE ]; then echo '###VER:'$($Q --version 2>&1 | head -1); else echo '###VER:NONE'; fi",
    "S=$HOME/.qoder-cn/settings.json",
    "if [ -f $S ]; then echo '###SETTINGS:yes'; echo '###BASEURL:'$(python3 -c \"import json;d=json.load(open('$S'));print((d.get('providers',{}).get('magpie') or {}).get('baseUrl',''))\" 2>/dev/null); else echo '###SETTINGS:no'; echo '###BASEURL:'; fi",
  ].join("\n")

  const r = await runRemote(srv, script, { timeoutMs: 45000 })

  const pick = (k) => {
    const m = r.out.match(new RegExp(`###${k}:(.*)$`, "m"))
    return m ? m[1].trim() : ""
  }

  const ver = pick("VER")
  const settings = pick("SETTINGS")
  const baseUrl = pick("BASEURL")
  const hasCli = pick("QODER") !== "NONE" && pick("QODER") !== ""

  // 远端 → 网关可达性：单独一次调用，用 base64 传 python，避免 heredoc 嵌套
  let gw = ""
  // 已有 settings.json 的 baseUrl 时优先测它——那是远端真正在用的地址；
  // 没配过才用部署目标地址（预检）。
  const probeBase = (baseUrl || "").replace(/\/v1\/?$/, "") || gatewayUrl
  if (r.ok) {
    const py = [
      "import urllib.request",
      `url = "${probeBase}/v1/models"`,
      `key = "${gatewayKey}"`,
      "try:",
      "    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + key})",
      "    r = urllib.request.urlopen(req, timeout=6)",
      "    print('OK' if r.status == 200 else 'HTTP%d' % r.status)",
      "except Exception as e:",
      "    print('FAIL:' + type(e).__name__)",
    ].join("\n")
    const b64 = Buffer.from(py).toString("base64")
    const gwr = await runRemote(
      srv,
      `python3 -c "import base64;exec(base64.b64decode('${b64}'))" 2>&1`,
      { timeoutMs: 30000 }
    )
    gw = (gwr.out || "").trim().split("\n").pop() || ""
  }

  checks.push({ name: "SSH 连接", ok: r.ok, detail: r.ok ? r.ms + "ms" : (r.err || "").slice(-160) })
  if (!r.ok) return { ok: false, checks, at: Date.now() }

  checks.push({ name: "操作系统", ok: !!pick("OS"), detail: `${pick("OS") || "?"} ${pick("ARCH")}` })
  const dlTools = []
  if (pick("CURL") === "yes") dlTools.push("curl")
  if (pick("WGET") === "yes") dlTools.push("wget")
  if (pick("PY3") === "yes") dlTools.push("python3")
  checks.push({
    name: "下载工具",
    ok: dlTools.length > 0,
    detail: dlTools.length ? dlTools.join(" / ") : "缺 curl / wget / python3",
  })
  checks.push({ name: "qoderclicn", ok: hasCli, detail: hasCli ? (ver || "已安装") : "未安装" })
  checks.push({
    name: "settings.json",
    ok: settings === "yes",
    detail: settings === "yes" ? (baseUrl || "已存在，但没有 magpie provider") : "不存在",
  })
  checks.push({
    name: "远端→网关",
    ok: gw === "OK",
    detail: gw === "OK"
      ? probeBase
      : `${probeBase} ${gw || "未检测"}${gw.startsWith("FAIL") ? "（需隧道）" : ""}`,
  })

  return { ok: checks.every((c) => c.ok), checks, at: Date.now() }
}

// ── 部署：在远端装/配 qoderclicn ────────────────────────────────────────
// 官方安装脚本（Qoder CN）：curl -fsSL https://static.qoder.com.cn/qoder-cli-cn/install.sh | bash
async function deployQoderCli(srv, gatewayUrl, gatewayKey, onStep) {
  const steps = []
  const TOTAL = 4

  // 每完成一步就上报，页面据此画进度条
  const report = (name, ok, detail) => {
    steps.push({ step: name, ok, detail })
    if (typeof onStep === "function") {
      try { onStep({ index: steps.length, total: TOTAL, step: name, ok, detail }) } catch {}
    }
  }

  // 1. 环境检查（curl / wget / python3 任一即可下载安装脚本）
  const env = await runRemote(
    srv,
    "echo OS:$(. /etc/os-release 2>/dev/null && echo $ID); echo CURL:$(command -v curl || echo NONE); " +
      "echo WGET:$(command -v wget || echo NONE); echo PY:$(command -v python3 || echo NONE); echo HOME:$HOME",
    { timeoutMs: 25000 }
  )
  report("env", env.ok, env.ok ? env.out.replace(/\n/g, " ") : env.err.slice(-200))
  if (!env.ok) return { ok: false, steps }

  const hasCurl = /CURL:/.test(env.out) && !/CURL:NONE/.test(env.out)
  const hasWget = /WGET:/.test(env.out) && !/WGET:NONE/.test(env.out)
  const hasPy = /PY:/.test(env.out) && !/PY:NONE/.test(env.out)

  if (!hasCurl && !hasWget && !hasPy) {
    report("install", false, "远端没有 curl / wget / python3，无法下载安装脚本")
    return { ok: false, steps }
  }

  // 2. 官方安装脚本（自动选 amd64/arm64 原生二进制）
  //    远端常常没有 curl（实测 qdai 就没有），依次回退 wget / python3
  const INSTALL_URL = "https://static.qoder.com.cn/qoder-cli-cn/install.sh"
  let dl
  if (hasCurl) {
    dl = `curl -fsSL ${INSTALL_URL} | bash`
  } else if (hasWget) {
    dl = `wget -qO- ${INSTALL_URL} | bash`
  } else {
    dl = `python3 -c "import urllib.request,sys;sys.stdout.buffer.write(urllib.request.urlopen('${INSTALL_URL}',timeout=60).read())" | bash`
  }
  const inst = await runRemote(srv, `${dl} 2>&1 | tail -12`, { timeoutMs: 300000 })
  report("install", inst.ok, (inst.out || inst.err).slice(-500))

  // 3. 写 settings.json（providers 指向网关）
  //    必须写全 capabilities / contextWindow：只给 model+displayName 时，
  //    qoder 界面会显示「不可调思考档位」「上下文 128k」。
  //    这些信息网关 /v1/models 都给了（context_window / reasoning_levels /
  //    modalities / tool_call），照搬即可。
  const settingsPy = [
    "import json,os,urllib.request",
    "p=os.path.expanduser('~/.qoder-cn/settings.json')",
    "os.makedirs(os.path.dirname(p),exist_ok=True)",
    "d={}",
    "d=json.load(open(p)) if os.path.exists(p) else {}",
    "raw=[]",
    "try:",
    `    r=urllib.request.urlopen('${gatewayUrl}/v1/models',timeout=20)`,
    "    raw=json.loads(r.read()).get('data',[])",
    "except Exception as e:",
    "    print('WARN models fetch failed:',e)",
    "def to_qoder(m):",
    "    lv=m.get('reasoning_levels') or [x.get('effort') for x in (m.get('supported_reasoning_levels') or []) if x.get('effort')]",
    "    inp=(m.get('modalities') or {}).get('input') or []",
    "    return {",
    "        'model': m.get('id',''),",
    "        'displayName': m.get('magpie_label') or m.get('display_name') or m.get('id',''),",
    "        'contextWindow': int(m.get('context_window') or m.get('context_length') or 128000),",
    "        'capabilities': {",
    "            'thinking': {",
    "                'modes': ['enabled'] if m.get('reasoning') else [],",
    "                'requiresBudgetForEnabled': False,",
    "                'supportedEffortLevels': lv,",
    "                'supportsEffort': bool(m.get('reasoning') and lv),",
    "            },",
    "            'tools': bool(m.get('tool_call')),",
    "            'vision': 'image' in inp,",
    "        },",
    "    }",
    "models=[to_qoder(m) for m in raw if m.get('id')]",
    "ids=[m['model'] for m in models]",
    `prefer=[i for i in ids if not i.startswith('mgw/')]`,
    "chosen=(prefer or ids or [''])[0]",
    "prov=d.setdefault('providers',{}).setdefault('magpie',{})",
    "prov.update({'type':'openai-compatible','protocol':'openai','authType':'bearer',",
    `  'baseUrl':'${gatewayUrl}/v1','apiKey':'${gatewayKey}','displayName':'magpie',`,
    "  'model':chosen,'models':models})",
    "if chosen:",
    "    d.setdefault('model',{})['name']='magpie/'+chosen",
    "    got=next((m for m in models if m['model']==chosen),None)",
    "    if got:",
    "        lv2=(got['capabilities']['thinking'] or {}).get('supportedEffortLevels') or []",
    "        e={'contextWindow':got['contextWindow']}",
    "        if lv2: e['reasoning']={'enabled':True,'effort':lv2[-1]}",
    "        d['model'].setdefault('preferences',{})['magpie/'+chosen]=e",
    "d.setdefault('ui',{})['language']='zh-CN'",
    "json.dump(d,open(p,'w'),ensure_ascii=False,indent=2)",
    "print('WROTE',p,'models',len(models),'chosen',chosen)",
  ].join("\n")

  const b64 = Buffer.from(settingsPy).toString("base64")
  const cfg = await runRemote(
    srv,
    `python3 -c "import base64;exec(base64.b64decode('${b64}'))" 2>&1`,
    { timeoutMs: 30000 }
  )
  report("settings", cfg.ok, (cfg.out || cfg.err).slice(-200))

  // 4. 验证版本
  const ver = await runRemote(
    srv,
    "export PATH=\"$HOME/.local/bin:$PATH\"; (qoderclicn --version || qodercn --version) 2>&1 | head -1",
    { timeoutMs: 40000 }
  )
  report("verify", ver.ok, (ver.out || ver.err).slice(-160))

  return { ok: steps.every((s) => s.ok), steps }
}

// ── 后台轮询：执行页面提交的任务，把状态写进快照 ────────────────────────
let timer = null
let lastProbeAt = 0
const lastStatus = {}
let deployProgress = null
// 检测结果按服务器 id 存，并落盘 —— host 重启（改插件、magpie 重载）后仍在
let lastTests = {}
let workerBusy = false
// 已处理的任务戳：和检测结果一起落盘。
// 不能用「进程启动时间」过滤——magpie 的 plugin host 是懒加载的，
// 启动时刻可能晚于用户提交任务的时间，会把真实任务误判成历史任务。
let seenTestMarks = []
let seenDeployMarks = []
const seenSecrets = new Set()

const TESTS_FILE = () => join(magpieConfigDir(), "qoder-ssh-tests.json")

function loadTests() {
  try {
    const p = TESTS_FILE()
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, "utf8"))
      if (d && typeof d === "object") {
        lastTests = d.tests || {}
        seenTestMarks = Array.isArray(d.seenTests) ? d.seenTests : []
        seenDeployMarks = Array.isArray(d.seenDeploys) ? d.seenDeploys : []
      }
    }
  } catch {}
}

function saveTests() {
  try {
    writeFileSync(
      TESTS_FILE(),
      JSON.stringify(
        { tests: lastTests, seenTests: seenTestMarks.slice(-50), seenDeploys: seenDeployMarks.slice(-50) },
        null, 2
      ),
      "utf8"
    )
  } catch {}
}

function startWorker(client) {
  if (timer) return
  loadTests()
  console.log("qoder-ssh: worker started")

  timer = setInterval(async () => {
    // 防重入：一次检测/部署要几十秒，5 秒的 tick 会叠加成并发
    if (workerBusy) return
    workerBusy = true
    try {
      const opts = readOwnOptions()
      const servers = Array.isArray(opts.servers) ? opts.servers : []
      const secrets = readSecrets(client)
      const ids = servers.map((s) => s.id)

      // 页面提交的新密码：写进 600 文件后，从 options 里清掉（下次 set 时覆盖）
      if (opts.pendingSecret && opts.pendingSecret.id) {
        const sk = opts.pendingSecret.id + "|" + (opts.pendingSecret.password || "")
        if (!seenSecrets.has(sk)) {
          seenSecrets.add(sk)
          setSecret(client, opts.pendingSecret.id, opts.pendingSecret.password || "")
        }
      }
      // 页面删服务器时一并清密码
      if (opts.removeSecret) {
        removeSecret(client, opts.removeSecret)
      }

      const status = {}
      // 全量探测节流：距上次超过 18 秒才重新探测所有服务器，
      // 否则沿用上次结果（队列任务仍然每个 tick 都处理，所以「测试」5 秒内有响应）
      const nowMs = Date.now()
      const fresh = !lastProbeAt || nowMs - lastProbeAt > 18000
      if (fresh) {
        lastProbeAt = nowMs
        for (const s of servers) {
          if (!s || !s.id || !s.host || !s.user) continue
          const srv = { host: s.host, port: s.port || 22, user: s.user, password: (secrets[s.id] || {}).password }
          if (!srv.password) {
            lastStatus[s.id] = { ok: false, error: "未设置密码", at: nowMs }
            continue
          }
          try {
            lastStatus[s.id] = { ...(await probeServer(srv)), at: Date.now() }
          } catch (e) {
            lastStatus[s.id] = { ok: false, error: String(e && e.message).slice(0, 200), at: Date.now() }
          }
        }
      }
      Object.assign(status, lastStatus)
      // 清掉已删除服务器的旧状态
      for (const k of Object.keys(lastStatus)) {
        if (!servers.some((s) => s && s.id === k)) delete lastStatus[k]
      }

      // 测试队列：页面点「测试」写进来的 —— 立即深度检测一台
      let testResult = null
      const tq = Array.isArray(opts.testQueue) ? opts.testQueue : []
      if (tq.length && !seenTestMarks.includes(tq[0].at)) {
        const job = tq[0]
        seenTestMarks.push(job.at)
        const srvDef = servers.find((s) => s && s.id === job.id)
        if (srvDef) {
          const srv = {
            host: srvDef.host, port: srvDef.port || 22, user: srvDef.user,
            password: (secrets[srvDef.id] || {}).password,
          }
          if (srv.password) {
            console.log(`qoder-ssh: testing ${srvDef.name || srvDef.id}`)
            try {
              testResult = {
                id: job.id,
                name: srvDef.name || srvDef.id,
                ...(await testServer(
                  srv,
                  stripSlash(opts.deployUrl || opts.url || ENV_BASE),
                  opts.deployKey || opts.key || ENV_KEY
                )),
              }
            } catch (e) {
              testResult = {
                id: job.id, name: srvDef.name || srvDef.id, at: Date.now(), ok: false,
                checks: [{ name: "测试异常", ok: false, detail: String(e && e.message).slice(0, 240) }],
              }
            }
          } else {
            testResult = {
              id: job.id, at: Date.now(), ok: false,
              checks: [{ name: "密码", ok: false, detail: "未设置密码" }],
            }
          }
          // 按服务器 id 存一份，页面据此决定该行显示「检测」还是「配置」
          if (testResult) {
            lastTests[job.id] = testResult
            saveTests()
          }
        }
        // 注意：**不要写回 plugins.json**。
        // 曾经在这里把 testQueue 清空写回文件，magpie 监听到配置变化就重载 plugin host，
        // 正在跑的测试被打断、队列又没清干净 → 无限重启。改用内存去重（seenTests）。
      }

      // 部署队列：页面点「配置 qoderclicn」写进来的
      let deployResult = null
      const queue = Array.isArray(opts.deployQueue) ? opts.deployQueue : []
      if (queue.length && !seenDeployMarks.includes(queue[0].at)) {
        const job = queue[0]
        seenDeployMarks.push(job.at)
        const srvDef = servers.find((s) => s && s.id === job.id)
        if (srvDef) {
          const srv = {
            host: srvDef.host, port: srvDef.port || 22, user: srvDef.user,
            password: (secrets[srvDef.id] || {}).password,
          }
          if (srv.password) {
            console.log(`qoder-ssh: deploying qoderclicn to ${srvDef.name || srvDef.id}`)
            // 进度：每完成一步就立刻写快照，页面 5 秒轮询能看到推进
            deployProgress = {
              id: job.id, name: srvDef.name || srvDef.id,
              index: 0, total: 4, step: "准备中", ok: null, at: Date.now(),
            }
            try {
              deployResult = {
                id: job.id,
                name: srvDef.name || srvDef.id,
                at: Date.now(),
                ...(await deployQoderCli(
                  srv,
                  stripSlash(opts.deployUrl || opts.url || ENV_BASE),
                  opts.deployKey || opts.key || ENV_KEY,
                  (p) => {
                    deployProgress = {
                      id: job.id, name: srvDef.name || srvDef.id,
                      index: p.index, total: p.total, step: p.step, ok: p.ok, at: Date.now(),
                    }
                    writeSnapshot({
                      at: Date.now(),
                      servers: servers.map((s) => ({
                        id: s.id, name: s.name || s.id, host: s.host, port: s.port || 22, user: s.user,
                      })),
                      status,
                      hasSecret: secretPresence(client, ids),
                      deploying: deployProgress,
                      testResult,
                      log: readTail(resolveLogFile(opts), Number(opts.logLines) || 30),
                      gateway: {
                        url: stripSlash(opts.url || ENV_BASE),
                        keySet: !!(opts.key || ENV_KEY),
                        deployUrl: stripSlash(opts.deployUrl || opts.url || ENV_BASE),
                        deployKeySet: !!(opts.deployKey || opts.key || ENV_KEY),
                      },
                    })
                  }
                )),
              }
            } catch (e) {
              deployResult = { id: job.id, at: Date.now(), ok: false, steps: [{ step: "error", ok: false, detail: String(e && e.message).slice(0, 300) }] }
            } finally {
              deployProgress = null
            }
          } else {
            deployResult = { id: job.id, at: Date.now(), ok: false, steps: [{ step: "auth", ok: false, detail: "未设置密码" }] }
          }
        }
        // 同样不写回 plugins.json（会触发 magpie 重载 host，打断部署）。靠 seenDeploys 去重。
      }

      // ── 隧道：options.tunnel.enabled 时维持一条 ssh -R ──
      let tunnel = null
      const tcfg = opts.tunnel
      if (tcfg && tcfg.enabled && tcfg.serverId) {
        const srvDef = servers.find((s) => s && s.id === tcfg.serverId)
        const pwd = srvDef ? (secrets[srvDef.id] || {}).password : ""
        if (srvDef && pwd) {
          const st = tunnelState(srvDef.id)
          if (st.running) {
            tunnel = { ...st, id: srvDef.id, name: srvDef.name || srvDef.id }
          } else {
            // 先看远端端口是不是已经有隧道（比如上一任 host 留下的）
            const remotePort = Number(tcfg.remotePort) || 23425
            const probe = await runRemote(
              srvDef,
              `python3 -c "import socket;s=socket.socket();s.settimeout(3);` +
                `s.connect(('127.0.0.1',${remotePort}));s.close();print('UP')" 2>/dev/null || echo DOWN`,
              { timeoutMs: 20000 }
            )
            if (probe.ok && /UP/.test(probe.out)) {
              tunnel = {
                id: srvDef.id, name: srvDef.name || srvDef.id, running: true,
                external: true, remotePort, localPort: Number(tcfg.localPort) || 3426,
              }
            } else {
              const started = startTunnel(
                { id: srvDef.id, host: srvDef.host, port: srvDef.port, user: srvDef.user, password: pwd },
                {
                  remotePort,
                  localPort: Number(tcfg.localPort) || 3426,
                  logFile: resolveLogFile(opts),
                }
              )
              tunnel = { ...started, id: srvDef.id, name: srvDef.name || srvDef.id }
            }
          }
        } else {
          tunnel = { running: false, id: tcfg.serverId, error: srvDef ? "未设置密码" : "服务器不存在" }
        }
      } else {
        // 关了开关：停掉本插件起的隧道
        for (const s of servers) stopTunnel(s.id)
      }

      writeSnapshot({
        at: Date.now(),
        servers: servers.map((s) => ({
          id: s.id, name: s.name || s.id, host: s.host, port: s.port || 22, user: s.user,
        })),
        status,
        hasSecret: secretPresence(client, ids),
        deployResult,
        deploying: deployProgress,
        tunnel,
        testResult,
        testResults: lastTests,
        log: readTail(resolveLogFile(opts), Number(opts.logLines) || 30),
        gateway: {
          url: stripSlash(opts.url || ENV_BASE),
          keySet: !!(opts.key || ENV_KEY),
          deployUrl: stripSlash(opts.deployUrl || opts.url || ENV_BASE),
          deployKeySet: !!(opts.deployKey || opts.key || ENV_KEY),
        },
      })
    } catch (e) {
      console.error("qoder-ssh worker:", e && e.message)
    } finally {
      workerBusy = false
    }
  }, 5000)

  // 进程退出时清掉
  const stop = () => { if (timer) { clearInterval(timer); timer = null } }
  process.once("exit", stop)
  process.once("SIGTERM", () => { stop(); process.exit(0) })
}

// ── 插件本体 ────────────────────────────────────────────────────────────
// 判断某个网关地址是不是"本机自己"：指向本机时，把它再包成 provider 毫无意义
// （模型是原有模型的副本、只是多个 mgw/ 前缀，还多一跳转发）。
function localGatewayPort() {
  try {
    const p = join(magpieConfigDir(), "gateway.json")
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, "utf8"))
      const m = String(d && d.addr ? d.addr : "").match(/:(\d+)\s*$/)
      if (m) return Number(m[1])
    }
  } catch {}
  return 0
}

function isSelfGateway(url) {
  const u = String(url || "").replace(/\/+$/, "")
  const m = u.match(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/)
  if (!m) return false
  const port = Number(m[2])
  const own = localGatewayPort()
  // 自己的端口；再兜上 magpie 默认的 3425/3426，防止 gateway.json 还没写
  return port === own || port === 3425 || port === 3426
}

export const QoderSsh = async ({ client }, options = {}) => {
  const DEFAULT_BASE = stripSlash((options && options.url) || ENV_BASE) || "http://127.0.0.1:3425"
  const DEFAULT_KEY = (options && options.key) || ENV_KEY

  startWorker(client)

  // 没显式配置 url，且默认地址就是本机网关 → 不注册 provider（避免自己包自己）。
  // 显式配了 url 的（比如飞牛指向 Win11 的 <gateway-host>:3425）照常注册。
  const SELF_LOOP = !(options && options.url) && isSelfGateway(DEFAULT_BASE)
  if (SELF_LOOP) {
    console.log("qoder-ssh: gateway is this machine, provider not registered (avoids self-loop)")
    return { config: async (cfg) => cfg }
  }

  const config = async (cfg) => {
    cfg.provider ??= {}
    if (!cfg.provider[PROVIDER]) {
      cfg.provider[PROVIDER] = {
        name: "Magpie Gateway",
        npm: "@ai-sdk/openai-compatible",
        api: stripSlash(DEFAULT_BASE) + "/v1",
        models: {},
      }
    }
    return cfg
  }

  const auth = {
    provider: PROVIDER,
    methods: [
      { type: "api", label: "Magpie gateway key", placeholder: DEFAULT_KEY },
    ],
    async loader(getAuth) {
      const a = await getAuth()
      const key = (a && (a.key || a.apiKey)) || DEFAULT_KEY
      const base = stripSlash(DEFAULT_BASE)
      return {
        baseURL: base + "/v1",
        async fetch(input, init) {
          const headers = new Headers(init && init.headers ? init.headers : {})
          if (!headers.has("authorization")) {
            headers.set("authorization", `Bearer ${key}`)
          }
          headers.set("x-qoder-ssh", "2.0.0")
          return fetch(input, { ...(init || {}), headers })
        },
      }
    },
  }

  const provider = {
    id: PROVIDER,
    async models(provider, { auth: accountAuth } = {}) {
      const base = stripSlash(DEFAULT_BASE)
      const key = (accountAuth && (accountAuth.key || accountAuth.apiKey)) || DEFAULT_KEY
      try {
        const res = await fetch(base + "/v1/models", {
          headers: { authorization: `Bearer ${key}` },
        })
        if (!res.ok) return provider.models
        const data = await res.json()
        const list = Array.isArray(data && data.data) ? data.data : []
        if (!list.length) return provider.models
        const out = {}
        for (const m of list) {
          if (!m || !m.id) continue
          out[m.id] = modelShape(m)
        }
        return out
      } catch {
        return provider.models
      }
    },
  }

  return { config, auth, provider }
}
