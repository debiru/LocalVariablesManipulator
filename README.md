# `code.ts` のコンパイル手順

1. `npm install -g typescript`
2. `npm install --save-dev @figma/plugin-typings`
3. `npm run build`

# Local Variables Manipulator

Figma の Local Variables を Export / Import するためのプラグインです。

## 概念

### Local Variables

Figma で管理できるデザイントークン全体のことです。

Local Variables は、次の要素から成り立ちます。

- Collection
- Modes
- Group
- Variable
    - variableName
    - description
    - valuesByMode
    - codeSyntax
    - scopes
    - hiddenFromPublishing

### Collection

Variable の集合を登録する、変数の「箱」です。

Collection には Modes が設定でき、その Collection 内の変数は各 Mode の値を持つことになります。

例えば、`Color` という Collection に `Light` と `Dark` の Modes を設定しているとき、そこに含まれる変数は `Light` と `Dark` 向けの値をそれぞれ持つことになります。

このとき `Light` や `Dark` といった Modes を持たない `Spacing` という変数を管理したい場合は、`Spacing` は `Color` とは別の Collection として作成すればよいことになります。

### Modes

Collection には変数の集合が登録されますが、その変数は Collection に設定された Mode の値をそれぞれ持ちます。

||Light|Dark|
|:---:|:---:|:---:|
|gray/100|#CCCCCC|#333333|

上記のように、Collection 内では変数は二次元表で管理されます。Mode はその表の「列」に対応する概念です。この例では `Light` と `Dark` の列を持っています。

### Group

Collection に変数を登録する際、変数名が設定できますが、その変数名を半角スラッシュで区切ることで階層的な名前を表現することができます。

Collection 内に `gray/100`, `gray/200`, `red/100` の名前を持つ変数を設定すると、画面上では次のように表示されます。

* gray
    * 100: ...
    * 200: ...
* red
    * 100: ...

Group は視覚的な表示に影響する概念で、機能的には意味を持ちません。変数名をスラッシュで区切ることには上記のような意味があるということを覚えておいてください。

### Variable

一つの変数情報です。変数は次の情報を持ちます。

|プロパティ|説明|
|:---:|:---|
|variableName|変数名|
|description|変数に関する備考欄|
|valuesByMode|Modes ごとの設定値|
|codeSyntax|コードプレビューに表示する値|
|scopes|この変数を使用できる項目の種類|
|hiddenFromPublishing|Publish から隠すかどうか|

### variableName

変数名です。Figma 上では Group を含む情報を変数名で扱います。つまり `Global Token/blue/100` という Group を持つ変数の変数名は、そのスラッシュを含む文字列そのものになるということです。

Collection 内において変数名は一意的です。同じ変数名を同じ Collection に定義することはできません。

### description

変数に対する備考欄です。メモとしての機能以上の意味を持ちません。

### valuesByMode

ある変数が持つ値を Modes ごとに取り出したものです。

||Light|Dark|
|:---:|:---:|:---:|
|gray/100|#CCCCCC|#333333|

この `gray/100` に対する `valuesByMode` の値は `{ Light: '#CCCCCC', Dark: '#333333' }` のようになります。

### codeSyntax

例えば `gray/100` をあるノードの `color` プロパティ値として設定したとします。このとき、そのノードを選択するとプロパティ情報を見ることができますが、その際に `color: gray/100` ではなく、`color: color.gray['100']` のように実際のコードで使えるような文字列を出力するための設定項目です。

これを実現するには、`gray/100` の変数の codeSyntax の `WEB` の値を `color.gray['100']` に設定します。

### scopes

例えば `Spacing` の Collection において `small/1: 2`, `small/2: 4` のように値を設定したとします。この変数は「線の太さ」などではなく「要素間の余白」を表すための変数値として使うことを想定しているものだとします。

このとき、あるノードのプロパティを設定しようとしたときに「線の太さ」として `Spacing` の変数が表示されてしまうと意図しない変数の使い方をされる恐れがあります。

これを防ぐために、プロパティの種類に応じて変数を使えるか使えないかを制御するための仕組みとして scopes があります。scopes に `GAP` のみを設定しておけば、「要素間の余白」を表すプロパティのみにその変数が表示されるようになります。

### hiddenFromPublishing

Local Variables をライブラリとして公開するときに、その変数を非表示にするかどうかを表すフラグです。
