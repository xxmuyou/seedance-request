# seed-local

本地 CLI 工具，用于调用 Seedream / Seedance / Seed3D 接口生成图片、视频和 3D 模型。

## 环境要求

- Node.js **>= 22**

## 安装

```bash
git clone <repo-url>
cd seedance-request
cp .env.example .env   # 填写 SEED_API_BASE_URL 和 SEED_API_KEY
```

## 配置

编辑 `.env`，至少填写以下两项：

```
SEED_API_BASE_URL=https://your-api-base-url
SEED_API_KEY=your-api-key
```

## 使用

```bash
# 生成图片（seedream）
npm run cli -- "一只在月球上骑车的猫"

# 指定模型
npm run cli -- seedance "赛博朋克城市航拍镜头"
npm run cli -- seedream "水墨风格山水画"
npm run cli -- seed3d --image ./assets/object.png

# 带参考图
npm run cli -- seedance --image ./assets/ref.png "女孩抱着狐狸，镜头缓缓拉出"
npm run cli -- seedance --image ./assets/a.png --image ./assets/b.png "两图融合"

# 使用 assets/source/ 目录下所有图片作为参考图
npm run cli -- seedance --folder "将所有参考图融合生成视频"

# 追加文本文件内容到 prompt
npm run cli -- --at ./context.txt "根据上述内容生成图片"

# 仅打印请求体，不发送请求
npm run cli -- --dry-run "测试 prompt"

# 查询已有任务并下载（seedance）
npm run cli -- seedance --fetch <task_id>

# 进入交互模式
npm run cli
```

## 系统提示词

编辑项目根目录的 `system-prompt.md`，写入提示词后，所有请求都会自动将其追加到 prompt 中。

## 输出

生成结果保存在 `assets/` 目录下，文件名格式为 `YYYYMMDD-HHmmss-<provider>.<ext>`。
