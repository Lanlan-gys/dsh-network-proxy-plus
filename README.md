# dsh-network-proxy-plus

DeepSeek Harness 的网络代理设置插件，支持 **SOCKS5 / SOCKS5H / HTTP / HTTPS** 四种代理类型。
在「设置 → 常规」里提供一行设置项，可以选择网络出口模式、代理类型、地址与端口，保存后立即生效。

> A working replacement for `dsh-network-proxy` on DSH 0.2.x, with SOCKS5 support.
> One row in **Settings → General**: mode, proxy type, address, port — applied live.

## 为什么重写

上游 `dsh-network-proxy@1.0.1` 是针对 DSH 0.1.5 写的，在 DSH 0.2.1 上**完全不会加载**：
它调用 `settings.register(namespace, schema, …)`，而 0.2.x 的 `settings` 服务已经没有这个方法
（配置改由插件自己的 `Config` schema + `volatile` 字段投影出表单）。因此插件行一直停在
`fiberPhase: null`，客户端那一行也没有注册，看起来就是「装上了但没有设置的地方」。

此外它只能填一个 `http(s)://` URL，`ProxyAgent` 也不支持 SOCKS，所以 `socks5://127.0.0.1:10809`
这类本地代理根本用不了。本插件做了两件事：

1. 按 0.2.x 的接口重写宿主端：`export const Config`（每个字段 `.volatile()`），
   监听 `loader/volatile-update` / `settings/document-updated` 后立即换掉 undici 的全局 dispatcher。
2. 自己实现了 SOCKS5 连接器（`Agent({ connect })`），支持 IPv4 / IPv6 / 域名目标、
   用户名密码认证、以及 SOCKS 隧道内的 TLS（HTTPS）。

## 设置项

**设置 → 网络代理**（侧边栏独立一页，位置在「启动动画」和「桌宠配置」之间）：

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| 模式 | `跟随系统` / `自定义代理` / `直连` | `跟随系统` |
| 类型 | `SOCKS5` / `SOCKS5H` / `HTTP` / `HTTPS` | `SOCKS5` |
| 地址 | 代理地址 | `127.0.0.1` |
| 端口 | 代理端口 | `10809` |
| 用户名 / 密码 | 可选，SOCKS5 认证用 | 空 |

> 默认是「跟随系统」而不是「自定义代理」：新装的插件不该替陌生人接管网络。
> 如果默认就写死 `127.0.0.1:10809`，别人机器上没有这个端口，装完 Harness 直接断网。
> 要自定义时点一下「自定义代理」，地址和端口已经预填好，再点「应用」即可。

### 行为

- **立即生效**：字段都是 `volatile`，只更新运行中的配置引用，不重启插件。
- **回环直连**：`localhost`、`127.0.0.0/8`、`::1`、`0.0.0.0` 永远直连，
  避免把 Harness 自己的本地服务（例如本地模型 `http://127.0.0.1:11434`）送进代理造成环路。
- **NO_PROXY**：启动时环境变量里已有的 `NO_PROXY`/`no_proxy` 仍然生效。
- **环境变量**：自定义模式下同步给子进程（bash/pwsh 里的 `curl`、`git` 等）——
  SOCKS5 只写 `ALL_PROXY`（`HTTP_PROXY` 带 socks 协议会让只支持 HTTP 代理的客户端出错），
  HTTP(S) 代理则写 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`；
  `NO_PROXY` 一定会补上回环地址（保留原有条目），免得子进程访问本地服务时被塞进代理。
- **跟随系统**：Windows 下读取注册表 `Internet Settings`（支持 `http=…;https=…` 与 `ProxyOverride`），
  其他平台读启动环境的 `HTTP(S)_PROXY`。Windows PAC 脚本不支持，会提示改用手动模式。

## 已知限制

- PAC（`AutoConfigURL`）不支持。
- 只影响 Harness 进程内的 Node 出站请求（`fetch` / undici）与它派生的子进程；
  浏览器自身的流量由系统代理决定。
- 内网地址不做额外旁路判断，除回环与 `NO_PROXY` 之外一律走代理。

## 安装

### 方式一：直接从 GitHub 安装（推荐）

在 DSH 的插件管理器里用 GitHub 安装源：

```
github:Lanlan-gys/dsh-network-proxy-plus
```

这种安装方式 pnpm 会正常安装本包的 `dependencies`（`undici`），依赖解析完整。

### 方式二：本地目录（开发用）

```bash
git clone https://github.com/Lanlan-gys/dsh-network-proxy-plus.git
cd dsh-network-proxy-plus
pnpm install --prod     # 本地目录是 link 安装，pnpm 不会自动装依赖，必须手动跑
```

然后把**绝对路径**作为 bundle 安装。改 `client.js` / `index.js` 后由 HMR 热加载，不必重装。

### 装好之后

1. 打开 **设置**，侧边栏出现「网络代理」。
2. 选「自定义代理」，类型 `SOCKS5`，地址 `127.0.0.1`，端口填你代理的端口（如 `10809`），点「应用」。
3. 状态变成「已生效」即已接管 Harness 的出站请求。

## 结构

```
dsh-network-proxy-plus/
├── index.js           # 宿主端：Config、SOCKS5 连接器、dispatcher 切换、环境变量
├── client.js          # Web 端：设置侧边栏「网络代理」整页（React，无外部依赖）
├── cordis.patch.yml   # 插入 network-proxy-plus 行
├── locale/{en,zh}.json# 插件标题与描述
└── icon.svg
```

## License

MIT
