// qoder-ssh 的 agent 声明：让 magpie 的「使用 → Agent」页面出现 qoder-ssh 一行。
//
// 为什么需要这个文件单独存在：magpie 把入口模块（index.mjs）里每个函数导出都当成
// 一个 provider 插件，所以 agent 声明必须放在独立文件，由 package.json 的
// "magpie": { "agent": "./agent.mjs" } 指过来。
//
// ⚠️ agent 插件**不能 import node: 内置模块**（magpie 只允许引同目录文件，
//    报错原文：an agent plugin imports only files beside it）。所以这里不能用
//    existsSync 之类的动态判断，config 必须是静态字符串。
//
// 为什么用 ~/.qoder-ssh/settings.json 而不是 ~/.qoder-cn/settings.json：
//    magpie 内置的 Qoder CN agent 也指向 ~/.qoder-cn/settings.json。只要我们建了
//    那个文件，内置 Qoder CN 就会一起冒出来，用户会看到一个"多出来的" agent。
//    用独立路径可以只让 qoder-ssh 出现。
//    真正给 qoder CLI 用的配置仍由插件页面的「配置 qoderclicn」写入
//    ~/.qoder-cn/settings.json，不受影响。
//
// qoder CLI 的 provider 结构比一般 agent 复杂（必须有 type/protocol/authType，
// 且 models[] 要逐个列出），所以：
//   · model 用 "model.qoder-ssh" 旁路字段（magpie 会往这里写裸 id）
//   · model.name 由 connect 独占写入全限定形式
//   · connect 用 merge 把 providers.magpie 整体合并进去，保留用户已有内容

const PROVIDER_KEY = "magpie"

// magpie 传进来的 model.id 已经是 qoder 要的裸 id（如 group/trae-xxx），
// 只需在 selection key 前面加 provider 名（qoder 的 model.name 要全限定）。
function qualified(id) {
  return PROVIDER_KEY + "/" + String(id || "")
}

export const agent = {
  id: "qoder-ssh",
  name: "qoder-ssh",
  config: "~/.qoder-ssh/settings.json",
  model: "model.qoder-ssh",
  merge: ["providers.magpie"],
  notice: "qoder CLI 读的是 ~/.qoder-cn/settings.json：用插件页面的「配置 qoderclicn」写入，重开会话生效。",
}

export function connect({ gateway, model, models }) {
  const all = Array.isArray(models) && models.length ? models : model ? [model] : []
  const list = all.map((m) => ({
    model: String(m.id || ""),
    displayName: m.name || String(m.id || ""),
  }))

  const out = {
    "providers.magpie": {
      type: "openai-compatible",
      protocol: "openai",
      authType: "bearer",
      baseUrl: gateway.v1,
      apiKey: gateway.key,
      displayName: "magpie",
      model: model ? String(model.id || "") : list.length ? list[0].model : "",
      models: list,
    },
    "ui.language": "zh-CN",
  }

  if (model && model.id) {
    out["model.name"] = qualified(model.id)
  }
  return out
}
