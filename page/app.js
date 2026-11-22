// qoder-ssh 管理页逻辑。
// 页面沙箱 connect-src 'none'，没有 fetch —— 实时状态来自后端写的 snapshot.js，
// 用户操作用 magpie.options.set 写回 plugins.json，后端轮询执行。

/* global magpie */

function show(id, text) {
  const n = document.getElementById(id)
  if (n) n.textContent = text || ""
}

function el(tag, text, cls) {
  const n = document.createElement(tag)
  if (text !== undefined && text !== null) n.textContent = String(text)
  if (cls) n.className = cls
  return n
}

function snapshot() {
  return window.__QODER_SSH_SNAPSHOT__ || { at: 0, servers: [], status: {}, hasSecret: {}, gateway: {} }
}

function fmtAgo(ms) {
  if (!ms) return "从未"
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return s + " 秒前"
  if (s < 3600) return Math.round(s / 60) + " 分钟前"
  return Math.round(s / 3600) + " 小时前"
}

// 重新加载 snapshot.js（加时间戳绕过缓存）
async function reloadSnapshot() {
  return new Promise((resolve) => {
    const s = document.createElement("script")
    s.src = "snapshot.js?" + Date.now()
    s.onload = s.onerror = resolve
    document.head.appendChild(s)
    setTimeout(resolve, 1500)
  })
}

// options 写入节流：magpie 限制 set 最多一秒一次
let lastSet = 0
async function saveOptions(patch) {
  const wait = 1000 - (Date.now() - lastSet)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  const cur = (await magpie.options.get()) || {}
  const next = { ...cur, ...patch }
  lastSet = Date.now()
  return magpie.options.set(next)
}

// 正在检测的服务器 id：页面每 5 秒重绘，靠这个保住「检查中…」状态
const testingIds = new Set()
// 已提交部署、等后端接手的 id
const pendingDeploy = new Set()

function readServers(opts, snap) {
  // 优先 options；bridge 读不到时用快照兜底（快照里也带 servers）
  const fromOpts = Array.isArray(opts && opts.servers) ? opts.servers : null
  if (fromOpts && fromOpts.length) return fromOpts.slice()
  const s = snap || snapshot()
  return Array.isArray(s.servers) ? s.servers.slice() : []
}

function renderServers(servers, snap) {
  const box = document.getElementById("srv-list")
  if (!box) return
  box.textContent = ""
  show("srv-count", servers.length ? "(" + servers.length + ")" : "")

  if (!servers.length) {
    box.appendChild(el("p", "还没有服务器。展开下面「添加服务器」开始。", "empty"))
    return
  }

  for (const s of servers) {
    const st = (snap.status && snap.status[s.id]) || null
    const row = el("div", null, "srv")

    const dot = el("span", null, "dot " + (st ? (st.ok ? "ok" : "bad") : "unknown"))
    row.appendChild(dot)

    const main = el("div", null, "srv-main")
    main.appendChild(el("div", s.name || s.id, "srv-name"))
    main.appendChild(el("div", (s.user || "") + "@" + (s.host || "") + ":" + (s.port || 22), "srv-host"))

    if (st) {
      if (st.ok) {
        const bits = []
        if (st.os) bits.push(st.os)
        if (st.arch) bits.push(st.arch)
        if (bits.length) main.appendChild(el("div", bits.join(" · "), "srv-host"))
      } else if (st.error) {
        main.appendChild(el("div", st.error, "srv-err"))
      }
    }
    row.appendChild(main)

    // qoderclicn 是否已装
    if (st && st.ok) {
      const has = st.qoder && st.qoder !== "NONE"
      const badge = el("span", has ? (st.version && st.version !== "NONE" ? "qoderclicn " + st.version.slice(0, 18) : "qoderclicn 已装") : "未装 qoderclicn", "srv-badge " + (has ? "good" : "warn"))
      row.appendChild(badge)
    } else if (!snap.hasSecret[s.id]) {
      row.appendChild(el("span", "未设密码", "srv-badge warn"))
    }

    const acts = el("div", null, "srv-actions")

    // 该台的检测结果（按 id 存）与部署进度
    const tr = (snap.testResults || {})[s.id] || null
    const dep = snap.deploying && snap.deploying.id === s.id ? snap.deploying : null
    const hasCli = !!(tr && (tr.checks || []).some((c) => c.name === "qoderclicn" && c.ok))
    const hasCfg = !!(tr && (tr.checks || []).some((c) => c.name === "settings.json" && c.ok))

    // ── 主按钮：未检测 → 检测；检测缺东西 → 配置；都齐 → 重新配置 ──
    if (dep) {
      pendingDeploy.delete(s.id)
      // 配置中：进度条 + 禁用按钮
      const pct = dep.total ? Math.round((dep.index / dep.total) * 100) : 0
      const wrap = el("div", null, "prog-wrap")
      const bar = el("div", null, "prog-bar")
      bar.style.width = pct + "%"
      const track = el("div", null, "prog-track")
      track.appendChild(bar)
      wrap.appendChild(track)
      const label = {
        env: "检查环境", install: "下载安装", settings: "写入配置", verify: "验证版本",
      }[dep.step] || dep.step
      wrap.appendChild(el("div", `${dep.index}/${dep.total} ${label}`, "prog-label"))
      acts.appendChild(wrap)

      const btnBusy = el("button", "配置中…")
      btnBusy.disabled = true
      acts.appendChild(btnBusy)
    } else if (!tr || testingIds.has(s.id)) {
      // 未检测过，或正在检测：按钮禁用，文案「检查中…」
      const busy = testingIds.has(s.id)
      const btnCheck = el("button", busy ? "检查中…" : "检测", "primary")
      btnCheck.disabled = busy
      if (!busy) {
        btnCheck.addEventListener("click", async () => {
          testingIds.add(s.id)
          btnCheck.disabled = true
          btnCheck.textContent = "检查中…"
          try {
            await saveOptions({ testQueue: [{ id: s.id, at: Date.now() }] })
            // 后端 5 秒一轮，检测本身要 30-45 秒，最多等 75 秒
            for (let i = 0; i < 15; i++) {
              await new Promise((r) => setTimeout(r, 5000))
              await reloadSnapshot()
              const t = (snapshot().testResults || {})[s.id]
              if (t) break
            }
          } catch (e) {
            // ignore
          } finally {
            testingIds.delete(s.id)
            await refresh()
          }
        })
      }
      acts.appendChild(btnCheck)
    } else {
      const label = hasCli && hasCfg ? "重新配置" : "配置 qoderclicn"
      const btnDeploy = el("button", pendingDeploy.has(s.id) ? "已提交…" : label, hasCli && hasCfg ? "" : "primary")
      btnDeploy.disabled = pendingDeploy.has(s.id)
      btnDeploy.addEventListener("click", async () => {
        pendingDeploy.add(s.id)
        btnDeploy.disabled = true
        btnDeploy.textContent = "已提交…"
        try {
          await saveOptions({ deployQueue: [{ id: s.id, at: Date.now() }] })
          // 等后端开始处理（deploying 出现）
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 3000))
            await reloadSnapshot()
            const dd = snapshot().deploying
            if (dd && dd.id === s.id) break
          }
          await refresh()
        } catch (e) {
          pendingDeploy.delete(s.id)
          btnDeploy.disabled = false
          btnDeploy.textContent = label
        }
      })
      acts.appendChild(btnDeploy)

      // 次要：重新检测
      const btnRecheck = el("button", "重检")
      btnRecheck.addEventListener("click", async () => {
        btnRecheck.disabled = true
        btnRecheck.textContent = "…"
        try {
          await saveOptions({ testQueue: [{ id: s.id, at: Date.now() }] })
          for (let i = 0; i < 9; i++) {
            await new Promise((r) => setTimeout(r, 5000))
            await reloadSnapshot()
            const t = (snapshot().testResults || {})[s.id]
            if (t && t.at !== tr.at) break
          }
          await refresh()
        } finally {
          btnRecheck.disabled = false
          btnRecheck.textContent = "重检"
        }
      })
      acts.appendChild(btnRecheck)
    }

    const btnDel = el("button", "删除", "danger")
    btnDel.addEventListener("click", async () => {
      if (!confirm("删除服务器 " + (s.name || s.id) + " ？（同时清除它的密码）")) return
      btnDel.disabled = true
      try {
        const opts = (await magpie.options.get()) || {}
        const keep = readServers(opts).filter((x) => x.id !== s.id)
        await saveOptions({ servers: keep, removeSecret: s.id })
        await refresh()
      } finally {
        btnDel.disabled = false
      }
    })
    acts.appendChild(btnDel)

    row.appendChild(acts)
    box.appendChild(row)
  }
}

async function refresh() {
  const opts = (await magpie.options.get()) || {}
  const snap = snapshot()

  const depUrlInput = document.getElementById("dep-url")
  const depKeyInput = document.getElementById("dep-key")
  if (depUrlInput && !depUrlInput.dataset.touched) {
    depUrlInput.value = opts.deployUrl || (snap.gateway && snap.gateway.deployUrl) || ""
  }
  if (depKeyInput && !depKeyInput.dataset.touched && opts.deployKey) {
    depKeyInput.value = opts.deployKey
  }

  renderServers(readServers(opts, snap), snap)
  renderTestResult(snap.testResult)
  renderTunnel(snap.tunnel, opts, readServers(opts, snap))
  renderLog(snap.log, opts)

  // 日志设置回填
  const ll = document.getElementById("log-lines")
  const lf = document.getElementById("log-file")
  if (ll && !ll.dataset.touched) ll.value = String(opts.logLines || 30)
  if (lf && !lf.dataset.touched) {
    lf.value = opts.logFile || (snap.log && snap.log.file) || ""
  }

  show("snap-at", snap.at ? "后端快照：" + fmtAgo(snap.at) : "等待后端第一次探测…")
}

// 隧道面板
function renderTunnel(tun, opts, servers) {
  const sel = document.getElementById("tun-srv")
  const btn = document.getElementById("tun-toggle")
  const state = document.getElementById("tun-state")
  const info = document.getElementById("tun-info")
  if (!sel || !btn) return

  // options 读不到时，用快照里的隧道运行状态兜底（至少有 serverId/端口）
  const cfg = (opts && opts.tunnel) || (tun ? {
    serverId: tun.id || tun.serverId,
    remotePort: tun.remotePort,
    localPort: tun.localPort,
    enabled: !!tun.running,
  } : {})

  // 服务器下拉（保留当前选择）
  const want = cfg.serverId || sel.value
  sel.textContent = ""
  for (const s of servers) {
    const o = el("option", s.name || s.id)
    o.value = s.id
    sel.appendChild(o)
  }
  if (want && servers.some((s) => s.id === want)) sel.value = want

  const rp = document.getElementById("tun-rport")
  const lp = document.getElementById("tun-lport")
  if (rp && !rp.dataset.touched) rp.value = String(cfg.remotePort || 23425)
  if (lp && !lp.dataset.touched) lp.value = String(cfg.localPort || 3426)

  const running = !!(tun && tun.running)
  const enabled = !!cfg.enabled
  btn.textContent = enabled ? "停止隧道" : "启动隧道"
  btn.className = enabled ? "" : "primary"

  if (!tun) {
    show("tun-state", enabled ? "启动中…" : "未启用")
    info.textContent = ""
  } else if (running) {
    const tag = tun.external ? "（远端已有隧道，非本插件启动）" : ""
    show("tun-state", "运行中 " + tag)
    info.textContent = `远端 127.0.0.1:${tun.remotePort || "?"} → 本机 127.0.0.1:${tun.localPort || "?"}`
      + (tun.pid ? `　pid ${tun.pid}` : "")
  } else {
    show("tun-state", tun.error ? "失败：" + tun.error : "已停止")
    info.textContent = ""
  }
}

// 运行日志
function renderLog(log, opts) {
  const view = document.getElementById("log-view")
  const meta = document.getElementById("log-meta")
  if (!view) return

  if (!log) {
    view.textContent = "（后端还没读日志）"
    if (meta) meta.textContent = ""
    return
  }
  if (log.error) {
    view.textContent = "读取失败：" + log.error
    if (meta) meta.textContent = "文件：" + (log.file || "未设置") + "　可在上面填绝对路径"
    return
  }
  const lines = Array.isArray(log.lines) ? log.lines : []
  view.textContent = lines.length ? lines.join("\n") : "（日志为空）"
  // 自动滚到底
  view.scrollTop = view.scrollHeight
  if (meta) {
    const size = log.size ? (log.size / 1024).toFixed(1) + " KB" : "?"
    meta.textContent = `${log.file}　共 ${log.total ?? "?"} 行 / ${size}　显示最后 ${lines.length} 行`
  }
}

// 测试结果：按服务器逐项列出检查结论
function renderTestResult(trOrAll) {
  const box = document.getElementById("test-result")
  if (!box) return
  box.textContent = ""

  // 兼容：优先用 testResults（按 id），回退单个 testResult
  const snap = snapshot()
  const all = snap.testResults && Object.keys(snap.testResults).length
    ? Object.values(snap.testResults)
    : trOrAll ? [trOrAll] : []
  if (!all.length) return

  for (const tr of all) {
    if (!tr || !Array.isArray(tr.checks)) continue
    const wrap = el("div", null, "test-box " + (tr.ok ? "pass" : "fail"))
    wrap.appendChild(el("div", (tr.ok ? "✓ " : "✗ ") + (tr.name || tr.id) + " 检测结果", "test-title"))

    const list = el("ul", null, "test-list")
    for (const c of tr.checks) {
      const li = el("li", null, c.ok ? "ok" : "bad")
      li.appendChild(el("span", c.ok ? "✓" : "✗", "test-mark"))
      li.appendChild(el("span", c.name, "test-name"))
      li.appendChild(el("span", c.detail || "", "test-detail"))
      list.appendChild(li)
    }
    wrap.appendChild(list)
    box.appendChild(wrap)
  }
}

async function main() {
  // magpie.ready 在某些 web 视图下可能永久 pending；加超时兜底，
  // 否则整个 main 卡在第一行，下面所有按钮事件都不会绑定（表现为按钮全死）。
  try {
    await Promise.race([
      magpie.ready,
      new Promise((r) => setTimeout(r, 2000)),
    ])
  } catch (e) {
    // ready 失败也继续，下面操作会自己报错
  }

  // 页面初次加载时 <script src="snapshot.js"> 会命中浏览器缓存，
  // 而后端每次 tick 都会重写这个文件（尤其 magpie 重启后）。
  // 带时间戳重载一次；失败也不能阻断下面的事件绑定。
  try {
    await reloadSnapshot()
  } catch (e) {
    console.warn("qoder-ssh: snapshot reload failed", e)
  }
  try {
    await refresh()
  } catch (e) {
    console.warn("qoder-ssh: initial refresh failed", e)
  }

  // 网关保存
  const saveGw = document.getElementById("save-gw")
  if (saveGw) {
    saveGw.addEventListener("click", async () => {
      const depUrl = (document.getElementById("dep-url") || {}).value || ""
      const depKey = (document.getElementById("dep-key") || {}).value || ""
      saveGw.disabled = true
      try {
        await saveOptions({
          deployUrl: depUrl.trim(),
          deployKey: depKey.trim(),
        })
        show("gw-state", "已保存")
      } catch (e) {
        show("gw-state", "保存失败：" + (e && e.message))
      } finally {
        saveGw.disabled = false
        setTimeout(() => show("gw-state", ""), 5000)
      }
    })
  }

  // 输入框标记 touched，避免轮询把手输的值冲掉
  for (const id of ["dep-url", "dep-key"]) {
    const n = document.getElementById(id)
    if (n) n.addEventListener("input", () => { n.dataset.touched = "1" })
  }

  // 日志设置：改了立刻保存
  const tunToggle = document.getElementById("tun-toggle")
  if (tunToggle) {
    tunToggle.addEventListener("click", async () => {
      tunToggle.disabled = true
      try {
        const opts = (await magpie.options.get()) || {}
        const cfg = opts.tunnel || {}
        const sel = document.getElementById("tun-srv")
        const rp = document.getElementById("tun-rport")
        const lp = document.getElementById("tun-lport")
        if (cfg.enabled) {
          await saveOptions({ tunnel: { ...cfg, enabled: false } })
          show("tun-state", "正在停止…")
        } else {
          if (!sel || !sel.value) {
            show("tun-state", "先添加一台服务器")
            return
          }
          await saveOptions({
            tunnel: {
              enabled: true,
              serverId: sel.value,
              remotePort: Number(rp && rp.value) || 23425,
              localPort: Number(lp && lp.value) || 3426,
            },
          })
          show("tun-state", "正在启动…")
        }
        // 等后端处理（5 秒一轮）
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 3000))
          await reloadSnapshot()
          if (snapshot().tunnel) break
        }
        await refresh()
      } catch (e) {
        show("tun-state", "操作失败：" + (e && e.message))
      } finally {
        tunToggle.disabled = false
      }
    })
  }
  for (const id of ["tun-rport", "tun-lport"]) {
    const n = document.getElementById(id)
    if (n) n.addEventListener("input", () => { n.dataset.touched = "1" })
  }

  const logLines = document.getElementById("log-lines")
  if (logLines) {
    logLines.addEventListener("change", async () => {
      try {
        await saveOptions({ logLines: Number(logLines.value) || 30 })
      } catch {}
    })
  }
  const logFile = document.getElementById("log-file")
  if (logFile) {
    logFile.addEventListener("input", () => { logFile.dataset.touched = "1" })
    logFile.addEventListener("change", async () => {
      try {
        await saveOptions({ logFile: logFile.value.trim() })
      } catch {}
    })
  }

  // 添加服务器
  const addBtn = document.getElementById("add-srv")
  if (addBtn) {
    addBtn.addEventListener("click", async () => {
      const name = (document.getElementById("new-name") || {}).value || ""
      const host = (document.getElementById("new-host") || {}).value || ""
      const port = Number((document.getElementById("new-port") || {}).value || 22)
      const user = (document.getElementById("new-user") || {}).value || ""
      const pass = (document.getElementById("new-pass") || {}).value || ""

      if (!host || !user) {
        show("add-state", "主机和用户必填")
        return
      }

      addBtn.disabled = true
      try {
        const opts = (await magpie.options.get()) || {}
        const servers = readServers(opts)
        const id = "s" + Date.now().toString(36)
        servers.push({ id, name: name || host, host: host.trim(), port: port || 22, user: user.trim() })
        const patch = { servers }
        if (pass) patch.pendingSecret = { id, password: pass }
        await saveOptions(patch)

        for (const f of ["new-name", "new-host", "new-user", "new-pass"]) {
          const n = document.getElementById(f)
          if (n) n.value = ""
        }
        show("add-state", "已添加，状态稍后刷新")
        await refresh()
        setTimeout(() => show("add-state", ""), 5000)
      } catch (e) {
        show("add-state", "失败：" + (e && e.message))
      } finally {
        addBtn.disabled = false
      }
    })
  }

  await refresh()
  // 后端每 5 秒写一次快照（队列任务即时处理）；页面 5 秒刷一次视图
  setInterval(async () => {
    try {
      await reloadSnapshot()
      await refresh()
    } catch {}
  }, 5000)
}

main().catch((e) => {
  const p = document.createElement("p")
  p.className = "srv-err"
  p.textContent = "页面脚本出错：" + (e && e.message)
  document.body.appendChild(p)
})
