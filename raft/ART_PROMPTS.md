# 《少年与海》美术提示词（给 ChatGPT 生图用）

游戏里的所有画面都已经用代码画好了，不放图片也能完整地玩。
下面这些图是**可选的升级**：用 ChatGPT（Work → GPT-6.1 Sol）生成后，按指定文件名放进
`raft/assets/` 文件夹（和 `index.html` 同级的 `assets` 目录），刷新游戏，对应的画面就会换成你生成的图。
支持 `.png`、`.webp`、`.jpg`。

## 用法

1. 在 ChatGPT 里新开一个对话，**先发「统一风格」那一段**，告诉它后面所有图都按这个风格画。
2. 再逐条发下面的提示词（英文提示词效果更稳定，中文说明是给你看的）。
3. 可以把你之前发我的两张参考图（夜空月亮那张、黄昏阳台那张）一起上传给它，说「参考这两张图的天空和云的画法」。
4. 下载图片，改成表里的文件名，放进 `raft/assets/`。

| 文件名 | 用在哪 | 尺寸建议 | 背景 |
| --- | --- | --- | --- |
| `sky_day` | 白天的天空 | 横版 16:9，越宽越好 | 不透明 |
| `sky_dusk` | 黄昏的天空 | 横版 16:9 | 不透明 |
| `sky_night` | 夜晚的天空 | 横版 16:9 | 不透明 |
| `horizon_day` | 白天远处海平线上的岛和礁石 | 横长条 4:1 | **透明** |
| `horizon_night` | 夜晚远处的剪影 | 横长条 4:1 | **透明** |
| `island` | 小岛（侧面） | 横版 3:2 | **透明** |
| `lighthouse` | 终点的灯塔岛（侧面） | 竖版 2:3 | **透明** |
| `title` | 标题画面的主视觉 | 横版 16:9 | 不透明 |

天空图的**海平线要在画面从上往下大约 62% 的位置**，海平线以下的部分会被游戏里的海水盖住，画什么都行。

---

## 统一风格（第一条先发这个）

> 接下来我要为一款 2D 横版游戏生成一系列美术图，请所有图片保持同一种风格：

```
Style guide for every image in this series:
hand-painted 2D game background art, gouache and watercolor texture with visible soft brushwork,
the painterly look of classic hand-drawn Japanese animated films (towering cumulus clouds with lit tops
and soft shadowed bellies, rich atmospheric skies), combined with the dark, oppressive, eerie mood of an
indie horror-adventure game: the world feels enormous, a lone child would look tiny in it, deep shadows,
muted desaturated colors with small pools of warm light, subtle film grain, slight vignette.
Side view (2D side-scroller), wide cinematic composition, no text, no logos, no people unless asked,
no frames or borders.
```

---

## 1. 白天的天空 → `sky_day`

```
A vast daytime sky over an endless calm ocean, side-view 2D game background, 16:9.
The horizon line is perfectly straight and sits at 62% of the image height from the top.
Soft teal-blue sky fading to a pale warm cream near the horizon, huge towering cumulus clouds
with sunlit cream tops and blue-grey shadowed undersides, thin high cirrus streaks, a few distant
seabirds as tiny marks. Below the horizon only a flat simple dark teal sea (it will be covered).
Peaceful, hopeful, a little lonely. Hand-painted gouache texture.
```

## 2. 黄昏的天空 → `sky_dusk`

```
The same ocean at sunset, side-view 2D game background, 16:9, horizon straight at 62% height.
The sun is half sunk into the horizon on the right third, glowing deep orange.
Sky layered from deep indigo at the top through rose and lilac to a dusty gold band at the horizon.
Enormous cumulus clouds lit peach, coral and lavender on the sunward side, purple-grey in shadow,
long soft cloud streaks near the horizon. Warm, nostalgic, the last light of the day.
Below the horizon only a flat simple dark sea (it will be covered). Hand-painted gouache texture.
```

## 3. 夜晚的天空 → `sky_night`

```
The same ocean at night, side-view 2D game background, 16:9, horizon straight at 62% height.
Deep navy and indigo sky full of small stars and a faint milky band, a thin bright crescent moon
high in the upper middle with a soft halo. Huge moonlit cumulus clouds with bright cold
blue-white rims and dark slate bellies. Low dark-blue mountain silhouettes far away on the horizon.
Quiet, beautiful and slightly ominous. Below the horizon only a flat near-black sea (it will be covered).
Hand-painted gouache texture.
```

## 4. 白天的远景剪影 → `horizon_day`（透明背景）

```
A long horizontal strip, 4:1, transparent background (PNG with alpha).
Distant small islands, sea stacks and a far-off rocky arch sitting on a straight horizon line along the
bottom edge, painted in soft hazy blue-grey with atmospheric perspective, very low contrast,
as if 20 kilometers away. Nothing above them but transparency. Hand-painted.
```

## 5. 夜晚的远景剪影 → `horizon_night`（透明背景）

```
A long horizontal strip, 4:1, transparent background (PNG with alpha).
Very distant dark-indigo silhouettes on a straight horizon line along the bottom edge: low mountains,
a broken old pier, and something unsettlingly tall and thin standing far out in the sea, barely visible.
Low contrast, cold moonlit rim light on the top edges. Eerie but quiet. Hand-painted.
```

## 6. 小岛 → `island`（透明背景）

```
Side view of a small tropical island for a 2D side-scroller, 3:2, transparent background (PNG with alpha).
A sandy beach on both sides sloping into the water line at the bottom, a low hill in the middle,
three leaning palm trees, dark jungle bushes, a few rocks, an old half-buried wooden chest, driftwood.
Daylight but moody: muted greens, warm sand, deep shadows under the trees where something could hide.
The bottom edge is where the sea surface will be. Hand-painted gouache.
```

## 7. 灯塔岛 → `lighthouse`（透明背景）

```
Side view of a rocky island with a tall old stone lighthouse, 2D side-scroller asset, 2:3 portrait,
transparent background (PNG with alpha). Weathered white-and-rust stone tower with a small wooden door
at the bottom, a warm light glowing in the lantern room at the top, a few stairs carved in the rock,
sea birds. The bottom edge is the sea surface. Hopeful and lonely, like the end of a long journey.
Hand-painted gouache.
```

## 8. 标题主视觉 → `title`

```
Title key art for a game called "The Boy and the Sea", 16:9, no text.
A tiny boy in an oversized dark navy sweater and a long red scarf stands on a small makeshift raft
in the lower third, seen from the side, holding a little glowing lantern. Around him an enormous
dusk-to-night sky with towering moonlit clouds and a thin crescent moon. Under the water's surface,
seen in cross-section, the silhouette of an impossibly huge whale passes beneath the raft in the dark.
Far on the horizon a lighthouse light. Wonder and fear at the same time. Hand-painted gouache.
```

---

### 小提示

- 如果 ChatGPT 生成的天空海平线不在 62% 的位置，可以追加一句：「把海平线移到从上往下 62% 的位置，保持一条水平直线」。
- 透明背景的图如果带了白底，追加一句：「请输出透明背景的 PNG，去掉所有背景」。
- 想换风格（比如更暗、更像恐怖游戏），只要改「统一风格」那一段再重新生成即可。
