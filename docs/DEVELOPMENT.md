<!-- Commands below run from the repository root. -->

# RideBili 0.1.21 开发说明

BMW iDrive 7 (MGU/ID7) 上的非官方哔哩哔哩客户端，由 RideTube 改编。支持访客首页和搜索、BV 号或普通视频链接、B 站 App 扫码登录、关注、稍后再看，以及本地续播。首页标题为「小宁兄弟 - ( ゜- ゜)つロ 乾杯~」。视频使用 H.264 硬解。自动音频模式以 48 kHz 双声道 PCM 输出到 SmartX。历史续播、跳转、切换画质及备用 MP4 同样优先 PCM。实时音频设备、路由或解码失败时会提示，可手动选择 BMW MediaPlayer 的兼容 MP3 通路。应用层的车速画面屏蔽、行车设置和低压电池自动暂停已移除。

当前播放范围是普通 BV 点播视频的 H.264/AAC DASH 流，并支持公开单文件 MP4 备用流。多 P 视频可用带 `?p=N` 的标准网页链接选择分 P。未实现弹幕、直播、番剧专用播放接口或云端观看进度同步。

自动模式在没有近期带宽数据时优先 480P DASH，同档按分辨率和码率选清晰版本。用正在播放的视频记录实际传输速度，供接下来 90 秒内同一网络的点播参考。普通点播从开头开始，「继续观看」才从历史位置缓冲。首选 CDN 约 300 ms 未交付媒体数据时同时试备用地址，单轨最多两路并行，失败即补下一条，沿用先到数据的连接。音视频、手动选档及 MP4 备用流统一使用这套选路。解析出首批画面时启动硬解码器，音频在后台继续准备。画质弹窗可手动切换当前视频。

## 兼容性

0.1.21 在原生设置页和完整显示设置页加入署名与来源致谢。兼容 MP3 恢复播放时，忽略新音轨尚未完成跳转前的临时进度，连续恢复以最后一次操作为准。参考 RideTube 8977a11 的恢复保护思路。

本版核对 MGU Store 0.9.42、Updater 0.8.53、Renderer 0.6.25、Deploy 0.8.27、Uplink 0.7.13、Python 1.0.3，以及独立 GPU renderer 2.1.19 的代码。自动选路和实时 PCM 沿用 0.1.20；新渲染器继续支持 I420 视频和既有触控协议。具体检查范围见交付包说明；0.1.21 的实车验证已获作者确认。

0.1.20 的设置可选择新视频默认清晰度，自动模式优先 480P。「完全退出应用」等待播放服务停止、释放音频，再结束界面进程。音轨优先选择同类较低码率的 AAC，并允许两次校验后的 CDN 断点接续。

0.1.19 为关键词搜索设置总时限，签名接口超时或需要验证时尝试一次公开搜索接口。搜索使用当前热点分配的 DNS，并缩短等待单个 DNS 服务器的时间。

0.1.18 优先连接实际运行的独立渲染器，遇到不支持所需协议或触控的渲染器时尝试 Store Renderer。播放器显示实时音频失败的环节，可从错误页为当前视频单独使用兼容 MP3 重试。页面提供原生设置入口。

0.1.15 优先尝试 B 站返回的常规国内 CDN，保留原始签名和备用地址。同一热点的近期有效媒体读取结果可调整同类地址的顺序。选路使用实际播放请求的样本。

0.1.14 实时音频点播仅启动一次下载会话。响应中断时可按已读字节在同一媒体的签名 CDN 地址接续，保留解码状态。加载条显示当前等待的阶段，首帧出现前后位置一致。兼容 MP3 由用户手动选择。

0.1.12 区分起播前的 CDN 传输失败和实时音频故障。CDN 失败按网络路径重试，实时音频故障仍可切到 MP3，同一网络上近期取得的播放地址可用于这次切换。随包附带官方 Renderer 0.6.16，其触控规则更新移出了绘图循环。

0.1.11 将 HMI 背景图片上传与 GPU 绘制解耦，系统图片请求超时会释放绘图循环。显示服务恢复后可继续绘制。只接入支持原生图片、视频和输入协议的渲染连接；组件未就绪时显示恢复提示，避免无法交互的缩小主页。

0.1.10 优先连接 MGU Store 原生渲染器接口，握手超时自动重试，支持依赖服务重启后的页面与控制恢复。更新过程中中断的首页请求会在服务恢复后重新获取。播放服务从系统用户组解析控制接口权限，并支持 MainApp 的两种 SOME/IP 描述文件目录。原版 RideTube 服务存在时，首页与账号功能仍可使用；播放前会提示卸载原版服务，避免两者抢占共用的音视频资源。

USB 补丁包含应用、播放服务和官方 mgu-render 0.6.16。其余运行时使用车机已安装版本，更新保留扫码账户和设置。

## 构建

依赖 Python 3.10+、Node.js 18+、MGU Store 源码和 RideTube 官方服务包。已随源码带上编译好的中文字形。重新生成字形可使用 `kit/tools/bake_bili_cjk.py`、Noto Sans SC 和 Pillow。

```sh
python3 kit/tools/build.py --store-only ride_bili
node kit/tools/test_ride_bili.js
node kit/tools/test_qr.js
sh native/ride-bili-d/tools/build_audio.sh third-party-audio/ffmpeg-n7.1.2.tar.gz third-party-audio/lame_3.100.orig.tar.gz "$PWD/native/ride-bili-d/build/mgu-audio"
sh native/ride-bili-d/tools/build_pcm.sh third-party-audio/ffmpeg-n7.1.2.tar.gz "$PWD/native/ride-bili-d/build/mgu-pcm"
MGU_STORE=/path/to/mgu-store sh native/ride-bili-d/build.sh /path/to/jap-ridetube-d@0.3.8.tgz
python3 tools/release.py /path/to/USB
```

音频工具的构建需要 Linux x86-64、C 编译器和 make。

构建脚本从校验过的 RideTube 0.3.8 官方包提取原版 x86-64 解码器。其源码见 `native/ytdec`。Store 安装时会从车机上的 BMW 应用获取 OAP SDK。源码和发布包均未附 BMW SDK。

## 来源

© 2026 Kan Ning。

上述署名用于 RideBili 的新增改动。RideBili 基于 RideTube 开发，参考 Moonride、BiliPai 等项目；原作者的版权与第三方许可证继续有效，整体按 GPL-3.0-or-later 发布。

- [RideTube](https://github.com/JustAnotherPU/ridetube/tree/25af2ac)，应用、车机服务和解码器的基础，GPL-3.0-or-later。
- [BiliPai 0.7.8](https://github.com/jay3-yy/BiliPai/tree/v0.7.8)，B 站扫码、WBI 签名和播放接口参考。未使用其安卓 APK 或运行库。
- [MGU Store](https://github.com/robertnisipeanu/mgu-store/tree/2cf83fc)，U 盘目录和工具打包格式。
- [Moonride](https://github.com/JustAnotherPU/moonride/tree/73bd2742530b94b63999e1b9b6217e74cd6a8c30)，SmartX PCM 输出和 AudioManager 路由参考。
- [Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc)，预渲染中文字形，SIL OFL。

许可证及第三方声明见 `LICENSE`、`THIRD_PARTY_LICENSES`、`kit/LICENSE` 和随文件的许可证。原始 RideTube 更新记录保留在 `CHANGELOG.md`。
