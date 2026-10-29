# 让 dsh-market 收录这个插件

dsh-market 的「发现」列表来自策展目录 `https://awesome-dsh-plugin.com/plugins.json`，
目录数据在 GitHub 仓库 `awesome-dsh-plugin/awesome-dsh-plugin` 的 `data/plugins/` 下，
**一个插件一个 YAML 文件**。收录 = 往那个仓库提一个只加一个文件的 PR。

- 发布到 npm **不是**收录的前提（只影响是否显示下载量）。
- 收录**不是**安全审计：装上后是你的用户权限运行本地代码。

## 1. 把代码放进一个公开 GitHub 仓库

仓库根目录就是本插件目录（`package.json`、`cordis.patch.yml`、`index.js`、`client.js` 在根上）。

```sh
cd dsh-remote-gpu
git init -b main
git add -A
git commit -m "feat: remote GPU monitor plugin for dsh"
git remote add origin git@github.com:OWNER/REPO.git
git push -u origin main
```

然后在 GitHub 仓库页面 → About 右侧齿轮 → **Topics** 里加 `dsh-plugin`（收录要求）。

先把 `package.json` 里的 `OWNER/REPO` 换成真实仓库（`homepage` 和 `repository` 两处）：

```sh
sed -i 's|OWNER/REPO|你的用户名/仓库名|g' package.json
```

## 2. 提交前自检（对应 CI 的四道关）

| CI 检查 | 本仓库现状 |
| --- | --- |
| 每个 PR 最多 3 条 | 只提 1 条 |
| `package.json` 声明 `dsh.bundle` | ✅ `dsh.bundle.patch = ./cordis.patch.yml`，文件存在且有 `- id:` 行 |
| 仓库创建满 1 天 | 新建仓库当天提 PR 会被拦，隔天再提即可 |
| `awesome-lint` + 站点构建 | 条目 YAML 格式、双语描述、分类合法 |

> 最常见的被拒原因：只声明了 `dsh.client` 而没有 `dsh.bundle`。本插件两者都有，不会踩。

## 3. 提 PR

1. Fork `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`
2. 把 `market-entry/OWNER__REPO.yml` 复制到 fork 的 `data/plugins/`，**文件名改成
   `<owner>__<repo>.yml`**（`__` 两个下划线），并把文件里的 `OWNER/REPO` 换成真实值：

   ```sh
   cp market-entry/OWNER__REPO.yml /path/to/awesome-dsh-plugin/data/plugins/<owner>__<repo>.yml
   ```

3. 不要手改 README（它们由 `data/plugins/*.yml` 生成）
4. 提 PR。CI 通过后由维护者读代码合并，合并后 `plugins.json` 与站点自动重建，
   dsh-market 面板刷新即可看到（目录每次请求都重新拉取，没有缓存）。

## 4. 可选，但建议

- **截图**：仓库里声明 `screenshots.json`（本仓库已建好，指向 `assets/screenshot-1.png`）。
  放 1–8 张；相对路径不能跳出插件目录。不声明也能收录，市场会从 README 里抽取。
- **图标**：条目里的 `icon:` 必须是 GitHub 托管的**位图**（png/jpg/webp，方形最清楚），
  SVG 会被拒。现在是 `icon.svg`，所以条目里没写 `icon:`，市场会回退到你的 GitHub 头像。
  想自定义就加一张 `assets/icon-180.png` 再在条目里加
  `icon: https://raw.githubusercontent.com/OWNER/REPO/main/assets/icon-180.png`。
- **npm**：可选。发布时包名要用你自己拥有的 scope（`@local/...` 发不了），且
  `repository` 必须指回这个仓库，市场的下载量映射才会自动接上。发布前记得去掉
  `private: true`。

## 5. 改名（可选）

`@local/dsh-remote-gpu` 里的 `local` 是「本地私有」的意思，公开收录建议改成一个正常名字
（如 `dsh-remote-gpu` 或 `@你的scope/dsh-remote-gpu`）。改名要同步三处：

- `package.json` → `name`
- `cordis.patch.yml` → `- insert[].name`
- `client.js` → `window.__ModuleLoader__.load({ id: ... })`

改完必须重新安装一次（`plugin_manager remove_bundle` + `install_bundle`），
本地 profile 的依赖名也要跟着换。
