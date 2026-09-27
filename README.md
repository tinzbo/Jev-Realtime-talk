# Xtasy · 和小岚聊聊

语音优先的交互数字人，使用 **RunningHub 生成视频、Hypit 编排导出、Jev 选择回应**。用户说完一句，系统从预先准备的内容中选择一段播放，形成伪实时对话。

当前版本 **v0.3.0**，已接入本地 Whisper 语音识别，浏览器只负责采集声音。仓库直接包含 **24 条完整 MP4**：22 条中文口播、2 条静音过渡，共 197.6 秒，720×1280、30fps、H.264 / AAC。克隆后即可播放，不需要重新生成视频或下载 Git LFS 对象。

## 本地启动

推荐 Node.js 24（最低 22.15）。播放现有视频不需要 ffmpeg。

```sh
git clone https://github.com/tinzbo/Jev-Realtime-talk.git xtasy
cd xtasy
npm ci
npm run dev
```

打开 http://127.0.0.1:4173 。默认仅监听本机；私有仓库克隆需要访问权限。

没有配置服务时，界面会明确使用本地关键词演示。接入真实 Jev：

```sh
cp .env.example .env
```

在 `.env` 填入 `TYPESAFE_API_KEY` 后重启服务。`RUNNINGHUB_API_KEY` 仅用于重新制作视频，现有 24 条视频无需生成账户。凭证只由服务端读取，`.env`、云端任务记录和临时产物不入库。

启用语音需要本机 Python 3 和 [Whisper](https://github.com/openai/whisper)。先运行一次：

```sh
npm run voice:setup
```

该命令优先复用现有 Whisper 环境，否则在项目的 `.asr-venv` 安装；下载默认 `base` 模型约 139 MiB，不调用付费转写接口。重启工作室后在「设置」查看 Whisper 状态。可在 `.env` 指定 `ASR_PYTHON`、`ASR_MODEL_DIR`、`ASR_MODEL` 和 `ASR_THREADS`；服务运行时只加载已安装模型，不自动下载。没有模型时，文字和视频仍可使用。

生产构建也在本机运行：

```sh
npm run build
npm start
```

## 怎么交互

- 点击 **开始语音聊天**，允许浏览器使用麦克风，然后直接提问。识别到完整话语才提交。
- 回应播放完会自动继续倾听；短暂停顿或长时间不说话不会结束会话，也不会发送空问题。
- 小岚回应时暂停识别，避免扬声器声音被当成用户输入。想接话时点击 **打断并说话**。这是一种半双工会话，不是免点击的全双工语音打断。
- 点击 **也可以打字** 展开输入框。支持中文输入法，Enter 发送、Shift + Enter 换行。
- 点击 **结束语音**、打开工作室或将页面切到后台会关闭麦克风。

主界面没有流程进度条、选片耗时或无话倒计时。倾听视频持续循环，回应在首帧解码后叠入；回应结束或主动打断只淡出该回应，不重置静态封面或清空对话。内容库与连接详情收在右上角。

建议从「你能做什么」「怎么批量制作数字人视频」「怎么接入我的网站」开始。当前内容库用于 AI 产品讲解与数字人制作示例，未覆盖的问题会说明范围。

语音路径为 `麦克风 → AudioWorklet → 自动分句 → 本机 Whisper → Jev → 回应视频`，不再依赖浏览器厂商的 SpeechRecognition 服务。需要支持 `getUserMedia` / `AudioWorklet` 的浏览器，推荐桌面 Chrome；当前服务器仅允许本机访问。停顿约 0.9 秒提交一轮，单轮最长约 18 秒。录音只在内存中处理，不保存到磁盘；转写后的文字及最近对话仍会发送给 Jev。

**已验证合成中文音频经过真实采集处理、Whisper、Jev 和浏览器视频播放；真实麦克风、现场噪声及扬声器回声仍需在目标设备验收。** 6 条固定语音样例全部选中预期视频，不代表开放场景的准确率。详见 [v0.3.0 语音验收](docs/voice-acceptance-2026-09-27.md)。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `src/App.tsx` | 简化界面、持续倾听画面、回应播放与打断 |
| `src/voice.ts` | 连续语音会话、识别请求取消、回应期间暂停及恢复 |
| `src/capture.ts` / `src/audio.ts` | 浏览器采集、自动分句、WAV 编码与开发用合成语音输入 |
| `server/asr.ts` / `server/voice-api.ts` | 常驻 Whisper、同源语音接口、限流、超时与清理 |
| `src/catalog.ts` | 24 条台词、用途、时长和选片线索 |
| `server/router.ts` | Jev 类型化判断、候选范围与置信度校验 |
| `public/media/` | 24 条可直接播放的最终视频 |
| `data/assets.json` | 已验收素材清单，Jev 介绍使用修订版 |
| `data/media-checksums.json` | 每条 MP4 的 SHA-256 与文件长度 |
| `scripts/produce.ts` | RunningHub 批量提交、恢复查询、验收 |
| `scripts/export-hypit.ts` | Hypit 编排、统一画幅和帧率、真实导出 |

Jev 同时接收当前问题、最近对话和已播放片段。新输入递增 turn ID，旧请求与过期媒体事件无法覆盖新回应。正式模式只使用已验收的内容，含无匹配和澄清分支；明确的停止请求走本地即时打断。

## 扩充内容库与批量制作

仓库已有的素材会被跳过，不重复付费生成。扩充时先在 `src/catalog.ts` 添加新的片段 ID、台词和选片意图。需要 ffmpeg / ffprobe、Hypit 运行环境、RunningHub Enterprise-Shared API Key。可选填 `AVATAR_IMAGE_URL`；未填时会上传仓库中的原创虚构人物参考图。

```sh
npm run production:plan
npx hypit runtime up --runtime production/hypit.runtime.json
npm run production:sample
```

`plan` 只生成制作清单。在尚未生成素材的新工作室中，`sample` 会提交 3 条生成任务并使用账户额度；当前仓库会直接跳过已有样片。先核对平台报价，再检查形象、台词、声音、口型和首尾动作；通过后执行：

```sh
npm run production:accept -- listen
npm run production:accept -- greeting
npm run production:accept -- mechanism
npm run production:batch
```

每个生成任务的 task ID 保存到被忽略的 `production/jobs.json`；并发数由 `RUNNINGHUB_CONCURRENCY` 控制，范围 1–4。已知任务不会重复提交；提交超时的 `unknown` 任务必须先在 RunningHub 控制台核对，避免重复计费。`npm run production:collect` 仅查询并收集已有任务。生成片段先进入 `review`，验收后才能用于正式对话。

新媒体验收后应同步更新 `data/media-checksums.json`。仓库中的校验清单固定对应本次交付的 24 条最终视频。

```sh
npm run production:verify   # ffprobe、抽帧和本地 Whisper 转写；需安装相应工具
npm run production:package # 根据完整验收报告生成 artifacts/xtasy-videos.zip
```

`artifacts/` 为本地 QA 与交付目录，不包含在 Git 中。制作说明见 [production-brief](docs/production-brief.md)，验收范围见 [acceptance](docs/acceptance.md)。

## 验证

```sh
npm test
npm run check:media
npm run build
```

GitHub Actions 不使用生产凭证，检查类型、行为测试、24 条媒体完整性和生产构建。

本机交互回归需先启动工作室，且安装 ffmpeg；macOS 自动使用系统合成声音创建 6 条测试输入。其他系统可先在 `artifacts/interaction/` 准备相同名称和台词的 WAV。该命令会使用已配置的 Jev 进行最多 6 次选片判断，不生成新视频。

```sh
npm run check:interaction
# 只准备样例，不调用 Jev：
npm run check:interaction -- --fixtures-only
```

结果写入 `artifacts/interaction/latest.json`。开发服务器的 `http://127.0.0.1:4173/?voice-test=1` 提供合成样例选择和运行按钮，通过实际 AudioWorklet / 自动分句链路，不启用麦克风。该面板和样例接口不会出现在生产构建中。

## 上游项目

- [Hypit](https://github.com/hypit-ai/hypit)：`@hypit/hypit@0.2.12`，以离线制作工具运行，前端只使用导出的视频。参考提交 `9c9918d0cedf2f06574ab0d517b1b6b0afb56a66`。
- [TypeSafe / Jev SDK](https://docs.typesafe.ai/sdk/javascript.md)：`@typesafe-ai/sdk@0.6.0`。
- [RunningHub 视频生成 API](https://www.runninghub.ai/runninghub-api-doc-en/api-494859286.md)：Seedance 2.0 Mini，统一人物参考、720p、9:16、原生中文语音。

上游包保留其各自许可；Hypit 的再分发或对外制作服务请按上游 LICENSE 处理。当前版本为本地工作室，没有公网部署或多人账户系统。
