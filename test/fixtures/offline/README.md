# SIMS 0.1.2 离线重建验收材料

这是隔离重建材料，不是生产配置或插件市场条目。插件本体仍是 artifacts/ 中的标准 DSH tgz；宿主镜像、包管理器和缓存用于断网重建，不进入插件发行包。

## 已验证

Linux ARM64 和 Linux x86_64（本机模拟）均从容器内空目录安装 runtime、Profile 两套锁定依赖。Docker 使用 --network none；明确允许运行的依赖安装脚本执行成功，原生 PTY 可用。实际 dsh --profile web 启动后，经其认证 RPC 创建模板为 ready，并可显式移除。

缺少原始插件 tgz 和原 tgz 被追加一个字节，均被 SHA256 预检拒绝。安装步骤位于预检之后；不会通过更新摘要来接受损坏制品。

测试没有 SIMS 凭据，connection.check 返回 CONFIGURATION_REQUIRED；不代表生产迁移或新的真实账号验收。Docker Engine 本身需提前安装。

## 内容

- node-image.tar：固定 Node 22.22.0 Debian 镜像，含 arm64/amd64 两个本地标签。
- artifacts/：SIMS 0.1.2 原始发行包及 pnpm 10.32.1 原包。
- runtime/、profile/：各自的清单、锁文件和构建脚本允许列表。
- store.tar：完整 pnpm 内容寻址缓存，安装时提取到新目录。
- SHA256SUMS：重建输入摘要；RESULTS.json：本次实际结果。
- offline-test.sh、verify-offline.mjs：可复现的完整性、断网安装和真实宿主验收。
- public-source.tar.gz：仅自有插件的公开源码候选，尚未公开；源码来源提交见 RESULTS.json。公开仓库地址及从 Git 来源安装的最终发布流程仍待确定。

## 在已安装 Docker 的机器复现

解压本材料，进入目录后执行。首次加载镜像前也应验证摘要；macOS 可使用 shasum -a 256 -c SHA256SUMS。

```sh
sha256sum -c SHA256SUMS
docker load -i node-image.tar
docker run --rm --pull=never --platform linux/amd64 --network none \
  -v "$PWD:/input:ro" sims-offline-node:22.22.0-amd64 sh /input/offline-test.sh
```

ARM64 将两个 amd64 替换为 arm64。脚本只使用 /tmp/sims-new-home 等一次性容器目录，不挂载生产 HOME、不复用既有 node_modules。验证结束容器自动移除。

## 现场问题与纠正

- 自动解析曾组合 react 18.3.1 和 react-dom 19.3.0。已在部署清单固定两者为 18.3.1，重新生成锁文件；此纠正只在部署配置层。
- 直接挂载底层 Loader 的初版验收遗漏宿主正常启动的模块解析配置，错误报告 Persona 缺失。最终使用正式 DSH CLI 入口验证，没有为验收脚本问题改动上游或插件依赖。
- 运行配置、凭据和用户模板状态应按宿主机制单独迁移；本材料不携带任何生产凭据。换目录模板识别已由此前功能测试验证，完整生产业务恢复仍需独立验收。
