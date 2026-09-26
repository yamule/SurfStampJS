# SurfStampJS

SurfStamp（生体分子表面に残基ラベルのテクスチャを貼るソフト, Apache-2.0, yamule）の JavaScript 移植版です。
Node.js の標準モジュールのみを使用し、外部パッケージには依存しません。

A JavaScript port of [SurfStamp](https://github.com/yamule/SurfStamp-public): it generates a molecular
surface from a PDB file, unwraps the surface per residue, and paints residue labels onto a texture
image. No external npm packages are used (only Node.js built-ins).

## 使い方 / Usage

```
node bin/surfstamp.js -pdb 3zsj_prot.pdb.gz -nowater -out 3zsj -image_size 4096
```

出力 / Output:

- `3zsj.obj` — 表面メッシュ（`v` / `vt` / `vn` / `f v/vt/vn`）
- `3zsj.obj.mtl` — マテリアル（`map_Kd 3zsj.obj.png`）
- `3zsj.obj.png` — テクスチャ画像
- `-preview` を付けると `3zsj_preview1..6.png`（6 方向のレンダリング）も出力

主なオプション / Main options:

| option | description |
|---|---|
| `-pdb FILE` | PDB ファイル（.gz 可） |
| `-obj FILE` | 既存の表面メッシュ（.obj）を使う（ラベルには `-pdb` も必要） |
| `-nowater`, `-nohetatm`, `-noh` | 水 / HETATM / 水素を除去 |
| `-surface_resolution F` | 格子間隔 Å（既定 0.5） |
| `-surface_proberadius F` | プローブ半径（既定 1.4） |
| `-surface_removeinside` | 内部空洞を埋める |
| `-residue` / `-residue_oneletter` / `-atom` / `-chain` | グループ化単位 |
| `-color_scheme N\|FILE` | 0 ClustalX 風（既定）, 1 疎水性, 2 等電点, 3 原子, 4 B-factor, 5 占有率, 7 チェーン階調, またはファイル |
| `-image_size N` | テクスチャサイズ（既定 2048） |
| `-font_name NAME\|FILE` | フォント名または .ttf のパス（既定: DejaVu Sans 等のシステム TrueType） |
| `-text_weight plain\|bold` | 太さ |
| `-font_size_min N` | ラベルの最小サイズ px（既定は自動） |
| `-outline_width F` | 境界線の太さ（既定 3） |
| `-text_num N`, `-text_dist F` | 島あたりのラベル数（既定 2）と間隔 |
| `-tile [-font_size N]` | ラベルをタイル状に敷き詰める |
| `-nobackground`, `-nooutline`, `-notext` | 背景 / 境界線 / 文字を描かない |
| `-nosep` | 法線方向によるグループ分割をしない |
| `-large_threshold N`, `-unwrap_large` | クラスターマッピング（階層展開）を使う面数の閾値（既定 10000）/ 常に使う |
| `-areamax_ratio F`, `-max_group_faces N` | グループを面積比 / 面数で分割する（`-chain` などの大きなグループ向け） |
| `-targetpoint x,y,z` | この点に近い外周点が各島の上になる（文字の向き, 既定は +y） |
| `-remove_jaggy`, `-color_missing`, `-force`, `-mtl_template FILE`, `-quiet`, `-verbose` | |

色スキームファイルの書式は SurfStamp と同じです（タブ区切りの `residue=TRP	residue_number=181	background_color=255,0,0	text_color=0,0,0	outline_color=0,0,0`、後の行が優先）。

## ライブラリとして / As a library

```js
import { PDBData, generateSurface, buildResidueDecorations, createTexturedObject, saveTexturedObject } from './src/index.js';

const pdb = PDBData.load('3zsj_prot.pdb.gz').removeWater();

// 1. 分子表面 (SurfaceMesh: { vertices: [[x,y,z]...], faces: [[i0,i1,i2]...] }, 面は外側から見て反時計回り)
const mesh = generateSurface(pdb, { resolution: 0.5, probeRadius: 1.4 });

// 2. 展開情報オブジェクト: 描画文字 / フォント / 文字色 / 背景色 / 連結して展開する Face のインデクス
const decorations = buildResidueDecorations(pdb, mesh, { scheme: 0 });
// 手動で作ることもできる:
// [{ faces: [0, 1, 2, ...], text: 'TRP181', textColor: [255,255,255], backgroundColor: [25,127,229], outlineColor: [0,0,0] }, ...]

// 3. UV 展開 + テクスチャ作成 + テクスチャ付きオブジェクト構築
const result = createTexturedObject(mesh, decorations, { imageSize: 2048, font: 'DejaVu Sans' });
// result: { vertices, faces, uv: [[u,v]...], faceUV: [[a,b,c]...], texture: Raster(RGBA), labels }

// 4. .obj エクスポート
saveTexturedObject(result, 'out.obj');
```

表面生成とテクスチャ作成は完全に分離されているので、他のソフトで作った `.obj` メッシュを `loadOBJ()` で読み込んで
`createTexturedObject()` に渡すこともできます。

## アルゴリズム概要 / Algorithm

1. **表面生成** (`src/surface.js`): 原子を VDW 半径 + プローブ半径で格子にボクセル化 → ユークリッド距離変換 →
   「SAS 境界からの距離 = プローブ半径」の等値面を surface nets で抽出 → 各頂点を厳密な SES 上へ投影 → 平滑化・非多様体修復・外向き配向。
2. **Face → 残基割当** (`src/mapping.js`): Face 中心に最も近い原子の残基。
3. **グループ分割** (`src/unwrap/group.js`): 法線の移動平均によりある方向から見渡せる部分に分割。閉曲面・ハンドル（トーラス）・ポケット・指状構造はシーム（頂点複製）で切り開く (`src/unwrap/disk.js`, `findMountains`)。
4. **グループ展開** (`src/unwrap/core.js`): 外周を弧長比例で円に置き（中心からの測地距離で半径補正）、中心点を円の中心に置き、外周から中心へ向かう波面で経路長に応じて点を配置。三角形配置（既知 2 点 + 3 辺長 → 法線側の 1 点）の予測を平均して緩和。反転面は局所 Tutte 再埋め込みで修復、最終手段は凸円 + Tutte（反転ゼロ保証）。スケール差はスケール精錬で縮小。
5. **失敗時**: 反転・重なりのある Face と周囲を分離し別グループとして再展開。
6. **クラスターマッピング** (`src/unwrap/cluster.js`): 大きなグループは ~30 面のクラスタに縮約し、縮約メッシュを展開後、クラスタ境界を展開済みエッジ上に配置して元 Face を復元。
7. **テクスチャ** (`src/texture/draw.js`): 島の背景塗り、残基境界線、最大内接矩形への文字描画（TrueType を自前でラスタライズ）。

## テスト / Tests

```
npm test
```

## License

Apache License 2.0 (same as SurfStamp).
