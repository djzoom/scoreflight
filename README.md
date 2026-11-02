# ScoreFlight — 乐谱飞越 · 八音盒

一个纯前端（Three.js + Web Audio）的音乐可视化页面，两种模式：

- **乐谱飞越**：整首曲子用 [Verovio](https://www.verovio.org/) 刻成一张长长的总谱铺在地上，镜头沿着谱子飞行，正在发声的音符按声部分色点亮。
- **八音盒**：把同一份乐谱"写"进一个 3D 八音盒——每个音符是滚筒上的一根针（角度 = 时间，排 = 音高），钢梳上每个音高一根齿；滚筒转动，针拨动梳齿，齿发光振动，并用合成的八音盒音色演奏。长曲子按真实多曲八音盒的办法分成多圈：每圈的针在齿缝里错开一个小步距，每转完一圈，蜗形凸轮把滚筒横向推进一步，下一排针对上梳齿，其余排从齿缝间穿过。盒盖内侧印着这首曲子的谱子。

没有构建步骤，没有依赖安装：`index.html` + `src/` + `data/`，Three.js 从 CDN 的 importmap 加载。

## 本地运行

```bash
git clone https://github.com/djzoom/scoreflight
cd scoreflight
python3 -m http.server 8000     # 任意静态服务器都行
# 打开 http://localhost:8000/
```

快捷键：`空格` 播放/暂停 · `←` `→` 前后 5 秒 · `1` / `2` 切换模式 · `c` 切换镜头自动/手动（手动时可拖拽旋转、滚轮缩放）。

URL 参数：`?piece=bach-bwv846&mode=musicbox`。

## 自带曲目（公共领域作品）

| id | 曲目 | 声部 |
|---|---|---|
| `bach-bwv846` | J. S. Bach — Prelude in C major, BWV 846 | 钢琴 |
| `joplin-maple-leaf-rag` | Scott Joplin — Maple Leaf Rag | 钢琴 |
| `verdi-la-donna-e-mobile` | Verdi — La donna è mobile | 钢琴缩谱 |
| `chopin-mazurka-op6-no2` | Chopin — Mazurka Op. 6 No. 2 | 钢琴 |
| `handel-lascia-chio-pianga` | Handel — Lascia ch'io pianga | 人声 + 钢琴 |
| `haydn-op1-no1-i` | Haydn — String Quartet Op. 1 No. 1, I | 弦乐四重奏 |
| `beethoven-op18-no1-i` | Beethoven — String Quartet Op. 18 No. 1, I | 弦乐四重奏 |

乐谱编码来自 [music21](https://github.com/cuthbertLab/music21) 自带语料库（公共领域作品；编码文件遵循 music21 corpus 的许可）。

## 数据是怎么来的

`tools/build_pieces.py` 做的事：

1. `music21` 从语料库读出乐谱，导出 MusicXML；
2. `verovio` 刻谱成一页很宽的 SVG（`breaks=auto`, `pageWidth=12000`），每个音符在 SVG 里带 id；
3. `renderToTimemap()` + `getMIDIValuesForElement()` 得到每个音符的起始秒数、时值、MIDI 音高；
4. 从 SVG 的 `<g class="note">` 里取符头坐标和所在的谱表/行；
5. 写出 `data/<id>/score.svg` 和 `data/<id>/notes.json`（`[time, duration, midi, staff, x, y, system]`）。

想加自己的曲子：有 MusicXML/MEI/**kern 就行，在 `PIECES` 里加一行（路径可以是本地文件），然后

```bash
pip install verovio music21
python3 tools/build_pieces.py
```

## 实现要点

- **乐谱贴图**：浏览器把 SVG 栅格化成 ≤4096px 的 canvas 瓦片，贴到平面上；像素总量有预算（约 4200 万像素），长曲子自动降分辨率。
- **镜头**：每个发音时刻取音符的平均位置作为"播放头"，镜头用阻尼追踪它，换行时自然地扫过去。
- **音频**：全部实时合成，无采样。八音盒音色 = 基频正弦 + 2 倍频 + 2.76 / 5.4 / 8.9 倍的非谐泛音（短衰减，模拟悬臂梳齿）+ 针拨的高频咔哒 + 卷积混响；乐谱模式按曲目家族用拨弦/键盘音或弓弦音。
- **调度**：`Transport` 以 `AudioContext.currentTime` 为时钟，提前 120 ms 调度音符，画面和声音共用同一时间轴。
- **八音盒机械**：按真实滚筒八音盒建模。梳齿间距 P；曲子分成 K 圈（约每 45 秒一圈，最多 10 圈），第 r 圈的针放在齿旁 r·P/K 处；滚筒末端的蜗形凸轮（K 级台阶）每圈把滚筒轴向推进 P/K，弹簧顶回。换圈的横移放在每圈最后 5% 的转角里以 smoothstep 过渡，这段里的针沿斜线排布（即"半螺旋 semi-helicoidal"做法），音乐不中断。针用 `InstancedMesh`，四千多根也不卡；低音齿更长并带铅块配重，齿被拨后按阻尼正弦振动，高音齿振得更快。
- **反复记号**：刻谱前先用 music21 `expandRepeats()` 把反复段落完整写出（否则 Verovio 的时间表在反复处只推进时间、不重发音符，会出现长段静音）；反复记号写得不规范、展开失败的曲子，去掉反复记号按写出来的弹一遍。
- **Cantus 卡带格式**：`tools/encode_cantus.py` 把每首曲子编码成 Cantus 音乐芯片外置 Flash 用的 CNT2 二进制（每个音约 3 字节：变长时间差 + 声部 3 bit + 音高 7 bit + 时值 6 bit），并分配到 8 个声部（超过 8 个同时发声时优先保留旋律和低音），输出 `data/cantus-songs.json`。
- **乐谱飞越的光**：符头本身变成灯（平贴在谱面上的发光圆片 + 柔光晕，`InstancedMesh`），最亮的十来个音符再各配一盏真实点光源照亮周围的刻谱，经 bloom 后处理成光斑。

## 许可

代码 MIT。曲目见上。
