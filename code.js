"use strict";
/*
{
  "ColorExample": {
    "Alias Token/primary": {
      "$variableValues": {
        "Light": "$Global Token/blue/100",
        "Dark": "$Global Token/blue/100"
      },
      "$description": "",
      "$codeSyntax": {
        "WEB": "color.aliasToken.primary"
      },
      "$scopes": [
        "ALL_SCOPES"
      ],
      "$hiddenFromPublishing": false
    },
    "Global Token/blue/100": {
      "$variableValues": {
        "Light": "#0000FF",
        "Dark": "#0000FF"
      },
      "$description": "",
      "$codeSyntax": {
        "WEB": "color.globalToken.blue['100']"
      },
      "$scopes": [
        "ALL_SCOPES"
      ],
      "$hiddenFromPublishing": false
    }
  }
}
*/
function entrypoint() {
    console.clear();
    figma.showUI(__html__, {
        width: 640,
        height: 740,
        themeColors: true,
    });
    figma.ui.onmessage = App.onmessage;
}
const App = {
    post(params) {
        figma.ui.postMessage(params);
    },
    outputExportJSON(data) {
        App.post({ type: 'LVM-export-json', data });
    },
    outputImportStatus(data) {
        App.post({ type: 'LVM-import-status', data });
    },
    onmessage(msg) {
        if (msg.type === 'LVM-export')
            App.doExport();
        if (msg.type === 'LVM-import')
            App.doImport(msg);
    },
    async doExport() {
        // Local Variables の Collections 情報を全て取得する
        const collectionsInfo = await CIManip.getCollectionsInfo();
        // Collections 情報を JSON に変換する
        const jsonObj = JSONManip.getJSONObjByCollectionsInfo(collectionsInfo);
        App.outputExportJSON(Util.toJSON(jsonObj));
    },
    async doImport(msg) {
        let runtimeError = false;
        try {
            // JSON をオブジェクトに変換する
            const jsonObj = JSON.parse(msg.data);
            // 既に登録済みの Local Variables の Collections 情報を取得する
            const collectionsInfo = await CIManip.getCollectionsInfo();
            // JSON を静的解析して、構文に問題があれば処理を中断する
            JSONManip.validateImportJSON(collectionsInfo, jsonObj);
            // インポート処理前の Local Variables の Collections 情報を JSON に変換する
            const backupJSONObj = JSONManip.getJSONObjByCollectionsInfo(collectionsInfo);
            // インポート処理を実行する（実行中に例外が発生したら runtimeError として処理する）
            runtimeError = true;
            await App.importVariables(collectionsInfo, jsonObj);
            runtimeError = false;
            // ui.html に情報を送る
            App.outputExportJSON(Util.toJSON(backupJSONObj));
            App.outputImportStatus(Util.toJSON({
                status: 'インポートが成功しました。',
                note: 'インポート前の情報をエクスポートしています。必要であればログを控えておいてください。',
            }));
            App.post({ type: 'LVM-import-succeeded' });
        }
        catch (err) {
            // JSON.parse() で失敗した場合は err.lineNumber が与えられる
            const status = err.lineNumber != null ? 'Invalid JSON' : 'Invalid data structure';
            const note = runtimeError ? 'インポート処理中にエラーが発生しました。データが途中までインポートされた可能性があります。' : undefined;
            // ui.html に情報を送る
            App.outputImportStatus(Util.toJSON({ status, line: err.lineNumber, message: err.message, note }));
        }
    },
    /**
     * JSON 情報を基に Local Variables のインポートを実行する
     */
    async importVariables(collectionsInfo, jsonObj, prevNullCount) {
        // AliasVariable は、参照先の変数が登録済みでなければ登録できない
        // nullCount は、登録できなかった AliasVariables の個数を表す
        let nullCount = 0;
        for (const [collectionName, variablesValues] of Object.entries(jsonObj)) {
            let collectionInfo;
            // 初回のインポート処理
            if (prevNullCount == null) {
                const variableValuesArray = Object.values(variablesValues).map($keys => $keys.$variableValues);
                const modeNames = Util.getKeysByObjectArray(variableValuesArray);
                // Collection が存在すればそれを取得、なければ新規 Collection を作成し、mode を設定する
                collectionInfo = await CIManip.upsertCollectionInfoByName(collectionsInfo, collectionName, modeNames);
            }
            // 2回目以降のインポート処理
            else {
                // Collection を取得する
                collectionInfo = collectionsInfo[collectionName];
            }
            for (const [variableName, jsonObjVariable] of Object.entries(variablesValues)) {
                if (VIManip.upsertVariable(collectionInfo, variableName, jsonObjVariable) == null)
                    ++nullCount;
            }
        }
        // nullCount が 1 以上であれば、未登録の AliasVariable があるので再登録を試みる
        // 直前の処理と nullCount が同じ場合は、存在しない参照先を指定しているので処理を中断する
        // なお、循環参照している場合は、循環を検出した Variable の値の登録が無視される
        if (nullCount > 0 && nullCount !== prevNullCount) {
            // 直前の処理でインポートに成功した分も含めて Collections 情報を取得し直す
            collectionsInfo = await CIManip.getCollectionsInfo();
            await App.importVariables(collectionsInfo, jsonObj, nullCount);
        }
    },
};
/**
 * CollectionInfo Manip
 */
const CIManip = {
    /**
     * 存在する全ての Collection の CollectionInfo を取得する
     */
    async getCollectionsInfo() {
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        const collectionsInfoArray = await Promise.all(collections.map(collection => CIManip.getCollectionInfo(collection)));
        const keyCallback = (value) => value.collection.name;
        let collectionsInfo = Util.objMap(Util.arrayCombine(collectionsInfoArray), null, keyCallback);
        collectionsInfo = Util.objKeySort(collectionsInfo);
        return collectionsInfo;
    },
    /**
     * Collection から CollectionInfo を作成する
     */
    async getCollectionInfo(collection) {
        const variablesInfo = await VIManip.getVariablesInfo(collection);
        return { collection, variablesInfo };
    },
    /**
     * 指定した name の CollectionInfo があれば取得し、なければ作成する
     */
    async upsertCollectionInfoByName(collectionsInfo, name, modeNames) {
        let collectionInfo = collectionsInfo[name];
        const collection = collectionInfo == null ? figma.variables.createVariableCollection(name) : collectionInfo.collection;
        // modeNames で mode を上書きする
        CIManip.setModes(collection, modeNames);
        if (collectionInfo == null)
            collectionInfo = await CIManip.getCollectionInfo(collection);
        return collectionInfo;
    },
    /**
     * Mode から name を取得する
     */
    getModeName(mode) {
        // for Figma bug: https://forum.figma.com/t/the-number-of-modes-does-not-match/79073
        if (mode == null)
            return '';
        const name = mode.name;
        // デフォルトのモードは name と表示名が異なっているので表示名を使う
        if (name === 'Mode 1')
            return 'Value';
        return name;
    },
    /**
     * Collection に modeNames を設定する
     */
    setModes(collection, modeNames) {
        if (modeNames.length === 0)
            return;
        const modes = collection.modes;
        // modeName を書き換える
        modeNames.forEach((modeName, idx) => {
            let modeId = modes[idx] && modes[idx].modeId;
            if (modeId == null)
                modeId = collection.addMode(modeName);
            else
                collection.renameMode(modeId, modeName);
        });
        // 不要な mode を削除する
        for (let idx = modeNames.length; idx < modes.length; ++idx) {
            collection.removeMode(modes[idx].modeId);
        }
    },
};
/**
 * VariableInfo Manip
 */
const VIManip = {
    /**
     * 指定した variableName の Variable があれば上書きし、なければ作成する
     */
    upsertVariable(collectionInfo, variableName, jsonObjVariable) {
        const { collection, variablesInfo } = collectionInfo;
        let variable = (variablesInfo[variableName] && variablesInfo[variableName].variable);
        if (variable == null) {
            // 設定しようとしている $variableValues を基に変数の型を導出する
            const variableType = AppUtil.detectTypeByJSONObjVariable(collectionInfo.variablesInfo, jsonObjVariable);
            if (variableType == null)
                return null;
            variable = figma.variables.createVariable(variableName, collection, variableType);
        }
        // $variableValues
        collection.modes.forEach(mode => {
            const modeName = CIManip.getModeName(mode);
            const value = jsonObjVariable.$variableValues[modeName];
            if (value == null)
                return;
            const internalValue = AppUtil.convertValue(collectionInfo.variablesInfo, value);
            if (internalValue == null)
                return;
            variable.setValueForMode(mode.modeId, internalValue);
        });
        // $description
        variable.description = jsonObjVariable.$description;
        // $codeSyntax
        for (const [platform, codeSyntax] of Object.entries(jsonObjVariable.$codeSyntax)) {
            variable.setVariableCodeSyntax(platform, codeSyntax);
        }
        // $scopes
        variable.scopes = jsonObjVariable.$scopes;
        // $hiddenFromPublishing
        variable.hiddenFromPublishing = jsonObjVariable.$hiddenFromPublishing;
        return variable;
    },
    /**
     * Collection 内にある Local Variables を全て取得する
     */
    async getVariablesInfo(collection) {
        let variablesInfo = {};
        const promiseList = [];
        for (const variableId of collection.variableIds) {
            promiseList.push(figma.variables.getVariableByIdAsync(variableId));
        }
        const variables = await Promise.all(promiseList);
        for (const variable of variables) {
            variablesInfo[variable.name] = VIManip.getVariableInfo(collection, variables, variable);
        }
        variablesInfo = Util.objKeySort(variablesInfo);
        return variablesInfo;
    },
    /**
     * Collection と Variable から VariableInfo を作成する
     * https://www.figma.com/plugin-docs/api/VariableCollection/
     *  - name | modes | defaultModeId | variableIds
     * https://www.figma.com/plugin-docs/api/Variable/
     *  - name | resolvedType | valuesByMode | codeSyntax | scopes
     * https://www.figma.com/plugin-docs/api/VariableScope/
     *  - STRING: "ALL_SCOPES" | "TEXT_CONTENT" | "FONT_FAMILY" | "FONT_STYLE"
     *  - FLOAT: "ALL_SCOPES" | "TEXT_CONTENT" | "CORNER_RADIUS" | "WIDTH_HEIGHT" | "GAP" | "OPACITY" | "STROKE_FLOAT"
     *           | "EFFECT_FLOAT" | "FONT_WEIGHT" | "FONT_SIZE" | "LINE_HEIGHT" | "LETTER_SPACING" | "PARAGRAPH_SPACING" | "PARAGRAPH_INDENT"
     *  - COLOR: "ALL_SCOPES" | "ALL_FILLS" | "FRAME_FILL" | "SHAPE_FILL" | "TEXT_FILL" | "STROKE_COLOR" | "EFFECT_COLOR"
     */
    getVariableInfo(collection, variables, variable) {
        const keyCallback = (value, key) => {
            const mode = collection.modes.find(mode => mode.modeId === key);
            return CIManip.getModeName(mode);
        };
        const valueCallback = (value) => AppUtil.reverseConvertValue(variables, value);
        const jsonObjVariable = {
            $variableValues: Util.objMap(variable.valuesByMode, valueCallback, keyCallback),
            $description: variable.description,
            $codeSyntax: variable.codeSyntax,
            $scopes: variable.scopes,
            $hiddenFromPublishing: variable.hiddenFromPublishing,
        };
        // for Figma bug: https://forum.figma.com/t/the-number-of-modes-does-not-match/79073
        delete jsonObjVariable.$variableValues[''];
        return { variable, jsonObjVariable };
    },
};
const JSONManip = {
    /**
     * Local Variables 情報を JSONObj として取得する
     */
    getJSONObjByCollectionsInfo(collectionsInfo) {
        const jsonObj = {};
        for (const collectionInfo of Object.values(collectionsInfo)) {
            const collectionJSON = JSONManip.convertVariablesInfoForJSON(collectionInfo.variablesInfo);
            jsonObj[collectionInfo.collection.name] = collectionJSON;
        }
        return jsonObj;
    },
    /**
     * VariablesInfo を JSON 用の構造に変換する
     */
    convertVariablesInfoForJSON(variablesInfo) {
        const jsonObj = {};
        for (const variableInfo of Object.values(variablesInfo)) {
            const variableName = variableInfo.variable.name;
            jsonObj[variableName] = variableInfo.jsonObjVariable;
        }
        return jsonObj;
    },
    /**
     * Import された JSON の形式が妥当かどうかチェックする
     */
    validateImportJSON(collectionsInfo, jsonObj) {
        if (!Util.isObject(jsonObj)) {
            Util.Exception('JSON がオブジェクトではありません。');
        }
        if (Object.keys(jsonObj).length === 0) {
            Util.Exception('JSON が空のオブジェクトです。');
        }
        for (const [collectionName, variablesValues] of Object.entries(jsonObj)) {
            if (!Util.isObject(variablesValues)) {
                Util.Exception(Util.sprintf("'%s' の値がオブジェクトではありません。", collectionName));
            }
            for (const [variableName, jsonObjVariable] of Object.entries(variablesValues)) {
                // jsonObjVariable
                if (!Util.isObject(jsonObjVariable)) {
                    Util.Exception(Util.sprintf("%s['%s'] の値がオブジェクトではありません。", collectionName, variableName));
                }
                const set = new Set(Object.keys(jsonObjVariable));
                if (!Util.hasOnlyInSet(set, ['$variableValues', '$description', '$codeSyntax', '$scopes', '$hiddenFromPublishing'])) {
                    Util.Exception(Util.sprintf("%s['%s'] の値は次のキーのみを全て持つオブジェクトである必要があります。['$variableValues', '$description', '$codeSyntax', '$scopes', '$hiddenFromPublishing']", collectionName, variableName));
                }
                const validJSONObjVariable = jsonObjVariable;
                // jsonObjVariable.$variableValues
                if (!Util.isObject(validJSONObjVariable.$variableValues)) {
                    Util.Exception(Util.sprintf("%s['%s']['$variableValues'] の値がオブジェクトではありません。", collectionName, variableName));
                }
                for (const [modeName, variableValue] of Object.entries(validJSONObjVariable.$variableValues)) {
                    if (!AppUtil.validateVariableValue(variableValue)) {
                        Util.Exception(Util.sprintf("%s['%s']['%s'] の値が string | number | boolean ではありません。", collectionName, variableName, modeName));
                    }
                }
                // jsonObjVariable.$description
                if (!Util.isString(validJSONObjVariable.$description)) {
                    Util.Exception(Util.sprintf("%s['%s']['$description'] の値が文字列ではありません。", collectionName, variableName));
                }
                // jsonObjVariable.$codeSyntax
                if (!Util.isObject(validJSONObjVariable.$codeSyntax)) {
                    Util.Exception(Util.sprintf("%s['%s']['$codeSyntax'] の値がオブジェクトではありません。", collectionName, variableName));
                }
                const codeSyntaxKeys = Object.keys(validJSONObjVariable.$codeSyntax);
                for (const key of codeSyntaxKeys) {
                    if (!(key === 'WEB' || key === 'ANDROID' || key === 'iOS')) {
                        Util.Exception(Util.sprintf("%s['%s']['$codeSyntax'] の値は次のいずれかのキーを持つオブジェクトである必要があります。['WEB', 'ANDROID', 'iOS']", collectionName, variableName));
                    }
                }
                // jsonObjVariable.$scopes
                if (!Array.isArray(validJSONObjVariable.$scopes)) {
                    Util.Exception(Util.sprintf("%s['%s']['$scopes'] の値が配列ではありません。", collectionName, variableName));
                }
                // jsonObjVariable.$hiddenFromPublishing
                if (!Util.isBoolean(validJSONObjVariable.$hiddenFromPublishing)) {
                    Util.Exception(Util.sprintf("%s['%s']['$hiddenFromPublishing'] の値が真偽値ではありません。", collectionName, variableName));
                }
            }
        }
        return jsonObj;
    },
};
const AppUtil = {
    /**
     * 入力値が COLOR 型かどうかを判定する
     */
    isColorInputValue(value) {
        return Util.isString(value) && /^(?:#|rgba?\()/.test(value);
    },
    /**
     * 入力値が ALIAS 型かどうかを判定する
     */
    isAliasInputValue(value) {
        return Util.isString(value) && /^\$/.test(value);
    },
    /**
     * ALIAS 型の入力値から valiableName を取得する
     */
    getByAliasInputValue(value) {
        return value.replace(/^\$/, '');
    },
    /**
     * 変数の値の型として妥当かどうかチェックする
     */
    validateVariableValue(value) {
        if (Util.isString(value))
            return true;
        if (Util.isNumber(value))
            return true;
        if (Util.isBoolean(value))
            return true;
        return false;
    },
    /**
     * jsonObjVariable を基に VariableType を取得する
     */
    detectTypeByJSONObjVariable(variablesInfo, jsonObjVariable) {
        return AppUtil.detectType(variablesInfo, Util.getFirstElement(jsonObjVariable.$variableValues));
    },
    /**
     * 入力値に応じて Local Variable の型を決める
     * https://www.figma.com/plugin-docs/api/VariableResolvedDataType/
     * type VariableResolvedDataType = "BOOLEAN" | "COLOR" | "FLOAT" | "STRING"
     */
    detectType(variablesInfo, value) {
        if (value == null)
            return null;
        if (Util.isBoolean(value))
            return 'BOOLEAN';
        if (Util.isNumber(value))
            return 'FLOAT';
        if (AppUtil.isColorInputValue(value))
            return 'COLOR';
        if (AppUtil.isAliasInputValue(value)) {
            const variable = AppUtil.getAliasVariable(variablesInfo, value);
            return variable == null ? null : variable.resolvedType;
        }
        return 'STRING';
    },
    /**
     * 入力値を setValueForMode が受け付ける内部値に変換する
     */
    convertValue(variablesInfo, value) {
        if (AppUtil.isColorInputValue(value))
            return figma.util.rgba(value);
        if (AppUtil.isAliasInputValue(value)) {
            const variable = AppUtil.getAliasVariable(variablesInfo, value);
            return variable == null ? null : figma.variables.createVariableAlias(variable);
        }
        return value;
    },
    /**
     * ALIAS 型の入力値から対応する Variable を取得する
     */
    getAliasVariable(variablesInfo, value) {
        const variableName = AppUtil.getByAliasInputValue(value);
        const variable = variablesInfo[variableName] && variablesInfo[variableName].variable;
        return variable;
    },
    /**
     * 内部値を入力値に変換する
     * https://www.figma.com/plugin-docs/api/VariableValue/
     *  - string | number | boolean | RGB | RGBA | VariableAlias
     */
    reverseConvertValue(variables, value) {
        if (AppUtil.isColorVariableValue(value))
            return AppUtil.rgbaToHex(value);
        if (AppUtil.isAliasVariableValue(value))
            return AppUtil.aliasToName(variables, value);
        return value;
    },
    /**
     * 内部値が COLOR 型かどうかを判定する
     */
    isColorVariableValue(value) {
        if (!Util.isObject(value))
            return false;
        const { r, g, b, a } = value;
        if (r == null || g == null || b == null || a == null)
            return false;
        return true;
    },
    /**
     * 内部値が ALIAS 型かどうかを判定する
     */
    isAliasVariableValue(value) {
        if (!Util.isObject(value))
            return false;
        const { type } = value;
        return type === 'VARIABLE_ALIAS';
    },
    /**
     * RGBA 値を CSS value に変換する
     */
    rgbaToHex({ r, g, b, a }) {
        if (a < 1)
            return `rgb(${[r, g, b].map((value) => Math.round(value * 255)).join(' ')} / ${a.toFixed(4)})`;
        const toHex = (value) => Math.round(value * 255).toString(16).toUpperCase().padStart(2, '0');
        return `#${[toHex(r), toHex(g), toHex(b)].join('')}`;
    },
    /**
     * VariableAlias 値を $ValiableName に変換する
     */
    aliasToName(variables, { id }) {
        const variable = variables.find(variable => variable.id === id);
        return Util.sprintf('$%s', variable.name);
    },
};
const Util = {
    /**
     * 例外を発生させる
     */
    Exception(msg) {
        throw new Error(msg);
    },
    /**
     * %s プレースホルダーのみが使える sprintf を提供する
     */
    sprintf(format, ...args) {
        let p = 0;
        return format.replace(/%./g, function (m) {
            if (m === '%%')
                return '%';
            if (m === '%s')
                return args[p++];
            return m;
        });
    },
    /**
     * 値を JSON に変換する
     */
    toJSON(arg) {
        return JSON.stringify(arg, null, 2);
    },
    /**
     * String かどうかを判定する
     */
    isString(arg) {
        return typeof arg === 'string';
    },
    /**
     * Number かどうか判定する
     */
    isNumber(arg) {
        return typeof arg === 'number';
    },
    /**
     * Boolean かどうか判定する
     */
    isBoolean(arg) {
        return typeof arg === 'boolean';
    },
    /**
     * Object かどうかを判定する
     */
    isObject(arg) {
        if (typeof arg !== 'object' || arg === null)
            return false;
        const prototype = Object.getPrototypeOf(arg);
        const isPlainObject = prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null;
        return isPlainObject && !(Symbol.toStringTag in arg) && !(Symbol.iterator in arg);
    },
    /**
     * Set に含まれる値が唯一指定したものに限るかどうかを判定する
     */
    hasOnlyInSet(set, values) {
        for (const value of values) {
            if (!set.has(value))
                return false;
        }
        return set.size === values.length;
    },
    /**
     * Object または Array の最初の要素を取得する
     */
    getFirstElement(arg) {
        if (Util.isObject(arg) || Array.isArray(arg)) {
            const array = Object.values(arg);
            if (array.length >= 1)
                return array[0];
        }
        return null;
    },
    /**
     * Object に対して map する
     */
    objMap(obj, valueCallback, keyCallback) {
        if (valueCallback == null)
            valueCallback = (value) => value;
        if (keyCallback == null)
            keyCallback = (value, key) => key;
        const ret = {};
        Object.entries(obj).forEach(([key, value]) => ret[keyCallback(value, key)] = valueCallback(value, key));
        return ret;
    },
    /**
     * keyArray と valueArray から Object を生成する
     */
    arrayCombine(keyArray, valueArray) {
        if (valueArray == null) {
            valueArray = keyArray;
            keyArray = Object.keys(keyArray);
        }
        const ret = {};
        for (let i = 0; i < keyArray.length; ++i)
            ret[keyArray[i]] = valueArray[i];
        return ret;
    },
    /**
     * Object の配列から、Object で使われているキーの一覧を取得する
     */
    getKeysByObjectArray(objArray) {
        const set = new Set();
        for (const obj of objArray) {
            for (const key of Object.keys(obj)) {
                set.add(key);
            }
        }
        return Array.from(set);
    },
    /**
     * Object のキーを基にソートする
     */
    objKeySort(obj) {
        const ret = {};
        const keys = Object.keys(obj);
        keys.sort();
        for (const key of keys) {
            ret[key] = obj[key];
        }
        return ret;
    }
};
entrypoint();
