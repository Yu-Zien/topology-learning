# 课件指纹计算口径

`runtime/catalog.json` 的模块 `contentHash` 是权威 Markdown 以 UTF-8 读取、统一换行后再以 UTF-8 编码的 SHA-256。它参与既有学习内容版本；本次没有改用发布文件哈希覆盖它，也不据哈希差异清空记录。

公开 Markdown 会把本机绝对课件链接改成同目录相对链接，因此含此类链接的公开文件与源文件可以具有不同哈希。`read/catalog.json` 逐课给出 `sourceSha256`、`publishedMarkdownSha256` 和 `sourceLinkRewrites`：前者等于既有 `contentHash`，后者可直接对公开 `read/*.md` 文件重算。转换清单只记录目标课件、相对地址与次数，不公开本机路径。

复算源到公开文件时，在原开发项目读取该课件，并将每项 `sourceLinkRewrites` 指定的目标课件绝对路径替换为 `publishedTarget`；转换后 UTF-8 字节的 SHA-256 应等于 `publishedMarkdownSha256`。构建脚本会拒绝构建后又被改动的源稿。

全课程 `contentVersion` 是按固定编号排序的 `id:contentHash` 各行以 LF 连接（末尾不加 LF）后的 SHA-256。它不涵盖运行映射、页面模板或版本说明；整个发布目录的逐文件完整性由 `release-manifest.json` 的精确字节哈希负责。
