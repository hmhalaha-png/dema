// 奇遇图鉴：every creature / wonder the boy can encounter.
// Modules call discover(G, id) the first time the player sees one on screen.
// kind: 'day' | 'night' | 'deep' | 'island' — decides where it shows up in the codex panel.

export const CODEX = {
  seagull:     { name: '跟船的海鸥',     kind: 'day',    desc: '它们总在木筏上空打转，好像知道哪里有鱼。' },
  flying_fish: { name: '飞鱼群',         kind: 'day',    desc: '一整片银光从浪尖上掠过，像有人往海面撒了一把硬币。' },
  dolphin:     { name: '海豚',           kind: 'day',    desc: '它们陪木筏游了一段路，又笑着离开了。' },
  turtle:      { name: '老海龟',         kind: 'day',    desc: '背壳上长满了藤壶，慢吞吞地，像是已经游了一百年。' },
  manta:       { name: '魔鬼鱼',         kind: 'day',    desc: '巨大的影子从脚下滑过，安静得像一片会飞的云。' },
  whale:       { name: '鲸',             kind: 'day',    desc: '整片海都暗了一下。它从木筏下面经过，比木筏大一百倍。' },
  shark:       { name: '鲨鱼',           kind: 'day',    desc: '灰色的背鳍一直跟着木筏。下水的时候要小心。' },
  crab:        { name: '寄居蟹',         kind: 'island', desc: '背着别人丢掉的瓶盖当房子。' },
  jelly:       { name: '发光水母',       kind: 'night',  desc: '夜里的海面下亮起一盏盏小灯，碰到会有点疼。' },
  plankton:    { name: '夜光浮游',       kind: 'night',  desc: '划一下水，水就会发出蓝色的光，像把星星搅碎了。' },
  lanternfish: { name: '灯笼鱼',         kind: 'night',  desc: '它们成群地发着光，绕着提灯打转。' },
  moon_whale:  { name: '月光鲸',         kind: 'night',  desc: '它跃出水面的时候，正好挡住了月亮。' },
  leviathan:   { name: '地平线上的巨影', kind: 'night',  desc: '远处有什么东西站在海里，比云还高。最好别盯着它看太久。' },
  ghost_ship:  { name: '雾里的船',       kind: 'night',  desc: '起雾的夜里，一艘亮着灯的船从旁边漂过，甲板上一个人也没有。' },
  angler:      { name: '深渊垂钓者',     kind: 'deep',   desc: '黑暗里有一盏小灯在晃。灯后面是一张很大很大的嘴。' },
  deep_eye:    { name: '海底之眼',       kind: 'deep',   desc: '海床上的那块石头，眨了一下眼睛。' },
  island_beast:{ name: '林中野兽',       kind: 'island', desc: '天黑以后，岛上的树林里有东西在走动。它不喜欢光。' },
};

export const CODEX_IDS = Object.keys(CODEX);
