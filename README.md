<div align="center">
  <img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
  <h1 align="center">Gemini Shadow Node</h1>
  <p align="center">
    将 Google AI Studio 网页环境转化为私有、高性能、兼容原生 API 的 Gemini 服务基础设施。
  </p>
  <p align="center">
    <a href="https://github.com/TianLanDaoRen/GeminiShadowNode/stargazers"><img src="https://img.shields.io/github/stars/TianLanDaoRen/GeminiShadowNode?style=for-the-badge&logo=github&color=00f3ff" alt="Stars"></a>
    <a href="https://github.com/TianLanDaoRen/GeminiShadowNode/blob/main/LICENSE"><img src="https://img.shields.io/github/license/TianLanDaoRen/GeminiShadowNode?style=for-the-badge&color=bc13fe" alt="License"></a>
    <img src="https://img.shields.io/badge/Version-v3.0-blue?style=for-the-badge" alt="Version">
    <img src="https://img.shields.io/badge/Status-Stable-green?style=for-the-badge" alt="Status">
  </p>
</div>

---

## 🎯 项目目标：突破限制，重获自由

**现状**：Google AI Studio 提供了对顶级模型（如 Gemini 3.0 Pro）的免费网页访问，但官方并不提供相应 Free Tier 级别的 API 调用，这给开发者和 AI 爱好者带来了极大的不便。

**常见的错误路径**：
许多人尝试使用**无头浏览器 (Headless Browser) + 自动化模拟 (Puppeteer)** 的方式来转发请求。这种方法存在致命缺陷：
1.  **风控封号风险**：Google 拥有顶级的机器人检测机制，自动化模拟极易被识别为异常行为，导致账号被封禁。
2.  **解析脆弱性**：依赖解析网页 DOM 元素来获取输出，一旦 Google 更新前端，整个系统就会崩溃。

**我们的方案：Shadow Node**
我们采用了一种更底层、更可靠的架构：**Applet 挂机 + WebSocket 隧道**。

- **可靠**: 我们不模拟用户输入，而是通过 AI Studio 的 WebContainer 环境直接与 Google 内部 SDK 交互，请求路径最短，行为最原生。
- **原生适配**: 我们 1:1 复刻了 Google Gemini REST API 的所有行为，包括**流式生成 (SSE/JSON Array)**、**模型列表获取**、**多模态输入**和**工具调用 (Function Calling)**。
- **生态兼容**: 天然适配任何支持自定义 Gemini Base URL 的大模型客户端（如 **Cherry Studio**, **NextChat**, **LangChain**）。

---

## ✨ 核心亮点

<table width="100%">
  <tr>
    <!-- <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/TianLanDaoRen/GeminiShadowNode/main/assets/feature_stream.gif" alt="Streaming Demo">
    </td> -->
    <td width="50%" valign="top">
      <h3>🚀 原生级流式传输</h3>
      <p>完美支持 <code>:streamGenerateContent</code> 接口，并提供 <strong>Server-Sent Events (SSE)</strong> 和 <strong>JSON Array</strong> 两种流式格式，无缝兼容所有客户端。</p>
      <br>
      <h4>🎛️ 可调式流式缓冲</h4>
      <p>Applet 端独创 <strong>“大坝式”</strong> 缓冲机制。你可以自定义缓冲时间（如 50ms-2000ms），在 <strong>丝滑体验</strong> 和 <strong>低服务器负载</strong> 之间找到完美平衡。</p>
    </td>
  </tr>
  <tr>
    <!-- <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/TianLanDaoRen/GeminiShadowNode/main/assets/feature_cluster.png" alt="Cluster Demo">
    </td> -->
    <td width="50%" valign="top">
      <h3>🌐 分布式集群 & 故障转移</h3>
      <p>Relay Server 支持连接多个 Applet 节点（多账号/多设备）。</p>
      <br>
      <h4>⚖️ 智能负载均衡</h4>
      <p>采用 <strong>“最小连接数 + LRU”</strong> 调度算法，自动将请求分发给最空闲的节点，轻松实现并发处理和多账号速率限制翻倍。</p>
      <br>
      <h4>🛡️ 故障自动转移</h4>
      <p>当某个 Applet 节点意外掉线时，正在处理的任务会自动漂移到其他健康节点上，用户端毫不知情。</p>
    </td>
  </tr>
</table>

---

## 🚀 快速部署指南

部署 **Shadow Node** 架构仅需两步：搭建你的中转站，然后激活云端的执行节点。

| 步骤 | 组件 | 描述 | 教程文档 |
| :--- | :--- | :--- | :--- |
| **01** | 🛰️ **Relay Server** | 在你的 VPS 或服务器上部署 Node.js 中转服务，并配置 Nginx 进行 HTTPS 加密和反向代理。 | [**`/doc/relay-server.md`**](./doc/relay-server.md) |
| **02** | 👻 **Applet 挂机** | 打开 AI Studio 专属链接，运行 Angular Applet，并将其连接到你的 Relay Server。本教程包含**低配 VPS (2G内存)** 的极限优化指南。 | [**`/doc/applet-on-vps.md`**](./doc/applet-on-vps.md) |

---

## 🔧 测试你的 API

部署完成后，你可以使用任何标准工具进行测试。

- **Base URL**: `https://your-domain.com/v1beta`
- **模型列表**: `GET /models`
- **生成内容**: `POST /models/gemini-3-pro-preview:generateContent`

我们也提供了一个功能完备的**网页客户端 (`user-client.html`)**，支持多模态、上下文、流式和压力测试。

> ➡️ [**点击这里查看 user-client 使用指南**](./doc/user-client.md)

---

## ❤️ 支持与贡献

如果你觉得这个项目对你有帮助，请给一个 ⭐️ **Star**！这是我们持续更新的最大动力。

欢迎提交 Pull Request 或在 Issues 中提出建议。